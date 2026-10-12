# Confluence MCP TypeScript

本目录提供 `confluence-rest-mcp@1.0.0-alpha.2` 的 TypeScript 实现，使用 Node.js 和直接 HTTPS Basic Auth，提供 12 个 MCP 工具。CLI 名为 `confluence-mcp`；无子命令时运行 stdio。当前为只读有限试用，npm 试用标签为 `next`，客户端固定具体版本。

公开源码仓库为 [x1nfinity/confluence-rest-mcp](https://github.com/x1nfinity/confluence-rest-mcp)，包含 TypeScript、通用文档和合成测试。包采用 MIT 许可，版权为 `Copyright (c) 2026 x1nfinity`，完整条款随包提供于 `LICENSE`。MIT 允许使用、修改和分发，包括商业使用，要求保留版权及许可声明，并按原样提供软件。

## 本地构建与验证

固定 Node.js 22.23.2、npm 10.9.8、TypeScript 5.9.3。在本目录运行：

```sh
fnm exec --using=22.23.2 npm ci --ignore-scripts
fnm exec --using=22.23.2 npm run typecheck
fnm exec --using=22.23.2 npm test
fnm exec --using=22.23.2 npm pack --dry-run --json
```

运行服务不需要 Python。源码开发测试需要 Python 3.9+，用于标准库对照和合成检查；文档及附件回归使用自包含的冻结合成夹具。`check:baseline`、黄金夹具导出和 Windows 实机互读属于可选本机对照工具，另需与冻结基线匹配的原 Python 实现置于源码根目录的 `native/`；该对照实现由验收人员另备。默认构建和回归不调用该实现。PDF 文字提取可选使用系统 `pdftotext`，缺少时仍返回嵌入文件及明确警示。DOCX／XLSX 解析使用包内代码，不依赖 Python 或 Office 程序。

工具包括正文、搜索、附件、直接子页面、独立评论、指定版本比较、完整结构、章节、字面关键词，以及创建／更新／局部修改预览与受控提交。保持原 schema、annotations 和错误结构；正文和结构按 Unicode 码点续读，固定页面版本及相应全文指纹。结构分段需全部拼接后再解析 JSON。

正文、结构和附件输出分别说明覆盖范围。引用元数据不能代替实际读取；Office 提取不代表图片、图表或视觉布局已读，Excel 不执行公式。PDF 文字最多前 20 页和 30,000 个码点，不代表视觉全文完整性。REST JSON 响应最多 2 MiB，附件下载最多 4 MiB，Office 解压总量最多 16 MiB、提取文字 UTF-8 总量最多 8 MiB；超限返回明确错误。

## 认证与本地启动

```sh
node dist/cli.js version
node dist/cli.js login --base-url https://confluence.example.com/confluence
node dist/cli.js whoami --base-url https://confluence.example.com/confluence
node dist/cli.js doctor --base-url https://confluence.example.com/confluence --check --json
```

默认 Keyring 来源，macOS 使用 Keychain，Windows 使用 Credential Manager。站点为完整 HTTPS 地址，保留 `/confluence` 等部署路径。复用旧 Python 的 service/account 和 JSON 凭据记录。macOS 旧记录读取已验证；Windows 通过系统自带 Windows PowerShell 5.1 与 WinCred API 读取、保存及删除，仍待 Windows 实机验收。无需 Python 或额外凭据工具；系统 PowerShell／Add-Type 被企业策略禁用时明确报错，不切换凭据来源。

`login` 由本人在交互终端隐藏输入，身份校验通过后保存；不接受命令行参数或管道中的账号密码。密码更新后使用同一命令。Windows 使用一次 CredWrite 保存完整 UTF-16LE JSON，复用 service 或现存 account@service 目标，保留其他 account 的记录；超出 2,560 字节或目标冲突时报错。`logout` 只清除本站点固定 account 的两个可能目标，先清旧碰撞记录，再清主记录；重复注销安全。`whoami` 和 `doctor` 不显示账号密码；`doctor --check` 不读凭据或访问网络，普通 doctor 验证身份，`--page` 另查正文。

Windows 的凭据操作在同一电脑上使用按用户 SID 和站点隔离的 Global 命名互斥锁，覆盖同一用户的多个登录会话。保存及每次删除前复核目标归属、时间戳、长度与自有记录指纹，删除后确认两个目标没有自有记录。Python、旧版 TS 和系统 UI 不参与该锁；WinCred 不提供条件写入／删除，最后复核到 API 调用之间仍有竞态，管理凭据时请避免同时使用这些入口。两个目标的删除不构成事务：后续删除失败会报错，已清除的旧碰撞记录不恢复。保存／删除遇到超时或进程中断时，实际结果可能已生效，应先检查状态，不自动重试。

用户状态固定在 macOS `~/.confluence-mcp/.local/`、Windows `%LOCALAPPDATA%\ConfluenceMCP\.local\`，与当前目录、npx 缓存和包版本无关。程序只读加载非敏感 settings.json、auth.json 和 policy.json，不在安装或启动时改写个人文件。密码仅由本人登录保存至系统凭据库。

显式环境变量模式设置 `CONFLUENCE_CREDENTIAL_SOURCE=env` 并成对提供 `CONFLUENCE_USERNAME`／`CONFLUENCE_PASSWORD`；失败不切换来源，也不写入 Keychain。客户端 JSON 的 env 对象向进程注入变量；把密码放在该配置中会形成明文文件。程序不自动加载 `.env`。

macOS 凭据读取经有期限的私有 IPC 子进程；Windows 桥接经有期限的私有 stdin/stdout 管道传递，管道输出只供父进程解析。记录不进入命令参数、父进程终端输出、日志或文件；PowerShell 的 EncodedCommand 仅包含固定代码。Agent 受限执行环境可能干扰 Keychain 原生调用；出现 CREDENTIAL_FAILED 时，按宿主批准机制使用正常本机权限做只读 whoami／doctor 对照，再判断所需的本人操作。不能仅据沙箱失败判定密码失效。

Windows 源码验收入口为 `npm run check:windows -- --python EXISTING_PYTHON_EXE --report NEW_JSON`，操作说明见源码仓库的 `docs/WINDOWS-ACCEPTANCE.md`。脚本需实际 Windows 和另备的本机 Python 对照实现，固定使用随机 example.invalid 目标与合成记录，覆盖 Python 互读、失败保留、碰撞、多进程、删除和定向清理；脚本属于源码验收资料，未包含在 npm 运行包内。当前尚未 Windows 实机验收。

## 客户端试用

先独立验证身份和工具，再按明确授权局部接入客户端。保留原批准、禁用、超时和其他服务配置；示例只展示服务启动字段，不应覆盖整个配置。从源码试用时替换 Node 路径、源码路径和站点，服务名使用 `confluence`：

```json
{
  "mcpServers": {
    "confluence": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/typescript/dist/cli.js"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.example.com/confluence",
        "CONFLUENCE_AUTH_MODE": "basic",
        "CONFLUENCE_CREDENTIAL_SOURCE": "keyring",
        "CONFLUENCE_READ_ONLY": "true"
      }
    }
  }
}
```

服务无子命令时运行 stdio；提供 serve、login、whoami、logout、doctor、version。旧 browser 模式成员先验证本人 Basic 身份，再局部切换启动配置；旧 Python、.venv、个人设置与系统注册保留。客户端重载及新会话工具实读需独立验收。

### npm 固定版本接入

需要 Node.js `>=22.23.2 <23`；本机验证环境为 Node.js 22.23.2、npm 10.9.8。以下命令和配置在 npm 发布后使用，当前使用本地构建或本地 tarball。试用发行标签为 `next`，客户端固定具体版本以控制升级。

安装和配置可由 AI 协助；登录时由本人在交互终端隐藏输入账号密码。发布完成后使用：

```sh
npx -y confluence-rest-mcp@1.0.0-alpha.2 version
npx -y confluence-rest-mcp@1.0.0-alpha.2 login --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.0-alpha.2 whoami --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.0-alpha.2 doctor --base-url https://confluence.example.com/confluence --check --json
```

Cursor 等 JSON 客户端使用：

```json
{
  "mcpServers": {
    "confluence": {
      "command": "npx",
      "args": ["-y", "confluence-rest-mcp@1.0.0-alpha.2"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.example.com/confluence",
        "CONFLUENCE_AUTH_MODE": "basic",
        "CONFLUENCE_CREDENTIAL_SOURCE": "keyring",
        "CONFLUENCE_READ_ONLY": "true"
      }
    }
  }
}
```

Codex 使用对应 TOML：

```toml
[mcp_servers.confluence]
command = "npx"
args = ["-y", "confluence-rest-mcp@1.0.0-alpha.2"]

