# 开发包验证记录

日期：2026-10-22。不是正式发布或性能资格证明。

## 构建

- 传输源码提交：`02f04f5fb0e45458becbe19470cebc71953cb72f`，已跟踪源码干净。
- Go 1.26.9、`CGO_ENABLED=0`、`linux/arm64`。
- OpenWrt APKv3；主包架构 `aarch64_cortex-a53`，LuCI 包 `noarch`。
- 固定构建时间 `SOURCE_DATE_EPOCH=1792627200`。
- 本地未签名开发包，具体文件及 SHA-256 见 `dist/SHA256SUMS`。

## 已完成

- ImmortalWrt 25.12.1，Redmi AX6 stock layout：包完整性校验、模拟安装、
  从手工部署迁移及后续 APK 升级；包管理器确认核心与 helper 文件归属。
- 迁移前在设备本地备份旧可执行文件和启动脚本；原设备配置保持 mode 0600，
  配置内容校验值保持不变。未将私钥复制到开发仓库。
- SOCKS5 访问 `https://example.com/`，安装前后均返回 HTTP 200；指标接口可读。
- LuCI 登录、页面加载、停止、启动、配置保存应用；后端启动参数确实随 UCI
  改变，并恢复正常设置。
- 配置编辑器读取现有 JSON；对现有有效配置执行保存及保存后重启；内容未变。
  旧修订号保存请求被拒绝。
- JavaScript、ACL/menu JSON、shell 语法检查；helper 的 gofmt 与 Go vet。
- 以下上游现有检查通过，未新增测试文件或测试用例：

```sh
go test -short -p=1 -timeout 5m ./cmd/queqiaod ./cmd/queqiaopack ./internal/identity
go vet ./cmd/queqiaod ./cmd/queqiaopack
```

helper 的 vet 使用与构建相同的 Go source overlay，目标为 Linux arm64。
Windows 上首次在受限沙箱运行时，本地网络与临时文件权限导致失败；正常权限
下串行重跑通过。CLI 包最初未串行运行也遇到回环端口复用问题，串行重跑通过。

## 未验证或不适用

- 未向有效设备配置提交空对象等破坏性载荷。非法配置校验使用上游已有
  identity 测试和代码检查；实机冲突请求在写入前被拒绝。
- 未重启整台路由器，未运行长时间 soak、吞吐比较或内存压力测试。
- 未验证其他架构、旧 opkg 系统或完整 SDK/feed 构建。
- 未跑整个仓库的完整测试、race/fuzz、Python 脚本集、全局 staticcheck 或六目标
  正式发布流水线；传输源码没有因本次打包而修改。
- 上游 `scripts/validate_release.py` 对 APK 目录报不支持其文件集合：该工具只
  校验六平台 tar/zip 正式发布集合，不能把本开发包标成该发布检查通过。

协议仍为 version 1。配置编辑使用独立 ACL、固定路径、尺寸上限、核心身份
校验、共享续期锁、修订号比较、私有备份和原子替换。`GOMEMLIMIT` 为软目标，
不承诺进程 RSS 上限。本次只证明所列设备上的安装和功能流程。
