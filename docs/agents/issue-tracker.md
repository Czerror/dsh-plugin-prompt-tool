# Issue tracker：本地 Markdown

本仓库的 Issue 和规格文档存放在 `.scratch/` 中。

## 约定

- 每项功能使用一个目录：`.scratch/<feature-slug>/`
- 规格文件为 `.scratch/<feature-slug>/spec.md`
- 实现任务分别存放于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 普通 Issue 的 triage 状态记录在文件顶部附近的 `Status:` 行，取值见 `triage-labels.md`；Wayfinding 子任务则使用下文的 `claimed` 和 `resolved`
- 评论和讨论追加到文件底部的 `## Comments` 标题下

## 当技能要求“发布到 issue tracker”

在 `.scratch/<feature-slug>/` 下创建新文件，必要时创建目录。完成标准：规范路径下的文件已写入完整请求，Issue 文件还包含当前 `Status:`。

## 当技能要求“获取相关 ticket”

读取用户指定路径或编号对应的完整文件，包括 `## Comments`。完成标准：当前请求、状态和既有决策均已纳入后续工作。

## Wayfinding 操作

- Map：`.scratch/<effort>/map.md`
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`
- `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`
- `Status:` 记录 `claimed` 或 `resolved`
- `Blocked by: NN, NN` 记录依赖
- Frontier：选择首个未解决、未阻塞且未认领的任务
- Claim：开始工作前将 `Status:` 设为 `claimed`
- Resolve：在 `## Answer` 下追加答案，将状态设为 `resolved`，再向 map 的 Decisions-so-far 添加上下文链接
