# Queqiao for OpenWrt

Queqiao 的 OpenWrt APK 打包与 LuCI 管理页面，独立于传输核心仓库维护。
目前针对 **OpenWrt / ImmortalWrt 25.12、aarch64_cortex-a53** 提供开发包。
已在 Redmi AX6（stock layout）上完成安装及 SOCKS5 HTTPS 连通性验证。
其他架构、旧版 opkg 固件、重启恢复和长期负载尚未验证。

## 功能

- `queqiao`：静态 Linux arm64 主程序、procd 服务、UCI 配置。
- `luci-app-queqiao`：服务状态、启停、保存应用、开机启动、出口设备、
  QUIC/TLS-TCP 模式、本地端口、并发上限、内存软目标及日志级别。
- SOCKS5 和指标接口固定监听 `127.0.0.1`，供路由器本机 mihomo 等程序使用。
- 设备配置 JSON 可在 LuCI 中导入、编辑、保存，或保存后重启。
- 私钥只在主动打开编辑器时通过受授权的 RPC 读取；管理权限单独由
  `luci-app-queqiao-profile` ACL 控制，普通服务管理 ACL 不授予私钥访问。

这是开发预览。未修改 Queqiao 协议，仍使用 wire version 1。代理连通性
通过不等于吞吐、稳定性或所有 OpenWrt 平台已获验证。上游限制见
[Queqiao 状态](https://github.com/bojieli/queqiao/blob/main/docs/STATUS.md)。

## 安装

先检查设备架构为 `aarch64_cortex-a53`。将两个 APK 复制到路由器 `/tmp`，
核对 `SHA256SUMS` 后安装对应的实际文件名：

```sh
apk add --allow-untrusted --no-network /tmp/queqiao-<version>.apk \
  /tmp/luci-app-queqiao-<version>.apk
```

这些是**未签名的本地开发包**，`--allow-untrusted` 只用于这次显式安装；
不要全局关闭签名校验。全新安装默认不启动客户端。

已有手工安装时，先在路由器本地备份 `/usr/bin/queqiaod`、
`/etc/init.d/queqiao` 和已有 `/etc/config/queqiao`。apk 会保留部分已有文件，
将包内版本写成 `.apk-new`：比较后采用新的启动脚本，并在 UCI 中迁移原有
出口设备、端口及启用状态。不要直接用默认 UCI 覆盖正在使用的配置。
避免下载或公开现有设备私钥。

通过 SSH 注册邀请，或安全地安装已有配置：

```sh
umask 077
mkdir -p /etc/queqiao
chmod 700 /etc/queqiao
queqiaod enroll --profile /etc/queqiao/router.json --device openwrt \
  'queqiao://enroll/REPLACE_WITH_YOUR_PRIVATE_INVITATION'
chmod 600 /etc/queqiao/router.json
```

邀请是敏感的一次性凭据，建议关闭 shell 历史后输入，使用后清理。
不要把邀请或配置文件提交到 Git。

LuCI 中打开 **服务 → Queqiao**，设置出口设备（`auto` 或 `if:wan` 等实际
Linux 设备名），勾选启用客户端并保存应用。命令行等价操作：

```sh
uci set queqiao.main.enabled='1'
uci set queqiao.main.local_address='if:wan'
uci commit queqiao
/etc/init.d/queqiao enable
/etc/init.d/queqiao restart
```

“停止”只停止当前进程；取消启用并保存应用同时关闭开机启动。启用标志为 0
时，“启动”不会运行客户端。邀请注册通过 SSH 完成；已有配置可通过页面的 Edit device profile 导入或编辑。
这两个包不配置透明代理、DNS 或防火墙；继续使用现有路由客户端的 SOCKS 出站。

## 设备配置编辑

点击 **Edit device profile** 主动加载 `/etc/queqiao/router.json`。编辑器包含
设备私钥，因此不要分享编辑器截图或把内容复制到公共渠道。可以粘贴已有的
有效配置，选择 **Save profile** 仅保存，或 **Save and restart** 保存后重启。

后端使用独立的 Go helper，链接所选传输源码的 `identity.LoadClientProfile`，
完整检查严格 JSON、协议配置版本、端点、证书有效期、私钥匹配和身份绑定。
无效配置不会覆盖现有文件。helper 固定只读写这一条路径，拒绝符号链接和
宽松文件权限；配置上限 64 KiB，RPC 保存请求上限 512 KiB。

保存时使用与核心自动续期相同的 flock 文件，等待最多 3 秒。SHA-256 修订号
防止编辑器覆盖加载后发生的变更；冲突时关闭并重新打开编辑器。写入采用
同目录 mode-0600 临时文件、文件同步和原子替换；已有文件变化时保留一份
同样私有的 `router.json.bak`，不将私钥放入命令行参数、日志或 Git。
编辑器读取不要求配置当前有效，允许修复损坏或过期的配置；保存必须有效。

helper 通过 Go `-overlay` 使用上游内部校验代码，无需修改传输源码。
`BUILDINFO.json` 同时记录 helper 二进制及源码摘要。

## 资源边界

默认同时最多 256 个会话、64 个待打开请求、4096 个文件描述符；界面允许
将会话上限设为 1–4096。日志写入 RAM `/tmp/queqiao`，单文件约 1 MiB，
保留一个轮转备份（单条日志写入可能使文件略超阈值）。procd 在 3600 秒内
最多重启 5 次，重启间隔 5 秒。

`GOMEMLIMIT=64MiB`、`GOGC=50` 用于降低路由器内存压力。内存值是 Go 的
**软目标**，不限制进程总 RSS；不能据此承诺固定内存占用或吞吐。
指标默认关闭，启用后也只监听回环地址。

## 从源码构建 APK

使用传输源码 `go.mod` 指定的 Go 工具链（当前 1.26.9）和 Python 3.10+。
需要 Linux `apk mkpkg`（apk-tools 3.x，包含打包 applet）；可使用 Alpine
官方 `apk-tools-static`。Windows 通过 WSL 调用该工具，Linux 可用 root 或
fakeroot，确保包内文件属于 UID/GID 0。

Windows PowerShell 示例；所有路径换成自己的绝对路径：

```powershell
python scripts/build.py --source C:/code/queqiao `
  --apk-tool /path/in/wsl/to/apk.static --wsl Ubuntu-22.04
```

Linux 示例：

```sh
fakeroot python3 scripts/build.py --source ../queqiao --apk-tool /usr/bin/apk
```

`dist/` 包含两个 APK、校验和、静态可执行文件、模块图及 `BUILDINFO.json`。
默认构建时间取源提交时间，可用 `--epoch` 固定。构建记录源提交、工作区
是否有修改、源码摘要、Go 版本、目标、模块文件摘要和二进制摘要；编译期间
源码或 HEAD 变化会报错。源码应来自可信 checkout；未跟踪源码不应参与正式
构建。相同源码、打包脚本、apk 工具和 epoch 才具有相同重现条件。
包内附带上游及依赖许可证。`dist/` 不提交 Git。

上游 `scripts/validate_release.py` 验证六个平台的官方 tar/zip 发布集合，
尚不识别本仓库的 OpenWrt APK，因此本开发包使用 `apk verify`、模拟安装、
实机安装和文件摘要进行验证，不能将其标为上游正式发布验证通过。

## OpenWrt SDK/feed

本仓库含两个 feed 包目录：`queqiao/` 与 `luci-app-queqiao/`。
将仓库加入 SDK 的 `feeds.conf.default`，执行 feeds update/install，再选中
`queqiao` 和 `luci-app-queqiao`。核心包使用预构建的静态 Linux arm64 文件，
默认 `dist/queqiaod`，可通过 `QUEQIAO_BINARY` 显式指定；必须与目标架构一致。
当前 feed Makefile 是开发入口，完整 SDK 构建尚未验证。

## 开发与回滚

传输核心仓库：[acgq/queqiao](https://github.com/acgq/queqiao)。
LuCI 使用原生 JavaScript view、UCI、有限方法的 rpcd 插件及最小 ACL。
新增设置应同步更新启动脚本的取值校验，避免增加任意命令执行或私钥读取接口。

只回滚软件包时安装保留的旧 APK；从手工部署迁移时，先停止服务、卸载两个包，
再从路由器本地备份恢复旧程序和旧启动脚本，并恢复原来的启用状态。卸载不应
删除 `/etc/queqiao/router.json`，但任何回滚前均应确认设备配置仍安全保留。
备份内若含配置或密钥，只能留在受保护的路由器目录，不要公开。

协议兼容性和认证由上游核心负责；本仓库不改变认证或网络协议。
