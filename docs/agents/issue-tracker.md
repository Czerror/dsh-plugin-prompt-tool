# Issue tracker: GitHub

本仓库的 Issue 和规格由 GitHub Issues 跟踪。普通 Issue 的分类和状态按 `triage-labels.md` 选择标签。[本仓库的 Issues](https://github.com/Czerror/dsh-plugin-prompt-tool/issues)

**PRs as a request surface: no.**

## 当技能要求“发布到 issue tracker”

在本仓库运行 `gh issue create --title "标题" --body-file <正文文件>`。返回的 Issue URL 用于引用规格或票据。

## 当技能要求“获取相关 ticket”

用 `gh issue view <编号> --json number,title,body,state,labels,comments` 读取正文、状态、标签和讨论。

## 决策变更的角色回复

修改 Issue、Spec 或 Map 的已有决策时，只在对应的 GitHub Issue 下追加角色回复。再次变更时另发一条回复，保留原正文和历次评论。

三个角色名由用户指定，分别为架构师、评审者、工程师。每条评论的首行只写实际发言的角色名，用 Markdown 加粗。空一行后，用自然语言写清原决定、新决定和变更原因。

```markdown
**架构师**

原定{原决定}，现改为{新决定}，因为{原因}。
```

在 Deck 中把整条回复放入 `deck_issue_patch` 的 `comment` 字段。使用 GitHub CLI 时，运行 `gh issue comment <编号> --body-file <评论文件>`。

## 查阅历史 Markdown 票据

以下是原有 `.scratch/` 票据的格式。按明确路径读取完整文件，默认检索可能跳过该目录。

### 约定

- 规格文件为 `.scratch/<feature-slug>/spec.md`
- 任务与子任务存放于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，一票一文件，编号在该目录内从 `01` 开始递增
- 普通 Issue 的 triage 状态记录在文件顶部附近的 `Status:` 行，取值见 `triage-labels.md`；同处用 `Category:` 行记录 `bug` / `enhancement`（category 与 state 各恰好一个）；Wayfinding 子任务则使用下文的 `claimed` 和 `resolved`
- 评论和讨论追加到文件底部的 `## Comments` 标题下

### 状态行必须是机器可读的

deck 只认拉丁字段名 `Status`（两侧的 `**` 当装饰剥掉，冒号全角半角都行），冒号后是状态词：

- 完成词 `resolved` / `completed` / `closed` / `done`，以及 `wontfix` → 票显示为已关闭；
- 其余值、或没有状态行 → 票一直显示为打开；
- 地图子票只有 `claimed` / `resolved` 两档。

中文写法 `**状态**：已完成` 不被识别——deck 从没打开过的票就是这么卡在 open 的。

### 票文件模板

实施票（`.scratch/<feature>/issues/<NN>-<slug>.md`）：

    # NN · 标题

    Status: ready-for-agent
    Category: enhancement

    ## 验收
    ...

完成时把状态行改成 `Status: resolved`。

容器（`spec.md` / `map.md`）读可见的 `Status:` 行优先，没有才读隐藏注释：

    <!-- DSH-STATUS: closed -->

取值 `open` / `ready-for-agent` / `closed`。

宿主提供 `deck_issue_patch` 时优先用它更新状态（关闭用 `close: true`）；未提供时用内置编辑工具更新上述状态行，完成后回读确认。

## Wayfinding 操作

- **Map** 用带 `wayfinder:map` 标签的 GitHub Issue 记录地图。[查看本仓库的地图 Issue](https://github.com/Czerror/dsh-plugin-prompt-tool/issues?q=is%3Aissue%20label%3A%22wayfinder%3Amap%22)
- **子任务** 在地图下创建 GitHub 子 Issue，按类型使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- **依赖** 在子 Issue 的 `Blocked by` 关系中关联阻塞它的 Issue。
- **Frontier** 按地图顺序选择首个仍打开、无人认领且所有阻塞项均已关闭的子 Issue。
- **Claim** 开工时用 `gh issue edit <子票编号> --add-assignee @me` 认领。
- **Resolve** 先在子 Issue 的评论中写下答案，涉及决策变更时使用[角色回复](#决策变更的角色回复)。随后用 `gh issue close <子票编号>` 关闭它，再到地图正文的 `Decisions-so-far` 追加一句摘要和这条评论的链接，供回查。
