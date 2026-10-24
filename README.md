# Queqiao for OpenWrt

Queqiao 的 OpenWrt APK 打包与 LuCI 管理页面，独立于传输核心仓库维护。
目前针对 **OpenWrt / ImmortalWrt 25.12、aarch64_cortex-a53** 提供开发包。
已在 Redmi AX6（stock layout）上完成安装及 SOCKS5 HTTPS 连通性验证。
其他架构、旧版 opkg 固件、重启恢复和长期负载尚未验证。

## 功能

- `queqiao`：静态 Linux arm64 主程序、procd 服务、UCI 配置。
- `luci-app-queqiao`：服务状态、启停、保存应用、开机启动、出口设备、
  QUIC/TLS-TCP 模式、本地端口、并发上限、内存软目标及日志级别。
- SOCKS5 默认仅限本机，可显式选择 LAN IPv4；指标接口始终仅限本机。
- 支持最多 32 份命名连接配置，可新建、复制、编辑、删除和选择。只有手动点击
  **应用所选配置** 才会切换客户端；选择和保存草稿不会影响正在使用的连接。
- 支持单份 JSON 导入导出、整个配置库备份，以及批量导入备份。
- 私钥只在主动打开编辑器或导出配置时通过受授权的 RPC 读取；管理权限单独由
  `luci-app-queqiao-profile` ACL 控制，普通服务管理 ACL 不授予私钥访问。

