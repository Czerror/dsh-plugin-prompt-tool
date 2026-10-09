# 统一规则引擎复用指南

`module.yml` 保存完整定义与恢复依据，运行时消费校验通过的 rules/ 快照。一张卡对应一条具有稳定 `id` 的规则：
`if` 判断树决定是否执行，`then` 数组承载具有各自稳定 `id` 的动作（`else` 承接动作级分支）。保存、导入与物化
共用 `engine/rule-spec.mjs#compileRules()`；宿主管理路径和独立路径共用
`engine/rule-runtime.mjs#mountRuleSources()`，独立插件入口是 `engine/rule-engine.mjs`。

`ensureModuleSlices` 从完整定义分解规则正文、状态清单和模板变量；切片失配单向重切。`writeModule` 不生成宿主组合或旧目录，运行时不双读旧 `promptConfigs`、
`triggers` 或快捷模型参数。旧定义只能先通过显式离线迁移转换；旧 `/triggers` 以及
提示词、模型参数写入口返回退役错误，编辑走带模块身份与版本的 `/rules` 事务。
空模块不暗自增加正文、规则或请求参数。持久化、版本与恢复边界见 [后端框架](architecture-params.md#磁盘格式规则与共享参数各有所有者)。

引擎是可复制的 ESM 模块库。晋升门控、首轮锚定、目录过滤、预算和节拍由模板或规则
显式选择。模型配置与采样属于 `request-params` 动作；顶层 `persona` 在 Agent scope 中通过官方 systemPrompt 服务注册。ST/角色卡遵循同一边界。模块 memory.md 只由模型工具按需读取，不自动注入。

### 能力内联与兼容入口

- 自定义工具在保存和装配前完整校验，官方 DSL 编译后的定义数组通过 `tools` 传给 `tool-config-engine`。空数组代表无工具；字段缺失才读取 configsDir；显式非法值在注册前拒绝。
- 子代理策略通过 `policy` 内联，沿用同一 compile／resolve seam、扩权审批与 ceiling 裁决。模块策略段缺失或 null 时不安装 shadow；独立入口缺 policy 才读取 policyFile，只有文件不存在可降级。
- `resourceRoot` 是工具资源允许根，宿主仍传 modules 集合根；旧 presetRoot 是兼容别名，冲突拒绝。规则模板允许根使用 templateModuleRoot，独立规则入口使用 moduleRoot。更名不改变资源权限。
- configsDir／policyFile 和独立规则文件入口供包使用者兼容，插件管理路径不生成旧文件。工具身份、注册 scope、disposer 和主／子代理授权边界保持。

### 官方与本地分类

- `engine/compositions/` 现在只有 `source/local/`：官方切块已全部随「与预设彻底解耦」清理——
  插件不再分发预设，官方工具由会话原有预设提供，模块不需要重新声明它们。
- `engine/compositions/source/local/` 是本地模块源码；`rule-engine` 负责统一规则入口。
  `filesystem-editor` 显式装配隔离文件系统及编辑器，`tool-git-bash` 提供 Windows Git Bash。
- 官方 row id 保持原样；同一组合不允许重复 row。模块文件名是 `modules` 中的引用标识。
- 新模块不得恢复 `prompt-config-engine` / `declared-triggers` 的并行运行入口。底层兼容
  导出只为既有内部调用和离线读取服务，不表示旧声明还能进入新模块运行链。
- 组合与业务模板参数拥有默认值，引擎负责校验和执行；缺少业务正文或判据时不私自补齐。

## 模型工具的宿主约束（exec 字段与 SDK 段变量校验）

新写或跨项目复制模型工具时，两条宿主约束必须遵守（此前只写在代码注释里，此处上提）：

1. **`tools:sdk` 段与 `{{var}}` 校验：现有代码注释与官方实现不符，此处按实测记录。**
   `src/runtime/session-var-tools.ts:21-23` 的注释称「工具 `description` 会进入宿主 `tools:sdk` 段，
   宿主对该段做 `{{var}}` 变量校验（变量名须匹配 `[a-z][a-z0-9_]*` 且已注册），文本中不得出现双花括号字面量」。
   但在已安装的 `@deepseek-ai/dsh-tools@0.1.6-alpha.2` 上：
   - `sdkSection()` 返回的 `tools:sdk` 段**显式设了 `interpolate: false`**（`lib/index.js:2743-2758`）；
   - 装配端对 `interpolate === false` 的 section **保留字面文本、不做插值**（`@deepseek-ai/dsh-system-prompt`
     的 `lib/index.js:105-116`，其注释原文是「Sections with `interpolate: false` retain literal text」——
     只有**其它** section 的非法/未注册/无值引用才抛错，见同文件 `:60` 的
     `VARIABLE_NAME = /^[a-z][a-z0-9_]*$/` 与 `:167`/`:170`/`:173`）。
   - `dsh-tools` 只注册 `tools:sdk` 与 `tools:ptc-only` 两个工具类 section，二者都不从 `description` 构造文本。

   即：**当前实现下该段不会触发 `{{var}}` 校验**。两种解释待定——注释描述的是更早版本的行为，
   或另有尚未查明的校验路径。**在查明之前，工具 `description` 沿用现有写法**（占位符示例写成单花括号
   `{变量名}`）：它不会造成问题，而注释所警告的风险也尚未被证伪。

2. **`exec` 上可用的字段由官方 `ToolRunContext` 决定**（安装包
   `@deepseek-ai/dsh-tools` 的 `lib/types/index.d.ts:198-294`）：`callId` / `rootCallId` / `name` /
   `schema?` / `arguments` / `agent?` / `parent?` / `signal` / `token` / `deferContext()`。两点须注意：
   - `signal` 是**必填的 caller-owned 取消信号**（同上 `:222-223`）。官方注释要求「异步工作必须观察或
     转发 `exec.signal`，并只在其 settle 之后结束」（`:112`）；`tools/execute` 包装器可以替换它，
     但**不能移除**（`:271-277`）。
   - `agent?` 是发起该调用的 agent（`:211`）。官方 `@deepseek-ai/dsh-agent`
     （`lib/types/runtime-types.d.ts:139-143`）声明了 `readonly session: Session`，本项目据此用
     `exec.agent?.session` 取当前会话（`src/runtime/session-var-tools.ts:60`）。

## 复制协议（跨项目复用）

1. 把 `engine/` 整个目录复制到你的项目（自包含 + vendor yaml，无外部依赖）。目录里的模块按依赖分三类，
   复制后按需装配：

   | 类别 | 模块 | 复制后的运行条件 |
   |---|---|---|
   | 核心可复制 | 统一规则引擎（规则编译器 / 动作库 / 条件谓词）、提示词批执行器、条件判定、ST 渲染、世界书选择、`compaction-epoch`、`subagent-tool-policy-core`、`classify-task` | 无额外依赖：隔离复制后即可挂载并完成注入 |
   | 需官方 DSH 包 | 依赖宿主服务（`tools` / `systemPrompt` / `llm` / `agents` / `scope`）的模块行 | 目标项目需装配同名宿主服务；缺服务时按各自契约报错或跳过（`inject` 声明的行保持 pending） |
   | 需 Prompt Tool 私有服务 | `character-tools.mjs`、`world-book-tools.mjs`、`session-var-tools.mjs` | 经 `ctx.inject` 等待各自 `pt-*` 服务；服务迟到后挂载，服务移除或组合卸载时释放 |

   实测（2026-09-20）：把 `engine/` 复制到隔离目录、由最小 Cordis 根挂载并触发一次 `agent/pre-step`，
   核心模块完成注入（正文 `COPIED`）；三条私有适配器在缺服务时各告警一次，补齐 mount 服务后全部注册成功。
   因此私有适配器只在第二个真实宿主需要这些能力时再考虑下沉，当前只需按上表明确依赖契约。
2. 组合文件（agent.cordis.yml）以相对路径引用引擎插件行：

   ```yaml
   - id: rule-engine
     name: ./engine/rule-engine.mjs
     config:
       rulesFile: ../rules.yml
   ```

3. 需要按预设参数化时，参考本仓库 `manifest.ts` 的
   `buildModuleConfigsFromParams`（params 扁平键 → 模块行 config 对象合并，
   取代旧 `__TOKEN__` 文本占位符）与 `applyModuleConfigs`（行级/嵌套合并）。

## 统一入口与模块职责

| 入口或目录 | 职责 |
|---|---|
| `engine/rule-engine.mjs` | 独立规则入口：读取 `rules.yml` 包，调用同一编译与挂载接口 |
| `engine/rule-spec.mjs` | 规则、动作身份与选项校验；`assertRuleId` 是保存、导入、直接编译共用的安全身份边界 |
| `engine/rule-runtime.mjs` | 将动作按真实官方执行点接线；同点共享判定，跨点独立求值 |
| `engine/conditions/` | `text`、`phase`、`source`、`count`、`names`、`session`、`preset`、`scope`、`anchor` 及组合的真实实现 |
| `engine/actions/` | 九类动作的真实实现；`content.mjs` 只负责显式正文选择与生成 |
| `engine/executor.mjs` / `engine/layers.mjs` | 复用批次注入、变量、去重、官方文本注册与各层执行机制 |
| `engine/instruction-hint.mjs` | 独立指令提示协议；显式模板生成提示，文件正文仍从声明的文件路径读取。**组合源行必须自带 `messageTemplate` 等模板**——`apply()` 在模板为空时不注册任何转换（开关打开也零效果） |
| `engine/skill-search.mjs` | 技能面的按需发现与加载（`skill_search` / `skill_load`），替代官方全量技能目录注入 |
| `engine/dev-tool-search.mjs` | 工具面的按需发现与解锁（`dev_tool_search`）；能力摘要从 `ctx.tools.schemas()` 运行时折叠分组，不手工维护索引 |
| `engine/tool-config-engine.mjs` | 自定义工具资产到官方工具注册；执行器保留完整官方工具管线与批准边界 |
| `engine/subagent-tool-policy.mjs` / `subagent-tool-policy-core.mjs` | 子代理实例策略、真实 provider 绑定及共享校验，贡献随 scope 释放 |
| `engine/character-tools.mjs` / `world-book-tools.mjs` / `session-var-tools.mjs` | 等待宿主对应服务，按预设 scope 贡献工具并释放 |
| `engine/compaction-epoch.mjs` | 可重建晋升状态机；不是插件行，不内建业务锚词 |

`actions.mjs`、`predicates.mjs`、`strategies.mjs` 仅保留重导出；不能把实现重新堆回这些入口。
`trigger-spec.mjs` 用于旧声明的离线校验，新运行链只编译 `rules`。原专用能力模块
`context-gate`、`tool-bootstrap`、`tool-filter`、`anchor-turn`、`deliberation-gate`、
`progress-reminder` 与 `promoted-code-mode` 不再内置；需要时由明确规则组合表达。
渐进阶段推进工具和按晋升时机切换 PTC 呈现没有恢复；需要 PTC 时显式装配官方呈现行。
`workspaceLine` 与 `phase1FirstCallInstruction` 的既有段正文改写仍无通用动作，
不要把 `assembly.sections.add/remove/keep` 宣称为等价实现。

## 工具面收窄与按需解锁

工具面是每请求的固定开销：实测 156 个工具、描述合计 46894 字符（约 12K token）。把它
收窄到常驻核心集、其余按需解锁，由三件**互相依赖**的东西组成，缺一件就退化：

| 件 | 落点 | 缺了它会怎样 |
| --- | --- | --- |
| 常驻白名单 + 动态白名单 | `assembly.target.tools.allow` / `allowFrom` | 目录不收窄，省不下 token |
| 发现工具 | `engine/dev-tool-search.mjs`（组合源 `source/local/dev-tool-search.yml`） | 模型无法知道有什么可解锁，只能用别的方式硬凑 |
| 解锁名单的回收 | `assembly` 的 `allowFrom` | 解锁是**一次性的**：当次请求用完即被裁掉 |

- `allowFrom: { tool, key }` 读**本会话已持久化**的 `tool/call` 事件：筛 `type` 精确等于
  `tool/call` 且 `data.name` 精确等于 `tool` 的事件，`try/catch` 解析 `data.arguments`，
  只取 `key` 指向的字符串数组里的字符串项。**它只做加法**——`createMask.blocks()` 的语义
  是「在 allow 里就放行」，所以动态集合只能解锁，永远不能裁掉任何工具。
- 坏数据**逐条忽略、绝不上抛**：非法 JSON、`key` 非数组、`tool` 不匹配、缺 `arguments`、
  数组混入非字符串，都只跳过那一条。取不到 session（无 `snapshotEvents`）或读事件抛错时，
  退回静态 `allow`，并**不**影响其余工具。
- `deny` 与 `allowFrom` 同声明在**挂载期 fail loud**：黑名单与「只做加法」的语义不可解释，
  不留给运行期猜。
- 解锁跨请求保留的原理是「持久事件 + 每轮重算」，因此**压缩后仍然保留**（成功压缩会清零
  晋升相位，但不会删掉历史 `tool/call` 事件）。
- **收窄模板**：`templates/80-tool-surface.yml`，常驻集
  `pwsh / read / write / edit / glob / grep / todo_write / skill_search / skill_load / dev_tool_search`。
  它是**规则**（走 `compileRules`），不是 `triggers` 声明——因此**不能**声明
  `waterfallPosition`（那是声明路径的字段，规则路径会以 unknown fields 拒绝）。需要
  `outermost`（`prepend: true`）时改用声明路径，格式见 `test/engine/declarations/tool-bootstrap.yml`。
- 相位用 `any` 两支表达，因为单个 `phase` 节点**无法**表达「两个相位都命中」：`promoted`
  的缺省是 `true`（= 只匹配已晋升，不是「任意」），而 `promoted: 'ignore'` 又要求同时声明
  只接受布尔值的 `compacted`。故写作
  `any: [phase{promoted:true}, phase{compacted:true, promoted:false}]`。**首轮（未晋升且未压缩）
  刻意不收窄**——先让模型看到完整目录，再随相位推进收窄。
- `requireMatch: true` 是必配：任一 `allow` 工具缺失（含模型解锁了一个不存在的名字）就放弃
  裁剪、暴露完整目录。宁可多给上下文，也不静默裁成空目录。
- **与 `tool-bootstrap` 的分工**：那份原型（见 `test/engine/declarations/tool-bootstrap.yml`）
  只**在受控相位**收窄、晋升后放开，且没有解锁通道；本模板覆盖晋升后与压缩后，靠
  `allowFrom` 提供解锁。两者不叠加——同一通道上相邻的 `assembly` 动作各做一次白名单裁剪，
  **A 裁掉的工具 B 不会加回**，所以每个动作的 `allow` 都要点名它需要的全部工具。

## 规则、条件与动作边界

- `rule.id` 是稳定且安全的模块内身份，禁用规则也必须通过校验；拒绝点目录、路径分隔、
  控制字符和 Windows 保留字符。`action.id` 只承担动作身份，不能套用文件名限制。
- `then` 必须是非空数组（动作级分支写 `else`）。规则可以跨多个官方执行点；`channel`、执行阶段由动作能力
  决定，不能在规则顶层另填通道。规则的 `layer` 仅用于展示，真正注入层取动作 `config.layer`。
- 同规则、同一真实执行点严格按 `then` 数组顺序执行，条件只求值一次；跨执行点、下一次
  调用及新 epoch 重新求值。不按 session、turn 或同一 context 对象缓存规则结果。
- `assembly` 动作 target 内的名单语义互斥，且都在**编译期**（`prepareAssembly` 经
  `compileRules`）拒绝：`sections.keep` × `sections.remove`、`contexts.clear` ×
  `contexts.add/remove`；`contexts.clear` 出现时必须是布尔（`'true'` / `1` 不再被静默当
  false）。跨动作拆分不是同一个声明：`[clear 动作, add 动作]` 按 after-next 顺序串接，
  后面的 `clear` 会清掉前面动作的 `add`。
- `channelOrder` 位于动作中，只控制同执行点跨规则定位；同卡同点存在冲突值时编译拒绝，
  不替作者任选一个。`waterfallPosition` 也位于动作中，缺省 `default`，适用的原生动作
  可显式使用 `outermost`；它表达官方 waterfall 位置，不创建跨层全局顺序。
- `if` 缺省表示没有附加门；组合采用 `all/any/not/notAny` 显式树形结构。缺少真实
  agent/session/model 等必要事实时，条件内部返回 `UNAVAILABLE`，`not` 不会把未知变真；
  `any` 中已知 true 仍可决断，`all` 中已知 false 仍可决断。只有结果严格为 true 才执行。
  不从 UI 当前会话或挂载 scope 猜测缺失的事件身份。
- 事件型文本注入支持顶层 `if`，包括 system-section 与 runtime-context：官方同步
  provider 注册占位，真实 assembly 中按本次判定填充；取消、卸载和失败不留下过期正文。
- `guard`、`complete` 和 `suppressRuntimeContext` 是固定注册效果，拒绝动态 `if` 与
  waterfall 定位，不能用空文本模拟撤销注册。其中 `complete` / `suppressRuntimeContext`
  **只属于 `system-section` 层**：其他层写同名键（`false` 除外，出现即拒）既不注册成
  独占段、又会被独占计数误算，编译期逐动作拒绝并点名层。多个启用 complete，或与顶层
  persona.complete 冲突，在候选编译时拒绝。`inject-text` / `guard` 不支持 `maxPerTurn`，
  错误选项不能静默忽略。
- 动作声明按**字段白名单**校验：九类动作各自的合法键见 `engine/actions/catalog.mjs`
  的 `ACTION_KINDS[].fields`（通用键 `id`/`kind`/`channelOrder`/`waterfallPosition`/
  `maxPerTurn` 另计），`inject-text.config` 的键由 `engine/schema.mjs` 的
  `INJECT_CONFIG_FIELDS` 派生，`request-params` 的 `patch` / `unset` 子键复用
  `schema.mjs` 的 `assertLlmCallPatch`（官方 LlmCallConfig 键集与值规则）；拼错的键在
  保存与装配期报出动作 id 与允许键集合，不再静默失效。动作级 `enabled`/`group`/
  `exclusive` 属于规则层，写了即报错（运行期 `rule-runtime.mjs` 会覆盖它们）。带 `kind`
  的动作对象写 `if`/`then`/`else` 同样拒绝：分支必须写成无 `kind` 的节点，否则
  `expandActions` 会静默丢掉分支。`prepend`（未文档化的注册后门，`executor.mjs` 直读
  `config.prepend`）已取消且暂无等价替代——`inject-text` 不接受 `waterfallPosition`，
  动作级位置只对非 inject-text 动作可用。
- 通用动态判断只归规则级 `if`：注入动作不再声明受众、模型、晋升或文本匹配门；请求参数动作的受众与模型范围也用规则级 `if.scope`（动作级 `audience`/`modelScope` 只保留给旧声明迁移，非中性值一律报「move it to rule.if」）。未声明模型范围等价于 `all`。固定 system-section 独占／抑制的 `audience` 仅表示静态注册目标，仍不接受动态条件。
- 旧单动作声明的判断在离线迁移时提升为规则级 `if`；只作用于某个动作的多动作条件不能提升后影响兄弟动作，须先明确拆分。
- 同模块非空组中任一规则声明 `exclusive: true`，整组最多一条启用规则。编译器拒绝
  多启用冲突，不按排序选赢家；Host 显式激活一条卡时在一次原子事务中关闭同组其他卡。

`inject-text.config` 复用整批 `createPromptConfigs()`，保留 ST 共享变量帧。缺少显式
`config.id` 时，投递身份由稳定 rule/action id 编码派生；**卡内**重排不改身份，**卡内**复制
（换 rule/action id）产生新身份。迁移保留原有显式投递身份。`templateFile` 相对该模块的
`module.yml` 解析，只允许读取模块根内
资产；保存、物化与运行使用同一边界。`strategyDir` 也相对规则包解析，不能从包内引擎目录
反推数据目录。正文模板、策略目录和身份校验在所有入口同源。

**dedupe 身份在同时启用的模块间须唯一**：**整模块复制**保留 rule id，因此默认派生的身份
（`rule:<ruleId>:<actionId>`）跟着复制，不产生新身份（与上段「卡内复制」是两回事）；两个
启用模块声明同一个 `dedupe: session` / `batch` 身份时，装配**不拒绝**（复制模块后两者同时
启用是合法操作），只在第一条装配时 `warnOnce` 一条诊断并照常装配。判重同时覆盖两条通道：
`plugin`（`identity.value`，缺省 `config.id`）与显式 `sourceKind`（进 `source.kind`，两张
id 不同、却声明同一个 sourceKind 的卡同样会经 kind 通道互相压制）。`identity` 显式声明时
同样按值判重：`{ field: 'plugin', value }` 的值两卡相同即视为同一身份。有意让两模块共享同一
身份是合法用法（跨模块共享一份会话去重），告警措辞因此区分「显式共享」与「疑似误复制」；
两种情况**同一批内两张卡仍各注入一次**，共享只在后续步生效。

**来源盖章与去重查找同源**：消息 `source.plugin` 写的是该配置的**去重身份**
（`merged` 组用 `merged:<position>`，其余用 `identity.value`，默认即 `config.id`），
与 `alreadyDelivered` 的查找键一致。解析器自带 `source` 的候选（`fill=instruction-hint`
解析出的 `{ kind: 'instruction-hint' }` 等）也会被补盖 `source.plugin = 该身份`，否则身份
只落在 kind 通道、`dedupe: session` 每步重复注入。副作用：显式 `identity` 的卡要按
`source.plugin` 屏蔽（`pre-step-filter` 的 `blockPlugins`）须写 `identity.value` 而不是
`id`（该名单按 `source.plugin` 做精确等值匹配的完整语义见后文「会话去重以『宿主接纳』为准
（2026-09-20）」一节）；旧消息的 kind 仍是 `plugin:<id>`，kind 通道继续命中。

`getRuleEditorMeta()` 从实际条件、动作目录派生可序列化选项；`getEngineMeta()` 提供有效
层和内容策略目录。新动作种子是可编译的中性空内容、空 patch 或空名单，不替用户选业务值。
`custom-fallback` 不再发布，也没有可执行兼容分支，必须离线转为显式 `anchor` 条件和
`anchor-notice` 内容；条件未声明 `fallbackAfter` 时不启用轮数兜底。

## pre-step 消息角色出口（2026-09-17）

宿主把本批 `decision.messages` 逐条写成 `user/message` 事件，事件校验要求 `role === "user"`
（assistant 只能由模型侧 `assistant/message` 事件产生）。引擎因此只有一个出口角色：

- `executor.mjs#buildMessage` 统一发出 `user`；配置声明或策略 patch（含 `templateFile` 的 role）
  给出的其它值在出口降级，只 `warnOnce` 一次，原角色写入 `source.requestedRole`，正文、位置、
  次数、dedupe、order 与变量副作用都不变。合并组按首条配置的角色发出，其余成员声明的非法角色
  同样告警并留痕。
- 配置的 `role` 只接受 `user`，`getEngineMeta().roles` 与表单同源；策略或模板 patch 的角色仍经出口守卫校验。
- 想让消息以 assistant 出现在模型面前，只能走宿主 assistant 侧通道，不要在 pre-step 里伪造
  assistant 历史：那会写出宿主无法重新加载的会话日志。

## pre-step 协调器与官方指令过滤

`rule-runtime` 的注入来源通过共享批执行器接入 pre-step：

- 宿主插件提供 `promptToolPreStep` 协调服务时，引擎行把本 mount 的提示词配置注册给协调器
  （`registerPreset`），由协调器用**同一个** `engine/executor.mjs#runPreStepBatch` 统一执行
  预设来源；任一时刻每个 scope 只有一条预设配置执行路径。文件正文由官方来源生成，插件
  在消息进入会话前执行逐文件过滤，不把文件卡编译为第二批注入配置。
- 没有该服务（引擎被复制到无宿主的目录复用）时，引擎行仍自带 pre-step 监听器，只执行自身
  预设配置；引擎不 import `src/host`，也不强制协调服务存在。
- 协调服务迟到时，引擎行先停止本地注入再启用管理路径；服务消失时反向恢复独立执行。
  注册句柄同时绑定服务实例，HMR 在相邻两步之间替换服务时也会撤销旧登记、向新实例重登；
  同一来源在接管期间只选择一个批执行器；无 pre-step 贡献时无需注册该来源。来源随 ctx disposer
  标记为失效，已被 waterfall 捕获的旧回调也不得在服务重挂后恢复登记。
- 来源作用域来自注册 ctx（`@deepseek-ai/dsh-scope`）：同一 scope 内**同名来源以最新一次登记
  为准**——宿主重挂同一个 preset（同一 scope 上旧 mount 的 fiber 尚未释放）时后来者接管，
  先撤旧登记再插新登记，不抛错；抛错会让引擎行未激活，进而让整个 preset 挂载失败（表现为
  无法切换预设）。被顶替的旧登记句柄迟到撤销是空操作，不会移除已接管的登记；接管只在
  同一 scope 内发生，兄弟 scope 的同名来源互不顶替。父 scope 的来源对子代理可见、兄弟
  scope 互不串，scope dispose 即释放。resolver 也绑定来源 ctx，不因合并批次而改读协调器的
  全局服务。预设批执行器使用普通监听顺序，留在最外层 pre-step 门（声明式 `pre-step-filter`，
  `waterfallPosition: outermost`）内侧；官方指令过滤在官方消息生成之后、写入会话之前完成。
  迟到或重挂不改变外层门对最终消息批的约束。

### 官方指令的逐文件过滤

官方 `@deepseek-ai/dsh-agent-instructions` 是文件正文的注入来源，负责发现、读取、预算、
增量更新和压缩恢复。插件只对待注入消息应用 `$DSH_HOME/.prompt-tool/instructions.yml`
中的 `files[fileId].enabled: false`，没有独立来源总开关，也不接管官方生命周期：

- 仅处理 `source.kind: agent-instructions` 的官方消息；通过 `source.changes` 路径与
  `Instructions from:`、`Additional instructions from:`、`Updated instructions from:`、
  `Instructions removed:` 模板段落共同定位关闭的文件。其他来源不受逐文件过滤影响。
- 基线、附加、更新和移除消息使用同一过滤入口；删除对应正文时同步删除该文件的
  `source.changes`，保留其他文件、消息身份及其余元数据。该消息没有剩余文件时整条移除。
- 项目路径按当批或当前可见官方基线 `baselineIdentity` 中的项目根解析，不用插件的 `.git`
  探测替代官方根；路径必须能映射到本地文件身份，未知身份原样保留。格式歧义、标题重复或元数据与正文不
  一致时原样放行该条消息并报告诊断，不通过猜测段落边界误删官方内容。策略损坏同样诊断
  并放行，工作台拒绝覆盖损坏的策略文件。
- 完整替代基线中的移除记录可能只由共同引言表达，没有独立正文区间；此类基线需要过滤时
  原样放行并诊断，避免误删正文中的移除示例或确认模型没有收到的移除。
- 缺省放行；首次请求前关闭可阻止可识别文件进入新历史。会话中关闭只作用于后续注入，
  已有正文不撤回，重新开启也不强制重放；官方后续产生消息时再按当前开关处理。主会话、
  子代理及压缩恢复使用同一过滤规则，不新增文件级位置、晋升、受众或模型控制。
- 官方已经完成预算裁剪，插件不补回被省略的其他内容，不重复读取文件来生成注入正文。
  文件卡为了编辑原文仍可读取文件；关闭不是文件访问控制，也不阻止官方读取。
- `instructionHint` 默认关闭。显式开启且提供有效 messageTemplate 后先调用同一过滤入口，再转换剩余符合条件的官方
  消息；转换与过滤都不改写历史。未装配官方指令时，插件不补建文件注入。
- 旧版生成目录里的 `agents-file-*` 卡（或 `sourceKind: instruction-file`）继续跳过，
  避免旧产物恢复插件自注入。`instructions.owner.officialInstructions` 只报告观察到的官方装配
  事实：`true` 仅在观察到官方装配时出现（当前没有生产者），`null` 表示尚未观察到；不报
  「未装配」这类插件观察不到的否定事实，也不表示某个文件已经进入模型上下文。

策略结构与旧字段清理见 [参数架构](architecture-params.md#指令文件与逐文件过滤策略)。
取舍记录见 [ADR-0004](adr/0004-official-instruction-filter.md)。

## 提示词配置插入点与顺序

- 九个插入点彼此独立，没有跨层全局运行顺序。
- `order` 只在同一插入点内生效。
- UI / 写盘展示顺序固定为 `pre-step → system-section → runtime-context → agent-request → llm-stream → tool-pipeline → turn-stop → subagent-start → subagent-end`；这是展示与写盘顺序，不是运行时优先级。
- 模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` / `turn-stop` / `subagent-start` / `subagent-end` 是控制通道，不构成提示词文本优先级。
- 规则完整保存在 module.yml，规则正文切片使用裸 id 文件名；顺序由 _settings.yml.rules[id].order 承载，完整定义保留 configOrder。引擎仍接收独立顺序映射。
- pre-step 中注入与原生过滤动作按声明顺序交错，分批插入继续排在先前仍存活的同位置消息之后；过滤器的 claimed 基线使用真实事件 payload，不把下游增量当成原始消息。

### 同 scope 内的注册顺序（2026-09-22）

上表的「顺序」说的是**配置层**的展示与文本顺序；宿主 waterfall 里另有一条**注册顺序**语义，两者互不替代：

- waterfall **由外向内**执行，最外层监听器的返回值即最终结果（`@deepseek-ai/cordis` 的 `events.ts`：`cbs.shift()` 取数组头部先跑，`waterfall()` 返回最外层监听器的返回值）。
- 普通注册（`push`）**先注册者在外**；`prepend: true` 等价 `unshift`，插到链首 = 最外层，且**同为 prepend 时后注册者更外层**。
- 因此需要落在普通注册之外的**否决型**动作（清空 `contexts`、窄化 `tools`、按名单掩码、剥离请求参数）应显式选择 outermost；**协作式填充**（`runtime-context` 的同步占位与填充）与**纯副作用**监听器保持普通注册，不去抢外层。
- 本引擎把这条位置表达在规则动作里：`then[]` 的 `waterfallPosition: outermost` 映射为 `prepend: true`（`engine/rule-runtime.mjs`），**缺省 `default` 即普通注册**。它表达的是**位置**，不承担同一通道内声明之间的排序——后者归 `channelOrder`。
- 顺序语义只能用真实 cordis 用例证明；手写的 mock `ctx.on` 只记录选项、**不实现顺序**，不能用作顺序证据。
- **已知边界**：`prepend` 只保证「比**已存在**的普通注册更外层」。若第三方插件同样 `prepend` 且注册更晚，它仍处于更外层、可以翻越门控；`global: true` 的注册也不受本 scope 约束。这正是「不再依赖组合行序」的确切含义——位置改由注册选项保证，而该保证有明确上界，不等价于「与顺序无关」。

### 条件判定与事件载荷

规则条件在 `if` 中显式选择，文本条件使用 `if.text.subject` 与匹配参数；主子会话和
模型范围使用 `if.scope`。条件真实实现位于 `engine/conditions/`，匹配器复用
`engine/anchor-match.mjs`；非法组合、空文本键集合与非法正则在编译期拒绝。旧配置中的
subject/match/promotion 只能经离线转换显式进入规则条件，不能把旧配置层当成第二规则来源。

`if.text.subject` 与 `if.names` / `if.source` 要读的事实必须由该条件被求值的官方通道真实
提供：**动作级**分支条件写错通道（或 `text` 省略 subject）时，该动作永不执行且挂载与运行期
都不报错，因此在编译期拒绝。文本与事实的可用集合都由 `engine/conditions/subject.mjs` 的
`channelTextSubjects()` / `channelFactSubjects()` 从**同一张**通道载荷表反查，不另立名单。
`subagent/start`、`subagent/end` 在表里标记为提供 `name`（= provider），所以 `names` 在这两层
合法；provider 真缺席（官方 one-shot 变 ready、持久 Activation 冷恢复）是**运行期**
UNAVAILABLE，不是编译期拒绝。
**规则级** `if` 不在此列——它在该规则每个动作的执行点各自求值，「缺事实即不执行」
是三值语义的设计意图（见 `test/engine/rules.test.mjs` 的缺事实用例）。规则级 `if` 本身不被
校验（`else` 注入的 `not(if)` 按节点身份排除，不按 subject 名字）；但**动作级嵌套分支的 `if`
一律按该动作的执行点校验**，与规则级 `if` 同名 subject 不会因此被跳过。

| 动作或展示层 | 真实扩展点 | 可选文本 subject | 命中后的行为 |
|---|---|---|---|
| `pre-step` | `agent/pre-step` | `userMessage` | 与本层其余配置一致的消息批注入 |
| `decision` | `tools/pre-execute` / `tools/post-execute` | `toolArgs` / `toolResult` | 分别声明 phase 为 pre / post 的裁决动作 |
| `turn-stop` | `agent/turn-stopping` | `assistantText` | 阻止本轮停止并强制续跑一步 |
| `subagent-start` | `subagent/start` | `subagentInfo` | 向该子代理注入一条上下文 |
| `subagent-end` | `subagent/end` | `subagentInfo` | 默认记录；`params.action: inject-main` 时通过独立 Agent.inject 调用向所属主会话投递文本，不改写子代理结果、不唤醒空闲主会话 |

- `turn-stop` 的续跑上限固定在引擎内（**每个来源（模块）**每轮 1 次、每会话 3 次：
  `engine/layers.mjs` 的
  `TURN_STOP_MAX_PER_TURN` / `TURN_STOP_MAX_PER_SESSION`），**不暴露为配置**——强制续跑
  失控会把会话卡在停不下来的循环里，官方 hook 桥在同等位置也只留了 `TODO(stop-loop-guard)`。
  预算按来源模块一份，经 options 下传到动作：同一模块的多条 `turn-stop` 配置与
  `append-context`（`mode: continue`）动作共享它，不能靠「同模块多写几条」叠加次数。
- 原生 `decision.toolNames` 支持明确的工具名单；名单类型错误必须拒绝，不能因解析失败
  把定向门扩大成全工具门。工具前、后阶段是不同执行点，各自重新判定。
- **策略只在消费它的层生效**：`config.resolve` 只由 pre-step（`executor.mjs`）与 runtime-context
  的 `system-prompt/assemble` waterfall（`layers.mjs`）调用，其余层声明非 `static` 策略会在挂载期报错
  （`schema.mjs#STRATEGY_LAYER_SUPPORT`）。模板专属策略（`strategyDir` 懒加载）同样只允许
  pre-step 与 runtime-context，两层都真实调用 resolver：runtime-context 的模板专属策略与
  placeholder 一样先通过官方 context/variable 注册可渲染为空的同步占位，再由异步 waterfall
  在 `next()` 前填充本次装配中的对应项。官方排序、作用域遮蔽及下游门控保持生效；不缓存
  会话正文，复用同一 AssembleContext 的并发请求也各自求值。空值或异常只让该条为空并告警，
  取消或卸载会丢弃本次待填充结果。`strategyDir` 在引擎入口统一解析为绝对 URL（相对写法按
  当前模块的 `module.yml` 解析），相对目录不再让整行挂载抛 `ERR_INVALID_URL`。
- `conditions/subject.mjs` 按真实事件参数归一载荷；共享文本提取由 `engine/condition.mjs`
  提供，条件在规则编译期准备。未命中的规则**不写入 session 去重**，条件恢复后仍能注入。
- ST 宏模板（`params.stMacros`）的跨配置变量帧只求值**当前入口获准的配置**：
  `executor.mjs#runPreStepBatch` 传入本批的层、受众、模型、晋升与条件资格集合，去重受限的
  模板在通过去重后才由执行器触发。官方组装只求值其拥有的 system-section / runtime-context
  模板，不提前执行 pre-step 或其他控制、事件插入点的 setter 与 reader；这些插入点的
  条件与执行时机仍由各自入口决定。
- 后到的获准模板按 `order` 在同一变量帧内补求值，已求值的模板不重放副作用或随机宏；
  已返回的官方文本也不因后续 pre-step 赋值而倒放重算。两种入口顺序均沿用已有变量帧，
  新步骤与成功压缩创建新帧，失败压缩不推进。该规则不增加跨插入点的全局调度顺序。

## 会话去重以「宿主接纳」为准（2026-09-20）

`dedupe: session` 的候选生成与投递确认分开记账（`engine/executor.mjs`）：

- 候选只决定这一步注入什么；只有宿主把消息真正写进会话事件流（`session/event`）之后，
  该身份才记入本会话的去重快路径（`confirmDelivered`）。持久事件流仍是唯一真相
  （`snapshotEvents()`），快路径只省去每步全量扫描。
- 被最外层 pre-step 门（声明式 `pre-step-filter` 的 `sources` / `keepKinds` / `blockPlugins`）在**本步剥离**的候选
  不算已注入：晋升或门控放行后仍会补发，不会出现「日志里从来没有这条正文，去重却认为
  已注入」的永久缺失；`reject` 步同样不记账。
  `blockPlugins` 是**按 `source.plugin` 的显式屏蔽**（可选逃生阀）：仅当来源 `kind` 为 `plugin`
  时做大小写不敏感的**精确等值**比较，不做子串、正则或 glob，因此要覆盖某个插件须写全名；
  默认不启用，未声明或空名单等于关闭（注意与白名单「空 = 全拦」相反）；它与 `sources` /
  `keepKinds` 正交，可同时声明。
- 确认缓存分别记录 `plugin:<身份>` 与 `kind:<来源>`，只比较同字段的值，与持久扫描的
  `source.plugin` / `source.kind` 两条匹配规则一致；不同字段恰好同值不会误判已投递。
- 独立执行路径与管理路径（协调器）共用同一确认实现，两条路径的去重语义一致；重挂或
  进程恢复直接从持久记录重建，不依赖进程内已投递集合。
- 验收入口：`test/engine/prompt-config-engine.test.mjs`。

## 晋升语义（epoch-aware）

- `phase` 根据显式事件集合或 `promoteOn` 观察真实 durable 事件；默认事件类别 `either`
  是状态机协议，不会生成业务正文。成功 compaction/end 开启新 epoch，失败压缩保持原相位。
- 默认子代理被视为已晋升；需要对子代理施加同一相位时显式写 `includeSubagents: true`。
- `promoteGate: true` 的锚定识别只使用调用方的 `reasoningPattern`、
  `reasoningNegativePattern` 和 `reasoningFlags`；未提供正则时不内置 we/let me。
  `maxPromoteSteps` 只有显式配置时才启用步数兜底。
- `promoteAfterFirstResponse: true` 显式选择首响应或首轮结束释放。所有模式仍用同一
  observe / 冷扫 / epoch 状态机，不另建第二套计数状态。
- instruction-hint 的去重依据仍为 `session.deriveMessages()` 的可见 surface；但只有显式
  messageTemplate 能开启转换，模板为空时不替换或丢弃官方正文。

## 世界书入选/落选诊断（2026-09-16）

`selectStWorldBook()` 在既有判断分支旁记录只读诊断，执行器仍是真实注入与 commit 的最终
权威。诊断挂在返回的入选集合上（`selection.diagnostics`），不新增后台状态服务，
也不为解释结果重跑选择器。

- 选择时机是**批首一次**：合格配置集合、ST 世界书入选与模板位置身份集合都在步进入时取定
  （`qualified` 每配置每步只判一次），动作把批切成多次 flush 也复用同一份。同组互斥、概率
  与粘滞窗口因此按整步成立——旧实现每个 flush 各选一次，同组两条会在两个 flush 里各赢一条。
  快照同样在批首写入，末批没有世界书配置也不会把它覆盖成空集。

- 阶段区分：`excluded`（禁用/延迟/冷却/递归边界）、`rejected`（主键未命中、副键未满足、
  概率过滤、分组落选、匹配失败）、`candidate`（进入候选及激活原因 sticky/constant/key-match）、
  `selected`（组内胜出或未分组入选）、`committed`（执行器实际注入后才记录）。
- `committed` 只记录本次入选的 ST 世界书条目，普通提示词配置不占用世界书诊断额度。
- 原因由实际负责层提供：扫描窗口、主/副键命中数、selective logic、probability/roll、
  分组归属与 `delay` 等字段都取自真实求值结果，`primary-miss` 等不靠 UI 猜测。
- 有界：记录上限 200 条，超出置 `truncated: true`；不持久化对话或世界书正文，
  匹配异常只保留截断后的错误消息。
- 一致性：记录只追加观测数据，不抽样、不调用宏、不推进 sticky/cooldown。
  开关诊断的差分测试断言入选集合、顺序、`Math.random` 调用次数与粘滞窗口完全一致。
- 消费入口：当前由确定性测试消费；工作台只读入口（typed bridge）见 `docs/SillyTavern.md`
  的导入预览与诊断说明。

### 快照真实性（2026-09-17）

每次选择创建一个**有界快照对象**，`selection.diagnostics` 与会话最近快照
（`lastWorldBookDiagnostics`）引用**同一对象**，因此 commit 阶段追加 `committed` 记录、
或把 `truncated` 置真都写回同一份事实——不再复制布尔值（复制会让 commit 越限时读取端
仍看到 `truncated: false`）。

- 越限时机不受阶段影响：67 条常驻配置全部 commit 时，第 67 条触顶，快照与读取端同时为真。
- 最近一次求值**总是**替换快照（含空集合），并附 `step`；空结果因此不会被读成
  「本次又注入了旧条目」。
- `evaluated` 区分"该会话尚未求值"与"已求值但本次没有参与/入选条目"：bridge 对未知会话
  返回 `evaluated: false`，不伪报已检查。
- 只读端点每次读取都在对象上限内切片，但快照对象本身仍是引擎内部事实，读取不触发求值、
  抽样或时间窗推进。

### 条目级条件字段：延迟到递归与组内评分（2026-09-17）

ST 的两个条目级开关在引擎里按 `params.stWorldBook` 消费；未开启（缺省/假值）时求值路径与
既有断言逐条一致，字段缺省不产生任何新诊断。

- `delayUntilRecursion`（对齐 `world-info.js:4753-4762`、`:4860-4868`）：层级池只收真值、
  `true` 归一为 1、升序去重；初始化即取走最小层级，层级只增不减，因此「延迟到第 N 层」的
  条目在层级满足的那次递归 pass 就解锁（不是等 N 个 pass）。非递归 pass 一律抑制
  （sticky 命中例外，`constant` 也不例外）；递归 pass 中「条目值 > 当前层级」同样抑制，
  记录 `excluded: delay-until-recursion`（带 `delayUntilRecursion`/`level`/`pass`）。
  pass 推进与 ST 一致：有新正文可递归时层级保持不变，否则在层级池仍有剩余时打开下一层。
  有界扫描预算同时计入条目激活和延迟层级推进，避免后续层级在打开前耗尽 pass。
- `useGroupScoring`（对齐 `world-info.js:428-473`、`:5292-5328`）：组内存在显式开启的条目时
  整组按 `getScore` 等价实现评分（只统计命中键数，`NOT_ALL`/`NOT_ANY` 不参与加分，主键为空
  记 0 分）；只有**开启评分**的条目会被「严格小于最高分」淘汰，未开启者不被淘汰，但其分数
  计入最高分；组内有 sticky 命中时整组跳过评分。淘汰记录 `rejected: group-score-lost`
  （带 `score`/`maxScore`），入选结果不变时诊断不改变 `Math.random` 调用路径。

两处都对拍 ST 源码（测试内保留 `getScore` 与组内淘汰的抄写夹具），并断言「开关关闭时行为
与既有断言逐条一致」。

### 扫描字段开关（2026-09-17）

世界书条目的角色字段扫描与 ST 的 `globalScanData` 对齐（`world-info.js:294-320`）：每个开关
只在对应变量有值时把该字段并入本 pass 的扫描文本，未开启时不并入、既有触发面不变。
除既有的 `matchCharacterDescription` / `matchCharacterPersonality` / `matchScenario` /
`matchPersonaDescription` 外，本轮接入 `matchCreatorNotes`（变量 `creator_notes`，来源
`data.creator_notes`）与 `matchCharacterDepthPrompt`（变量 `depth_prompt`，来源
`data.extensions.depth_prompt.prompt`，`script.js:4626-4634`）。两个变量由 ST 导入期登记，
缺省不存在时开关自动失效（零噪音）。

## 业务参数与空值

规则行为属于 `rules`；其余已知模块部署参数仍由 `ENGINE_PARAM_DEFINITIONS` 映射到
对应 `moduleConfigs`。子代理工具面只由 `subagentToolPolicy` 实例策略授权，未启用时遵循
官方委派行为，不恢复旧 toolFilter 下发通道。自定义工具仍由 `customTools` 资产及
`tool-config-engine` 管理，保存和运行复用 `engine/tool-definition.mjs` 的官方 DSL 校验。

- 引擎不生成业务默认正文、长度阈值或模型偏好。`first-turn-anchor` 和 `guide-auto` 的
  正则与文本来自显式参数；`complexMinChars` 缺省、null、空字符串不启用长度判据，
  明确数值按严格大于比较。
- env-facts / skill-catalog 仅在存在 `config.texts`、`config.text` 或 `params.text` 的
  显式正文模板时输出，事实变量包括 `ENV_FACTS`、`SKILL_COUNT`、`SKILL_NAMES`、
  `SKILLS_TEXT`。目录 `fields` 缺省为空，`limit` 缺省不截断；业务字段和条数由模板选择。
- instruction-hint 的 projectTemplate / globalTemplate / suffixTemplate / messageTemplate
  均默认空。前两者支持 FILES、ROOT 插值，消息模板支持 FILES、SUFFIX；
  空模板或渲染为空时不替换、不丢弃官方指令。显式 `params.file` 仍实时读文件，
  `Instructions from:` 是来源协议标记，不是引擎自带的引导性文案。
- `templates/policies/legacy-defaults.yml` 只保存旧业务参数的精确快照，供模板生成与
  显式离线迁移读取。引擎运行时不得暗读该文件；迁移只补缺失键，保留显式空值。
- 诊断文本、数据结构和布尔组合真值、宿主协议、guard、续跑次数与资源预算是机制边界，
  不因移除业务默认而停用。ST/worldbook 的格式语义仍与转换和生命周期测试对拍。

## 组合示例

以下数值、正文和工具名单都是示例作者显式选择的业务配置，不是引擎默认。
PTC 呈现由官方工具呈现行装配，不随规则相位隐式切换。

同一卡在 assembly 同点执行两个动作，再在 request 点独立判定；动作 id 在重排时保持不变：

```yaml
rules:
  - id: controlled-tools-and-budget
    if:
      all:
        - scope: { audience: main }
        - phase: { promoted: false, promoteOn: either }
    then:
      - id: restrict-presentation
        kind: assembly
        target:
          tools: { deny: [web_search, web_fetch] }
      - id: restrict-sdk
        kind: sdk-strip
        mask: { deny: [web_search, web_fetch] }
      - id: request-budget
        kind: request-params
        patch: { maxTokens: 1024 }
        waterfallPosition: outermost
```

动态文本规则在一次真实 assembly 中共用条件结果；固定执行 guard 单独声明且没有 `if`：

```yaml
rules:
  - id: main-context
    layer: system-section
    if:
      scope: { audience: main }
    then:
      - id: main-section
        kind: inject-text
        config: { layer: system-section, text: '当前为主会话。' }
      - id: main-runtime
        kind: inject-text
        config: { layer: runtime-context, text: '按当前工作区事实执行。' }
  - id: fixed-tool-guard
    then:
      - id: deny-network-tools
        kind: guard
        mask: { deny: [web_search, web_fetch] }
        includeSubagents: false
        reason: '此规则禁止调用该工具'
```

外层 pre-step 来源过滤的位置写在动作中，缺少 `if` 才表示无附加门：

```yaml
rules:
  - id: controlled-inputs
    if:
      phase: { promoted: false, includeSubagents: false }
    then:
      - id: keep-user-and-goal
        kind: pre-step-filter
        sources: [user, goal]
        waterfallPosition: outermost
```

自定义锚词和可选轮数兜底分属条件，正文属于注入动作；不再声明 custom-fallback：

```yaml
rules:
  - id: confirmed-notice
    if:
      anchor: { keys: [READY], fallbackAfter: 1 }
    then:
      - id: notice
        kind: inject-text
        config:
          layer: pre-step
          strategy: anchor-notice
          text: '按已确认的任务约束继续执行。'
          params: { firstTurnWord: READY }
```

示例中 fallbackAfter: 1 是明确选择超过一条 assistant 消息后的兜底；删掉该字段只按锚词确认。

## 重建与验证

- 官方组合块已全部随「与预设彻底解耦」清理删除（`engine/compositions/` 只剩 `source/local/`）：
  生成器 `rebuild:composition` 与它的输入快照（内置预设目录 `preset/`、`test/fixtures/dsh/current`）
  都已退场；ST 导入的 `enable_web_search: true` 不再组装 web 工具行，改为在转换报告里提示。
- 已发布依赖的实际版本以 package.json 为准，验证脚本不再另行硬编码 rc.2；更新前同时核实
  npm 的版本列表与 dist-tags，不能把名字为 latest 的旧标签误当成更新版本。
- 本地新增模块放 `engine/compositions/source/local/<name>.yml`，直接装配；
- 规则通过 `compileRules` 校验；真实 channel/phase 从动作能力派生。`channelOrder` 缺省来自规则 configOrder（无配置时按规则序号定位）；同卡同点冲突值拒绝。after-next 先调用一次宿主 next，再按该时刻状态判断，压缩后读取新 epoch。
- 原生动作经 `prepareAction` 校验；注入整批编译共用动作选项验证，避免破坏 ST 变量帧。固定注册效果、非法身份、互斥冲突和不支持的选项在保存/物化前拒绝。
- 工具名单的 `allow` 与 `deny` 互斥。仅主会话的 guard 不安装会传播到子代理的 restrict；受众仍在执行 guard 内校验。动作次数预算只在目标匹配并产生效果前消费，非目标工具和被阻止的结果不消耗额度。
- 用户目录刷新：`pnpm rematerialize:presets` 按完整 module.yml 恢复 rules/ 并清理已退役产物，保留用户资产，`--dry-run` 只读。原「预设内嵌 skills 漂移比对 / `--refresh-skills`」已随该机制退场删除。
- 交付验证：从隔离临时 cwd 执行 `pnpm --dir $Repo typecheck`、`lint`、`test`、`build`，最后 `git -C $Repo diff --check`。重点证据包括 rules、business-defaults、真实 agent-assembly 与 rules-bridge-safety 测试；文档 YAML 示例也应通过 compileRules。
