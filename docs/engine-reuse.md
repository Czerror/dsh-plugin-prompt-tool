# engine 复用指南（晋升门控 / PTC 通用模块）

本仓库的引擎（`engine/`）是**自包含**的通用模块库：晋升门控、上下文门控、
工具目录相位、PTC（Code Mode）呈现、指令文件提示与提示词注入引擎全部以
共享 ESM 实现 + cordis 插件行/声明式配置提供，任何 dsh 预设可自由装配。

装配遵循显式按需语义：`modules: []` 生成合法空组合，只有列入 `modules` 的插件能力才会挂载；
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

- `engine/compositions/library/`：跟随核验过的官方最新 master，当前原样切出 22 个模块。官方预设本身的
  `delegation-ptc`、`skill-filesystem-cordis` 差异可保留，但不允许注入本地补丁。
- `engine/compositions/source/local/`：19 个本地自有或本地改写模块的唯一源码。
  `tool-bash-disabled` 与 `persistent-shell-posix` 是本地适配，不因使用官方包就归为官方模块。
- 模块文件名是 `modules` 的直接标识；官方原始 row id 保持不变，必要的模块名只描述职责
  或预设变体，例如 `tool-present` 对应官方 `present` 行。官方模块不使用额外 `official-` 前缀。
- 本地明确职责：`tool-git-bash` 提供 Windows Git Bash，`promoted-code-mode` 在晋升后启用
  Code Mode，`progress-reminder` 按工具结果节拍提醒进度。其他已经清楚的名称保持不变。
- **不提供旧名别名、兼容导出、双读或自动迁移。** 已撤销的模块名直接拒绝；`tool-bash`
  和 `persistent-shell` 只表示原样官方模块。本地适配须使用明确的新名。嵌套官方编辑器的
  row/tool 名 `str-replace-editor` 保持，但它不是可独立引用的组合模块。

## 复制协议（跨项目复用）

1. 把 `engine/` 整个目录复制到你的项目（自包含 + vendor yaml，无外部依赖）。目录里的模块按依赖分三类，
   复制后按需装配：

   | 类别 | 模块 | 复制后的运行条件 |
   |---|---|---|
   | 核心可复制 | 晋升门控、上下文门控、工具目录相位、PTC 呈现、提示词注入引擎、条件判定、ST 渲染、世界书选择、`compaction-epoch`、`subagent-tool-policy-core`、`classify-task` | 无额外依赖：隔离复制后即可挂载并完成注入 |
   | 需官方 DSH 包 | 依赖宿主服务（`tools` / `systemPrompt` / `llm` / `agents` / `scope`）的模块行 | 目标项目需装配同名宿主服务；缺服务时按各自契约报错或跳过（`inject` 声明的行保持 pending） |
   | 需 Prompt Tool 私有服务 | `character-tools.mjs`、`world-book-tools.mjs`、`session-var-tools.mjs` | 各自适配私有 `pt-*` 服务（角色卡 / 世界书 / 会话变量存取）：隔离复制后三条各告警一次并跳过，提供同名 mount 服务后 3/3 正常挂载 |

   实测（2026-09-20）：把 `engine/` 复制到隔离目录、由最小 Cordis 根挂载并触发一次 `agent/pre-step`，
   核心模块完成注入（正文 `COPIED`）；三条私有适配器在缺服务时各告警一次，补齐 mount 服务后全部注册成功。
   因此私有适配器只在第二个真实宿主需要这些能力时再考虑下沉，当前只需按上表明确依赖契约。
2. 组合文件（agent.cordis.yml）以相对路径引用引擎插件行：

   ```yaml
   - id: context-gate
     name: ./engine/context-gate.mjs
   ```

3. 需要按预设参数化时，参考本仓库 `manifest.ts` 的
   `buildModuleConfigsFromParams`（params 扁平键 → 模块行 config 对象合并，
   取代旧 `__TOKEN__` 文本占位符）与 `applyModuleConfigs`（行级/嵌套合并）。

## 晋升门控模块清单

