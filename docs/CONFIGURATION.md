# 配置、认证与操作边界

本说明适用于 `confluence-rest-mcp` 1.0.x。首次接入按[快速开始](../README.md#快速开始)操作；本页说明高级配置和失败处理。

## 个人状态

- macOS／Linux：`~/.confluence-mcp/.local/`。
- Windows：`%LOCALAPPDATA%\ConfluenceMCP\.local\`。

路径独立于当前工作目录、npx 缓存和包版本。程序只读加载非敏感配置，安装和启动不改写个人文件：

- `settings.json`：站点地址 `base_url`。兼容保留 `extension_origin`／`transport` 字段，运行认证模式为 Basic。
- `auth.json`：认证模式 `mode` 和本机写入开关 `allow_write`。
- `policy.json`：`enabled_tools` 和 `write_spaces`。

环境变量优先于文件中的站点地址和认证模式。配置文件的未知字段、符号链接、超过 64 KiB 的文件或非法 JSON 对象会被拒绝。

## 系统凭据库认证

`CONFLUENCE_CREDENTIAL_SOURCE=keyring` 为默认来源。macOS 使用 Keychain，Windows 使用 Credential Manager；Linux 的系统凭据库入口未实现，应使用环境变量来源。

```sh
npx -y confluence-rest-mcp@1.0.1 login --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.1 whoami --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.1 logout --base-url https://confluence.example.com/confluence
```

`login` 要求交互 TTY，隐藏输入并验证身份，成功后保存。`logout` 仅删除本站点的产品凭据；重复注销安全，不影响浏览器登录。系统凭据以规范化站点隔离，复用旧版 service／account 和 JSON 记录。

macOS 凭据读取使用有期限的私有 IPC 子进程。Windows 使用系统 Windows PowerShell 5.1 和 WinCred API，通过有期限的私有 stdin／stdout 管道传递；不需要安装额外凭据工具。企业策略禁用 PowerShell／Add-Type 时明确失败，不切换来源或修改策略。

Windows 每次保存使用一次 CredWrite 替换完整 UTF-16LE JSON，拒绝超过 2,560 字节的记录及目标归属冲突。保存和删除由按用户 SID／站点隔离的 Global 锁协调，操作前复核目标归属、时间戳、长度和自有记录指纹。注销先清旧碰撞项，再清主记录，保留其他 account 的记录。

外部程序和系统 UI 不参与该锁，WinCred 也没有条件写／删除 API；最后复核与操作之间仍有竞态。两个目标的删除不构成事务，后续失败不恢复已删除的旧碰撞项。超时或进程中断后应先检查状态，不自动重试。平台适用范围见[环境要求](../README.md#环境要求)。

## 环境变量认证

使用 `CONFLUENCE_CREDENTIAL_SOURCE=env`，由受信任的宿主环境成对注入 `CONFLUENCE_USERNAME` 和 `CONFLUENCE_PASSWORD`。该来源适用于 Linux 或无法使用系统凭据库的运行环境。

示例仅声明来源和非敏感配置；账号密码由环境或秘密管理系统提供：

```json
{
  "CONFLUENCE_BASE_URL": "https://confluence.example.com/confluence",
  "CONFLUENCE_AUTH_MODE": "basic",
  "CONFLUENCE_CREDENTIAL_SOURCE": "env",
  "CONFLUENCE_READ_ONLY": "true"
}
```

程序不自动加载 `.env`，来源失败不自动回退，env 来源不写系统凭据库。`login` 只用于 keyring 来源。客户端 JSON 的 `env` 可能把值保存到配置文件；把账号密码填入其中会形成明文文件。不同客户端的变量引用语法以其说明为准。

## 工具与写空间策略

未配置 `enabled_tools` 时暴露完整的 19 个工具；空数组隐藏全部工具，禁用工具的直接调用返回 `TOOL_DISABLED`。写空间须为实际 Confluence 空间 key，重复、未知字段／工具、非法类型和空间通配符被拒绝。

仅阅读时使用客户端的 `CONFLUENCE_READ_ONLY=true`，按需限制工具。需要受控写入时，在个人状态目录配置：

`auth.json`：

```json
{
  "mode": "basic",
  "allow_write": true
}
```

`policy.json`：

```json
{
  "enabled_tools": ["get_page", "search_pages", "get_attachments", "update_page"],
  "write_spaces": ["TEAM_DOCS"]
}
```

并将客户端的 `CONFLUENCE_READ_ONLY` 设为 `false` 后重载。该环境变量不能独立打开本机写入开关；`true` 始终禁止真实写入。所有开关同时生效，空间白名单不会提升服务端权限。

1. 新鲜读取目标正文、空间和版本。
2. 使用 `dry_run=true` 获取完整预览，包括目标、正文／标题变化、payload、版本和 `preview_hash`。
3. 审查预览并授权具体目标及内容。
4. 使用相同参数、`dry_run=false` 和返回的 `preview_hash` 提交；目标或内容变化时重新预览。
5. 遇到 `VERSION_CONFLICT` 或 `WRITE_UNCERTAIN`，先读回实际状态，冲突和不确定写入不自动重试。

`preview_hash` 检测目标／payload 变化，不构成操作授权。未配置 `write_spaces` 时可兼容预览并返回 `write_scope_configured=false`，真实提交返回 `WRITE_SCOPE_REQUIRED`；显式空数组的预览返回 `SPACE_NOT_ALLOWED`，提交返回 `WRITE_SCOPE_REQUIRED`。

更新只针对已发布 page 的标题和 storage。`patch_page` 的替换目标须为唯一完整顶层普通块；宏或嵌套目标使用完整 storage 更新预览。复制、移动、标签、评论和附件的范围及并发边界见[协作工具说明](COLLABORATION.md)。

## 操作审计

设置 `CONFLUENCE_AUDIT=true` 后重载 MCP，使用 `false` 关闭；只接受这两个字符串。默认关闭，`doctor --check --json` 的 `audit_enabled` 可核对开关。

每次 `tools/call` 结束后向 stderr 输出一行 JSON：

```json
{"timestamp":"2026-10-12T09:30:00.000Z","tool":"add_comment","mode":"preview","result_code":"OK","duration_ms":80,"version":"1.0.1"}
```

字段固定为 UTC 时间、工具名、模式、结果码、整数耗时和版本。模式为 `read`／`preview`／`write`；写模式只表示提交请求，是否成功由结果码判断。

参数、页面／空间 ID、站点 URL、账号、正文、标题、附件内容、凭据及错误原文不进入审计。未知工具和错误码分别记录为 `unknown` 和 `UNKNOWN_ERROR`。工具初始化／发现、协议层拒绝、CLI 登录／诊断和未结束的调用不在记录范围。

客户端须持续读取 stderr 并负责采集、存储及保留；程序不创建审计文件。输出失败丢弃该条日志，保持工具结果，不重试业务操作。本地审计为尽力记录，不能替代完整持久审计或 Confluence 页面修改历史。

## 故障排查

- `AUTH_CONFIG_INVALID`／`POLICY_INVALID`：核对配置 JSON、字段类型、来源、实际空间 key 和工具名。站点只接受无凭据的 HTTPS 地址，保留部署路径。
- `TTY_REQUIRED`：在本人交互终端登录，避免管道输入或通过 MCP 工具输入密码。
- `CREDENTIAL_BACKEND_UNAVAILABLE`：核对系统及凭据库来源；Linux 使用 env 来源。
- `CREDENTIAL_FAILED`：受限宿主可能干扰 Keychain 或系统调用；按宿主正常批准机制做只读 `whoami`／`doctor` 对照，再判断本人需要执行的操作。
- 401／403：分别核对身份和权限；未读内容保持未验证。
- 客户端找不到 `npx`：核对 Node 安装及宿主 PATH，按客户端说明使用正确启动命令或绝对路径。
- Windows PowerShell／Add-Type 被策略禁用：交由环境负责人核对；程序不会改用不安全来源或更改执行策略。
