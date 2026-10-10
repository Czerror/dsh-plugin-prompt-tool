# 渐进式披露的收窄端改用 `ctx.tools.restrict()`

状态：**方向已采纳，2026-10-10；尚未实施**（模块规则当前不声明 `tool-narrow`）。

## 背景

工具面的渐进式披露在本项目由两处组成：发现端是 `dev_tool_search`（[`engine/dev-tool-search.mjs`](../../engine/dev-tool-search.mjs)），收窄端是 `tool-surface` 模块的 `assembly` 动作——它在 `system-prompt/assemble` 的下游结算之后重写装配结果的 `tools` 数组（[`engine/actions/assembly.mjs`](../../engine/actions/assembly.mjs)），解锁项由 `allowFrom` 从持久的 `tool/call` 参数里回收。技能面是同一形状（`skill_search` / `skill_load` + `skill-surface` 拦掉全量目录）。

这条路能跑，但代价是**展示、查找、执行三处没有单一真相源**：展示由装配重写决定，查找与执行由注册表视图决定，两者只是「各自读同一份 allow 名单」的约定。官方因此把渐进式披露直接写成另一种做法：**当可见集变化时替换一个作用域化的 `ctx.tools.restrict()` 注册**（`docs/cookbook/extension-cookbook.zh.md` 的渐进式披露一节），并明确「对于需要在展示、查找和执行之间保持对齐的工具过滤，优先使用 `ctx.tools.restrict()`」。

## 决策

收窄端改用官方的实时过滤器，**发现端一行不动**：

- 收窄 = `ctx.tools.restrict({ allow: 常驻集 ∪ 已解锁 })`，**一条** restriction 会话；名单变化时 `dispose()` 旧的再挂新的（多条 restriction 取交集，叠加不会变宽）；
- 解锁 = `dev_tool_search` 执行时刷新那条 restriction，于是被解锁的工具**当场**在模型目录、查找与执行三处同时可用（三处一致由注册表保证，不再靠约定）；
- 发现 = 保持 `dev_tool_search` 与其描述不变。

配套三件（缺一件就是坏的中间态）：

1. **`ToolRestriction` 完整形态**：`allow` / `deny` 二选一（同时写即挂载期拒绝）。`deny` 是现在的真实缺口——`guard` 的 `deny` 只挡执行，模型照样看得见工具声明；
2. **收窄前的目录副本**：`restrict` 会砍掉 `ctx.tools.schemas(agent)`，`dev_tool_search` 的搜索视野随之只剩已解锁项。必须在挂 restrict **之前**把当时目录（名字 + 一行描述）存一份，搜索读副本、实时视图只用于校验工具是否存在；
3. **共享状态**：按 session/agent 键控的一处状态（restriction 的 disposer、当前名单、目录副本），`tool-narrow` 与 `dev-tool-search` 都通过它读写——否则解锁端会变成第二个真相源。

## 取舍

- **收益**：三处一致、执行层强拒绝、解锁当场生效（现有方案里解锁要等下一次装配）、收窄端与官方推荐一致。
- **代价一：restrict 只作用于继承的全局工具**。scope 自己注册的工具既不过滤也不受影响——本插件的 `dev_tool_search`、`skill_search`、自定义工具、角色卡 / 世界书 / 会话变量工具都注册在 agent scope，**一个都裁不掉**。所以改用 restrict 之后，插件自己的工具仍需 `assembly` 或 `guard` 兜底，收窄变成两套机制并用，而不是替换掉旧的。
- **代价二：动态解锁把「时机」问题重新引入**。`assembly` 重写是每请求重算的，天然跟随解锁；restrict 是常驻注册，必须显式刷新与撤销，否则解锁后的工具在下一步仍不可见。方案里的第 2、3 件就是为它付的账。
- **代价三：`requireMatch` 的 fail-open 语义要重新设计**。`restrict` 对未知全局名抛错，而现有 `assembly` 在名单里有工具缺失时**放弃裁剪、暴露完整目录**；接入 restrict 后要保留同样的兜底方向（宁可多给上下文，也不静默裁成空目录）。

## 后续

1. 先补 `tool-narrow` 的 `allow` / `deny` 完整形态（静态），确认重启后 restrict 真的生效；
2. 再加共享状态与「解锁当场刷新」，用相位 / 计数条件验证动态切换（命中替换、不命中撤销——`restrict` 只能收紧，撤销必须显式 dispose）；
3. 最后加收窄前目录副本与搜索读副本，并删除 `tool-surface` 里不再需要的 `allowFrom` 依赖。

判定条件：第 2 步做完后，`dev_tool_search` 的搜索必须仍能覆盖全量目录；覆盖不到就说明第 3 件没做完，此时**不要**把 `tool-surface` 切到 restrict 模式。

## 与历史决策的关系

- [ADR-0011](0011-module-participation-criteria.md) 固定的是「谁读哪个判据」；本 ADR 只动收窄通道，不改判据归属。
- 模块侧的同组互斥（`group` + `exclusive`）仍是「两种模式二选一」的表达手段，但**当前模块只保留无条件收窄一条**（2026-10-10 用户拍板先还原）；将来若并存两种模式，用现成的互斥组表达，不新造开关。
- `docs/engine-reuse.md` 的「工具面收窄与按需解锁」一节描述的是现状（`assembly` + `allowFrom`）；本 ADR 实施后需同步改写该节，而不是两处并存。
