# 模块参与判据：唯一真值源与按用途分的三个问题

状态：已采纳，2026-10-10。

2026-10-14 实时编辑补充：运行配装仍以总闸与启用表决定成员；已启用模块的定义暂时不可读属于读取失败，不再先过滤成未启用。候选完整校验失败时保留最后有效配装并告警，恢复后自动更新；明确从启用表移除仍撤销贡献。这一补充只调整运行读取失败的处理，不改变编辑主语与规则卡准入。

## 决策

**「一个模块是否参与」只有一个真值源**：存储根 `config.yml` 的启用表（`schemaVersion: 3` 的 `enabled` 列表）。`src/host/config-store.ts` 的 `enabledModuleIds()` 是它**唯一**的读取口，客户端不另立一份真相——它用的是 `/bootstrap` 下发的 `meta.modules[].enabled`，那是启用表的**副本**。

**判据按用途分，不合并成一个入口。** 五个消费者问的是三个不同的问题：

| 消费者 | 判据 | 它问的问题 | 为什么不合并 |
|---|---|---|---|
| 运行时装配（`src/index.ts` 的 `enabledModules`） | **总闸** && `enabledModuleIds()`；目录与定义在候选校验中检查 | 这个模块**现在参与装配吗** | 总闸关闭撤销贡献；定义读取失败保留最后有效配装并告警，不等同于停用 |
| 跨模块排序（`src/host/module-config-order.ts` 的 `readInputs`） | `enabledModuleIds()` | 已启用模块之间**怎么排** | 排序定义的编辑不该被总闸牵连 |
| 规则卡准入（`src/client/features/prompts/RulesWorkspace.tsx` 的 `owners`） | `meta.modules[].enabled`（启用表副本） | 这张卡**给不给编辑** | 用户 2026-10-10 拍板：启用表是第一优先级，其次才是 `_settings.yml` 与 `rules/*.yml` |
| 创建/模板写入目标（`src/client/features/prompts/useTemplatePicker.tsx` → `/rules` `createRule`） | 本次操作显式 `moduleId` + 用户目录内有效、可写的模块身份 | 这次创建**写入哪个模块** | 不查启用表或总闸；未启用模块也可作为目标，系统模板、损坏或只读模块仍拒绝 |
| 编辑通道（`src/runtime/settings-bridge.ts` 的 `/rules` 端点） | **不查启用** | 我**能不能读写**这个模块的定义 | 保留「先把模块写好、再启用」的能力 |

**模块与配置的身份同样只有一处**：`src/shared/module-config-order.ts` 的 `configIdentityKey({ moduleId, configId })` —— 规则区的卡、排序条目与运行时的 `promptConfigs` 共用它，所以「卡的身份链路」不会分叉。

**模块目录身份不是一张登记表，而是写死的路径结构**：`<modulesRoot>/<id>/` 加上 `module.yml` 的 `id`，由 `assertModuleDirectory` 强制两者一致（并拒绝符号链接、越界与大小写混淆）——它是那个约定的**执行者**，不是身份的载体。全仓没有 id→路径 的映射：定位一律 `join(root, id)`，唯一的 `moduleSpecCache` 也以**定义文件路径**为键。因此**身份含根**——不同根下的同一个 id 是**两个身份**（包内模板与用户副本一直如此），不构成冲突；反过来，「根传错」得到的是「操作到另一个身份」，属参数归属问题，不是身份冲突。

**入口表随实现更新（2026-10-12 核对）**：同一个问题「这次读写/装配属于哪个模块」在阶段 1／2 之后有 **6 个现存入口**，它们问的不是同一个问题，故不合并：

