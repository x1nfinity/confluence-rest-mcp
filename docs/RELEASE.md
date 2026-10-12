# Confluence MCP alpha.2 发行说明

日期：2026-10-12。当前状态：**alpha.2 已公开发布，供只读有限试用**。

包名为 `confluence-rest-mcp`，版本为 [`1.0.0-alpha.2`](https://www.npmjs.com/package/confluence-rest-mcp/v/1.0.0-alpha.2)，CLI 为 `confluence-mcp`，MCP 服务标识为 `confluence`。包已发布至官方 registry，访问级别为 public，发布账号为 `xinfinity`。Node.js 要求 `>=22.23.2 <23`；发行验证使用 Node.js 22.23.2、npm 10.9.8、TypeScript 5.9.3。

GitHub 仓库 [x1nfinity/confluence-rest-mcp](https://github.com/x1nfinity/confluence-rest-mcp) 为 public，默认分支为 main。[发行源码提交 `8c36bbc`](https://github.com/x1nfinity/confluence-rest-mcp/commit/8c36bbcdfd17c8a7d2a76a36f6d77b57e2b64813) 已推送，远端提交和 58 个公开源码文件均与审核清单一致。

当前 registry 的 `next` 和 `latest` 均指向 `1.0.0-alpha.2`。`latest` 待维护者完成二次验证后移除并读回核实；试用期间请使用固定版本。

采用 [MIT 许可](../LICENSE)，版权为 `Copyright (c) 2026 x1nfinity`。公开源码范围为 TypeScript 实现、通用文档和合成测试；npm 运行包采用 README、LICENSE、package.json、构建后 dist 的白名单。个人状态、系统凭据和客户端策略由成员本机保留。生产运行不依赖 Python，源码测试需要 Python 3.9+；额外的本机对照验收需要另备原实现。

## 能力与已有验收范围

- M0：固定工具链、12 工具契约、错误定义和合成基线，stdio 协议及打包入口。
- M1：Basic Auth、系统 Keyring／显式 env 来源、隐藏交互登录和诊断 CLI，以及正文、搜索和附件清单读取。
- M2：完整结构、章节、字面关键词、子页面、评论、版本比较、附件内容，以及三个写工具的默认预览和受控提交门禁。
- M3：稳定用户状态目录、工具开关、精确写空间策略、固定版本 npm／客户端接入与平台验收入口。

已有 macOS 独立进程的读取与默认预览验收，Codex 桌面重载后的正文、搜索和附件实读，以及 2 个 DOCX、2 个 XLSX 和 1 个 PDF 的实际内容读取。Office 完整性仅指提取文字，PDF 文字最多前 20 页和 30,000 个码点；图片、图表、嵌入对象和视觉全文需分别验证。

Windows 实机、Cursor、本人交互登录换密及真实测试空间受控写入仍待验收。Windows 说明见 [实机验收](WINDOWS-ACCEPTANCE.md)。alpha.2 为只读有限试用，正式 `1.0.0` 要求完成这些平台、客户端、认证和写入门槛。

## 已执行的发行验证

发行预检已在本机和公开源码隔离目录通过锁定依赖安装、类型检查、构建和源码测试：94 项中 90 项通过、4 项按环境条件跳过，无失败。合成文档和附件夹具共 857 个；本机原实现的 83 文件冻结基线检查通过。4 个跳过项涉及未启用的 Python／PowerShell Windows 模拟环境及非 Windows 的实机用例，不计为实机通过。本轮发布后的验证覆盖公开包安装与运行，未重新执行完整源码测试。

公开源码范围及 JSON／TOML 示例、公共链接检查通过，测试中的身份和密码均为合成数据。registry 下载的运行包与审核归档及发行产物逐字节一致，共 21 个文件、57,208 字节；SHA-256 为 `4a74d43f808a70584317294334b631f53da5093cc6cbf228ecfee616bbb90fb2`。运行包清单与 `npm pack --dry-run --json` 一致，包元数据、MIT、访问级别和 registry 已核对。

通过公开 package spec，在全新 cache 和包含中文、空格的隔离 HOME 目录执行 `--ignore-scripts` 安装，bin 可执行；`npx -y confluence-rest-mcp@1.0.0-alpha.2 version` 返回 `1.0.0-alpha.2`。`doctor --check` 确认为只读、12 工具、待认证；实际 stdio 初始化、12 工具发现及非法参数拒绝通过，stderr 为空。检查未读取站点凭据，隔离用户状态未发生写入。

本机已有实现、个人状态和客户端策略保留，1,116 个已有文件的哈希检查一致。本次发行未写入 Confluence 页面。

## 仍待完成

- 移除 `latest` 标签并核实 registry 标签状态。
- Windows 实机及 Cursor 客户端接入。
- 本人交互登录换密及真实测试空间受控写入。

后两项为正式 `1.0.0` 的验收门槛；alpha.2 的公开发行与安装验证已完成。

## 固定版本接入

使用 `npx -y confluence-rest-mcp@1.0.0-alpha.2`，客户端固定版本接入。JSON／TOML 配置和认证步骤见 [使用说明](../typescript/README.md)。示例站点为 `https://confluence.example.com/confluence`，默认系统 Keyring，显式 `CONFLUENCE_READ_ONLY=true`。

登录由本人在交互终端隐藏输入；局部调整客户端启动字段，保留个人状态、系统凭据、已有本机实现和客户端策略。重载后在新会话实际读取正文、搜索和附件，独立确认宿主接入。
