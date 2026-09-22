# engine 复用指南（晋升门控 / PTC 通用模块）

本仓库的引擎（`engine/`）是**自包含**的通用模块库：提示词注入引擎、触发器引擎
（声明编译器 + 动作库 + 条件谓词）、指令文件提示与各提供者模块全部以
共享 ESM 实现 + cordis 插件行提供，任何 dsh 预设可自由装配。晋升门控、上下文门控、
工具目录相位、首轮锚句、深思门、进度节拍与工具名单**不再是内置能力模块**：
它们改由预设顶层 `triggers` 段的声明表达（见下「模块清单」，净损失与迁移项同样列在那里）。

装配遵循按需语义：空模块、无规则且无请求参数时生成合法空组合；显式参数补齐对应能力，
真实提示词规则或模型请求参数补齐必要的 `prompt-config-engine`，不创建额外 UI 配置卡。
四个官方基型保留上游工具能力，人设统一由 preset.yml 顶层 `persona` 段（官方
`@deepseek-ai/dsh-persona` 行 config 同构）驱动——`renderComposition` 在 `modules` 清单预设中
直接从字段生成该行，不读取任何 persona 模块。模块库不提供 `persona`，不得把人设
重新拆回模块清单；ST/角色卡转换也遵循顶层字段契约。

`filesystem-editor` 是**本地模块**
（`engine/compositions/source/local/filesystem-editor.yml`）：DSH `0.1.5-rc.2` 官方 minimal 已删除
`filesystem` 行，只剩当前 OS 的持久 shell，因此内置 `preset/pt-minimal` 同步为单 shell 工具基型；
带隔离文件系统的 `fs-local` + `str-replace-editor`（同属一个 `fs` 隔离域）只由显式声明
`filesystem-editor` 的预设装配。官方 `agent.cordis.yml` 中同名 row 不作为
可编辑插件能力；同一预设内仍禁止重复 row。

### 官方与本地分类

- `engine/compositions/library/`：跟随核验过的官方最新 master，当前原样切出 24 个模块。官方预设本身的
  `delegation-ptc`、`skill-filesystem-cordis` 差异可保留，但不允许注入本地补丁。
- `engine/compositions/source/local/`：14 个本地自有或本地改写模块的唯一源码。
  `tool-bash-disabled` 与 `persistent-shell-posix` 是本地适配，不因使用官方包就归为官方模块。
- 模块文件名是 `modules` 的直接标识；官方原始 row id 保持不变，必要的模块名只描述职责
  或预设变体，例如 `tool-present` 对应官方 `present` 行。官方模块不使用额外 `official-` 前缀。
- 本地明确职责：`tool-git-bash` 提供 Windows Git Bash，`declared-triggers` 读入预设的
  `triggers.yml` 声明并注册触发器。其他已经清楚的名称保持不变。
- **不提供旧名别名、兼容导出、双读或自动迁移。** 已撤销的模块名直接拒绝；`tool-bash`
  和 `persistent-shell` 只表示原样官方模块。本地适配须使用明确的新名。嵌套官方编辑器的
  row/tool 名 `str-replace-editor` 保持，但它不是可独立引用的组合模块。

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
   | 核心可复制 | 触发器引擎（声明编译器 / 动作库 / 条件谓词）、提示词注入引擎、条件判定、ST 渲染、世界书选择、`compaction-epoch`、`subagent-tool-policy-core`、`classify-task` | 无额外依赖：隔离复制后即可挂载并完成注入 |
   | 需官方 DSH 包 | 依赖宿主服务（`tools` / `systemPrompt` / `llm` / `agents` / `scope`）的模块行 | 目标项目需装配同名宿主服务；缺服务时按各自契约报错或跳过（`inject` 声明的行保持 pending） |
   | 需 Prompt Tool 私有服务 | `character-tools.mjs`、`world-book-tools.mjs`、`session-var-tools.mjs` | 各自适配私有 `pt-*` 服务（角色卡 / 世界书 / 会话变量存取）：隔离复制后三条各告警一次并跳过，提供同名 mount 服务后 3/3 正常挂载 |

   实测（2026-09-20）：把 `engine/` 复制到隔离目录、由最小 Cordis 根挂载并触发一次 `agent/pre-step`，
   核心模块完成注入（正文 `COPIED`）；三条私有适配器在缺服务时各告警一次，补齐 mount 服务后全部注册成功。
   因此私有适配器只在第二个真实宿主需要这些能力时再考虑下沉，当前只需按上表明确依赖契约。
