# Confluence MCP

[`confluence-rest-mcp@1.0.0-alpha.2`](https://www.npmjs.com/package/confluence-rest-mcp/v/1.0.0-alpha.2) 已公开发布，提供基于 Node.js、HTTPS Basic Auth 和 stdio 的 12 个 Confluence MCP 工具。CLI 为 `confluence-mcp`，MCP 服务标识为 `confluence`。当前为只读有限试用，已发布至 npm `next` 标签；推荐固定版本接入，发行验证及标签状态见 [发行说明](docs/RELEASE.md)。

需要 Node.js `>=22.23.2 <23`。使用固定版本检查和登录：

```sh
npx -y confluence-rest-mcp@1.0.0-alpha.2 version
npx -y confluence-rest-mcp@1.0.0-alpha.2 login --base-url https://confluence.example.com/confluence
npx -y confluence-rest-mcp@1.0.0-alpha.2 doctor --base-url https://confluence.example.com/confluence --check --json
```

登录由本人在交互终端隐藏输入账号密码；默认使用系统 Keyring，macOS 为 Keychain、Windows 为 Credential Manager。站点地址保留 `/confluence` 等部署路径。`doctor --check` 只检查配置，不读取凭据或访问网络；真实身份检查使用 `whoami` 或普通 `doctor`。

JSON 客户端的服务配置：

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

Codex 对应 TOML 配置：

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

只局部调整服务入口，保留客户端已有批准、禁用、超时和其他服务配置。重载后在新会话实际调用正文、搜索和附件工具确认接入。

工具支持正文及结构续读、章节定位、关键词检索、搜索、附件、子页面、评论、版本比较，以及创建／更新／局部修改预览。正文续读固定版本和内容指纹；附件需要独立读取。Office 提取文字不代表图片、图表和视觉布局已读，PDF 文字最多前 20 页和 30,000 个码点。真实写入还须本机开关、空间白名单、本人权限及具体目标／内容授权，默认预览不能代替提交验收。

macOS 独立读取、默认写入预览及 Codex 桌面正文／搜索／附件读取已有验收证据，包括 2 个 DOCX、2 个 XLSX 和 1 个 PDF。Windows 实机、Cursor、本人交互登录换密及真实测试空间写入仍待验收；正式 `1.0.0` 需完成这些门槛。

- [TypeScript 使用、开发与安全边界](typescript/README.md)
- [发行说明与验证清单](docs/RELEASE.md)
- [Windows 凭据实机验收](docs/WINDOWS-ACCEPTANCE.md)

公开源码包含 TypeScript 实现、通用文档和合成测试。生产运行不依赖 Python；源码开发测试需要 Python 3.9+，可选互读对照另需本机对照实现。迁移时保留个人状态、系统凭据、已有本机实现和客户端策略。

项目采用 [MIT 许可](LICENSE)，版权为 `Copyright (c) 2026 x1nfinity`。源码：[x1nfinity/confluence-rest-mcp](https://github.com/x1nfinity/confluence-rest-mcp)。
