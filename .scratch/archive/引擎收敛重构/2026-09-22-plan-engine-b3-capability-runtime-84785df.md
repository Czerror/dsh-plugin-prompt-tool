# B3 触发器引擎 PLAN（判断原语 + 动作库）

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支把引擎从「一堆针对特定模型问题的专用模块」重构为**一个触发器引擎**：**判断（predicate）→ 执行（action）**。

> 本支在 2026-09-22 的评审后重新定义：原范围是「实现通用 capability 运行时并迁移 13 个模块」，现范围是「实现触发器引擎（判断原语库 + 动作库）+ 三个能力提供者保持独立」，专用能力的重建与删除移交 B7。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；依赖 B2（字段声明）。
- 用户拍板（原话）：
  - `因为有一些是过时设计,用来调整模型能力. 所以本项目需要精简,即引擎能力 只需要 条件判断 行为判断等判断或 字词句锚定 对应执行即可`；
  - `全删除,只保留机制,同时 subagent-tool-policy tool-config-engine str-replace-editor 是必须保留的功能`；
  - `主要是黑白名单语义不明, 用户会理解未 白名单中增加 即可使用,黑名单中增加 不可使用`。

## 审查结论

### 1. 现有 10 个能力里，7 个是「判断 → 执行」，3 个是能力提供者

| 能力 | 判断 | 执行 |
|---|---|---|
| `tool-filter` | 名单 | 剔除工具 |
| `tool-bootstrap` | 相位 | 窄化 / 恢复目录 |
| `context-gate` | 相位 + 来源 | 清空 contexts / 过滤消息 |
| `anchor-turn` | 会话状态 | prepend 消息 |
| `deliberation-gate` | 计数 / 阈值 | `{kind:'deny'}` |
| `progress-reminder` | 计数 | 追加上下文 |
| `promoted-code-mode` | 相位 | `presentAs('ptc')` |
| `subagent-tool-policy` / `tool-config-engine` / `str-replace-editor` | — | **能力提供者**（注册工具/域），不进引擎 |

### 2. 判断需要七类原语，只有两类已有实现

| 原语 | 现状 |
|---|---|
| **文本锚定**（字/词/句、any/all/not/notAny、整词、正则） | ✅ `anchor-match.mjs`（137 行） |
| **相位**（晋升 / compaction epoch） | ✅ `compaction-epoch.mjs`（150 行） |
| **来源**（`source.kind` / `source.plugin`） | ❌ `context-gate` 自写一套；`isMnemonPluginMessage` 一类零散实现 |
| **计数 / 阈值**（次数、字符数、轮次） | ❌ `deliberation-gate.mjs:49-76` 的 turns Map、`progress-reminder.mjs:44-54` 的 state 各写一套 |
| **名单**（名称集合） | ❌ `tool-filter.mjs:37-43` 的 `nameSet` + `context-gate.mjs:103-127` 的三个孪生 helper |
| **会话状态**（如"会话内无 `user/message`"） | ❌ `anchor-turn.mjs:35-38` 直接用 `sessionEvents` 扫 |
| **当前预设** | ❌ 本项目**没有**这个判定；host 侧只有部署级的 `agent-presets.default`（新会话默认值），语义不同 |

**第 7 类「当前预设」是四种来源里唯一正确的那一个**，依据来自官方源码（非转述）：

- `packages/preset/agent-presets/src/index.ts:504-505`：`composedPreset(agentCtx) { return standingMountFor(agentCtx)?.presetId }`——**服务方法就是模块导出的包装，同源**；
- 同包 `invariant.ts:48,61-64`：内核自己就用 `composedPreset()` 判「这个 agent 有没有 join 预设」；
- 同包 `mount.ts:243-248`：`standingMountFor` 在 `livePresetMounts()` 里按 scope 匹配，读的是 **live scope chain**；
- 同包 `session.ts:12`：**「Reconstruction reads the `agentPreset` Session projection, **never the header**」**——`header.agentPreset` 是出生预设，不可信（对标项目 dsh-agent-studio 亦有真机实测：该字段写着 `custom-standard` 而 agent 实际跑在 `dsh-studio-lab` 上）；
- 四种来源的正确性排序（**进程内**判定）：`composedPreset(agent.ctx)` ✅ > 会话投影（初值取自 header，之后由 `agent-preset/selected` 推进）⚠️ > `header.agentPreset` ❌ > `agent-presets.default`（**新会话默认值**，与已存在 agent 的挂载无关）❌。
- **但官方对"跨边界"用的是投影，不是 `composedPreset`**：session-controller 对外给出的"会话当前预设"读 `sessionProjections.stateOf(session, 'agentPreset')`（`agent.ts:361`、`:515`、`skill-catalog.ts:40-47`），且客户端 remote 面根本不暴露 `composedPreset`。**所以两种取法不是替代关系而是分工**：进程内（有 `agent.ctx`）用 `composedPreset`，跨 API/客户端边界用投影。本项目客户端跟随走投影**与官方契约一致**，不改。
- **边界**：`undefined` 的含义是「该 agent 没有预设」（裸 agent），**不是取不到**，**不得回落默认值**；调用方按"不干预 / 不命中"处理。