2. 组合文件（agent.cordis.yml）以相对路径引用引擎插件行：

   ```yaml
   - id: prompt-config-engine
     name: ./engine/prompt-config-engine.mjs
   ```

3. 需要按预设参数化时，参考本仓库 `manifest.ts` 的
   `buildModuleConfigsFromParams`（params 扁平键 → 模块行 config 对象合并，
   取代旧 `__TOKEN__` 文本占位符）与 `applyModuleConfigs`（行级/嵌套合并）。

## 模块清单（触发器引擎、声明与提供者）

七个专用能力模块（`context-gate`、`tool-bootstrap`、`tool-filter`、`anchor-turn`、
`deliberation-gate`、`progress-reminder`、`promoted-code-mode`）已删除，其行为改由预设
顶层 `triggers` 段的**声明**表达：`writePreset` 把该段物化为 `<预设目录>/triggers.yml`，
`declared-triggers` 行在运行时读入、编译并注册。声明由预设提供，引擎不带默认
（`triggers.yml` 缺失 = 没有声明，不注册任何触发器，也不让预设挂载失败）。

**净损失只有两项**（其余是机制统一，不是能力删除）：

- `stages` 渐进披露（多级阶段窄化、`phase_advance` 推进工具与阶段状态段）**按拍板放弃**：
  它只是触发器机制的一个应用，需要时可用「多条件 + 多触发 + 多动作」自行声明；
  引擎不再提供该内置能力，也不注册推进工具。
- `promoted-code-mode` 的**「晋升后才呈现 PTC」时机特性**：PTC 呈现不再由晋升相位触发，
  需要 PTC 的预设直接在 `modules` 里装配官方 `tool-presentation` 行。

`bootstrapMaxTokens`（首轮输出封顶）与 `personaSectionsOnly`（首轮 sections 白名单）
**不是放弃**：两者已作为声明迁移，分别为 `request-params` 动作的 `patch` / `unset`
与 `assembly` 动作的 `target.sections.keep`。

### 未迁移项（待产品/引擎侧决定）

以下两项**既不是「已迁移」，也不是拍板放弃的净损失**（净损失只有上面两项），而是
**尚未处理**的未迁移项：它们都要**改写已有段的正文**，而 `assembly` 动作只能
`sections.add` / `remove` / `keep` 整段（`engine/actions.mjs:386-391`，没有正文改写形态），
因此**未写声明**。

- `workspaceLine`（`engine/tool-bootstrap.mjs:323-339`，调用点 `:415`）：晋升后给 persona 段
  追加一行工作目录（段正文已含该行则原样返回，幂等）。
- `phase1FirstCallInstruction`（`engine/tool-bootstrap.mjs:439-444`）：受控相位里给保留下来的
  段追加首调指令（段正文已含该文本则跳过，幂等）。

两项当前都没有等价声明，需要产品/引擎侧决定补哪种原语（例如 `sections` 的正文改写）。

### 已知边界

- `request-params` 动作无条件走 `matchesAgentScope`（`engine/actions.mjs:691`）；未声明
  `modelScope` 时 `matchesModel` 按「非 Flash」过滤（`engine/shared.mjs:117-120`：`scope`
  非 `flash` 即「非 Flash」），而原 `tool-bootstrap` 的预算监听没有模型过滤
  （`engine/tool-bootstrap.mjs:466-483`）⇒ **Flash 模型下 `bootstrapMaxTokens` 不等价**。
  对拍用例使用非 Flash 模型，这一支未覆盖。

