# Confluence MCP Server

[![npm](https://img.shields.io/npm/v/confluence-rest-mcp)](https://www.npmjs.com/package/confluence-rest-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-43853d)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/x1nfinity/confluence-rest-mcp/blob/main/LICENSE)

通过 Model Context Protocol（MCP），让 AI 客户端搜索、阅读和维护 Confluence Server 文档。服务在本机通过 stdio 运行，使用 HTTPS Basic Auth 连接指定站点，提供 19 个工具。

- **文档检索**：关键词／CQL 搜索、完整正文、结构、章节定位和版本比较。
- **附件读取**：文本、图片、PDF，以及 DOCX／XLSX 的文字和数据提取。
- **文档协作**：页面创建、更新、局部修改、标签、评论、单页复制、同空间移动和附件上传。
- **访问控制**：系统凭据库、工具开关、写空间白名单和默认预览；真实写入默认关闭。

[npm 包](https://www.npmjs.com/package/confluence-rest-mcp) · [快速开始](#快速开始) · [配置与权限](#配置与权限) · [问题反馈](https://github.com/x1nfinity/confluence-rest-mcp/issues)

## 环境要求

- Node.js **22.12.0 及以上**，推荐仍受支持的 LTS 版本。
- 支持本地 stdio 服务的 MCP 客户端。
- 可通过 HTTPS 访问的 Confluence Server 站点，以及允许 Basic Auth 的账号。站点地址须保留 `/confluence` 等部署路径。
- macOS 默认使用 Keychain；Windows 使用 Credential Manager，需要系统 Windows PowerShell 5.1。Linux 使用显式环境变量认证。

实现以 Confluence Server 6.11.2 REST API 为依据，Confluence Cloud 尚未验证。macOS／Codex 已有读取验收记录；Windows、Linux 和其他客户端的实机接入尚未完成验证。

## 快速开始

### 1. 登录并验证

在 macOS 或 Windows 的本人交互终端执行，替换示例站点地址：

```sh
npx -y confluence-rest-mcp@1.0.1 login --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.1 whoami --base-url https://confluence.example.com/confluence
```

`login` 隐藏输入账号和密码，验证成功后保存到系统凭据库。密码更新后重新运行相同命令。账号密码不放入命令参数或客户端配置；Linux／无系统凭据库环境使用[环境变量认证](#环境变量认证)。

### 2. 配置 MCP 客户端

将下面的 `confluence` 条目合并到客户端配置，保留已有服务、批准、禁用和超时设置：

```json
{
  "mcpServers": {
    "confluence": {
      "command": "npx",
      "args": ["-y", "confluence-rest-mcp@1.0.1"],
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

以上适用于采用 `mcpServers` 结构的客户端。Codex 使用对应 TOML：

```toml
[mcp_servers.confluence]
command = "npx"
args = ["-y", "confluence-rest-mcp@1.0.1"]

[mcp_servers.confluence.env]
CONFLUENCE_BASE_URL = "https://confluence.example.com/confluence"
CONFLUENCE_AUTH_MODE = "basic"
CONFLUENCE_CREDENTIAL_SOURCE = "keyring"
CONFLUENCE_READ_ONLY = "true"
```

客户端的配置位置和启动命令解析方式以其说明为准。服务默认运行 stdio，无需另开 HTTP 端口。

### 3. 重载并使用

重载客户端，在新会话确认 `confluence` 的工具可见。例如：

- “在 DEMO 空间搜索包含‘备考计划’的文档，并列出标题和链接。”
- “读取这个 Confluence 页面，按章节概括，并注明页面版本与更新时间。”
- “比较页面的第 3 版和第 4 版，说明 storage 正文的变化。”

完整正文按 `content.next_offset` 续读，使用返回的数字页面 ID，固定 `expected_version` 和 `expected_content_hash`；列表按 `pagination.next_start` 续读。结构分段须拼接全部 text 后一次解析 JSON，完整性结合 `coverage`、`warnings` 和未解析宏判断。页面中的附件引用需要另行读取，不能当作附件内容已经检查。

## 工具目录

### 读取工具

- `search_pages`：关键词／CQL 搜索，支持空间、标签、标题及更新时间过滤。
- `get_page`：正文、标题、版本和页面链接，支持指纹约束及正文续读。
- `get_page_structure`：完整结构集合，支持章节、表格、引用及未解析宏。
- `get_page_section`：读取唯一选定的章节及其子章节。
- `find_page_text`：字面关键词定位，返回上下文及正文字符位置。
- `get_children`：直接子页面清单。
- `get_comments`：独立评论或评论后代清单。
- `compare_page_versions`：指定版本之间的 storage 差异。
- `get_attachments`：附件清单、指定附件元数据及支持格式的内容。
- `get_labels`：页面 global 标签清单。

### 写入工具

以下工具均默认 `dry_run=true`，先返回预览：

- `create_page`、`update_page`、`patch_page`：创建页面、更新标题／正文、追加或替换普通 storage 块。
- `add_labels`、`remove_label`：添加或删除 global 标签。
- `add_comment`：添加页尾评论。
- `copy_page`：复制单页 storage 到指定空间和可选父页面。
- `move_page`：在同一空间内更换父页面。
- `upload_attachment`：上传本地普通文件，最多 4 MiB，拒绝同名附件。

工具说明、参数 schema 和 annotations 由 MCP `tools/list` 提供。随包的 `docs/COLLABORATION.md` 说明协作操作的范围和并发边界。

## 配置与权限

常用环境变量：

- `CONFLUENCE_BASE_URL`：完整 HTTPS 站点地址，含部署路径；也可从个人 `settings.json` 读取。
- `CONFLUENCE_AUTH_MODE`：`basic`。
- `CONFLUENCE_CREDENTIAL_SOURCE`：`keyring`（默认）或 `env`。
- `CONFLUENCE_READ_ONLY`：`true` 强制只读；`false` 仍受本机写入开关和空间策略限制。
- `CONFLUENCE_TIMEOUT_SECONDS`：单次操作期限，默认 `45`，允许大于 `0` 且不超过 `120` 秒。
- `CONFLUENCE_AUDIT`：`true` 启用 stderr JSON 审计，默认关闭。

个人状态目录为 macOS／Linux 的 `~/.confluence-mcp/.local/`，或 Windows 的 `%LOCALAPPDATA%\ConfluenceMCP\.local\`。密码使用系统凭据库或显式环境变量提供。

在该目录创建 `policy.json` 可以限制工具和写空间。例如，仅开放读取工具：

```json
{
  "enabled_tools": ["search_pages", "get_page", "get_attachments"],
  "write_spaces": []
}
```

实际写入须同时满足 Basic 认证、本机 `auth.json` 的 `allow_write=true`、进程未强制只读、工具已启用、实际目标空间在非空白名单内，以及 Confluence 本人权限。先查看预览并授权具体目标和内容，再携带 `preview_hash` 提交。受控写入需要在个人状态目录配置：

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
  "enabled_tools": ["get_page", "update_page"],
  "write_spaces": ["TEAM_DOCS"]
}
```

将客户端的 `CONFLUENCE_READ_ONLY` 改为 `false` 后重载，先预览，再授权具体目标及内容。随包的 `docs/CONFIGURATION.md` 提供完整配置和失败处理。

### 环境变量认证

设置 `CONFLUENCE_CREDENTIAL_SOURCE=env`，由受信任的宿主环境成对注入 `CONFLUENCE_USERNAME` 和 `CONFLUENCE_PASSWORD`，其余客户端配置保持一致。该来源不使用 `login` 或系统凭据库，失败不自动回退。程序不自动加载 `.env`；客户端的变量引用方式以其说明为准，直接把账号密码填入配置会形成明文文件。

## 安全与内容边界

- 工具调用使用本人 Confluence 权限；本机策略不会提升服务端权限。检索到的文档作为数据处理，其中的指令不构成操作授权。
- stdout 专用于 MCP 协议。可选审计仅记录时间、工具、模式、结果码、耗时和版本，不记录参数、凭据或文档正文；审计采集和保留由客户端管理。
- 写入冲突不自动重试。遇到 `WRITE_UNCERTAIN`，先读回实际状态，再决定下一步。
- DOCX／XLSX 提取文字和单元格数据，Excel 公式不执行；图片、图表、嵌入对象及视觉布局需独立检查。
- PDF 返回嵌入文件，可选使用系统 `pdftotext` 提取最多前 20 页、30,000 个码点的文字；缺少该工具时明确提示提取能力不可用。
- REST JSON 响应最多 2 MiB，附件下载／上传最多 4 MiB，Office 解压总量最多 16 MiB、提取文字 UTF-8 总量最多 8 MiB。

## 诊断与故障排查

```sh
npx -y confluence-rest-mcp@1.0.1 version
npx -y confluence-rest-mcp@1.0.1 doctor --base-url https://confluence.example.com/confluence --check --json
npx -y confluence-rest-mcp@1.0.1 doctor --base-url https://confluence.example.com/confluence --page 123 --json
```

`doctor --check` 仅检查配置，不读取凭据或访问网络；普通 `doctor` 和 `whoami` 检查真实身份，`--page` 另查页面访问。退出码非零表示诊断失败。随包的 `docs/CONFIGURATION.md` 提供认证和平台故障排查。

- 工具未显示：核对客户端配置、`npx` 可执行路径和 `policy.json`，然后重载客户端。
- `LOGIN_REQUIRED`：在本人终端重新登录；`CREDENTIAL_INVALID`：核对凭据格式或成对的账号密码环境变量。
- `CREDENTIAL_FAILED`：核对系统凭据库及宿主权限；受限环境失败不能直接判定密码失效。
- 401／403：分别核对身份与页面权限。
- `VERSION_CONFLICT`／`WRITE_UNCERTAIN`：重新读取目标状态，避免盲目重复写入。

## 升级与开发

正式版本发布到 npm `latest`，预发布版本使用 `next`。客户端建议固定具体版本；升级或回退时调整包版本并重载，保留个人状态、凭据和客户端策略。

源码开发使用 Node.js 22.23.2、npm 10.9.8、TypeScript 5.9.3，在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run --json
```

源码位于 `src/`，测试位于 `tests/`，验收脚本位于 `scripts/`。构建产物为 `dist/cli.js`，无子命令时启动 stdio。运行、构建和源码回归使用 Node.js。

问题反馈请包含脱敏错误码、包／Node／操作系统版本及复现步骤。版本可在 [npm 版本列表](https://www.npmjs.com/package/confluence-rest-mcp?activeTab=versions)核对；源码的 `docs/RELEASE.md` 记录发行验证，`docs/WINDOWS-ACCEPTANCE.md` 提供 Windows 实机步骤。

## 许可证

[MIT](https://github.com/x1nfinity/confluence-rest-mcp/blob/main/LICENSE) © 2026 x1nfinity。