**注意**：`deliberation-gate` 的"深思判断"不是字词锚定，而是**文本长度阈值**（`deliberation-gate.mjs:12-13`「当前轮深度 < `minChars` → deny」）；做词检测的 `classifyReasoning`（`we`/`let me`）在 `compaction-epoch.mjs:37-53`，只被 `promoteGate` 使用。所以"字词句锚定"这一条原语覆盖不了计数类判断。

### 3. 执行需要七类动作：四类已有实现但分散，三类缺失

| 动作 | 现状 |
|---|---|
| 注入文本（九层） | ✅ `layers.mjs` + `executor.mjs` |
| 改装配（tools / sections / contexts） | ❌ 各模块在 `system-prompt/assemble` 里各写一份 |
| 裁决工具调用（allow / deny / ask） | ❌ `layers.mjs:371-412` 与 `deliberation-gate.mjs:124-135` 各写一份 |
| 追加上下文 / 续跑 | ❌ `progress-reminder.mjs:92-110`、`layers.mjs:442` 各写一份 |
| **执行层 guard**（`ctx.tools.guard()`） | ❌ **本项目完全缺失**（R4 的两条独立来源同向：官方扩展点表 + `dsh-agent-studio` 的三层收窄） |
| 裁 SDK 声明文本（`tools:sdk`） | ❌ 缺失——`tool-filter` 只改 `assembly.tools`，PTC 下被剔工具仍在 SDK 正文里可见可调用 |
| 改模型请求参数（`agent/request`） | ⚠️ 已有**声明层**先例：`layers.mjs:296-314` 的 `agent-request` 层（`params.patch` / `params.replace`），但未进统一动作库，且浅合并不支持按值条件删键 |

### 4. 注册样板重复（沿用本次收敛的既有结论）

18 个 waterfall 监听器 + 15 处同步旁听、三种改写姿势；`createWarnOnce` 3 份实现；降级四类语义且文案格式不统一；9 个模块无 disposer。

## 影响面、依赖与护栏

- 新增 `engine/trigger.mjs`（触发器引擎）、`engine/predicates.mjs`（判断原语库）、`engine/actions.mjs`（动作库）；扩展 `engine/shared.mjs` 的会话态声明——**最小接口（键类型 + 计数/标志两类形态，含 `rebuildable` 标注）由本支定义**，B4 只负责把既有模块迁移到它（R7）。
- 硬约束：
  - **不删除任何现有模块**（删除与重建归 B7）；本支只新增引擎并让 B7 有可用的原语。
  - 三个能力提供者**不接入触发器引擎**，保持独立装配。
  - 官方 seam 语义不可伪造（ADR 0002）；不引入依赖；`engine/` 保持自包含。
- 与 B4 的分工（R7）：判断原语里的**计数/会话状态**需要统一的有界状态容器，**该容器的最小接口由本支定义并落在 `engine/shared.mjs`**（键类型、两类形态、`rebuildable` 标注）；B4 只做既有模块到该接口的迁移与策略变更，**本支不等待 B4 交付**，两支不再互为前置。

## Wave 1：判断原语库

