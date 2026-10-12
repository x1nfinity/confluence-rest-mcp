# Confluence MCP alpha.2 发行说明

日期：2026-10-12。当前状态：**发行待执行**。本页在源码推送和 npm 发布实际成功后更新结果。

包名为 `confluence-rest-mcp`，版本为 `1.0.0-alpha.2`，CLI 为 `confluence-mcp`，MCP 服务标识为 `confluence`。npm 试用标签为 `next`，发布目标为官方 registry 的 public 包。Node.js 要求 `>=22.23.2 <23`；发行验证使用 Node.js 22.23.2、npm 10.9.8、TypeScript 5.9.3。

GitHub 仓库 [x1nfinity/confluence-rest-mcp](https://github.com/x1nfinity/confluence-rest-mcp) 已核实为 public，默认分支为 main，发行身份具有管理及推送权限。首次发行前远端为空，本轮建立首个源码提交。npm 当前登录账户已核对为 `xinfinity`；包名查询本次未检出，实际可发布性仍以 registry 发布结果为准。

采用 [MIT 许可](../LICENSE)，版权为 `Copyright (c) 2026 x1nfinity`。公开源码范围为 TypeScript 实现、通用文档和合成测试；npm 运行包采用 README、LICENSE、package.json、构建后 dist 的白名单。个人状态、系统凭据和客户端策略由成员本机保留。生产运行不依赖 Python，源码测试需要 Python 3.9+；额外的本机对照验收需要另备原实现。

## 能力与已有验收范围

- M0：固定工具链、12 工具契约、错误定义和合成基线，stdio 协议及打包入口。
- M1：Basic Auth、系统 Keyring／显式 env 来源、隐藏交互登录和诊断 CLI，以及正文、搜索和附件清单读取。
- M2：完整结构、章节、字面关键词、子页面、评论、版本比较、附件内容，以及三个写工具的默认预览和受控提交门禁。
- M3：稳定用户状态目录、工具开关、精确写空间策略、固定版本 npm／客户端接入与平台验收入口。

已有 macOS 独立进程的读取与默认预览验收，Codex 桌面重载后的正文、搜索和附件实读，以及 2 个 DOCX、2 个 XLSX 和 1 个 PDF 的实际内容读取。Office 完整性仅指提取文字，PDF 文字最多前 20 页和 30,000 个码点；图片、图表、嵌入对象和视觉全文需分别验证。

Windows 实机、Cursor、本人交互登录换密及真实测试空间受控写入仍待验收。Windows 说明见 [实机验收](WINDOWS-ACCEPTANCE.md)。alpha.2 为只读有限试用，正式 `1.0.0` 要求完成这些平台、客户端、认证和写入门槛。

## 本轮发行验证与执行清单

本机及不含原 Python 实现的公开源码隔离目录，均通过锁定依赖安装、类型检查、构建和源码测试：94 项中 90 项通过、4 项按环境条件跳过，无失败。合成文档和附件夹具共 857 个；本机原实现的 83 文件冻结基线检查通过。4 个跳过项涉及未启用的 Python／PowerShell Windows 模拟环境及非 Windows 的实机用例，不计为实机通过。

58 个公开源码文件已审查；真实验收资料与原 Python 安装保持在本机。JSON／TOML 示例及公共链接检查通过，测试中的身份和密码均为合成数据。运行包 dry-run 与实际 tarball 清单一致，共 21 个文件、57,208 字节；SHA-256 为 `4a74d43f808a70584317294334b631f53da5093cc6cbf228ecfee616bbb90fb2`。tarball 全部成员与本机发行产物逐字节一致，元数据、MIT 及 next／public／官方 registry 已核对。

含中文和空格的隔离目录安装通过：bin 可执行，离线 npx 返回 alpha.2，doctor 的零凭据／零网络检查为只读；实际 stdio 初始化、12 工具发现与非法参数拒绝通过，stderr 为空。隔离用户状态未发生写入。

以下检查在最终文件冻结后执行，实际结果由发行人员补记：

1. 使用固定工具链安装锁定依赖，运行类型检查、构建及源码测试，记录实际通过、跳过和失败项。
2. 审查 Git 将公开的完整源码、通用文档和合成夹具；核对个人状态、凭据及私有材料未进入源码提交。
3. 比对 `npm pack --dry-run --json` 和真实 tarball 的成员、元数据、许可及构建入口，并检查文件内容。运行包白名单不能替代 Git 源码审查。
4. 在包含中文和空格的干净临时目录安装 tarball，验证版本、CLI、stdio 初始化、工具发现、非法参数拒绝和只读状态；合成站点测试不访问真实凭据或业务站点。
5. 核对最终差异，提交并推送 main；推送成功后核对远端提交及公开内容。
6. 在 `typescript/` 发布 `npm publish --tag next`，核对 registry 的具体版本、`next` 标签及实际安装内容，再更新发行状态。

## 固定版本接入

发布成功后使用 `npx -y confluence-rest-mcp@1.0.0-alpha.2`，客户端不要跟随浮动标签自动升级。JSON／TOML 配置和认证步骤见 [使用说明](../typescript/README.md)。示例站点为 `https://confluence.example.com/confluence`，默认系统 Keyring，显式 `CONFLUENCE_READ_ONLY=true`。

登录由本人在交互终端隐藏输入；局部调整客户端启动字段，保留个人状态、系统凭据、已有本机实现和客户端策略。重载后在新会话实际读取正文、搜索和附件，独立确认宿主接入。
