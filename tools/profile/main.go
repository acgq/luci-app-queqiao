// The profile library keeps editable drafts separate from applied runtime files.
// Identity validation is linked from the selected Queqiao source checkout.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bojieli/queqiao/internal/identity"
	"golang.org/x/sys/unix"
)

const (
	root        = "/etc/queqiao"
	drafts      = root + "/profiles"
	live        = root + "/runtime"
	legacy      = root + "/router.json"
	pointer     = root + "/active-profile"
	maxProfile  = 64 << 10
	maxRequest  = 512 << 10
	maxProfiles = 32
)

type entry struct {
	Name     string `json:"name"`
	Revision string `json:"revision"`
	Pending  bool   `json:"pending"`
}

type response struct {
	OK       bool    `json:"ok"`
	Error    string  `json:"error,omitempty"`
	Name     string  `json:"name,omitempty"`
	Content  string  `json:"content,omitempty"`
	Revision string  `json:"revision"`
	Exists   bool    `json:"exists"`
	Active   string  `json:"active"`
	Profiles []entry `json:"profiles,omitempty"`
	Warning  string  `json:"warning,omitempty"`
	Running  bool    `json:"running"`
}

type request struct {
	Name     string `json:"name"`
	Content  string `json:"content"`
	Revision string `json:"revision"`
	Session  string `json:"ubus_rpc_session,omitempty"`
}

func hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func validName(name string) bool {
	if !utf8.ValidString(name) || len(name) > 128 || utf8.RuneCountInString(name) > 48 || name == "" {
		return false
	}
	for i, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && (i == 0 || r != '_' && r != '-') {
			return false
		}
	}
	return true
}

func directory(path string, create bool) error {
	if create {
		if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return errors.New("cannot create profile directory")
		}
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("profile directories must be regular private directories (mode 0700)")
	}
	return nil
}

func readFile(path string, limit int64) ([]byte, bool, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errors.New("cannot open private profile file")
	}
	file := os.NewFile(uintptr(fd), "private profile")
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, false, errors.New("profile files must be regular private files (mode 0600)")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, false, errors.New("profile file cannot be read or exceeds its size limit")
	}
	return data, true, nil
}