| # | 侧 | 入口 | 判据 | 它问的问题 |
|---|---|---|---|---|
| 1 | 请求 | `src/shared/bridge-contract.ts` 的 `readSubjectHeader` | `x-module-id` 头（`ok`／`absent`／`invalid`） | 这次请求**声明了**哪个模块 |
| 2 | 请求 | `src/runtime/settings-bridge.ts` 的 `editDir()` + `src/index.ts` 的 `moduleDirectory` 接线（`resolveRequestedModuleDir`）；TUI 侧的调用点是 `src/runtime/tui.ts` 的 `getModuleDirectory(moduleId)` | 声明存在且 `<root>/<id>/module.yml` 存在（TUI 的 `moduleId` 来自用户显式声明，未声明即传 `undefined`、解析为空） | 声明的主语**能不能解析成目录** |
| 3 | 请求 | `src/runtime/module-subject-gate.ts` 的 `subjectGate(tx, key, { write?, format?, declaration? })` | 请求头声明的目录 + 载荷主语 + `BRIDGE_SUBJECT_POLICY[key]` + `DECLARED_SECTIONS[key]`（`module.yml` 顶层键存在性） | 目标**是谁**／这次调用**凭什么成立**（门统一拒绝；未声明时回退启用表 `[0]` **已删**；**读**模块没声明该节 400 `module-not-declared`，**写**不查声明面并建立该节） |
| 4 | 请求 | `src/host/module-config-order.ts` 的 `readInputs` | `enabledModuleIds()` 后 `.sort()` 字典序 | 跨模块排序**按什么取输入与定序**（排序首项与声明顺序首项不是同一个） |
| 5 | 请求 | `src/host/persona-selection.ts` 的 `personaSources` | `config.yml.personaSources` 的 main／subagent 引用 | 人设正文**读哪个模块**（与启用表正交） |
| 6 | Agent | `src/host/module-tool-target.ts` 的 `resolveModuleToolTarget` + `MODULE_ID_PARAM` | 这次调用显式声明的 `moduleId`（`<root>/<id>/module.yml` 存在性由 `assertModuleDirectory` 复核；该 Agent 的装配记录只作拒绝提示） | 模块工具**这次读写哪个模块**（**无声明即拒绝**，不再默认落到任何模块） |

**已删入口（登记备查，不计入上面的 6 个）**：

- 客户端传输层的**模块级可变全局目标**（`src/client/data/bridge-transport.ts` 的 `editTarget` 与默认头，随 `c8fc22ae` 删除）——`postBridge` / `bridgeCall` 的 `subject` 实参仍在，但它每次调用显式传入、不持有状态。
- 客户端 store 的目标写入点（`src/client/data/use-prompt-tool-store.ts` 的 `setModuleId` 与单主语事实镜像）——`rg 'setModuleId' src test` 现已零命中，主语由卡片归属决定。

「表随实现更新」：本表按落地时的 `rg` 结果登记，不承诺入口数长期不变——阶段 1 删掉两处猜目标的入口、阶段 2 把归属判据收进 `subjectGate`（入口 3，见 [ADR-0014](0014-module-subject-declared-per-operation.md)），阶段 3 的声明面与阶段 4 的 Agent 侧／TUI 已落地（入口 2 与入口 6 已按下述口径更新，未新增入口行：TUI 的会话主语是「用户声明」的状态，仍走入口 2 的目录解析，不另立判据）；新增消费者时先回答它问的是上表哪一类问题，再登记。

## 取舍

- **不引入 `isModuleActive()` 之类的统一判据**：表里那三个问题的答案本就不同，合并的结果只能是加参数区分（等于没统一），或者删掉「总闸关闭仍可改排序定义」这条既有行为。
- **总闸刻意不进 UI 的可见性**：`docs/ui-architecture.md` 的配置排序一节写明「模块启用或停用均可保存自身排序，**总闸关闭仍可改排序定义**」。规则区对总闸的反馈是**只读**（`RulesWorkspace` 的 `readOnly` 读 `fields.modulesEnabled`），不是隐藏。
- **一致性来自真值源唯一，不来自入口唯一**：客户端拿的是服务端下发的副本，两侧不会各自解释「启用」的含义。
- **卡片准入与编辑通道的差异是设计**：前者按启用表收窄，后者保留（编辑未启用模块是准备动作）。这两处看起来「不一致」，但回答的是不同问题。

## 后续

- 新增消费者时，先回答「它在问这三个问题里的哪一个」，并在上表登记；**不要**因为「别处已经有判据」就直接复用。
- 卡片准入的收窄（2026-10-10，提交 `c35b93bc`）仍只约束规则卡展示与卡内读取：未启用模块不出卡、不发卡内 `/rules`；模板创建与显式编辑目标不受该收窄影响，可先写未启用模块再决定是否启用。
- 真值源若将来变化（例如启用表增列），只需改 `enabledModuleIds()` 与 `/bootstrap` 的下发，装配与卡片消费者不动；显式创建/编辑目标仍按本次 `moduleId` 判定。

## 与历史决策的关系

- [ADR-0008](0008-module-slices-memory-assembly.md) 的模块切片与内存装配不变：本 ADR 只规定「谁按什么判据决定参与」，不改写盘与装配机制。
- [ADR-0010](0010-two-history-views.md) 管的是会话历史的视图归属，与模块参与无关。
- [ADR-0014](0014-module-subject-declared-per-operation.md) 把「写入目标」从启用表旁路出去（主语由这次操作声明，缺声明即无目标）：本 ADR 的三个问题与「编辑通道不查启用」不变，启用表仍然只回答「谁参与装配」。
- `docs/ui-architecture.md` 的模块列表与配置排序两节是本 ADR 的事实依据。