```xml
<task type="auto">
  <name>T1：新增 engine/predicates.mjs（七类判断）</name>
  <files>engine/predicates.mjs（新增）；engine/anchor-match.mjs；engine/condition.mjs；engine/compaction-epoch.mjs；engine/shared.mjs</files>
  <action>把判断收敛为一个统一的谓词接口 predicate(payload) → boolean：文本（包 anchor-match，支持字/词/句、any|all|not|notAny、整词、正则）、相位（包 createEpochPromotion，支持 epoch 边界与「不订阅复位」两种语义）、来源（`source.kind` / `source.plugin`，含大小写与精确/前缀两种比较）、计数（次数、字符数、轮次，带上限与冷扫重建）、名单（名称集合，含大小写规则）、会话状态（如 user/message 计数为 0）、**当前预设**（第 7 类，取法见下）。多个谓词可组合（and/or/not），组合语义与 anchor-match 的 logic 保持一致的表达习惯。

**第 7 类「当前预设」的取法只有一种正确写法**（依据：官方 `packages/preset/agent-presets/src/index.ts:504-505` 的 `composedPreset(agentCtx) { return standingMountFor(agentCtx)?.presetId }`——服务方法就是模块导出的包装，**同源不是两个来源**；官方内核自己在 `invariant.ts:48,61-64` 用它判「这个 agent 有没有 join 预设」；`mount.ts:243-248` 读的是 live scope chain）：

```js
const id = ctx.get?.('agentPresets')?.composedPreset?.(agent.ctx)          // 首选
  ?? standingMountFor(agent.ctx)?.presetId                                 // 服务未就绪时的同源兜底
```

三条硬约束必须写进实现注释与测试：(1) **禁止读 `session.header.agentPreset`**——它是出生预设，官方 `session.ts:12` 明写「Reconstruction reads the `agentPreset` Session projection, **never the header**」，另有真机实测该字段与 agent 实际挂载不一致；(2) **禁止用 `agent-presets.default`**（宿主 settings 的 default）当当前预设——它是**新会话的默认值**，与任何已存在 agent 的挂载无关；(3) **`undefined` 的含义是「该 agent 没有预设」**（裸 agent），**不得回退到默认值**，调用方按"不干预/不命中"处理。

**适用边界（同样必须写进注释，否则会被误用）**：`composedPreset` 只在**进程内、拿得到 `agent.ctx`** 时可用——装配期的 `context.agent.ctx`、子代理认领、引擎能力。**跨 API/客户端边界没有这个方法**：官方 `ctx.remote.agentPresets` 只暴露 `list / read / copy / deletePreset / select`（见 `packages/client/ui-agent-preset/src/client/{settings-store,section-store,seat-store}.ts`），**不含** `composedPreset`；而官方 session-controller 对外给出的"会话当前预设"读的正是**会话投影**——`agent.ts:361` `this.ctx.sessionProjections.stateOf(session, 'agentPreset')`、`agent.ts:515`、`skill-catalog.ts:40-47`。

因此本项目**客户端的会话跟随路径继续用投影是正确的**（与官方对外契约一致，且客户端拿不到 `agent.ctx`），**不得**改成 `composedPreset`。两者分工是：**进程内判定用 `composedPreset`，跨边界用投影**（正常情况下二者一致；不一致时 `composedPreset` 更即时，因为它读 live scope chain 而不依赖事件落盘）。</action>
  <verify>每类谓词单独断言：命中与不命中的边界输入；组合断言（and/or/not 的短路与优先级）；计数类断言的冷启动重建路径；相位类的两种复位语义（订阅 / 不订阅）分别可表达；**预设类**断言三条硬约束：无 standing scope 时返回 undefined 且调用方不命中（不回落默认）、服务缺席时走模块导出兜底得到同一结果、用真实 `agent/ctx` 的 live 挂载对照（不用 header 字段造夹具）。断言引用现有实现的等价性：文本类与 anchor-match 逐例一致、相位类与 compaction-epoch 逐例一致。</verify>
  <security>谓词只读判断、不产生副作用；不得在判断中执行 IO；不得因为统一而放宽任何匹配严格性（非法正则、空键集合仍在挂载期 fail loud）。</security>
  <done>七类判断有统一接口，其中文本与相位两类与现有实现逐例等价。</done>
</task>
```

## Wave 2：动作库

