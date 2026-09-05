# 后端参数框架（架构说明）

> 适用范围：dsh-plugin-prompt-tool 的引擎行为参数（按预设存储、随预设走）全链路。
> 相关代码：`src/shared/engine-params.ts`、`src/shared/param-keys.ts`、`src/host/manifest.ts`、
> `src/host/write-preset.ts`、`src/index.ts`（reloadPresetParams / applyParamOverrides / rebuildPreset）、
> `src/runtime/settings-bridge.ts`（/param-overrides）、`src/client/prompt-tool-store.ts`（fields / persist）。

## 1. 分层与职责

| 层 | 文件 | 职责 |
|---|---|---|
| 契约层 | `shared/engine-params.ts` | `EngineParams`（类型权威）+ `ENGINE_PARAM_KEYS`（运行时键唯一权威，与接口双向相等断言）+ `WRITER_PARAM_KEYS`（writePreset 透传键） |
| 键集合 | `shared/param-keys.ts` | `PARAM_KEYS` = `ENGINE_PARAM_KEYS` 派生 + 锚定内容键 + `promptConfigs`；variables.yml 排除集 / mutate 拦截 / 读回遍历共用 |
| 存储层 | `host/manifest.ts` | `loadPresetSpec`（顶层 model/subagentModel 段 → 扁平键，`MODEL_SEGMENT_MAP`）、`savePresetParams`（扁平键 → 段，同源映射；空值删键）、`buildModuleConfigsFromParams`（参数桥）、`renderComposition`（参数桥 > moduleConfigs > 行默认；组合模块从 `source/local` 与 `library` 唯一查找） |
| 物化层 | `host/write-preset.ts` | `writePreset`：参数 + 内容资产 → 官方预设目录（agent.cordis.yml / prompt-configs / variables.yml）；`runtimeOf` 透传、`modelRequestConfigs` 模型 patch |
| 装配层 | `index.ts` | `reloadPresetParams`（preset.yml → runtime）、`applyParamOverrides`（旧 overrides.yml 通道）、`rebuildPreset`（写入触发） |
| 接线层 | `runtime/settings-bridge.ts` | `/param-overrides` GET（读回）/ POST（保存到激活预设 preset.yml） |
| 消费端 | `client/prompt-tool-store.ts` | fields（UI 态）/ `persistParamOverrides`（条件发送：已有键或已改动键）/ `paramPatch`（读回） |

## 2. 参数流链路（保存 → 生效）

```
UI fields
  → persistParamOverrides（所有键总是发送，含 '' / [] / false / 0）
    → /param-overrides POST（settings-bridge）
      → savePresetParams（写 preset.yml：model 顶层段 / params；空值删键）
        → reloadPresetParams + applyParamOverrides（runtime 态）
          → rebuildPreset → writePreset
            → runtimeOf（透传 WRITER_PARAM_KEYS）
            → resolvePresetParams（spec.params + runtime 合并）
            → buildModuleConfigsFromParams（参数桥 → 行级 config）
            → renderComposition（参数桥 > moduleConfigs > 行默认）
              → agent.cordis.yml（宿主挂载生效）
```

## 3. 空值语义（统一规则）

`savePresetParams` 对空值统一处理（2026-08-25 起）：

| 值 | 处理 | 原因 |
|---|---|---|
| `''`（字符串清空） | **删键** | 回落模板/引擎默认（如 reasoningEffort 留空 = 继承宿主） |
| `[]`（列表清空） | **删键** | 引擎对空数组 fail loud（bootstrapTools/stages）或全拦注入（messageSources/allowKinds） |
| `0`（`stagePreUnlock`） | **写 0（保留）** | 引擎 `undefined → 1`，`0` 是合法档位，二者不等价 |
| `0`（其余数字） | **写 0** | 引擎 `|| 默认` 等价（maxPromoteSteps 0→4、deferredGraceSteps 0→无延迟） |
| `false`（布尔） | **写 false** | 引擎 `=== true` 归一，false = 显式关闭（与默认等价或明确） |


**保存前全量参数校验（2026-09-01）**：`/param-overrides` 写分支在落盘前调用
`validateEngineParamValues()`（契约层与渲染消费同源）——覆盖全部 `ENGINE_PARAM_KEYS`：
布尔键必须是 boolean；数值键（temperature/maxTokens/步数/字符数）按各自约束（有限数 /
正整数 / 非负整数）；字符串键必须是 string；列表键（工具集/白名单/来源）必须是 string 或
string[]；`maxDepth` 接受 `''`/`provider-managed`/非负整数/字符串标量；`stages` 必须是
`{ name, tools }` 数组。未知键（旧内容别名等不兼容键）在保存期响亮失败
（`400 overrides-unknown-key` / `400 overrides-invalid-value`），不做运行时自动兼容。
UI 字符串与 preset.yml 手写 number 两通道统一；空字符串仍是合法删键值。
渲染层保持宽容（never-brick），配置错误只在保存期响亮失败。

