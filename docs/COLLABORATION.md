# Confluence 协作工具

`confluence-rest-mcp` 1.0.x 在原 12 个工具基础上提供 7 个协作工具，共 19 个。开发验证使用根目录构建后的 `dist/cli.js`，公开包安装方式见 README。

## 标签、评论、复制、移动和附件

- `get_labels`：读取页面 global 标签，默认每页 25 项，按 `pagination.next_start` 续读。`expected_version` 校验页面版本；标签变化独立于页面版本，不能作为标签快照指纹。
- `add_labels`：添加 1–20 个不重复的 global 标签，保留已有标签。
- `remove_label`：删除一个指定标签，保留其他标签。
- `add_comment`：以 `body_storage` 添加页尾评论，用于记录需求疑问或评审结论。
- `copy_page`：指定源页面版本、新标题、目标空间和可选父页面，复制单页 storage。源和目标空间都须通过写空间策略。正文引用保持原样；子页面、附件、评论、标签和权限需要独立处理。源 storage 必须符合现有创建工具的非空和 1 MiB 限制。
- `move_page`：在同一空间下更换父页面，保留标题和 storage，以当前版本加 1 提交。拒绝自身、后代页面和跨空间父页面；Confluence 按其正常规则处理移动页面的后代。
- `upload_attachment`：从绝对 `file_path` 上传一个本地普通文件，文件最多 4 MiB。预览只返回文件名、字节数和 SHA-256，提交时重新读取文件；文件改变会使原 `preview_hash` 失配。预检拒绝同名附件，服务端请求固定 `allowDuplicated=false`，不调用已有附件的数据更新接口。

原有 12 个工具的 schema、annotations、默认值和错误契约保持；本机 `enabled_tools` 可包含新工具。缺省策略暴露完整工具目录，真实写入仍默认关闭。

## 预览和提交

所有新增写工具必须提供 `pageId` 和 `expected_version`，默认 `dry_run=true`。先读取页面取得版本，再查看完整预览，例如添加标签：

```json
{
  "pageId": "123",
  "expected_version": 7,
  "labels": ["release", "review-needed"]
}
```

评论示例：

```json
{
  "pageId": "123",
  "expected_version": 7,
  "body_storage": "<p>请确认优惠规则的生效日期。</p>"
}
```

复制和移动分别使用以下参数：

```json
{
  "pageId": "123",
  "expected_version": 7,
  "space_key": "TEAM_DOCS",
  "title": "需求评审副本",
  "parent_id": "456"
}
```

```json
{
  "pageId": "123",
  "expected_version": 7,
  "parent_id": "456"
}
```

本人明确授权具体目标及内容后，用相同参数添加 `dry_run=false` 和预览返回的 `preview_hash`。哈希保留可选契约，但提交时应携带；它检测目标、内容和文件变化，不代替授权。协作写入哈希同时绑定已校验的页面版本。

真实提交同时要求 Basic 身份、本机 `auth.json` 的 `allow_write=true`、进程未强制只读、工具已启用、非空 `write_spaces` 允许服务端实际空间，以及 Confluence 本人权限。环境变量 `CONFLUENCE_READ_ONLY=false` 不能独立打开写入。

复制会创建页面；移动会调整页面树；评论可能触发通知；标签可能影响搜索和自动化。预览不执行这些副作用。写入冲突不重试，超时、断线或响应不符合预期时返回 `WRITE_UNCERTAIN`，先读回状态再决定下一步。

标签、评论和附件接口没有页面版本条件写入：提交前会复核页面版本、内容和空间，但预检与实际写请求不构成事务。页面在最后复核后仍可能发生变化，应避免同时移动或编辑目标。标签集合没有版本指纹，不能用页面版本证明标签没有被其他人调整。

## REST 依据与验证范围

实现使用 [Confluence Server 6.11.2 REST API](https://docs.atlassian.com/ConfluenceServer/rest/6.11.2/)：标签 GET／POST／DELETE、评论 POST content、复制 POST content、移动 PUT content 的 ancestors、附件 multipart POST child/attachment。附件请求包含 `X-Atlassian-Token: nocheck` 并保持 HTTPS、同站路由、认证来源和响应大小限制。

合成回归覆盖默认预览零写入、工具及空间门禁、参数拒绝、复制正文保留、移动环路／跨空间／版本冲突、文件哈希变化／大小／同名拒绝、multipart 原始字节、DELETE 204、响应失配和写入不重试，以及 SDK 实际工具发现及调用。真实站点写入、Windows 和 Cursor 验收需独立执行。
