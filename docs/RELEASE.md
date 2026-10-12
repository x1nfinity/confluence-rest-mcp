# 发行说明

正式版本使用 npm `latest`，预发布版本使用 `next`。安装和 MCP 接入见[README](../README.md)。

## 1.0.1 — 文档与包元数据

日期：2026-10-13。状态：已公开发布；已核实 `latest → 1.0.1`，`next` 保持 `1.0.0-alpha.2`。

- README 改为面向使用者的快速开始、客户端接入、工具目录、配置权限、诊断及升级说明。
- npm 包说明明确面向 Confluence Server，补充 MCP、Confluence 和 Atlassian 检索关键词。
- 随包提供 `docs/CONFIGURATION.md` 和 `docs/COLLABORATION.md`，保留高级认证、写入、审计和并发边界。
- MCP 功能和参数契约保持 1.0.0 行为；CLI／协议版本同步为 1.0.1，Node 要求保持 `>=22.12.0`。

公开包包含 README、LICENSE、package.json、构建后 dist 和上述两份使用文档。个人状态、凭据、客户端配置、源码测试及维护者发行记录不进入运行包。

### 验证范围

文档锚点、JSON 示例、随包相对链接和包元数据检查通过。类型检查及构建通过；Node 22.23.2 与 24.21.0 的源码测试均为 108 项通过、3 项环境跳过，无失败。与已发布 1.0.0 的运行产物比较，只有 CLI／协议版本号变化。

23 文件的实际 tarball 在隔离目录安装后，Node 22.12.0、22.23.2、24.21.0 的版本、无凭据配置检查、默认只读、stdio 初始化、19 工具发现和非法参数拒绝检查通过。registry 已核实版本为 1.0.1，`latest` 指向 1.0.1；包说明、关键词、Node 要求、integrity 和 shasum 与审核包一致，匿名下载 tarball 字节与审核包完全相同。

1.0.1 包 SHA-256：`28ad60d137f9905d04e36cfb7d2737d0cab88ed307871965cd862597fde4b6f1`。读回核实时间：2026-10-13 00:04（Asia/Shanghai）。

实现以 Confluence Server 6.11.2 REST API 为依据。已有 macOS／Codex 读取验收记录；Windows、Linux、Cursor、本人交互登录换密及真实测试空间写入保持未验证。Office 完整性仅指提取文字，PDF 文字不代表图表或视觉全文已检查。

## 1.0.0 — 首个正式版本

日期：2026-10-12。状态：已公开发布；发布时已核实 `latest → 1.0.0`，`next` 保持 `1.0.0-alpha.2`。

- 19 个 MCP 工具，覆盖正文、结构、检索、附件、评论、版本比较、页面维护和协作。
- Basic Auth、系统 Keyring／显式 env 来源、稳定个人状态目录、工具开关和写空间白名单。
- 可选 stderr JSON 操作审计，真实写入默认关闭，写工具默认预览。
- Node.js `>=22.12.0`，源码采用根目录 `src/` 结构。

源码测试在 Node 22.12.0、22.23.2、24.21.0 均为 108 项通过、3 项环境跳过，无失败。21 文件的实际 tarball 经隔离安装、CLI、默认只读、stdio 初始化、19 工具发现及非法参数拒绝检查。registry 的 integrity、shasum 和匿名下载字节与审核包一致。

1.0.0 包 SHA-256：`805a6496504961053941fc4c82ef2c4ac31586e417fbe55f7c3738dfed15e368`。读回核实时间：2026-10-12 23:12（Asia/Shanghai）。

## 维护者发布流程

1. 同步 `package.json`、`package-lock.json` 和 CLI／协议版本，更新面向使用者的变更说明。
2. 使用声明的开发环境安装锁定依赖，执行类型检查、相关测试及构建；分别检查源码范围和 npm 实际清单。
3. 执行 `npm pack --dry-run --json` 并生成真实 tarball；确认 README、使用文档及包元数据，不包含个人状态和凭据。
4. 在隔离目录安装该 tarball，核对版本、stdio、工具目录、默认只读及无凭据预检。
5. 发布审核过的 tarball 到官方 registry：正式版本使用 `--access public --tag latest`；预发布使用 `next`。npm 二次验证由发布者本人完成。
6. 读回版本和标签，比较 registry integrity／shasum 及下载 tarball 字节，再更新发行状态。

同一包名和版本不能覆盖发布，包内 README 更新需要新版本。Git 源码发布单独执行。