UI 侧 `persistParamOverrides` **条件发送**：

- `load` 时记录 preset.yml 已存在的参数键；
- 已有键即使被改成 `''` / `[]` / `false` 也发送，由保存层删除键；`stagePreUnlock: 0` 是合法档位，会照常写入；
- 未改动且 preset.yml 未声明的 UI 默认值不发送，避免把 UI 默认固化成覆盖模板 `moduleConfigs` 的 params；
- 用户把值改到与 UI 默认不同即发送。

> 这里的「空值删键」只适用于引擎行为参数，不适用于内容占位变量。`variables` 的空字符串占位键是有意设计，必须继续写入 `variables.yml`，供内部世界书工具（`world_book_upsert`）动态登记与调整，不参与引擎参数校验。


## 4. variables 双通道（两套体系，不互串）

1. **引擎行为参数**：`PARAM_KEYS`（派生自 `ENGINE_PARAM_KEYS`）——UI 有编辑入口，writePreset 合并时**排除出 variables.yml**。
2. **内容占位变量**：`spec.variables` 段（preset.yml 顶层 variables）→ `variables.yml`——空值占位键也写入：
   - 引擎插值（`engine/interpolate.mjs`）`hasOwnProperty` 命中 → 替换（空串不留字面）；
   - 用途：模型经 `world_book_upsert` 写世界书条目，内容引用 `{{key}}` 占位；ST 未定义宏登记；
   - UI 模板变量卡（VariablesEditor）可编辑默认值覆盖。

新增参数时必须明确归属：引擎行为参数 → `ENGINE_PARAM_KEYS`（自动进 PARAM_KEYS 排除集）；内容占位 → `spec.variables` 段。二者不互串。

## 5. 新增参数 checklist（引擎行为参数）

1. `shared/engine-params.ts`：`EngineParams` 加字段 + `ENGINE_PARAM_KEYS` 加键（双向断言强制，漏改任一侧 typecheck 报错）。
2. 若需 writePreset 透传：`PresetWriterParams` Pick 加键 + `WRITER_PARAM_KEYS` 加键（断言强制）。
3. `host/manifest.ts`：`buildModuleConfigsFromParams` 加装配（否则契约测试「无装配消费」报错）。
4. 存储：若走 model/subagentModel 顶层段 → `MODEL_SEGMENT_MAP` 加映射（展平/迁移共用）；否则 params 段。
5. UI：`prompt-tool-bridge.ts` 的 Fields 必须覆盖全部 `EngineParamKey`（编译期断言），`prompt-tool-store.ts` 读回 / 快照 / persist 与组件编辑入口同步。
6. 测试：`test/host/param-contract.test.mjs` 的 BRIDGE_SAMPLES 加样本值（若为参数桥消费键）。
7. `docs/architecture-params.md` 如有语义变更同步；CHANGELOG 记条目。

## 6. 保存状态机（防保存期间编辑丢失）

`persistParamOverrides` 不直接把“当前 fields”当作保存结果：

1. 请求进入参数专用队列，串行化多次失焦/开关保存；
2. 队列执行时生成 `savedSnapshot`，请求载荷与成功后的已保存基线都来自该快照；
3. 请求成功后只把 `savedSnapshot` 写入 saved 基线；若用户在请求期间继续编辑，当前 fields 与快照不等，仍保持 dirty；
4. 只有当前 fields 与快照一致时才触发静默 `load()`；读取期间草稿版本再次变化时，`load()` 放弃应用服务端快照，避免旧磁盘状态覆盖新草稿；
5. provider 自动预选只是显示兜底：preset 未声明 provider 且模型名为空时不写入 params，防止 UI convenience default 被固化成用户覆盖。

`SwitchSnapshot` 的 dirty 比较为全字段结构化深比较（数组/record 均参与），新增参数只要进入 snapshot 即自动参与脏检测。客户端 `Fields` 与 `EngineParamKey` 有编译期覆盖断言，防止 host 新增参数后 client 静默丢弃；`bridgePost` 对桥载荷做 runtime shape guard，异常 JSON 不再被直接当作成功结果消费。