```xml
<task type="auto">
  <name>T2：新增 engine/actions.mjs（七类动作）</name>
  <files>engine/actions.mjs（新增）；engine/layers.mjs（既有 `agent-request` 层，本类与其复用同一实现）；engine/executor.mjs；engine/sdk-声明裁剪模块（新增）</files>
  <action>把执行收敛为统一动作接口：(1) 注入文本（复用九层的注册通道，不新开通道）；(2) 改装配（对 `assembly.tools` / `sections` / `contexts` 的增删改）；(3) 裁决（pre-execute 的 allow|deny|ask 与 post-execute 的 accept|replace|block）；(4) 追加上下文与续跑；(5) **执行层 guard**（`ctx.tools.guard()`，官方定位是「不可被后续策略解除的最终拒绝」）；(6) 裁 SDK 声明文本；(7) **改模型请求参数**（`agent/request` 载荷）。

**第 (5) 类不是可选补充，而是唯一能兜住执行的口子**（依总纲 R4 与本轮外部佐证，两条独立来源同向）：已发布工具包在 `run_code` 执行时**从 `registry.schemas(exec.agent)` 建绑定，不从裁过的 SDK 正文建绑定**——所以只裁文本挡不住「知道旧工具名」的调用；而 `scope restrict` 只收继承面，注册在 **agent 本层**与**晚到**的工具它收不动。因此：(a) **同一份名单判据同时驱动呈现过滤与执行 guard**；(b) `restrict` 只在它能限制的继承面上复用，本层/晚到工具一律交给 guard 裁决；(c) SDK 这一步必要时**按更新后的视图经官方 `sdkSection().text(context)` 重生**，文本裁剪只是剩余呈现补救，**不得替代执行边界**；(d) **不新增独立策略提供者**。第 (6) 类的解析必须覆盖 **TypeScript 与 Python 两种载荷**（已发布工具包同时支持两者，只认 TS `interface` 会让 Python 直接漏过）。每个动作声明其合法事件通道与降级语义（keep / expose-all / empty / silent）。

**第 (7) 类必须与既有 `agent-request` 层同源**（`engine/layers.mjs:296-314` 的 `wireAgentRequests`：`params.patch` 浅合并 / `params.replace` 整体替换，由 `promptConfigs` 驱动）——**不得**为触发器再写一套请求改写，二者共用同一实现。除 patch/replace 外，本类必须支持**按值条件删键**：`bootstrapMaxTokens` 的剥离语义是「仅当解析后的 `maxTokens` **恰好等于本声明注入的那个值**时才删除该键」（`engine/tool-bootstrap.mjs:464-472`），**不是**「存在即删」；现有 `patch` 的浅合并**做不到删键**，故必须显式定下删键语义（如 `undefined` 即删，或独立的 `unset` 通道）。位置策略沿用既有实现：该预算监听现注册为 `{ prepend: true }`（`engine/tool-bootstrap.mjs:478`），与第 ② 项属同一类「否决型最外层」诉求。</action>
  <verify>每类动作：注册通道、触发时机、降级语义与现有实现逐条对拍；断言「动作只在其合法通道注册」。第 (5)(6) 类另需**真实 PTC 子调用拒绝**——构造携带被剔工具名的 `run_code` 载荷，断言执行被 guard 拦下，而不是只断言文本里没有该工具；并覆盖 TS 与 Python 双载荷、预设切换后的首个请求、主子代理隔离、挂载失败与 disposer 释放。第 (6) 类的解析用例还要覆盖：形态异常时原样返回、删后自校验失败退回原文、需引号转义的工具名、空名单零开销。第 (7) 类对拍三种语义：`patch` 浅合并、`replace` 整体替换、**按值条件删键**（值不等时保留、相等时删除），并断言既有 `promptConfigs` 的 `agent-request` 层行为逐字段不变（B1–B6 零行为变更纪律）。</verify>
  <security>guard 是最终拒绝层：**不得被任何后续策略解除**，也不得因统一而降级成「可被覆盖的建议」；改装配不得越过 scope（不改 `global`）；SDK 裁剪**只删不增**且保守失败——裁错会破坏 PTC 下模型对工具形态的认知；追加上下文不得伪造 assistant 角色消息。第 (7) 类只改命中 scope/agent 的请求参数，不得跨 scope 生效；删键必须「只删本声明注入的那个值」，不得删除模型或其它插件设置的同名参数。</security>
  <done>七类动作可用，其中执行层与真实 PTC 子调用拒绝有**行为证明**（非文本断言）。</done>
</task>
```

## Wave 3：触发器引擎

