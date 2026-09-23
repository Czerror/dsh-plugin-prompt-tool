# Issue tracker：本地 Markdown

本仓库的 Issue 和规格文档存放在本地作业区 `.scratch/` 中（该目录被 `.gitignore` 忽略，不入库；用 `read` 工具直接读文件，检索工具按默认忽略规则看不到它）。

## 约定

- 规格文件为 `.scratch/spec.md`
- 任务与子任务存放于 `.scratch/issues/<NN>-<slug>.md`，编号在该目录内全局递增
- 普通 Issue 的 triage 状态记录在文件顶部附近的 `Status:` 行，取值见 `triage-labels.md`；Wayfinding 子任务则使用下文的 `claimed` 和 `resolved`
- 评论和讨论追加到文件底部的 `## Comments` 标题下

## 当技能要求“发布到 issue tracker”

按上述路径创建新文件，必要时创建目录。完成标准：规范路径下的文件已写入完整请求，Issue 文件还包含当前 `Status:`。

## 当技能要求“获取相关 ticket”

读取用户指定路径或编号对应的完整文件，包括 `## Comments`。完成标准：当前请求、状态和既有决策均已纳入后续工作。

## Wayfinding 操作

- Map：`.scratch/map.md`
- 子任务：`.scratch/issues/NN-<slug>.md`
- `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`
- `Status:` 记录 `claimed` 或 `resolved`
- `Blocked by: NN, NN` 记录依赖
- Frontier：选择首个未解决、未阻塞且未认领的任务
- Claim：开始工作前将 `Status:` 设为 `claimed`
- Resolve：在 `## Answer` 下追加答案，将状态设为 `resolved`，再向 map 的 Decisions-so-far 添加上下文链接