| 模块行 | 引擎文件 | 职责 |
|---|---|---|
| `instruction-hint` | engine/instruction-hint.mjs | 通用指令文件解析：`params.text` 自定义提示 → `params.file` 运行时读该文件正文（`Instructions from:` 头）→ `params.scope`（all / global / project）只发文件存在提示。**自带 plugin 形态**：挂本行并 `enabled: true`，即在晋升后把 agent-instructions 全文换成一次性 hint（原 `context-gate.instructionHint` 的归属；参数桥 `params.instructionHint` → 本行 `enabled`）；prompt-config 的 resolver 与本行共用同一实现 |
| `declared-triggers` | engine/declared-triggers.mjs | 触发器声明入口：读 `triggers.yml`（preset.yml 顶层 `triggers` 段的物化产物）→ 编译 → 注册；有声明时由 `writePreset` 自动装配 |
| （纯模块） | engine/trigger-spec.mjs / engine/actions.mjs / engine/predicates.mjs | 触发器引擎：声明编译器（校验 / 稳定排序 / 挂载）、七类动作（`inject-text` / `assembly` / `decision` / `append-context` / `guard` / `sdk-strip` / `request-params`）、条件谓词（`text` / `phase` / `source` / `count` / `names` / `session` / `preset` + `any` / `all` / `not` / `notAny`） |
| `prompt-config-engine` | engine/prompt-config-engine.mjs | 提示词配置执行器（per-config `promotion: main / include-subagents` 门控） |
| `tool-config-engine` | engine/tool-config-engine.mjs | 自定义工具引擎：preset.yml `customTools` 段 → 官方转换器物化标准 JSON Schema（`custom-tools/*.yml`）→ 运行时 `ctx.tools.register`（执行器 shell/http/delegate/fs/ask-user；行 `requireApproval` 门；delegate 经 `ctx.tools.execute` 嵌套调度走完整官方工具管线） |
| `subagent-tool-policy` | engine/subagent-tool-policy.mjs | generation-scoped subagent/subagent_fork shadow：只安装到当前预设后代；spawn/fork 分别绑定官方 provider，foreground 读取 `SubagentRun.result`，continuable 读取 `childId` 并传顶层 signal；实例参数在 body 前校验，扩权经 approval 门，provider 能力不足 fail loud |
| （纯模块） | engine/subagent-tool-policy-core.mjs | 策略 validate/compile/resolve/buildParameters 单一 seam（纯模块：不 import dsh-tools、不写文件，包内引擎与 host 两侧共用；bridge 预览与运行时同一 resolver） |
| （纯模块） | engine/classify-task.mjs | `createOrderedTaskClassifier`：有序正则任务规则确定性分类（taskRules order 升序，首个命中生效） |
| character-tools / world-book-tools / session-var-tools | engine/character-tools.mjs / engine/world-book-tools.mjs / engine/session-var-tools.mjs | 按预设模块分别挂载角色卡、世界书、会话变量模型工具；宿主只提供注册服务，工具随 agent scope 生命周期清理 |
| `compaction-epoch` | engine/compaction-epoch.mjs | 晋升状态机（`phase` 谓词与既有注入路径共用；非插件行） |

## pre-step 消息角色出口（2026-09-17）

宿主把本批 `decision.messages` 逐条写成 `user/message` 事件，事件校验要求 `role === "user"`
（assistant 只能由模型侧 `assistant/message` 事件产生）。引擎因此只有一个出口角色：

- `executor.mjs#buildMessage` 统一发出 `user`；配置声明或策略 patch（含 `templateFile` 的 role）
  给出的其它值在出口降级，只 `warnOnce` 一次，原角色写入 `source.requestedRole`，正文、位置、
  次数、dedupe、order 与变量副作用都不变。合并组按首条配置的角色发出，其余成员声明的非法角色
  同样告警并留痕。
- 引擎仍接受 `role: assistant` 作为**输入**（旧预设可加载，schema 不收紧），但 `getEngineMeta()`
  的 `roles` 只返回可发出角色 `user`，`acceptedRoles` 另行列出仍可加载的旧角色供 UI 区分。
- 想让消息以 assistant 出现在模型面前，只能走宿主 assistant 侧通道，不要在 pre-step 里伪造
  assistant 历史：那会写出宿主无法重新加载的会话日志。
- 验收入口：`test/host/pre-step-persistence.test.mjs`（真实 `@deepseek-ai/dsh-session` 的
  持久化 → 重新加载 → 派生请求）。

## pre-step 协调器与独立指令文件来源（2026-09-14）

`prompt-config-engine` 行不再无条件自建 pre-step 监听器：

- 宿主插件提供 `promptToolPreStep` 协调服务时，引擎行把本 mount 的提示词配置注册给协调器
  （`registerPreset`），由协调器用**同一个** `engine/executor.mjs#runPreStepBatch` 统一执行
  预设来源与独立指令文件来源；任一时刻每个 scope 只有一条执行路径。
- 没有该服务（引擎被复制到无宿主的目录复用）时，引擎行仍自带 pre-step 监听器，只执行自身
  预设配置；引擎不 import `src/host`，也不强制协调服务存在。
