# Domain Docs

布局：single-context，使用根目录 `CONTEXT.md` 和 `docs/adr/`。

## 探索前读取

- 根目录的 `CONTEXT.md`
- `docs/adr/` 中与当前工作相关的 ADR

完成标准：已读取所有存在且与任务相关的上述文档；文件不存在时静默继续。领域术语或决策实际形成后，再由 `/domain-modeling` 按需创建。

## 使用术语表中的词汇

Issue 标题、重构建议、假设和测试名称应使用 `CONTEXT.md` 定义的领域术语，避免改用其明确排除的同义词。

若所需概念尚未定义，应重新检查该概念是否属于项目；确有缺口时，交由 `/domain-modeling` 记录。

## 标明 ADR 冲突

输出若与现有 ADR 冲突，必须明确指出，不得静默覆盖。