```xml
<task type="auto">
  <name>T3：新增 engine/trigger.mjs（声明 → 注册）</name>
  <files>engine/trigger.mjs（新增）；engine/fields.mjs（B2）；engine/shared.mjs（**本支定义的 session 声明最小接口**）</files>
  <action>实现 `trigger({ id, when, do, schedule, degrade, state })`：`when` 是 predicates 的组合、`do` 是 actions 的一个或多个、`degrade` 表达兜底语义、`state` 表达该触发器需要的会话态（计数/阈值/相位）。

  **`schedule` 必须拆成两个互不混淆的字段**（R13 修正——原方案把数字 `order` 直接映射为 Cordis 的布尔 `prepend`，**不成立**：Cordis `src/events.ts:234-243/254-257` 只有外层 waterfall 与 `unshift`/`push`，多个 prepend 的顺序由**注册先后反转**决定，并不比较数字，也不提供跨插件的最终否决）：
  - `channelOrder: number` —— **同一官方通道内**的声明顺序，由运行时做有界稳定排序（升序、同值保持声明序），并注明该动作在 `next()` **之前**还是**之后**执行；
  - `waterfallPosition: 'default' | 'outermost'` —— 适配器在宿主 waterfall 中的位置，**保持既有的布尔注册策略**（现状是 prepend 的就 prepend，不是的就不是），**不得**用它承担声明间排序；
  - **跨九层的全局调度禁止**；`prepend` 也**不得**替代 guard 的单调执行边界。

  **声明契约与落位（R6）**：本支必须同时定义该声明在 `preset.yml` 中的**位置**、**校验与物化入口**，并说明它与既有 `promptConfigs` 的关系——**二者不能各自保留独立的判断/执行实现**，必须复用同一触发器运行时。落位沿既有 `writePreset` / `rebuildPreset` 链接入（候选路径与 materializeOnly 语义沿用既有实现），**不新开第二条存储通道**。

  运行时负责：注册（含 keepDisposer）、降级 catch 与统一告警、声明驱动的配置解析（复用 B2 的 fields.mjs）、会话态生命周期（用本支定义的 session 声明最小接口；B4 负责把既有模块迁移到它）。</action>
  <verify>表达力与边界分别验证：(a) 用声明重建 `tool-filter`（名单判断 + 剔工具动作）与 `deliberation-gate`（计数判断 + deny 动作），与现有模块在同一组输入下输出相同；(b) **两层顺序互不越界**——改 `channelOrder` 只改变同通道内次序、不改 waterfall 位置；改 `waterfallPosition` 只改位置、不承诺稳定排序；同值声明保持声明序；(c) 用**真实 cordis** 断言 `outermost` 映射为 prepend（mock 不实现该语义）；(d) 断言不存在跨通道的全局排序；(e) 声明落位走通「保存 → 重建 → 重载」全程（R6），不接受「无加载错误」作为等价证明。</verify>
  <security>触发器引擎不得吞掉下游异常（沿用「只 guard 自身逻辑」纪律）；不得因统一而放宽任何过滤；不得引入跨 scope 的 global 注册。</security>
  <done>触发器引擎可用，且能用声明重建至少两个现有能力的完整语义。</done>
</task>
```

## Wave 4：提供者边界

```xml
<task type="auto">
  <name>T4：明确三个能力提供者的边界与接入方式</name>
  <files>engine/{subagent-tool-policy,tool-config-engine}.mjs；engine/compositions/source/local/{subagent-tool-policy,tool-config-engine,filesystem-editor}.yml</files>
  <action>三个提供者**不接入触发器引擎**，但统一其样板：配置声明走 B2 的 fields.mjs、注册走 keepDisposer、降级告警走统一格式。**文件归属校正**（依总纲「旧能力如何归入固定架构」末段）：`str-replace-editor` 由 `engine/compositions/source/local/filesystem-editor.yml:20` 引用**官方** `@deepseek-ai/dsh-tool-str-replace-editor`，本仓库没有对应 `.mjs`；`engine/tool-git-bash.mjs` 提供的是 `bash` 工具，**不是**第三个指定提供者。文档写明「提供者 vs 触发器」的分类判据：会给模型提供可调用能力的进提供者，干预流程（改提示词、改装配、裁决、追加）的进触发器。

**可选改进（登记不阻塞本支）**：官方推荐服务定义用 `Service` 子类 + `declare module '@deepseek-ai/cordis'` 声明合并 + `super(ctx, name)`（`service-provider-plugin-tutorial-draft.md:103-148`）；本项目现用 `ctx.provide('pt-*', 普通对象)`，消费方只能 `ctx.get(...) as XxxService` 手写断言（全仓无 `declare module`）。会波及三处服务与全部消费点，**本支不改**，仅作为后续候选登记。</action>
  <verify>三个提供者的行为零变更（逐条对拍）；新增断言「引擎模块要么是声明式触发器、要么是显式登记的能力提供者」，防止将来把提供者误塞进触发器。</verify>
  <security>subagent-tool-policy 的扩权审批门与 fail loud 语义不得触碰；tool-config-engine 的 approvalGate 与 withinCwd 不得触碰。</security>
  <done>分类判据写入文档并有守卫，提供者样板收敛。</done>
</task>
```