- 协调服务迟到时，引擎行先停止本地注入再启用管理路径；服务消失时反向恢复独立执行。
  注册句柄同时绑定服务实例，HMR 在相邻两步之间替换服务时也会撤销旧登记、向新实例重登；
  空预设与非空预设使用同一接管路径，任一时刻只选择一个批执行器。来源随 ctx disposer
  标记为失效，已被 waterfall 捕获的旧回调也不得在服务重挂后恢复登记。
- 来源作用域来自注册 ctx（`@deepseek-ai/dsh-scope`）：同一 scope 内**同名来源以最新一次登记
  为准**——宿主重挂同一个 preset（同一 scope 上旧 mount 的 fiber 尚未释放）时后来者接管，
  先撤旧登记再插新登记，不抛错；抛错会让引擎行未激活，进而让整个 preset 挂载失败（表现为
  无法切换预设）。被顶替的旧登记句柄迟到撤销是空操作，不会移除已接管的登记；接管只在
  同一 scope 内发生，兄弟 scope 的同名来源互不顶替。父 scope 的来源对子代理可见、兄弟
  scope 互不串，scope dispose 即释放。resolver 也绑定来源 ctx，不因合并批次而改读协调器的
  全局服务。协调器使用普通监听顺序，留在最外层 pre-step 门（声明式 `pre-step-filter`，
  `waterfallPosition: outermost`）内侧；迟到或重挂不改变该门对预设与文件消息的约束。
- 验收入口：`test/host/pre-step-wiring.test.mjs`（来源 scope 隔离与 dispose 释放、同一 scope
  同名来源接管与旧句柄幂等、协调服务迟到与 HMR 重登）。

### 独立指令文件来源

正文永远在用户自己的指令文件里；独立来源只是「按会话工作区现场探测 + 独立策略」的第二类
pre-step 来源：

- 候选资格 = 文件可读且非空 + 独立策略（`$DSH_HOME/.prompt-tool/instructions.yml`，缺省
  `enabled: false`）启用 + 该 `(fileId, revision, surface epoch)` 身份尚未出现在当前可见
  上下文里。可见面以 `session.deriveMessages()` 为准，缺失时回退「持久日志里最后一次成功
  `compaction/end` 之后的消息」。
- 因此：同版本已可见不重复注入；内容变化在下一个合适 pre-step 注入一次新版本；成功压缩后
  同版本恢复一次（新 epoch 身份）；失败压缩不推进 epoch、不重放；`reject`、缺少
  `after-user` 锚点、后续 prepare/admission 取消都不算已注入，条件恢复后仍可重试；重挂或
  进程恢复直接从持久记录重建，不依赖进程内已投递集合。
- 文件正文以 content 块注入并加 `Instructions from: <显示路径>` 头，不经过预设变量插值；
  同一文件只有一份身份，不同文件不互相去重；多个文件按全局 → 项目根 → cwd 的探测顺序、
  与预设卡一起按 `order` 升序执行。
- 已注入过的文件被清空/删除/超限时，不再注入新全文，只发一次带文件身份的失效通知；历史
  正文仍在会话日志里，插件不谎称已撤回，也不篡改旧消息。
- 旧版物化在生成目录里的 `agents-file-*` 卡（`sourceKind: instruction-file`）不再参战：
  独立来源接管后统一跳过，避免同一正文双份注入。
- 负责人冲突：该 mount 的组合仍挂着官方 `@deepseek-ai/dsh-agent-instructions` 行时（引擎行
  从物化组合读取该装配事实），协调器整体跳过文件正文注入——同一正文只由一方注入；工作台
  通过 `instructions.owner.officialInstructions` 显示该事实（`null` = 尚未观察到，不猜）。
- 装配未知同样不注入：该 Agent 的 scope 里没有任何已注册的 preset 来源（mount 没有
  `prompt-config-engine` 行，或引擎行未注册）时不确认负责人，文件正文一律不注入，
  `instructions.owner.officialInstructions` 保持 `null`——不靠「先注入再说」赌只有一个负责人。

## 提示词配置插入点与顺序

