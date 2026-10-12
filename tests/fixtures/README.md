# 合成回归夹具

`document.json.gz` 固定 516 条正文、结构、章节和检索输入及预期结果；`attachments.json.gz` 固定 341 条文本、DOCX、XLSX 和数字格式输入及预期结果。

夹具来自 Python 0.14.0 的离线合成测试及一条 Unicode URL 用例，不包含真实站点内容、个人状态或凭据。默认测试直接读取这些黄金结果，公开源码无需包含旧 Python 实现。

`reads.json` 保留原 12 工具契约、错误、正文及预览向量；`history.json` 固定 57 条由 Python 标准库 difflib 独立生成的差异结果。测试直接读取夹具，无需旧运行时或实现。更新实现时保留失败类别、原值、Unicode 码点、覆盖说明、版本和指纹的语义；预期结果不能仅按 TypeScript 输出改写。
