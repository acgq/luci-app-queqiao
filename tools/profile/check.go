package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type checkResult struct {
	OK        bool   `json:"ok"`
	Reachable bool   `json:"reachable"`
	Target    string `json:"target"`
	Status    int    `json:"http_status,omitempty"`
	ElapsedMS int64  `json:"elapsed_ms"`
	ExitIP    string `json:"exit_ip,omitempty"`
	Error     string `json:"error,omitempty"`
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 64<<10 {
		return 0, errors.New("service response exceeds limit")
	}
	return b.Buffer.Write(data)
}

// Inspect the applied listener, including when UCI contains unapplied edits.
func runningListener(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/bin/ubus", "call", "service", "list", `{"name":"queqiao"}`)
	var output boundedOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return "", errors.New("无法读取当前运行的代理服务")
	}
	var services map[string]struct {
		Instances map[string]struct {
			Running bool     `json:"running"`
			Command []string `json:"command"`
		} `json:"instances"`
	}
	if err := json.Unmarshal(output.Bytes(), &services); err != nil {
		return "", errors.New("代理服务状态无效")
	}
	listener := ""
	running := 0
	for _, instance := range services["queqiao"].Instances {
		if !instance.Running {
			continue
		}
		running++
		if running > 1 {
			return "", errors.New("无法确定唯一的 Queqiao 客户端实例")
		}
		args := instance.Command
		if len(args) < 2 || args[0] != "/usr/bin/queqiaod" || args[1] != "client" {
			return "", errors.New("运行的服务不是预期的 Queqiao 客户端")
		}
		for i := 2; i+1 < len(args); i++ {
			if args[i] != "--listen" {
				continue
			}
			host, port, err := net.SplitHostPort(args[i+1])
			ip := net.ParseIP(host)
			number, portErr := strconv.Atoi(port)
			if ip != nil && ip.To4() != nil && ip.IsUnspecified() {
				for j := 2; j+1 < len(args); j++ {
					if args[j] == "--socks-lan-interface" && args[j+1] != "" {
						ip = net.ParseIP("127.0.0.1")
						break
					}
				}
			}
			if err != nil || ip == nil || !ip.IsLoopback() || portErr != nil || number < 1 || number > 65535 || listener != "" {
				return "", errors.New("无法确定唯一的本机 SOCKS5 监听地址")
			}
			listener = net.JoinHostPort(ip.String(), strconv.Itoa(number))
		}
	}
	if listener == "" {
		return "", errors.New("Queqiao 客户端尚未运行，请先应用并启动配置")
	}
	return listener, nil
}

func connectivity() (result checkResult) {
	var input struct {
		Target  string `json:"target"`
		Session string `json:"ubus_rpc_session,omitempty"`
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 1025))
	if err != nil || len(data) > 1024 {
		return checkResult{Error: "检查请求无效或超过 1 KiB"}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return checkResult{Error: "检查请求无效"}
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return checkResult{Error: "检查请求包含多余数据"}
	}
	target := ""
	switch input.Target {
	case "ip_sb":
		target = "https://api.ip.sb/ip"
	case "google":
		target = "https://www.google.com/generate_204"
	default:
		return checkResult{Error: "仅支持 ip.sb 和 Google 两个预设目标"}
	}
	result = checkResult{Target: target}
	guard, err := lock("/var/run/queqiao-connectivity.lock", time.Now())
	if err != nil {
		result.Error = "已有连通性检查正在进行，请稍后重试"
		return result
	}
	defer guard.Close()
	started := time.Now()
	defer func() { result.ElapsedMS = time.Since(started).Milliseconds() }()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	listener, err := runningListener(ctx)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	transport := &http.Transport{
		Proxy:                  http.ProxyURL(&url.URL{Scheme: "socks5h", Host: listener}),
		DialContext:            (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSHandshakeTimeout:    8 * time.Second,
		ResponseHeaderTimeout:  12 * time.Second,
		MaxResponseHeaderBytes: 16 << 10,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxConnsPerHost:        1,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		result.Error = "无法创建检查请求"
		return result
	}
	request.Header.Set("User-Agent", "Queqiao-LuCI-Connectivity/0.4")
	response, err := client.Do(request)
	result.ElapsedMS = time.Since(started).Milliseconds()
	if err != nil {
		if ctx.Err() != nil {
			result.Error = "代理请求超时（最长 15 秒）"
		} else {
			result.Error = "代理请求失败：" + err.Error()
		}
		return result
	}
	defer response.Body.Close()
	result.Reachable = true
	result.Status = response.StatusCode
	if input.Target == "google" && response.StatusCode == http.StatusNoContent {
		result.OK = true
		return result
	}
	if input.Target == "ip_sb" && response.StatusCode == http.StatusOK {
		body, err := io.ReadAll(io.LimitReader(response.Body, 129))
		result.ElapsedMS = time.Since(started).Milliseconds()
		if err != nil || len(body) > 128 {
			result.Error = "目标可达，但出口 IP 响应读取失败"
			return result
		}
		ip := net.ParseIP(strings.TrimSpace(string(body)))
		if ip == nil {
			result.Error = "目标可达，但返回内容不是有效的出口 IP"
			return result
		}
		result.OK = true
		result.ExitIP = ip.String()
		return result
	}
	result.Error = fmt.Sprintf("目标已返回 HTTP %d，但未满足预期响应；可能是目标站点拒绝访问", response.StatusCode)
	return result
}