- 九个插入点彼此独立，没有跨层全局运行顺序。
- `order` 只在同一插入点内生效。
- UI / 写盘展示顺序固定为 `pre-step → system-section → runtime-context → agent-request → llm-stream → tool-pipeline → turn-stop → subagent-start → subagent-end`；这是展示与写盘顺序，不是运行时优先级。
- 模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` / `turn-stop` / `subagent-start` / `subagent-end` 是控制通道，不构成提示词文本优先级。
- 生成文件名使用 4 位零填充前缀（`0000-`），避免大角色卡 / 大预设超过 10 条后字典序错乱。

### 同 scope 内的注册顺序（2026-09-22）

上表的「顺序」说的是**配置层**的展示与文本顺序；宿主 waterfall 里另有一条**注册顺序**语义，两者互不替代：

- waterfall **由外向内**执行，最外层监听器的返回值即最终结果（`@deepseek-ai/cordis` 的 `events.ts`：`cbs.shift()` 取数组头部先跑，`waterfall()` 返回最外层监听器的返回值）。
- 普通注册（`push`）**先注册者在外**；`prepend: true` 等价 `unshift`，插到链首 = 最外层，且**同为 prepend 时后注册者更外层**。
- 因此**否决型**动作（清空 `contexts`、窄化 `tools`、按名单掩码、剥离请求参数）必须 prepend 才能落在普通注册之外；**协作式填充**（`runtime-context` 的同步占位与填充）与**纯副作用**监听器保持普通注册，不去抢外层。
- 本引擎把这条位置表达在声明里：`triggers` 声明的 `waterfallPosition: outermost` 映射为 `prepend: true`（`engine/trigger.mjs` 的 `registrationOptions`），**缺省 `default` 即普通注册**。它表达的是**位置**，不承担同一通道内声明之间的排序——后者归 `channelOrder`。
- 顺序语义只能用真实 cordis 用例证明：`test/engine/assemble-authority.test.mjs` 用「先注册的 `prepend` 竞争者」作反例，验证三类否决型装配门控确实位于普通注册之外。手写的 mock `ctx.on` 只记录选项、**不实现顺序**，不能用作顺序证据。
- **已知边界**：`prepend` 只保证「比**已存在**的普通注册更外层」。若第三方插件同样 `prepend` 且注册更晚，它仍处于更外层、可以翻越门控；`global: true` 的注册也不受本 scope 约束。这正是「不再依赖组合行序」的确切含义——位置改由注册选项保证，而该保证有明确上界，不等价于「与顺序无关」。

### 条件判定与事件层（2026-09-19）

`pre-step`、`tool-pipeline` 与三个事件层支持声明式条件：`subject` 决定匹配对象，`match`
复用 `engine/anchor-match.mjs` 的匹配语义（主键 / 副键 / `any|all|not|notAny` / 大小写 /
整词 / 正则）；未声明 `match` 即保持无条件行为。键按**字面文本**匹配，正则元字符会被
自动转义，要写正则必须用 `/pattern/flags` 形态或 `useRegex: true`。非法 `logic`、空键集合
与非法正则在挂载期 fail loud（`engine/schema.mjs#normalizeMatch`），不在运行时静默不命中。

| 层 | 扩展点 | 缺省 subject | 命中后的行为 |
|---|---|---|---|
| `pre-step` | `agent/pre-step` | `userMessage` | 与本层其余配置一致的消息批注入 |
| `tool-pipeline` | `tools/pre-execute` / `tools/post-execute` | `toolArgs` | `preDecision` / `postAction` 按条件裁决 |
| `turn-stop` | `agent/turn-stopping` | `assistantText` | 阻止本轮停止并强制续跑一步 |
| `subagent-start` | `subagent/start` | `subagentInfo` | 向该子代理注入一条上下文 |
| `subagent-end` | `subagent/end` | `subagentInfo` | 默认记录；`params.action: inject-main` 时通过独立 Agent.inject 调用向所属主会话投递文本，不改写子代理结果、不唤醒空闲主会话 |

- `turn-stop` 的续跑上限固定在引擎内（每轮 1 次、每会话 3 次：`engine/layers.mjs` 的
  `TURN_STOP_MAX_PER_TURN` / `TURN_STOP_MAX_PER_SESSION`），**不暴露为配置**——强制续跑
  失控会把会话卡在停不下来的循环里，官方 hook 桥在同等位置也只留了 `TODO(stop-loop-guard)`。
- `tool-pipeline` 的 `params.toolNames` 是逗号分隔字符串；写数组会在挂载期归一化为逗号串，
  避免被解析成空列表（= 匹配所有工具），把一条定向门扩大成全工具门。