## 7. 合并优先级（组合行 config）

组合模块目录分工：`engine/compositions/source/local/` 是本项目自有模块的唯一源，
`engine/compositions/library/` 只保存 `pnpm rebuild:composition` 从官方预设切出的行与
确有语义差异的变体；`renderComposition` 跨目录发现同名模块时直接失败，避免源文件与
生成产物漂移。


`renderComposition`：**参数桥（params/UI）> moduleConfigs（模板/ST 行级直写）> 行默认**。
moduleConfigs 仅补充参数桥未覆盖的键（如 ST 导入 tool-web.fetch），不再锁定覆盖 UI 可管理参数（2026-08-25 翻转）。

## 8. 内容策略三功能与参数归属

`engine/instruction-hint.mjs` 是通用内置能力：`strategy: instruction-hint`、
`placeholder + fill: instruction-hint` 与 `context-gate.instructionHint` 共用同一组
文件探测、提示文本与转换函数；它不属于 anchored 预设专属模块。

`engine/strategies.mjs` 三个内容策略是**独立功能**，仅分类器在 fallback 层共用：

| 策略 | 功能 | 消费参数 | 注入时机 |
|---|---|---|---|
| `first-turn-anchor`（near-anchor） | 锚定：首轮任务分类 → 一次性锚句 | `buildPattern` `complexPattern` `firstTurnBuild/Inspect/Deep` `firstTurnCustom` `firstTurnText` | 首条用户消息后一次 |
| `guide-auto`（router-guide） | 引导：每轮路由强弱引导 | `guideWeak` `guideDeep` `guideCustom` `guideText` + **fallback 复用 `complexPattern`** | 晋升后每轮 |
| `custom-fallback`（prompt-injector） | 兜底注入：锚定词确认后注入 preset.md | `firstTurnWord`（锚定确认词）+ `promptText` | 确认后一次 / 未确认两轮兜底 |

复用点：`guideComplexPattern` 冗余副本已移除——引导的复杂判定 fallback 复用锚定的
`complexPattern`。旧预设 params 残留的 `guideComplexPattern` 不再运行时兼容（已从
PARAM_KEYS 移除），由 `pnpm migrate:presets` 离线一次性清理。
锚定与引导**不合并**：锚定句（reasoning 开头句，首轮一次性）与引导句（路由引导，每轮）注入位不同。

### 模块化视图（2026-08-25）

- **任务分类器单一能力**：`engine/classify-task.mjs` 的 `createTaskClassifier({ buildPattern, complexPattern })`
  提供 `ready` / `classify`（complex > build > fix）/ `isComplex`——锚定三档判定与引导复杂判定共用，
  正则构建与判定逻辑不再双处内联。
- **引导开关独立**：`guideEnabled?: boolean`——显式声明优先；`undefined` = 兼容旧行为（跟随
  `firstTurnAnchor`，关锚定 = 关引导）。TUI `/prompt-tool toggle guideEnabled` 可独立控制。
- **自定义文本契约统一**：锚定/引导策略统一读 `config.params.text`（`useCustom + text` 契约形态），
  `firstTurnText` 仅作存储键保留（writePreset 映射 `text: params.firstTurnText`，引擎兼容回退读旧键）。

### 世界书条目结构归一（2026-08-25）

`host/worldbook.ts` 的 `buildWorldBookEntry(input)` 是世界书条目结构工厂（能力归一）：
`strategy/layer/position` 固定值与 params 键集（constant/keys/secondaryKeys/caseSensitive/
wholeWords/selectiveLogic）单一权威。两个写入端共用：
- **ST 导入**（`sillytavern.ts` convertStToPreset）：ST 字段别名收敛（keys/key、constant/add_always、
  disable/enabled、insertion_order/order、case_sensitive/caseSensitive 等）保留在转换层，结构构造下沉工厂；
- **模型工具**（`world-book-tools.ts` world_book_upsert）：模型参数直接经工厂构造——工具后续暴露
  wholeWords 等字段时两通道自动一致。
- **角色卡记忆**（`characters.ts` buildCharacterMemoryEntry）：角色卡导入/记忆同步的 world-book 记忆
  条目同源构造（id 由调用方加 chara-<卡>- 前缀，工厂 id 缺省不写）。

契约测试断言：ST 转换产物与工厂同参数构造完全一致（两通道同构）。

### 锚定确认词归一（2026-08-25）