func lock(path string, deadline time.Time) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, errors.New("cannot open profile lock")
	}
	file := os.NewFile(uintptr(fd), "profile lock")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("profile lock must be regular")
	}
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return file, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) || !time.Now().Before(deadline) {
			file.Close()
			return nil, errors.New("profile is busy; reload and retry after renewal or application finishes")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func temporary(path string, data []byte) (string, error) {
	file, err := os.CreateTemp(filepath.Dir(path), ".luci-profile-*")
	if err != nil {
		return "", errors.New("cannot create private temporary profile")
	}
	name := file.Name()
	keep := false
	defer func() {
		file.Close()
		if !keep {
			os.Remove(name)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return "", errors.New("cannot write profile; check free storage")
	}
	if err := file.Sync(); err != nil {
		return "", errors.New("cannot sync profile")
	}
	if err := file.Close(); err != nil {
		return "", errors.New("cannot close profile")
	}
	keep = true
	return name, nil
}

func writeFile(path string, data []byte, backup bool) error {
	old, exists, err := readFile(path, maxProfile)
	if err != nil {
		return err
	}
	if exists && bytes.Equal(old, data) {
		return nil
	}
	name, err := temporary(path, data)
	if err != nil {
		return err
	}
	defer os.Remove(name)
	if backup && exists {
		if err := writeFile(path+".bak", old, false); err != nil {
			return err
		}
	}
	if err := os.Rename(name, path); err != nil {
		return errors.New("cannot atomically replace profile")
	}
	dir, err := os.Open(filepath.Dir(path))
	if err == nil {
		err = dir.Sync()
		dir.Close()
	}
	if err != nil {
		return errors.New("file replaced, but directory durability sync failed; reload before retrying")
	}
	return nil
}

func validate(data []byte) error {
	name, err := temporary(legacy, data)
	if err != nil {
		return err
	}
	defer os.Remove(name)
	if _, err := identity.LoadClientProfile(name); err != nil {
		return errors.New("profile rejected: check JSON fields, version, endpoint, certificate validity, matching private key and pinned identity")
	}
	return nil
}

func names() ([]string, error) {
	dir, err := os.Open(drafts)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	files, err := dir.ReadDir(2*maxProfiles + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(files) > 2*maxProfiles {
		return nil, errors.New("profile directory exceeds its entry limit")
	}
	result := []string{}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(file.Name(), ".json")
		if !validName(name) {
			return nil, errors.New("profile directory contains an unsupported file name")
		}
		result = append(result, name)
	}
	if len(result) > maxProfiles {
		return nil, errors.New("profile count exceeds 32")
	}
	sort.Strings(result)
	return result, nil
}

func applied() (string, bool, error) {
	data, exists, err := readFile(pointer, 129)
	if err != nil {
		return "", false, err
	}
	if exists {
		name := strings.TrimSpace(string(data))
		if !validName(name) {
			return "", false, errors.New("invalid active profile selector")
		}
		return name, true, nil
	}
	_, exists, err = readFile(legacy, maxProfile)
	if err != nil {
		return "", false, err
	}
	if exists {
		return "router", false, nil
	}
	return "", false, nil
}

func sourceRevision(name string) (string, error) {
	data, exists, err := readFile(filepath.Join(live, name+".source"), 65)
	if err != nil || !exists {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if raw, err := hex.DecodeString(value); err != nil || len(raw) != 32 {
		return "", errors.New("invalid applied profile revision")
	}
	return value, nil
}

func initialize(deadline time.Time) error {
	if err := directory(drafts, true); err != nil {
		return err
	}
	if err := directory(live, true); err != nil {
		return err
	}
	all, err := names()
	if err != nil {
		return err
	}
	active, selected, err := applied()
	if err != nil {
		return err
	}
	if len(all) != 0 || selected || active != "router" {
		return nil
	}
	file, err := lock(legacy+".lock", deadline)
	if err != nil {
		return err
	}
	defer file.Close()
	data, exists, err := readFile(legacy, maxProfile)
	if err != nil || !exists {
		return err
	}
	if err := writeFile(filepath.Join(drafts, "router.json"), data, false); err != nil {
		return err
	}
	return writeFile(filepath.Join(live, "router.source"), []byte(hash(data)+"\n"), false)
}

// Refresh only unchanged drafts from renewed runtime credentials. A user's
// pending draft is never replaced by this maintenance step.
func synchronize(all []string, active string, selected bool, deadline time.Time) error {
	for _, name := range all {
		marker, err := sourceRevision(name)
		if err != nil {
			return err
		}
		if marker == "" {
			continue
		}
		path := filepath.Join(drafts, name+".json")
		data, _, err := readFile(path, maxProfile)
		if err != nil {
			return err
		}
		if hash(data) != marker {
			continue
		}
		source := filepath.Join(live, name+".json")
		if name == active && !selected {
			source = legacy
		}
		file, err := lock(source+".lock", deadline)
		if err != nil {
			return err
		}
		current, exists, err := readFile(source, maxProfile)
		if err == nil && exists && hash(current) != marker && validate(current) == nil {
			err = writeFile(path, current, false)
			if err == nil {
				err = writeFile(filepath.Join(live, name+".source"), []byte(hash(current)+"\n"), false)
			}
		}
		file.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func service(action string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, "/etc/init.d/queqiao", action)
	command.Stdout, command.Stderr = io.Discard, io.Discard
	return command.Run()
}

func activate(name string, data []byte, deadline time.Time) (response, error) {
	if err := validate(data); err != nil {
		return response{}, err
	}
	path := filepath.Join(live, name+".json")
	marker := filepath.Join(live, name+".source")
	file, err := lock(path+".lock", deadline)
	if err != nil {
		return response{}, err
	}
	defer file.Close()
	type savedFile struct {
		path   string
		data   []byte
		exists bool
	}
	previous := []savedFile{}
	for _, target := range []string{path, marker, pointer} {
		old, exists, err := readFile(target, maxProfile)
		if err != nil {
			return response{}, err
		}
		previous = append(previous, savedFile{target, old, exists})
	}
	wasRunning := service("running", time.Second) == nil
	if wasRunning {
		if err := service("stop", 6*time.Second); err != nil {
			return response{}, errors.New("cannot stop the current client; profile was not switched")
		}
	}
	for _, target := range []struct {
		path   string
		data   []byte
		backup bool
	}{
		{path, data, true}, {marker, []byte(hash(data) + "\n"), false}, {pointer, []byte(name + "\n"), false},
	} {
		if err := writeFile(target.path, target.data, target.backup); err != nil {
			recovered := true
			for _, old := range previous {
				if old.exists {
					if writeFile(old.path, old.data, false) != nil {
						recovered = false
					}
				} else if err := os.Remove(old.path); err != nil && !errors.Is(err, os.ErrNotExist) {
					recovered = false
				}
			}
			file.Close()
			if wasRunning {
				_ = service("start", 4*time.Second)
			}
			if !recovered {
				return response{}, errors.New("apply failed and previous profile recovery is incomplete; inspect router storage")
			}
			return response{}, errors.New("apply failed; previous profile selector was restored")
		}
	}
	file.Close() // Renewal must be able to acquire the runtime file lock on start.
	result := response{OK: true, Name: name, Active: name, Exists: true, Revision: hash(data)}
	if err := service("start", 4*time.Second); err != nil {
		result.Warning = "profile applied, but client startup failed; check client settings and system log"
	}
	result.Running = service("running", time.Second) == nil
	return result, nil
}

// Remove only inactive entries. Stage the fixed set of private files together;
// a rename failure restores them before the library lock is released.
func deleteProfile(name string, deadline time.Time) (response, error) {
	file, err := lock(filepath.Join(live, name+".json.lock"), deadline)
	if err != nil {
		return response{}, err
	}
	defer file.Close()
	paths := []string{
		filepath.Join(drafts, name+".json"), filepath.Join(drafts, name+".json.bak"),
		filepath.Join(live, name+".json"), filepath.Join(live, name+".json.bak"),
		filepath.Join(live, name+".source"),
	}
	existing := []string{}
	for _, path := range paths {
		_, exists, err := readFile(path, maxProfile)
		if err != nil {
			return response{}, err
		}
		if exists {
			existing = append(existing, path)
		}
	}
	stage := filepath.Join(root, ".deleting-profile")
	if err := os.Mkdir(stage, 0700); err != nil {
		return response{}, errors.New("cannot stage deletion; check storage or recover an earlier interrupted deletion")
	}
	manifest, err := json.Marshal(existing)
	if err != nil {
		os.Remove(stage)
		return response{}, err
	}
	if err := writeFile(filepath.Join(stage, "manifest.json"), manifest, false); err != nil {
		os.Remove(stage)
		return response{}, err
	}
	for i, path := range existing {
		if err := os.Rename(path, filepath.Join(stage, fmt.Sprint(i))); err != nil {
			recovered := true
			for j := i - 1; j >= 0; j-- {
				if os.Rename(filepath.Join(stage, fmt.Sprint(j)), existing[j]) != nil {
					recovered = false
				}
			}
			if recovered {
				os.Remove(filepath.Join(stage, "manifest.json"))
				os.Remove(stage)
				return response{}, errors.New("deletion failed; profile files were restored")
			}
			return response{}, errors.New("deletion interrupted; recover private files using .deleting-profile/manifest.json")
		}
	}
	result := response{OK: true, Name: name}
	for _, path := range []string{drafts, live, root} {
		directory, err := os.Open(path)
		if err == nil {
			err = directory.Sync()
			directory.Close()
		}
		if err != nil {
			result.Warning = "profile removed, but directory durability sync failed"
		}
	}
	clean := true
	for i := range existing {
		if os.Remove(filepath.Join(stage, fmt.Sprint(i))) != nil {
			clean = false
		}
	}
	if clean {
		if os.Remove(filepath.Join(stage, "manifest.json")) != nil || os.Remove(stage) != nil {
			clean = false
		}
	}
	if !clean {
		result.Warning = "profile removed, but private deletion staging needs administrator cleanup"
	}
	return result, nil
}

func execute() (response, error) {
	if len(os.Args) != 2 {
		return response{}, errors.New("expected list, read, save, apply, delete, check or active-path")
	}
	operation := os.Args[1]
	if operation != "list" && operation != "read" && operation != "save" && operation != "apply" && operation != "delete" {
		return response{}, errors.New("unsupported profile operation")
	}
	var input request
	if operation != "list" {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequest+1))
		if err != nil || len(data) > maxRequest {
			return response{}, errors.New("request exceeds 512 KiB")
		}
		if len(bytes.TrimSpace(data)) == 0 {
			data = []byte("{}")
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			return response{}, errors.New("invalid profile request")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return response{}, errors.New("request contains trailing data")
		}
	}
	if err := directory(root, false); err != nil {
		return response{}, err
	}
	deadline := time.Now().Add(3 * time.Second)
	file, err := lock(root+"/profiles.lock", deadline)
	if err != nil {
		return response{}, err
	}
	defer file.Close()
	if err := initialize(deadline); err != nil {
		return response{}, err
	}
	active, selected, err := applied()
	if err != nil {
		return response{}, err
	}
	all, err := names()
	if err != nil {
		return response{}, err
	}
	if err := synchronize(all, active, selected, deadline); err != nil {
		return response{}, err
	}
	if operation == "list" {
		result := response{OK: true, Active: active, Profiles: []entry{}}
		for _, name := range all {
			data, _, err := readFile(filepath.Join(drafts, name+".json"), maxProfile)
			if err != nil {
				return response{}, err
			}
			revision, err := sourceRevision(name)
			if err != nil {
				return response{}, err
			}
			result.Profiles = append(result.Profiles, entry{Name: name, Revision: hash(data), Pending: hash(data) != revision})
		}
		return result, nil
	}
	if input.Name == "" {
		input.Name = active
	}
	if !validName(input.Name) {
		return response{}, errors.New("name must contain 1–48 letters or digits, with optional underscores or hyphens; start with a letter or digit")
	}
	path := filepath.Join(drafts, input.Name+".json")
	data, exists, err := readFile(path, maxProfile)
	if err != nil {
		return response{}, err
	}
	revision := ""
	if exists {
		revision = hash(data)
	}
	if operation == "read" {
		return response{OK: true, Name: input.Name, Content: string(data), Exists: exists, Revision: revision, Active: active}, nil
	}
	if input.Revision != revision {
		return response{}, errors.New("profile changed since loading; refresh the list or reload the editor")
	}
	if operation == "delete" {
		if !exists {
			return response{}, errors.New("profile does not exist; refresh the list")
		}
		if input.Name == active {
			return response{}, errors.New("cannot delete the applied profile; apply a different profile first")
		}
		result, err := deleteProfile(input.Name, deadline)
		result.Active = active
		return result, err
	}
	if operation == "apply" {
		if !exists {
			return response{}, errors.New("save the named profile before applying it")
		}
		return activate(input.Name, data, deadline)
	}
	if len(input.Content) == 0 || len(input.Content) > maxProfile {
		return response{}, errors.New("profile must contain 1–65536 bytes")
	}
	if !exists && len(all) >= maxProfiles {
		return response{}, errors.New("profile library is limited to 32 profiles")
	}
	if err := validate([]byte(input.Content)); err != nil {
		return response{}, err
	}
	if err := writeFile(path, []byte(input.Content), true); err != nil {
		return response{}, err
	}
	return response{OK: true, Name: input.Name, Exists: true, Revision: hash([]byte(input.Content)), Active: active}, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "check" {
		if err := json.NewEncoder(os.Stdout).Encode(connectivity()); err != nil {
			fmt.Fprintln(os.Stderr, "cannot encode connectivity response")
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "active-path" {
		if err := directory(root, false); err != nil {
			fmt.Fprintln(os.Stderr, "invalid profile directory")
			os.Exit(1)
		}
		name, selected, err := applied()
		if err != nil {
			fmt.Fprintln(os.Stderr, "invalid profile selector")
			os.Exit(1)
		}
		if !selected {
			fmt.Println(legacy)
			return
		}
		if err := directory(live, false); err != nil {
			fmt.Fprintln(os.Stderr, "invalid runtime profile directory")
			os.Exit(1)
		}
		fmt.Println(filepath.Join(live, name+".json"))
		return
	}
	result, err := execute()
	if err != nil {
		result = response{OK: false, Error: err.Error()}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, "cannot encode profile response")
		os.Exit(1)
	}
}
