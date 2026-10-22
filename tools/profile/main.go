// Queqiao profile editor helper. Built against the selected transport checkout
// using a Go source overlay so its identity validation stays identical.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/bojieli/queqiao/internal/identity"
	"golang.org/x/sys/unix"
)

const (
	profilePath = "/etc/queqiao/router.json"
	maxProfile  = 64 << 10
	maxRequest  = 512 << 10
)

type response struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	Content  string `json:"content,omitempty"`
	Revision string `json:"revision"`
	Exists   bool   `json:"exists"`
	Warning  string `json:"warning,omitempty"`
}

func hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func lock() (*os.File, error) {
	parent, err := os.Lstat(filepath.Dir(profilePath))
	if err != nil || !parent.IsDir() || parent.Mode().Perm()&0077 != 0 {
		return nil, errors.New("profile directory must be a private regular directory (mode 0700)")
	}
	fd, err := unix.Open(profilePath+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, errors.New("cannot open profile lock")
	}
	file := os.NewFile(uintptr(fd), "profile lock")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("profile lock must be a regular file")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return file, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) || time.Now().After(deadline) {
			file.Close()
			return nil, errors.New("profile is busy; retry after renewal finishes")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func read() ([]byte, bool, error) {
	fd, err := unix.Open(profilePath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errors.New("cannot open regular profile file")
	}
	file := os.NewFile(uintptr(fd), "profile")
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, false, errors.New("profile must be a private regular file (mode 0600)")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxProfile+1))
	if err != nil || len(data) > maxProfile {
		return nil, false, errors.New("profile read failed or exceeds 64 KiB")
	}
	return data, true, nil
}

func temporary(data []byte) (string, error) {
	file, err := os.CreateTemp(filepath.Dir(profilePath), ".luci-profile-*")
	if err != nil {
		return "", errors.New("cannot create private temporary profile")
	}
	name := file.Name()
	remove := true
	defer func() {
		file.Close()
		if remove {
			os.Remove(name)
		}
	}()
	if _, err = file.Write(data); err != nil {
		return "", errors.New("cannot write profile; check available storage")
	}
	if err = file.Sync(); err != nil {
		return "", errors.New("cannot sync profile to storage")
	}
	if err = file.Close(); err != nil {
		return "", errors.New("cannot close profile")
	}
	remove = false
	return name, nil
}

func execute() (response, error) {
	if len(os.Args) != 2 || os.Args[1] != "read" && os.Args[1] != "save" {
		return response{}, errors.New("expected read or save")
	}
	var request struct {
		Content  string `json:"content"`
		Revision string `json:"revision"`
		Session  string `json:"ubus_rpc_session,omitempty"`
	}
	if os.Args[1] == "save" {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequest+1))
		if err != nil || len(data) > maxRequest {
			return response{}, errors.New("save request exceeds 512 KiB")
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			return response{}, errors.New("invalid save request")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return response{}, errors.New("save request contains trailing data")
		}
		if len(request.Content) == 0 || len(request.Content) > maxProfile {
			return response{}, errors.New("profile must contain 1 to 65536 bytes")
		}
	}
	file, err := lock()
	if err != nil {
		return response{}, err
	}
	defer file.Close() // flock is also released on process termination.
	current, exists, err := read()
	if err != nil {
		return response{}, err
	}
	revision := ""
	if exists {
		revision = hash(current)
	}
	if os.Args[1] == "read" {
		return response{OK: true, Content: string(current), Exists: exists, Revision: revision}, nil
	}
	if request.Revision != revision {
		return response{}, errors.New("profile changed since loading; reload it before saving")
	}
	data := []byte(request.Content)
	name, err := temporary(data)
	if err != nil {
		return response{}, err
	}
	defer os.Remove(name)
	if _, err := identity.LoadClientProfile(name); err != nil {
		// Do not echo supplied keys, certificate text or arbitrary JSON fields.
		return response{}, errors.New("profile rejected: check JSON fields, version, endpoint, certificate validity, matching private key and pinned identity")
	}
	if bytes.Equal(current, data) {
		return response{OK: true, Exists: true, Revision: revision}, nil
	}
	if exists {
		backup, err := temporary(current)
		if err != nil {
			return response{}, err
		}
		defer os.Remove(backup)
		if err := os.Rename(backup, profilePath+".bak"); err != nil {
			return response{}, errors.New("cannot save previous profile backup")
		}
	}
	if err := os.Rename(name, profilePath); err != nil {
		return response{}, errors.New("cannot atomically replace profile")
	}
	result := response{OK: true, Exists: true, Revision: hash(data)}
	directory, err := os.Open(filepath.Dir(profilePath))
	if err == nil {
		err = directory.Sync()
		directory.Close()
	}
	if err != nil {
		result.Warning = "profile saved, but directory durability sync failed"
	}
	return result, nil
}

func main() {
	result, err := execute()
	if err != nil {
		result = response{OK: false, Error: err.Error()}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, "cannot encode profile editor response")
		os.Exit(1)
	}
}