这是开发预览。未修改 Queqiao 协议，仍使用 wire version 1。代理连通性
通过不等于吞吐、稳定性或所有 OpenWrt 平台已获验证。上游限制见
[Queqiao 状态](https://github.com/bojieli/queqiao/blob/main/docs/STATUS.md)。

## 安装

本仓库的 [Releases](https://github.com/acgq/luci-app-queqiao/releases) 只提供 LuCI APK
和校验文件；主程序 APK 由独立仓库构建。请先安装兼容的后端包：除了
`queqiaod`，还需包含本仓库的 profile helper、procd/UCI 集成，并提供
`queqiao-luci-api-v4` 能力标记。单独的可执行文件不能满足页面依赖。

已有兼容后端时，只需安装页面包：

```sh
apk add --allow-untrusted --no-network /tmp/luci-app-queqiao-0.5.1-r2.apk
```

先检查设备架构为 `aarch64_cortex-a53`。将两个 APK 复制到路由器 `/tmp`，
核对 `SHA256SUMS` 后安装对应的实际文件名：

```sh
apk add --allow-untrusted --no-network /tmp/queqiao-<version>.apk \
  /tmp/luci-app-queqiao-<version>.apk
```

请同时安装匹配版本的主程序和页面包。页面依赖主包提供的 `queqiao-luci-api-v4`
能力标记，旧后端不满足该依赖时包管理器会拒绝页面单独升级。

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
时，“启动”不会运行客户端。邀请注册通过 SSH 完成；已有配置可通过配置库导入或编辑。
端口、出口设备和资源限制是全局客户端参数；页面底部的“保存并应用”只应用这些
参数，不会把配置库下拉框中尚未应用的选择切换为当前配置。
这两个包不配置透明代理、DNS 或防火墙；继续使用现有路由客户端的 SOCKS 出站。

## 配置库与手动应用

“导出全部”将配置库内所有已保存草稿（最多 32 份）、原名称和当前应用名称
下载为一个 JSON 备份，格式为 `queqiao-profile-library` version 1；每份 `content`
保留原始 JSON 文本，不丢失空白或未应用修改。导出前后核对配置列表及修订，
若期间有配置变化，整次导出报错，不下载残缺备份。运行副本、历史备份和 UCI
全局服务参数不在配置库备份内；当前应用名称只是参考，不会在恢复时自动应用。

“导入文件”也支持这个备份格式（最大 16 MiB、1–32 份；每份仍最多 64 KiB）。
载入后展示名称预览和新增/跳过数量。同名默认跳过，可输入统一前缀作为副本导入，
不会覆盖或删除原配置；新增后不能超过 32 份。导入前检查格式、版本、名称唯一性
和单份 JSON 结构，点击“导入备份草稿”后逐份通过现有后端身份校验再保存。
这是逐份导入而非全库原子替换：若部分失败，已成功的草稿会保留，界面会逐项列出
失败原因，修正后重试会跳过同名。始终需要手动应用才切换当前连接。

通过“导入文件”选择单个 UTF-8 JSON 文件（1–65536 字节），载入后可编辑名称和内容。
点击“保存配置”才会调用现有后端校验并创建草稿；同名配置会被拒绝，不会覆盖。
导入后仍需点击“应用所选配置”才会切换连接。无效 JSON 在浏览器中拒绝，不会上传。

“导出所选”下载为 `<配置名称>.json`，内容是配置库中已保存的草稿，可能包含尚未应用的修改；
不会导出编辑器中尚未保存的内容，也不会切换连接。导出复用现有配置读取权限，
无需扩大 RPC/文件权限。文件包含设备私钥，请存放到私有位置，不要上传到公开仓库。

在 **配置文件** 区域使用下拉框选择文件。可以新建配置，复制所选配置后另存，
或编辑已有配置。名称支持 1–48 个字母、汉字或数字，以及下划线、短横线；
名称须以字母、汉字或数字开头，UTF-8 编码总长度不超过 128 字节。

**选择、复制和保存只更新草稿库。** 点击 **应用所选配置** 才会校验并切换，
客户端会短暂停止并重新启动。页面单独显示当前应用的名称，并标记未应用修改。
编辑正在应用的同名配置也不会改动其运行副本。启用标志为 0 时可以应用文件，
但客户端仍保持停止，直到启用后启动。

连接配置 JSON 包含设备私钥。只有独立的 `luci-app-queqiao-profile` ACL 可以
读取、保存、应用和删除；普通服务管理 ACL 可以查看元数据及手动发起连通检查。不要分享编辑器
截图或把 JSON 复制到公共渠道。邀请注册仍使用 SSH，已有有效 JSON 可直接粘贴
到新建配置编辑器。

- 草稿：`/etc/queqiao/profiles/名称.json`。
- 应用后的运行副本：`/etc/queqiao/runtime/名称.json`。
- 当前应用的名称：`/etc/queqiao/active-profile`，重启服务时继续使用这一选择。
- 每个文件改写时最多保留一份私有 `.bak`。

从旧版本升级后，首次打开配置库会将现有 `router.json` 导入为 `router`，
原文件保持不变。在第一次手动应用之前，客户端继续使用旧路径；应用后切换
到指定名称的运行副本。未启用时新安装不会自动连接任何网关。

后端复用 `identity.LoadClientProfile` 检查严格 JSON、配置版本、端点、证书
有效期、私钥匹配和身份绑定。保存和应用都校验；每份 JSON 不超过 64 KiB，
每个 RPC 请求不超过 512 KiB。文件路径由受限名称构造，拒绝路径穿越、符号
链接和宽松权限；目录 mode 0700，文件 mode 0600。

配置库使用全局互斥锁，运行副本使用与核心续期相同的 flock 文件；一次请求
等待锁的时间预算为 3 秒。SHA-256 修订号防止覆盖加载后发生的修改。写入使用
同目录私有临时文件、文件同步和原子替换。应用时先校验，再停止客户端、准备
运行副本并更新选择；文件准备失败会尝试恢复原选择和文件。若配置已应用而
服务启动失败，页面明确报告启动失败，不把它伪装成代理连通性成功。

核心自动续期只写运行副本。打开或操作配置库时，helper 仅在对应草稿没有
未应用修改的情况下，将续期后的有效身份同步回草稿，并更新修订号；不会覆盖
用户正在准备的改动。已修改的草稿和长期未使用的配置仍须通过有效期校验。
编辑器可以读取无效草稿供修复，保存和应用必须有效。

helper 通过 Go `-overlay` 链接所选源码的身份校验器；LAN 入口补丁的应用方式见下文。
`BUILDINFO.json` 记录 helper 二进制及源码摘要。

## 资源边界

默认同时最多 256 个会话、64 个待打开请求、4096 个文件描述符；界面允许
将会话上限设为 1–4096。日志写入 RAM `/tmp/queqiao`，单文件约 1 MiB，
保留一个轮转备份（单条日志写入可能使文件略超阈值）。procd 在 3600 秒内
最多重启 5 次，重启间隔 5 秒。

`GOMEMLIMIT=64MiB`、`GOGC=50` 用于降低路由器内存压力。内存值是 Go 的
**软目标**，不限制进程总 RSS；不能据此承诺固定内存占用或吞吐。
指标默认关闭，启用后也只监听回环地址。

配置库最多 32 份，每份最多 64 KiB；含草稿、运行副本及各自一个备份时，
配置内容最多约 8 MiB，另有原始旧配置与文件系统元数据。删除过程最多额外暂存
一份配置及其备份；互斥锁文件不含私钥，保留以维持锁语义。

## 删除配置

选择不再需要的配置，点击 **删除所选** 并确认。后端在共享库锁与运行文件锁下
检查修订号，永久删除该名称的草稿、运行副本、修订标记及相关 `.bak`。
当前应用的配置不能删除；先手动应用另一份配置再删除。
旧版本遗留的原始 `/etc/queqiao/router.json` 不随命名库条目删除。

固定私有目录 `.deleting-profile` 用于分阶段移除；重命名阶段失败时尝试恢复。
如设备掉电或清理失败，目录内 `manifest.json` 记录原路径，后续删除会停止，
需要管理员先恢复或清理这一目录。不会递归删除用户指定的路径。

## 代理连通性检查

页面的 **代理连通性检查** 可选择 Google 或 ip.sb，再点击检查。请求从路由器
通过当前运行实例的 SOCKS5 端口发出，域名交给代理解析，不读取尚未应用的端口
设置，也不直连回退。Google 使用 HTTPS `generate_204`，ip.sb 使用
[官方出口 IP 接口](https://ip.sb/api/)，均验证系统 CA 和主机名。

显示 HTTP 状态、总耗时和 ip.sb 返回的出口 IP。目标返回 403、重定向等响应时
会区分“目标可达”与“符合预期响应”，不能因此直接断言代理失效。检查不代表
全部站点或 UDP 连通。仅手动触发，最多一个检查、15 秒总预算，检查请求最多
1 KiB、HTTP 头最多 16 KiB、IP 响应最多 128 字节；不跟随重定向。

## 本机或局域网监听

**SOCKS5 监听范围** 默认为仅本机 `127.0.0.1`；可选择所有 LAN IPv4 地址。
LAN 模式通过 netifd 的 `lan` 网络确定实际接口，绑定 IPv4 通配地址，并在
SOCKS 协商前检查目标 IP 属于该 LAN 接口、来源 IP 属于其子网；本机回环访问
继续可用。LAN 内可达设备均可使用此代理，没有新增 SOCKS 密码认证。
WAN 地址及子网外来源会被拒绝，不会添加 WAN 防火墙放行规则。

UDP ASSOCIATE 返回对应 LAN 地址，且只接受 TCP 控制连接来源 IP 的数据报。
指标接口始终只监听回环。此版本的 LAN 入口仅覆盖 IPv4；多 VLAN/其他逻辑
网络需要各自明确的入口策略，目前不自动纳入。

LAN 能力随 `patches/100-lan-ingress.patch` 构建，默认回环行为保持原样。
构建器先在私有输出副本中严格检查补丁，再通过 Go overlay 构建，记录补丁摘要；
不会改写所选传输 checkout。补丁不改变 Queqiao 帧、ALPN 或网关认证，仍为协议 1。

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
删除 `/etc/queqiao/` 下的私有配置，但任何回滚前均应确认这些文件安全保留。
降级到单配置版本前，先停止服务，使用 `queqiao-profile active-path` 确认实际
运行副本，并将需要保留的那份安全复制回 `/etc/queqiao/router.json`。原始旧路径
在第一次切换后可能已经不是当前配置，不要直接把它当作最新身份。
备份内若含配置或密钥，只能留在受保护的路由器目录，不要公开。

协议兼容性和认证由上游核心负责；本仓库不改变网关认证或 Queqiao 网络协议；LAN 入口访问范围由显式选项控制。

## Actions 构建

在 **OpenWrt APK packages** 工作流手动填入 `acgq/queqiao` 的完整 40 位
提交 SHA。工作流从该提交构建，应用本仓库的 LAN 入口补丁，使用固定版本和
SHA256 的 apk-tools 生成 `aarch64_cortex-a53` 核心包及 noarch LuCI 包。
下载同次运行的 APK、SHA256SUMS、BUILDINFO.json 和模块记录，先核对校验和。
这些仍是未签名的开发包，不会自动发布 Release 或安装到路由器。
