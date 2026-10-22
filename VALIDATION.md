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

## 0.3 多配置变更

- 新的 Linux arm64 helper 构建、Go vet、JavaScript/JSON 与设备 shell 语法
  检查通过。使用同一传输源码提交；未增加或修改测试文件、测试用例。
- 主包升级至 r5，LuCI 升级至 0.3.0-r1，设备包完整性验证及安装成功。
- 原始私有配置校验值保持不变，服务继续运行，旧文件自动迁入命名配置库。
- 在浏览器复制现有配置为另一份并保存成功；列表已有两份，选择为新副本时，
  当前应用标记仍为原配置，证明页面把草稿选择与应用操作分开。
- 经用户确认，在浏览器手动应用第二份配置，再切回原配置，两次操作均成功；
  运行路径与应用名称一致，两份配置实际代理 HTTPS 均返回 HTTP 200。
- 在当前应用配置的草稿中增加一个空白换行并保存，客户端 PID 和运行副本
  摘要均保持不变，列表正确标记未应用修改；随后恢复草稿，标记恢复正常。
- 所有草稿、运行副本和选择文件均为 mode 0600，两个私有目录为 mode 0700。
- 应用失败恢复和自动续期同步的完整实机流程尚未验证；没有把这些检查标为通过。

配置库与运行副本分离，原协议、回环监听和全局资源参数未改变；新增 32 份
配置及各份 64 KiB 的边界。整机重启、长期负载、其他架构、SDK 与正式发布
流水线仍未验证。

## 0.4 连通检查、配置删除与 LAN 入口

日期：2026-10-23。传输基线提交
`5b1ab4111149d354c81ff72c3066e174c15f9f9c`；Go 1.26.9。
主包为 `0.10.0_git1792688400-r7`，LuCI 为 `0.4.0-r2`。

- Google HTTPS 检查返回 HTTP 204，ip.sb 官方 IP API 返回 HTTP 200；页面能显示
  Google 检查结果。出口 IP 没有写入此公开记录。
- LAN 模式从局域网电脑实际执行 SOCKS5 HTTPS 成功；UDP ASSOCIATE 返回 LAN
  地址，随后通过 UDP 中继收到有效 DNS 响应。
- 从 LAN 电脑定向连接路由器自身 WAN IPv4，未获得 SOCKS 协商；这不是从真实
  外部 WAN 设备发起的独立验证，不能替代外围防火墙和多网络验证。
- 测试后恢复原监听范围，当前应用名称与所有原有配置内容保持不变。
- 仅用一个不含私钥、从未应用的临时空配置验证删除：旧修订号被拒绝；正确
  修订号删除成功，暂存数据清理完成。浏览器检查确认窗口并取消，没有删除
  用户已有配置。当前应用配置的删除保护仅做代码检查，未进行实机删除尝试。
- 新增 helper 与 LAN 补丁的 Go vet、JavaScript/JSON、设备 shell 语法检查通过。
  以下现有短测试使用构建同样的 core overlay，通过且未新增测试用例：

```sh
go test -short -p=1 -timeout 10m -overlay dist/core-overlay.json \
  ./cmd/queqiaod ./internal/pep ./internal/socks5
```

- LAN 补丁下的 `queqiaod` 对 Linux、macOS、Windows 的 amd64/arm64 六目标编译
  均通过；未将编译成功当成这些平台上的运行资格证明。
- APK 完整性验证、安装和配置保留检查通过；包内加入 `ca-bundle` 依赖。
  打包目录统一使用 POSIX 路径，修正 Windows 下目录分隔符的问题。

没有运行 race（本机没有可用 CGO C 编译器）、全库测试、完整发布校验、整机
重启、长期负载、LAN IPv6 或多 VLAN 验证。删除失败恢复/掉电恢复仍未实机
验证。协议和网关认证保持 version 1；LAN 是显式的无 SOCKS 密码入口，按所选
LAN 接口的本地 IPv4 与来源子网限制访问，默认仍为回环。

页面包依赖主包的 `queqiao-luci-api-v4` 能力标记。旧后端下单独升级页面的模拟
安装被依赖检查拒绝；匹配的两个最终包安装成功，Google 检查继续返回 HTTP 204。