`firstTurnText`（锚定句）与 `firstTurnWord`（确认词）本质同功能——确认词是锚句的派生属性
（模型按锚句要求以某词开头，确认机制就该匹配该开头）：
- **自动派生**：writePreset 渲染 prompt-injector 时从锚句文本提取信号词集合 `anchorWords`
  （内置格式 `the exact sentence: X` → X 首词；无格式 → 文本首词；小写去重）——deep 档
  （Let…）与自定义锚句不再因固定确认词 we 而确认失败（旧缺陷）；
- **多词确认**：`anchor-match` prefix 模式从「仅首词」改为「任一确认词前缀命中」（any 语义）；
- **显式覆盖**：`firstTurnWord` 非空时优先（旧预设 `we` 行为不变）；空 = 自动派生（模板默认）。

### 主会话人设参数化（2026-08-25）

- 存储/契约：`ENGINE_PARAM_KEYS` + `WRITER_PARAM_KEYS` 完整透传（runtimeOf / index /
  preset-core / reloadPresetParams / initialRuntime）；
- 渲染：writePreset templateDefaults 对 persona-main 配置覆盖 `text`（非空时）；
  空值 = 模板默认（空值删键语义已有），模块卡仍为底层编辑入口；
- UI：模型路由卡（主对话）人设输入，persist 条件发送 + 读回。

### 人设参数桥移除（2026-08-26）

- `mainPersona` / `subagentPersona` 参数桥与 UI 输入框整体删除，人设一律由
  promptConfigs 配置卡承载：主会话 = persona-main 卡 text（唯一入口，无覆盖层）；
  子代理独立人设 = 新建配置卡（layer=pre-step + audience=subagent，继承主会话
  persona 并追加专属段；无子代理卡 = scope 链继承，行为不变）。
- 子代理 persona 语义变化：per-child shadow 整体替换 → 继承 + 追加。

### 子代理 persona 恢复官方 per-child shadow（2026-08-26，官方源码确认后修正）

- deepseek-harness 官方机制核实：`tool-subagent` 行 `config.persona` = per-child
  persona（子代理 scope 注册 `deployment:persona` 同名段 shadow 全局）；`PromptSection`
  无 audience 概念、同名段重复注册抛错、`AssembleContext` 仅不透明 ScopeKey——
  promptConfigs 配置卡无法做 per-scope persona shadow，上一条"pre-step 配置卡"
  结论作废。
- 修正：`subagentPersona` 参数桥恢复（写 delegation 行 config.persona），UI 在
  子代理模型卡自由编辑；主会话保持 persona-main 配置卡。`mainPersona` 删除有效。

### 子代理 persona 配置卡替换方案（2026-08-26，AssembleContext.agent 发现后定稿）

- 决定性源码发现：`assembleContextFor(agent)` 返回 `{ agent, scope: agent }`——
  `AssembleContext.agent` 运行时存在（官方类型仅声明 scope/signal），systemPrompt
  section 的 text 函数可判定当前装配 agent，`isDelegated(agent.session)` 可区分子代理。
- 定稿：子代理独立人设 = **配置卡**（system-section + `audience=subagent` +
  params.sectionName=deployment:persona），**不独立注册**（同名段冲突规避），作为
  persona-main 段的子代理分支：主会话 = 主 persona 文本；子代理 = 子卡文本（**替换，
  不继承**）；无子代理卡 = 继承（persona 段保持静态）。complete/suppressRuntimeContext
  透传不变。`subagentPersona` 参数桥再次删除（配置卡为唯一入口）。

### 角色卡导入的 persona 开放（2026-08-25）

ST 转换（convertStToPreset）自带人设开放处理（`moduleConfigs.persona = { complete: false }`，
注释「complete: false 允许 system-section 生效」）——但角色卡**导入激活预设**（applyCharacterToPreset）
此前未处理：激活预设 persona-main `complete: true` 会在 assembly 抑制导入的 ST
system-section 段（character-definition / system-prompt / post-history）。

修复：导入卡含 system-section 段且激活预设 persona-main complete: true 时，自动置
`complete: false`（开放，返回 `personaOpened: true`）；幂等（已开放不再改）；纯世界书卡
（无 system-section）不触碰。

## 9. 子代理工具策略（subagentToolPolicy，2026-09-02）

`subagentToolPolicy` 是 preset.yml 顶层领域段（非 params 键），声明子代理实例级工具授权：