| 模块行 | 引擎文件 | 职责 |
|---|---|---|
| `context-gate` | engine/context-gate.mjs | 注入门控：未晋升时清空运行时上下文 + pre-step kind 白名单；可选调用 instruction-hint 完成全文转换 |
| `instruction-hint` | engine/instruction-hint.mjs | 通用指令文件解析：`params.text` 自定义提示 → `params.file` 运行时读该文件正文（`Instructions from:` 头）→ `params.scope`（all / global / project）只发文件存在提示；含 agent-instructions 转换，prompt-config 与 context-gate 共用 |
| `tool-bootstrap` | engine/tool-bootstrap.mjs | 首轮工具目录窄化（bootstrap 对）→ 晋升后恢复完整目录；bootstrapMaxTokens 封顶；promoteGate 门控；personaSectionsOnly / workspaceLine |
| `promoted-code-mode` | engine/promoted-code-mode.mjs | 晋升后 PTC mode 呈现（`tools.presentAs('ptc')`），成功 compaction/end 释放 |
| `prompt-config-engine` | engine/prompt-config-engine.mjs | 提示词配置执行器（per-config `promotion: main / include-subagents` 门控） |
| `tool-config-engine` | engine/tool-config-engine.mjs | 自定义工具引擎：preset.yml `customTools` 段 → 官方转换器物化标准 JSON Schema（`custom-tools/*.yml`）→ 运行时 `ctx.tools.register`（执行器 shell/http/delegate/fs/ask-user；行 `requireApproval` 门；delegate 经 `ctx.tools.execute` 嵌套调度走完整官方工具管线） |
| `subagent-tool-policy` | engine/subagent-tool-policy.mjs | generation-scoped subagent/subagent_fork shadow：只安装到当前预设后代；spawn/fork 分别绑定官方 provider，foreground 读取 `SubagentRun.result`，continuable 读取 `childId` 并传顶层 signal；实例参数在 body 前校验，扩权经 approval 门，provider 能力不足 fail loud |
| （纯模块） | engine/subagent-tool-policy-core.mjs | 策略 validate/compile/resolve/buildParameters 单一 seam（纯模块：不 import dsh-tools、不写文件，.engine 与 host 两侧共用；bridge 预览与运行时同一 resolver） |
| （纯模块） | engine/classify-task.mjs | `createOrderedTaskClassifier`：有序正则任务规则确定性分类（taskRules order 升序，首个命中生效） |
| character-tools / world-book-tools / session-var-tools | engine/character-tools.mjs / engine/world-book-tools.mjs / engine/session-var-tools.mjs | 按预设模块分别挂载角色卡、世界书、会话变量模型工具；宿主只提供注册服务，工具随 agent scope 生命周期清理 |
| `compaction-epoch` | engine/compaction-epoch.mjs | 晋升状态机（被上面各模块共用；非插件行） |
| `tool-filter` | engine/tool-filter.mjs | 常驻工具白名单/黑名单（与晋升无关的常量掩码） |

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
- 来源作用域来自注册 ctx（`@deepseek-ai/dsh-scope`）：同一 mount 内唯一，父 scope 的来源对
  子代理可见、兄弟 scope 互不串，scope dispose 即释放。resolver 也绑定来源 ctx，不因合并
  批次而改读协调器的全局服务。协调器使用普通监听顺序，留在 `context-gate` 的 prepend
  门控内侧；迟到或重挂不改变 `allowKinds` 对预设与文件消息的约束。

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
- 被外层门控（`context-gate` 的 `allowKinds` / `messageSources`）在**本步剥离**的候选
  不算已注入：晋升或门控放行后仍会补发，不会出现「日志里从来没有这条正文，去重却认为
  已注入」的永久缺失；`reject` 步同样不记账。
- 确认缓存分别记录 `plugin:<身份>` 与 `kind:<来源>`，只比较同字段的值，与持久扫描的
  `source.plugin` / `source.kind` 两条匹配规则一致；不同字段恰好同值不会误判已投递。
- 独立执行路径与管理路径（协调器）共用同一确认实现，两条路径的去重语义一致；重挂或
  进程恢复直接从持久记录重建，不依赖进程内已投递集合。
- 验收入口：`test/host/pre-step-wiring.test.mjs`（门控剥离→晋升补发的独立/管理双路径、
  接纳后不重复、重挂按持久事实恢复、reject 不记账）与 `test/engine/prompt-config-engine.test.mjs`。

## 晋升语义（epoch-aware）

- 晋升信号：`tool/call` 和/或 `assistant/message`（`promoteOn`，默认 either）；
- 成功 `compaction/end` 为晋升边界：压缩后回到受控相位，重新晋升再恢复；失败压缩保持原相位；
- `context-gate.instructionHint` 以 `session.deriveMessages()` 的模型可见 surface 去重：hint 仍可见时不重复，被压缩遮蔽后才重新提示；
- 子代理：默认视为已晋升（继承完整上下文/目录）；`includeSubagents: true` 时跟随主会话相位；
- 严格门控模式（通用 opt-in 扩展）：`promoteGate: true` 要求首段 reasoning minimal-like
  （`we` 无 `let me`）+ 工具调用才晋升，`maxPromoteSteps`（默认 4）步数兜底，
  `promoteAfterFirstResponse: true` 无工具首响应/首轮结束即晋升。

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