- 条件层以外的层声明 `subject` / `match` 会在挂载期报错，不会静默忽略。
- **策略只在消费它的层生效**：`config.resolve` 只由 pre-step（`executor.mjs`）与 runtime-context
  的 `system-prompt/assemble` waterfall（`layers.mjs`）调用，其余层声明非 `static` 策略会在挂载期报错
  （`schema.mjs#STRATEGY_LAYER_SUPPORT`）。模板专属策略（`strategyDir` 懒加载）同样只允许
  pre-step 与 runtime-context，两层都真实调用 resolver：runtime-context 的模板专属策略与
  placeholder 一样先通过官方 context/variable 注册可渲染为空的同步占位，再由异步 waterfall
  在 `next()` 前填充本次装配中的对应项。官方排序、作用域遮蔽及下游门控保持生效；不缓存
  会话正文，复用同一 AssembleContext 的并发请求也各自求值。空值或异常只让该条为空并告警，
  取消或卸载会丢弃本次待填充结果。`strategyDir` 在引擎入口统一解析为绝对 URL（相对写法按
  `prompt-config-engine.mjs` 解析），相对目录不再让整行挂载抛 `ERR_INVALID_URL`。
- 条件判定的共享实现是 `engine/condition.mjs`：pre-step 缺省匹配本批用户消息，其余层按各自
  `subject` 取文本；`match` 的匹配器在 `schema.mjs` 挂载期预编译一次（`config.matchScan`），
  校验与执行同源。未命中的配置**不写入 session 去重**，条件恢复后仍能注入。
- ST 宏模板（`params.stMacros`）的跨配置变量帧只求值**当前入口获准的配置**：
  `executor.mjs#runPreStepBatch` 传入本批的层、受众、模型、晋升与条件资格集合，去重受限的
  模板在通过去重后才由执行器触发。官方组装只求值其拥有的 system-section / runtime-context
  模板，不提前执行 pre-step 或其他控制、事件插入点的 setter 与 reader；这些插入点的
  条件与执行时机仍由各自入口决定。
- 后到的获准模板按 `order` 在同一变量帧内补求值，已求值的模板不重放副作用或随机宏；
  已返回的官方文本也不因后续 pre-step 赋值而倒放重算。两种入口顺序均沿用已有变量帧，
  新步骤与成功压缩创建新帧，失败压缩不推进。该规则不增加跨插入点的全局调度顺序。
  验收入口：`test/engine/official-variable-regression.test.mjs`（真实官方组装先行、条件与
  受众/模型/晋升/去重边界、重复组装与新 epoch）及 `test/engine/st-render-macros.test.mjs`。

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
- 验收入口：`test/host/pre-step-wiring.test.mjs`（门控剥离→晋升补发的独立/管理双路径、
  接纳后不重复、重挂按持久事实恢复、reject 不记账）与 `test/engine/prompt-config-engine.test.mjs`。

## 晋升语义（epoch-aware）

- 晋升信号：`tool/call` 和/或 `assistant/message`（`promoteOn`，默认 either）；
- 成功 `compaction/end` 为晋升边界：压缩后回到受控相位，重新晋升再恢复；失败压缩保持原相位；
- `instruction-hint`（原 `context-gate.instructionHint`）以 `session.deriveMessages()` 的模型可见 surface 去重：hint 仍可见时不重复，被压缩遮蔽后才重新提示；
- 子代理：默认视为已晋升（继承完整上下文/目录）；声明里 `includeSubagents: true` 时跟随主会话相位；
- 严格门控（通用 opt-in 扩展）：由声明的 `phase` 谓词表达——`promoteGate: true` 要求首段 reasoning
  minimal-like（`we` 无 `let me`）+ 工具调用才晋升，`maxPromoteSteps`（步数兜底，开启门控时必填）
  兜底，`promoteAfterFirstResponse: true` 无工具首响应/首轮结束即晋升。

## 配置参考（params 扁平键 ↔ 模块行 config）

## 世界书入选/落选诊断（2026-09-16）

`selectStWorldBook()` 在既有判断分支旁记录只读诊断，执行器仍是真实注入与 commit 的最终
权威。诊断挂在返回的入选集合上（`selection.diagnostics`），不新增后台状态服务，
也不为解释结果重跑选择器。

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
- 接线回归：`test/host/st-preview-report.test.mjs#T08` 用物化引擎行把来源交给 bundle
  协调器，经真实 `agent/pre-step` 注入后由 bridge 读到非空 `selected`/`committed` 记录。

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