| 字段 | 职责 |
|---|---|
| `ceiling.allow` / `ceiling.deny` | 用户授权上限与永久禁用；deny 永远优先，任何 selector / additional_tools 不能恢复 |
| `defaultProfile` | 未命中任何选择器时的工具档 |
| `profiles[]` | 工具档（id/name/allow/deny/modelSelectable）；allow ⊆ ceiling.allow |
| `characterBindings[]` | 角色卡 id → 工具档绑定（模型可选） |
| `taskRules[]` | 有序正则任务规则（order 升序，首个命中生效；modelSelectable） |
| `modelExpansion` | 模型扩权（enabled/allow/maxAdditionalTools/requireApproval） |

### 分流规则

- 策略未启用（段缺失）：参数桥照旧把 `toolFilterAllow/Deny` 同时写入主代理 `tool-filter` 与子代理 `delegation.toolFilter`（官方原行为）。
- 策略启用（段非空）：参数桥只写主代理 `tool-filter`；子代理由 `subagent-tool-policy` 模块的 agent-local shadow 在创建窗口解析并冻结 toolFilter（不再热更新；需要更高权限时创建新实例）。
- `subagent-tools/policy.yml` 是生成物（writePreset 从 preset.yml 顶层段物化）；preset.yml 仍是单一来源。
- 保存链路：`/subagent-tool-policy` POST → `validateSubagentToolPolicy()` 校验 → 原子写盘 → 自动装配/移除 `subagent-tool-policy` 模块行。
- writer 直接读取手写/导入的 `subagentToolPolicy` 时同样先校验，并自动装配运行时模块；策略启用后 `subagentModel` 路由、reasoningEffort、maxTokens 与 maxDepth 改写到策略模块，不再只落到被 shadow 的官方工具行。
- 预览链路：`/subagent-tool-policy-preview` POST 与运行时 `resolveSubagentToolPolicy()` 同一 seam（不重复算法）；预览用 ceiling 工具宇宙。
- 工具面：`/tool-surface` POST 接受互斥的 `{ sessionId }` 或 `{ presetId }`。前者只读返回当前存活本地 Agent 的 name/description 摘要；后者仅在用户明确选择预设时，经官方 `agentPresets.list()` 白名单、`standingKeyFor()` 和 `tools.schemas(scope)` 懒加载预设有效能力。两者均不下发完整 Schema、大文本或 secrets；PTC 下“预设工具能力”不等于模型 wire 直连工具。

### 模块事实与能力卡（2026-09-05）

- `/bootstrap` 附带 `moduleFacts`：`declaredModules`（缺失为 `null`）、`effectiveModules`（`modules: []` 保持显式空装配）、递归 `rowIds`、`sourceMode` 和 `editable`；官方 `agent.cordis.yml` 行只作运行事实，不伪装成可编辑的插件能力。
- 能力卡存在性只由显式 `modules` 命中 `moduleKeys` 决定，不能由 params 或官方组合 `rowIds` 推断；`moduleConfigs` 回显优先级保持 `params > moduleConfigs > 行默认`。
- `tool-filter`、`context-gate` 等参数各有唯一 UI owner；子代理委派卡只编辑 `maxDepth` 与 `subagentToolPolicy`，避免跨页失焦保存互相覆盖。
- `engineCapability` bridge 只接受服务端白名单能力/recipe；recipe 不作为持久化实体，但展开结果一次写入目标 preset.yml，候选组合校验通过后才重建。

### 边界

- provider 不支持 toolFilter / agentOptions / depthLimit 时启动前 fail loud（不做 prompt-only 假过滤）。
- `modelExpansion.requireApproval: true` 且无 approval 通道时 fail closed（拒绝创建）。
- 扩权严格限制在 ceiling.allow ∩ modelExpansion.allow 内，`maxAdditionalTools` 上限数量。
- 模型不能修改 ceiling、profile、角色绑定或任务规则；UI 保存走受控端点。

### 纯模块接口（engine/subagent-tool-policy-core.mjs，单一 seam）

```
validateSubagentToolPolicy(raw)   → string[]（空 = 合法）
compileSubagentToolPolicy(raw)    → Compiled（正则/Set/分类器）
resolveSubagentToolPolicy(c, r)   → { selectedProfileId, toolFilter, ... }
buildSubagentToolParameters(c)     → 模型可见扩展参数 Schema
```

## 10. 契约测试

- `test/host/param-contract.test.mjs`：PARAM_KEYS 派生一致性；每个 ENGINE_PARAM_KEYS 键有装配消费；MODEL_SEGMENT_MAP 段目标唯一。
- `test/host/write-preset.test.mjs`：模型参数 patch 生成/留空跳过；空值删键（''/[]，stagePreUnlock=0 保留）；PARAM_KEYS 不进 variables.yml，variables 空占位键保留。