## Wave 5：决策可见性

```xml
<task type="auto">
  <name>T5：装配决策链的一次性诊断输出</name>
  <files>engine/trigger.mjs；engine/actions.mjs；engine/shared.mjs</files>
  <action>借鉴 dsh-agent-studio 的 `reportFirstDecision`（`apply.ts:238-250`）：一次装配「看起来没生效」时，原因可能有多种而**结果长得一样**——取不到 agent/session、解析不出预设、触发器未启用、谓词未命中、动作被外层门控剥离、名单为空。在触发器引擎里做一条**每会话只报一次**的决策链日志：按顺序列出每个触发器的判定依据（触发器 id、谓词类别与命中结果、动作是否执行、是否走了降级分支），让「为什么这次没生效」一次可读，不必逐项试。</action>
  <verify>构造五种「没生效」场景（缺 agent、缺 session、触发器 disabled、谓词未命中、动作被外层门控剥离），断言决策链日志能区分它们、各只出一条；断言默认关闭时零额外日志（不改变现有日志行为）。</verify>
  <security>诊断输出**不得打印消息正文、变量值或用户内容**（只输出触发器 id、谓词类别与命中结果、动作名与降级类别）；日志自身失败不得影响装配。</security>
  <done>「没生效」的原因可一次读清，默认不影响正常路径。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交。本支只新增引擎文件与最小接入，**不删除任何现有模块**，因此回滚风险低。中断检查点：新增的引擎文件若不完整，B7 不得开工。

## 状态

- [x] T1 判断原语库（七类，含「当前预设」的取法与三条硬约束）—— `engine/predicates.mjs`（576 行）+ `test/engine/predicates.test.mjs`（22 例）。
- [x] T2 动作库（七类，含 SDK 声明裁剪与改模型请求参数）—— `engine/actions.mjs`（539 行）+ `engine/sdk-strip.mjs`（365 行）+ `test/engine/actions.test.mjs`（38 例）。
- [x] T3 触发器引擎 —— `engine/trigger.mjs`（278 行）+ `test/engine/trigger.test.mjs`（11 例）+ `test/engine/trigger-rebuild.test.mjs`（7 例，验收条款 (a)）。
- [x] T4 提供者边界与样板收敛 —— `test/engine/provider-boundary.test.mjs`（8 例）+ 三个提供者的 `engineProvider` 登记与样板统一。
- [x] T5 装配决策链的一次性诊断输出 —— `createDecisionLog`（`trigger.mjs`），断言含在 `trigger.test.mjs`。

## 验收记录

本轮为方案产出，未执行。查证证据：10 个能力的判断/执行拆解表（逐模块行号见审查结论）、七类判断原语的现状分布、`deliberation-gate.mjs:12-13` 的长度阈值语义（修正"字词锚定可覆盖深思门控"的误判）、`deliberation-gate.mjs:49-76` 与 `progress-reminder.mjs:44-54` 的计数实现、`tool-filter.mjs:37-43` 与 `context-gate.mjs:103-127` 的名单 helper 重复、`anchor-turn.mjs:35-38` 的会话状态判断。

**「当前预设」取法的依据全部来自官方源码**（`D:\AI\GitHub\deepseek-harness\packages\preset\agent-presets\src\`）：`index.ts:504-505`（服务方法 = 模块导出的包装，同源）、`invariant.ts:48,61-64`（内核自己用它判定 join）、`mount.ts:243-248`（读 live scope chain）、`session.ts:12`（重建读投影、**绝不读 header**）、`session.ts:38`（投影初值取自 header）、`index.ts:755`（`swap()` 重绑后 append `agent-preset/selected` 推进投影）。另核对本项目现状：客户端 `session-preset-face.ts:41` 读会话投影（**次优但客户端唯一可用**，因为它拿不到 `agent.ctx`）、`src/index.ts:410-432` 的 `syncHostDefault` 用 `agent-presets.default`（**语义正确**——它维护的就是"新会话默认"），全仓 grep 无 `header.agentPreset` 命中。

### 执行结果（2026-09-22 执行）

**门槛（主线程统一跑，cwd `D:\AI\workspase\_temp`）**：`pnpm typecheck` ✓ / `pnpm lint` **0 errors**（2 warnings 在 `test/engine/actions.test.mjs`，`unicorn(no-useless-fallback-in-spread)` 与一处未使用声明，不影响门禁）/ `pnpm test` **1433 pass / 0 fail** / `pnpm build` ✓ / `git diff --check` **CLEAN**。

**逐任务证据**：

| 任务 | 定向断言 | 证据要点 |
|---|---|---|
| T1 | 22/22 | 七类谓词**全部与既有实现「导入真实现直接对拍」**（`anchor-match` / `compaction-epoch` / `tool-filter` / `deliberation-gate` / `anchor-turn`），不是自证；7 处官方源码引用逐条核实属实 |
| T2 | 38/38 | 七类动作的合法通道 ⊆ 官方事件表且实际注册集合 == 声明集合；第 (5)(6) 类用**真 `Context` + `SystemPrompt` + `ToolRuntime(mode:'ptc')`**（只替换语言运行时），断言「绑定确实存在 + 子调用确实发生 + 被 guard 拒绝 + `bodyRuns` 为空」——**行为证据，非文本断言**；TS/Python 双载荷 |
| T3 | 11/11 + 7/7 | 调度层：稳定排序、位置映射（真实 cordis）、判定失败降级、disposer 全注销、`state` 会话态最小接口、决策链；**重建对拍**：声明驱动路径重建 `tool-filter`（5 组名单 × 5 组目录逐条同结果）与 `deliberation-gate`（7 组事件逐条同裁决，含跨轮与子代理） |
| T4 | 8/8 | 三个提供者的 `engineProvider` 登记；「模块要么导出 `engineTriggers`、要么导出 `engineProvider`」的互斥守卫 |
| T5 | 含在 T3 | 决策链能区分「未命中 / 判定抛错 / 命中」且每会话只输出一次；默认关闭零日志；**绝不打印正文与返回值** |

**B1–B6 零行为变更纪律的核对**（本支改动面）：`layers.mjs` 的 `applyAgentRequestParams` 在无 `unset` 时与原内联写法**逐路径等价**（`replace` → `{...patch}`；否则 `{...base, ...patch}`）；`wireTurnStops` 去掉 `stateOf(sessionId, turn)` 的无用参、预算判定提到 `conditionHit` 之前（两者皆纯函数，副作用个数与顺序不变）；各 `wire*` 返回值改为 disposer 数组、`wireLayers` 返回聚合 disposer（**当前无人调用**，行为不变，正好是 B4 T3 要落地的东西）；`executor.mjs` 仅把 `ctx.on` 返回值命名并聚合为一个 disposer，注册顺序、`prepend`、监听器体逐字节未变。**受影响面既有回归 147/147 全绿**（`prompt-config-engine` / `preset-engine-modules` / `injection-gates` / `tool-filter` / `tool-module-mount` / `helper-convergence`），全量 1433 亦全绿。

**「当前预设」取法的依据全部来自官方源码**（`D:\AI\GitHub\deepseek-harness\packages\preset\agent-presets\src\`）：`index.ts:504-505`（服务方法 = 模块导出的包装，同源）、`invariant.ts:48,61-64`（内核自己用它判定 join）、`mount.ts:243-248`（读 live scope chain）、`session.ts:12`（重建读投影、**绝不读 header**）、`session.ts:38`（投影初值取自 header）、`index.ts:755`（`swap()` 重绑后 append `agent-preset/selected` 推进投影）。另核对本项目现状：客户端 `session-preset-face.ts:41` 读会话投影（**次优但客户端唯一可用**，因为它拿不到 `agent.ctx`）、`src/index.ts:410-432` 的 `syncHostDefault` 用 `agent-presets.default`（**语义正确**——它维护的就是"新会话默认"），全仓 grep 无 `header.agentPreset` 命中。

## 实施取舍与已知边界

- **判断原语只做七类**：语义相近但不相同的判断（如"轮内字符数"与"每轮工具次数"）归入同一类「计数」，靠参数区分；不为每个具体判断造一个原语。
- **动作库不做"注册工具"**：`tool-bootstrap` 的 `stages` 需要"注册阶段推进工具"，这属于提供者能力。**2026-09-22 拍板：放弃渐进披露**——该功能的行为可由「多条件 + 多触发 + 多动作」自行声明，**这一步不依赖注册工具**（推进条件改用既有判断原语与已有工具事件，不新增机制工具），故不作为内置能力保留，本动作库也不为此开例外。
- **三个提供者不归一**：它们的本质是"给模型提供能力"，与"干预流程"不同层；强行塞进触发器会让引擎失去单一职责。
- **`do` 的返回值参与瀑布（T3 执行期修正）**：原实现调用动作后**丢弃返回值**，于是「裁决」类动作（deny / ask / replace / block）**命中却拦不住**——这由 T3 验收条款 (a) 的重建对拍抓出（`deliberation-gate` 的 deny 在与现有模块对拍时暴露）。现约定：`do` 返回 `undefined` = 不干预（交给下游），返回其它值 = 该值成为本次瀑布结果。`before-next` 返回终局后**不再执行下游**；`after-next` 的返回值替换下游结果。这是本支唯一一处执行期语义修正，已在 `trigger.test.mjs` 用两条用例钉住双向行为。
- **`registerAction`（T2）与 `mountTriggers`（T3）尚未对接（登记，留给 B7）**：`actions.mjs:4` 写着「由触发器运行时（T3）在判断命中后交来」，但 `mountTriggers` 的 `do` 只接受**函数**，而 `registerAction(ctx, action)` 接受**声明对象**并自行注册到通道。当前两者是两条独立接线（T2 的用例直接调 `registerAction`；T3 的重建用例用匿名函数 `do`）。B7 做「声明等价」时必须统一为一条：建议 `mountTriggers` 对 `do` 同时接受函数与动作声明对象，并以声明的 `channel` 校验 `ACTION_KINDS[kind].events` 包含它（挂载期 fail loud）。
- **跨调用预算状态无法用当前谓词表达（登记，B7 的声明必须携带）**：`deliberation-gate` 的「每轮最多 deny `maxGatesPerTurn` 次」是跨调用累计的预算，而计数谓词是**纯函数**（同输入同结果）。`trigger-rebuild.test.mjs` 最后一条用例把差异**显式钉住**（现有模块第二次放行、声明路径第二次仍命中），不假装等价。B7 的等价声明要么给谓词加有状态预算入口，要么把该状态放进 `state` 声明。
- **`unset` 未进 `schema.mjs` 的 layer 契约表（登记，待补）**：`LAYER_CONTRACTS['agent-request'].params`（`schema.mjs:206-207`）只有 `patch`/`replace`；`normalizeLayerParams:320-327` **只校验已声明的键、未知键透传**，所以 `preset.yml` 手写 `params.unset` 能生效，但**类型不校验**（`unset: "foo"` 会被 `applyAgentRequestParams` 静默忽略 = 配了没生效，正是 fail loud 要消除的一类静默失效），且 UI 表单不渲染它。补它要连动 `src/shared/engine-params.ts` 与 UI 参数定义链（B0 有「能力卡覆盖引擎全部公开配置键」的双向一致性守卫），**不在 B3 收口时硬塞**——留给 B7 或独立修复轮次，届时同批补 `unset` 的形状校验（键须为 `LlmCallConfig` 字段）。
- **子代理 scope 挂载关系无法从源码证实（登记）**：安装包内找不到 agent 创建代码（`dsh-agent-loop` 未安装、已装包中 `createScope` 零命中），因此主子代理隔离用**两道**机制保证（guard 只注册在该 agent 的 scope + guard 体内按 `delegationDepth` 二次判定），测试按**最坏情形**（子 scope 显式挂在父 scope 链上）构造。**不以现有用例推断「宿主对象永不重建」**——那只是既有用例的覆盖范围，不是宿主契约。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。