字段映射集中在 `src/shared/engine-params.ts#ENGINE_PARAM_DEFINITIONS`；host 装配、bridge 回显与配置卡共享该目录。能力各自的 `includeSubagents`、`promoteOn`、启停和提示文本都在所属卡片或声明里设置，依旧没有跨模块全局顺序；内部服务路径由生成器管理。子代理工具面只能由 `subagentToolPolicy` 实例策略授权：`toolFilterAllow/Deny` 与「主过滤下发 delegation」的兼容通道已删除，策略未启用时按官方委派行为（不写 `toolFilter`），详见 [参数架构](architecture-params.md#9-子代理工具策略subagenttoolpolicy2026-09-02)。

自定义模型工具保持 `customTools` 资产及 `tool-config-engine` 模块链路。保存方与运行时复用 `engine/tool-definition.mjs`，保存前编译官方参数 DSL 并完整验证；`customToolRequireApproval` 控制需用户批准的执行器种类。工具预览只是有效工具面的只读视图，不承担安装、连接或注册职责。

优先级：参数桥（params / UI）> `moduleConfigs`（模板/ST 行级直写）> 行默认。
moduleConfigs 只补充参数桥未覆盖的键，不再锁定覆盖 UI 可管理参数。

行默认 = `engine/compositions/source/local/*.yml` 各行 `config`，是可配置默认值的唯一归属地。
引擎不内置可配置默认值：未声明 `enabled` 视为关闭，缺必填键在装配时
响亮失败（`requiredText` / `requiredInt`），显式空文本表示该能力不注册。

| params 键 | 落点（config 键） | 行默认（组合源） |
|---|---|---|
| `instructionHint` | instruction-hint.enabled（挂 `instruction-hint` 行并 `enabled: true`） | false |

被删除能力（`context-gate` / `tool-bootstrap` / `tool-filter` / `anchor-turn` /
`deliberation-gate` / `progress-reminder` / `promoted-code-mode`）的专属参数键已全部删除
（含首轮工具/封顶、门控与相位、来源名单、节拍与深思、`stages` 与 `stage*`、`toolFilter*`
与 `contextGate*` 等）。这些行为改由预设顶层 `triggers` 段声明，见下「组合示例」。

## 组合示例

只要 PTC（不窄化目录）：装配官方 `tool-presentation` 行（`mode: ptc`），
或直接使用基型 `pt-ptc`；PTC 呈现不再由晋升相位触发。

首轮窄化 + 输出封顶 + 严格门控（等价于原 `tool-bootstrap` 的两相窄化与请求预算，
`triggers` 段由 `writePreset` 物化为 `<预设目录>/triggers.yml`）：

```yaml
triggers:
  - id: bootstrap-catalog                  # 受控相位：目录窄化 + sections 白名单
    channel: system-prompt/assemble
    when:
      phase: { promoteGate: true, maxPromoteSteps: 4, compacted: false, promoted: false }
    do:
      kind: assembly
      id: bootstrap-catalog
      target:
        tools: { allow: [bash, str_replace_editor], requireMatch: true }
        sections: { keep: ['deployment:persona-prefix', 'deployment:persona-suffix'] }
  - id: bootstrap-catalog-compacted        # 已压缩的受控相位：补回压缩工具集
    channel: system-prompt/assemble
    when:
      phase: { promoteGate: true, maxPromoteSteps: 4, compacted: true, promoted: false }
    do:
      kind: assembly
      id: bootstrap-compacted
      target:
        tools:
          allow: [bash, str_replace_editor, read, write, edit, glob, grep, todo_write, ask_user_question]
          requireMatch: true
  - id: bootstrap-budget                   # 未晋升：把首请求 maxTokens 钉到 1024
    channel: agent/request
    when:
      not:
        phase: { promoteGate: true, maxPromoteSteps: 4 }
    do:
      kind: request-params
      id: bootstrap-budget
      patch: { maxTokens: 1024 }
    waterfallPosition: outermost
  - id: bootstrap-budget-release           # 晋升后按值释放该封顶
    channel: agent/request
    when:
      phase: { promoteGate: true, maxPromoteSteps: 4 }
    do:
      kind: request-params
      id: bootstrap-budget-release
      unset: { maxTokens: 1024 }
    waterfallPosition: outermost
```

未晋升时清空运行时上下文并过滤 pre-step 来源（原 `context-gate` 等价形态）：

```yaml
triggers:
  - id: gate-runtime-contexts
    channel: system-prompt/assemble
    when:
      not:
        phase: { promoteOn: either, includeSubagents: false }
    do:
      kind: assembly
      id: gate-runtime-contexts
      target:
        contexts: { clear: true }
  - id: gate-pre-step-sources
    channel: agent/pre-step
    waterfallPosition: outermost
    when:
      not:
        phase: { promoteOn: either, includeSubagents: false }
    do:
      kind: pre-step-filter
      id: gate-pre-step-sources
      sources: [user, goal]                # 原 messageSources 的取值
```

工具名单（原 `tool-filter` 等价形态，三条声明共用同一份名单：呈现 + SDK 正文裁剪 +
执行层 guard；只裁文本不拦执行不算生效）：

```yaml
triggers:
  - id: tool-filter-presentation
    channel: system-prompt/assemble
    do:
      kind: assembly
      id: tool-filter-presentation
      target:
        tools: { deny: [web_search, web_fetch] }
  - id: tool-filter-sdk
    channel: system-prompt/assemble
    do:
      kind: sdk-strip
      id: tool-filter-sdk
      mask: { deny: [web_search, web_fetch] }
  - id: tool-filter-guard
    channel: system-prompt/assemble
    do:
      kind: guard
      id: tool-filter-guard
      mask: { deny: [web_search, web_fetch] }
      includeSubagents: false
      reason: blocked by tool-filter declaration
```

严格两阶段门控（原 `tool-bootstrap` + `context-gate` 的 `moduleConfigs` 写法）等价于上方的
`triggers` 声明：目录窄化与 sections 白名单走 `assembly`，首轮封顶走 `request-params`，
未晋升时的上下文清空与来源过滤走 `assembly.target.contexts.clear` 与 `pre-step-filter`。

## 重建与验证

- 官方 0.1.7 的来源是 `packages/bundle/web-app/presets/*.patch.yml` 中 `config.plugins`，配套技能来自 `packages/preset/agent-preset/skills`。`pnpm rebuild:composition --sync-source` 核验当前官方提交后，同步包内模板的人设/模块和技能、记录原始来源快照与 SHA-256，再生成分发库；普通重建只校验并生成组合库。
- 声明的 `channel` 和 `phase` 必须与动作的真实通道及执行阶段一致，不支持的组合在编译期拒绝；省略 `channelOrder` 按 0 排序。同次 waterfall 内下游压缩成功后，after-next 条件读取复位后的 epoch。
- 动作先经 `prepareAction` 做纯参数校验，再绑定宿主；声明编译与运行时注册复用同一入口。非法动作与不支持的 when/prepend/maxPerTurn 在物化前拒绝，不改写现有组合、正文或共享引擎。
- 工具名单的 `allow` 与 `deny` 互斥。仅主会话的 guard 不安装会传播到子代理的 restrict；受众仍在执行 guard 内校验。动作次数预算只在目标匹配并产生效果前消费，非目标工具和被阻止的结果不消耗额度。

- 更新官方模块：`pnpm rebuild:composition`。默认读取同级 `deepseek-harness`（可用
  `DSH_HARNESS_REPO` 指定源码目录），先向官方远端核验 master HEAD；本地落后、预设文件
  有未提交改动或网络核验失败时拒绝生成，不回退旧版本，也不自动修改宿主源码仓库。
- 每次同步记录真实分支/commit，更新 `test/fixtures/dsh/current/PROVENANCE.md` 与当前快照。
  离线复验：`pnpm rebuild:composition test/fixtures/dsh/current`；这是重放已记录提交，
  不是声明该快照永远为最新。完整测试校验模块来源与快照一致，且无需网络。
- 已发布依赖的实际版本以 package.json 为准，验证脚本不再另行硬编码 rc.2；更新前同时核实
  npm 的版本列表与 dist-tags，不能把名字为 latest 的旧标签误当成更新版本。
- 本地新增模块放 `engine/compositions/source/local/<name>.yml`，重建脚本校验后直接装配；
  官方预设行变体在 `OFFICIAL_MODULES` 显式登记并生成到 `library/`；本地改写不得加入生成器补丁表，两处同名会 fail loud；
- 用户目录刷新：`pnpm rematerialize:presets` 按各预设 `preset.yml` 重新物化组合（引擎由插件包提供，不再物化共享引擎）。预设内嵌 `skills/` 不由 `writePreset` 管理，脚本默认只报告漂移；`--refresh-skills` 暂存包内文件与用户独有文件的合并树，再备份旧树并切换，失败恢复原目录。同名文件按模板更新，独有文件仍在有效目录，仅独有文件不触发重复备份；不沿符号链接外写。
- 验证三连：`pnpm typecheck` + `pnpm lint` + `pnpm test`。