[mcp_servers.confluence.env]
CONFLUENCE_BASE_URL = "https://confluence.example.com/confluence"
CONFLUENCE_AUTH_MODE = "basic"
CONFLUENCE_CREDENTIAL_SOURCE = "keyring"
CONFLUENCE_READ_ONLY = "true"
```

客户端重载后，在新会话实际调用正文、搜索和附件工具确认接入。升级／切回时只调整固定版本，复用稳定状态目录，保留原 Python、个人设置、凭据和客户端策略。

## 工具与空间策略

在本人稳定状态目录创建非敏感 `policy.json`，编辑后重载 MCP：

```json
{
  "enabled_tools": ["get_page", "search_pages", "get_attachments", "update_page"],
  "write_spaces": ["TEAM_DOCS"]
}
```

未配置 enabled_tools 时兼容全部 12 工具；空数组隐藏全部工具，禁用工具直接调用也返回 TOOL_DISABLED。重复、未知字段／工具、非法类型、空间通配符均拒绝。

三个写工具默认 dry_run=true，仅返回完整预览和可选 preview_hash。实际提交同时要求有效认证模式为 Basic、auth.json 的 `allow_write=true`，进程未强制只读、工具已启用，且 write_spaces 非空并允许服务端实际目标空间。env 中 `CONFLUENCE_READ_ONLY=false` 不能单独打开本机写入开关；true 始终禁止真实写入。未配置 write_spaces 字段时允许兼容预览并返回 write_scope_configured=false，真实提交返回 WRITE_SCOPE_REQUIRED；显式 write_spaces=[] 的预览返回 SPACE_NOT_ALLOWED，真实提交返回 WRITE_SCOPE_REQUIRED。已配置非空列表时，范围外预览和提交均拒绝。

升级保留旧 allow_write 开关，但旧安装没有 write_spaces 时真实写入会被上述门禁阻止。由成员明确选择空间后恢复，不自动选空间。空间白名单不会提升 Confluence 本人权限。

创建核对父页实际空间和同空间同标题；更新核对已发布页面、当前 storage 和版本；patch 只处理唯一完整顶层普通块并保留其余原文，二次读取变化即拒绝。preview_hash 校验目标与 payload 一致，仍需用户审查并明确授权具体目标和内容。写入冲突不重试；超时、断线、5xx 或不匹配响应返回 WRITE_UNCERTAIN，应先读回目标再决定下一步。

## npm 发行

包名为 `confluence-rest-mcp`，版本为 `1.0.0-alpha.2`，许可为 `MIT`。源码仓库为 public，默认分支为 main；试用发行使用 `--tag next`，具体版本与标签可在 npm registry 核对。

运行包白名单包含 README、LICENSE、package.json 和构建后 dist；依赖通过固定 package-lock.json 管理。构建在发行前完成，成员启动时不编译源码；安装脚本不请求凭据或修改客户端。发行人员分别审查 Git 源码、`npm pack --dry-run --json` 与真实 tarball，并在干净目录验证 CLI、stdio 和只读状态；推送及发布实际成功后核对远端提交、registry 版本和 `next` 标签。

alpha.2 仅限试用：macOS 独立读取与默认预览、Codex 桌面正文／搜索／附件读取已有证据，包括 2 个 DOCX、2 个 XLSX 和 1 个 PDF。Windows 实机、Cursor、本人交互登录换密和单独授权的真实测试空间写入仍待验收。正式 `1.0.0` 发布要求完成这些平台、客户端、认证和写入门槛。

源码仓库的 `docs/RELEASE.md` 汇总发行状态与验证清单，`docs/WINDOWS-ACCEPTANCE.md` 提供 Windows 实机步骤。本 README 在独立 npm 包内自包含，验收脚本与源码测试不进入运行包。