字段映射集中在 `src/shared/engine-params.ts#ENGINE_PARAM_DEFINITIONS`；host 装配、bridge 回显与配置卡共享该目录。能力各自的 `includeSubagents`、`promoteOn`、启停和提示文本都可在所属卡片设置，依旧没有跨模块全局顺序；内部服务路径由生成器管理。`tool-filter.includeSubagents` 保留为引擎兼容键，UI 不再提供绑定。启用 `subagentToolPolicy` 后，子代理工具面由实例策略授权，主过滤不再写入 delegation；没有实例策略时，参数桥保留将主过滤下发 delegation 的兼容行为，详见 [参数架构](architecture-params.md#9-子代理工具策略subagenttoolpolicy2026-09-02)。

自定义模型工具保持 `customTools` 资产及 `tool-config-engine` 模块链路。保存方与运行时复用 `engine/tool-definition.mjs`，保存前编译官方参数 DSL 并完整验证；`customToolRequireApproval` 控制需用户批准的执行器种类。工具预览只是有效工具面的只读视图，不承担安装、连接或注册职责。

优先级：参数桥（params / UI）> `moduleConfigs`（模板/ST 行级直写）> 行默认。
moduleConfigs 只补充参数桥未覆盖的键，不再锁定覆盖 UI 可管理参数。

| params 键 | 落点（config 键） | 默认 |
|---|---|---|
| `usePtcMode` | promoted-code-mode.usePtcMode | false（opt-in） |
| `bootstrapMaxTokens` | tool-bootstrap.bootstrapMaxTokens | 不封顶 |
| `bootstrapTools` | tool-bootstrap.bootstrapTools | [bash, str_replace_editor] |
| `promoteGate` | tool-bootstrap.promoteGate | false |
| `promoteAfterFirstResponse` | tool-bootstrap.promoteAfterFirstResponse | false |
| `maxPromoteSteps` | tool-bootstrap.maxPromoteSteps | 4 |
| `compactionTools` | tool-bootstrap.compactionTools | [] |
| `personaSectionsOnly` | tool-bootstrap.personaSectionsOnly | false |
| `workspaceLine` | tool-bootstrap.workspaceLine | false |
| `allowKinds` | context-gate.allowKinds | 不过滤（官方 pre-step 行为） |
| `messageSources` | context-gate.messageSources | 不启用 |
| `deferredSources` | context-gate.deferredSources | 不延迟 |
| `deferredGraceSteps` | context-gate.deferredGraceSteps | 0 |
| `instructionHint` | context-gate.instructionHint | false |
| `stages` | tool-bootstrap.stages（`[{name, tools}]`） | 未声明（两相窄化） |
| `stagePreUnlock` | tool-bootstrap.stagePreUnlock | 1 |
| `stageAdvanceTool` | tool-bootstrap.stageAdvanceTool | phase_advance |
| `stageSectionTemplate` | tool-bootstrap.stageSectionTemplate | 默认模板（`{{stage}}/{{stageName}}/{{unlocked}}/{{total}}/{{advanceTool}}`；空 = 不注入） |

## 渐进披露（stages 模式）

`tool-bootstrap` 声明 `stages` 时激活多级阶段窄化（参考 dsh-router-standard
progressive disclosure 自写）：目录 = 当前阶段工具 + 预放（`stagePreUnlock`
档）+ 本模块注册的推进工具（`stageAdvanceTool`：注册、`{{advanceTool}}` 提示与
目录裁剪引用同一个名字，`stagePreUnlock=0` 时它仍在目录里；被外层工具策略挡掉时
不复活，也不触发「缺失即放开完整目录」的降级）；`phase_advance`（名字可配）推进阶段；调用更高阶段工具 = 直达（自动
跳到其档）；阶段状态由 durable tool/call 事件推导（resume/reload 自动恢复，
无文件），compaction 不重置；阶段文案经 `stageSectionTemplate` 参数化
（引擎只注入动态状态 section `stage-status`，不写死引导文本——引导类内容
一律 promptConfigs 参数化）。

## 组合示例

只要 PTC（不窄化目录）：

```yaml
modules:
  - promoted-code-mode
```

PTC + 首轮锚定：

```yaml
modules:
  - context-gate
  - tool-bootstrap
  - promoted-code-mode
moduleConfigs:
  tool-bootstrap:
    bootstrapTools: [bash, str_replace_editor]
  promoted-code-mode:
    usePtcMode: true             # PTC 呈现默认 false，这里显式开启
```

渐进披露示例：

```yaml
modules:
  - tool-bootstrap
moduleConfigs:
  tool-bootstrap:
    stages:
      - { name: 了解, tools: [read, glob, grep] }
      - { name: 开发, tools: [write, edit] }
      - { name: 验证, tools: [pwsh, bash] }
    stagePreUnlock: 1
```

严格两阶段门控示例：

```yaml
moduleConfigs:
  tool-bootstrap:
    bootstrapTools: [bash, str_replace_editor]
    promoteGate: true
    maxPromoteSteps: 4
    promoteAfterFirstResponse: true
    bootstrapMaxTokens: 1024
    compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
    personaSectionsOnly: true
    workspaceLine: true
  context-gate:
    messageSources: [user, goal]
    deferredSources: [agent-instructions, skill-catalog]
    deferredGraceSteps: 1
    instructionHint: true
```

## 重建与验证

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
- 用户目录刷新：`pnpm rematerialize:presets` 按各预设 `preset.yml` 重新物化组合与共享引擎。预设内嵌 `skills/` 不由 `writePreset` 管理，脚本默认只报告漂移；`--refresh-skills` 暂存包内文件与用户独有文件的合并树，再备份旧树并切换，失败恢复原目录。同名文件按模板更新，独有文件仍在有效目录，仅独有文件不触发重复备份；不沿符号链接外写。
- 验证三连：`pnpm typecheck` + `pnpm lint` + `pnpm test`。
