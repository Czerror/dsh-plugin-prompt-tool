# engine 复用指南（晋升门控 / PTC 通用模块）

本仓库的引擎（`engine/`）是**自包含**的通用模块库：晋升门控、上下文门控、
工具目录相位、PTC（Code Mode）呈现、指令文件提示与提示词注入引擎全部以
共享 ESM 实现 + cordis 插件行/声明式配置提供，任何 dsh 预设可自由装配。

装配遵循显式按需语义：`modules: []` 生成合法空组合，只有列入 `modules` 的插件能力才会挂载；
四个官方基型保留上游工具能力，人设统一由 preset.yml 顶层 `persona` 段（官方
`@deepseek-ai/dsh-persona` 行 config 同构）驱动——`renderComposition` 在 `modules` 清单预设中
自动前插该行，无需把 persona 写进 `modules`。

`bootstrap-filesystem` 自 DSH `0.1.5-rc.2` 起是**本地模块**
（`engine/compositions/source/local/bootstrap-filesystem.yml`）：官方 minimal 已删除
`filesystem` 行，只剩当前 OS 的持久 shell，因此内置 `preset/minimal` 同步为单 shell 工具基型；
带隔离文件系统的 `fs-local` + `str-replace-editor`（同属一个 `fs` 隔离域）只由显式声明
`bootstrap-filesystem` 的预设装配，如内置 Anchored 与既有用户预设。官方 `agent.cordis.yml` 中
同名 row 不作为可编辑插件能力；同一预设内仍禁止重复 row，跨预设的 `official-*` 文件仅保留
确有语义差异的变体。

当前保留的变体包括 `tool-bash`、`persistent-shell`、`delegation` 和
`skill-filesystem`：它们分别承载平台禁用、shell 回退、PTC workflow 开关或 Cordis
技能路径差异，不能仅按 row id 合并。真正重复的嵌套拆分（如旧版独立
`str-replace-editor`）统一回收到所属官方 group。

旧版 `str-replace-editor` 模块名不再兼容也不迁移（本项目不含迁移代码）：升级前请把
预设里的该模块改写为 `bootstrap-filesystem`。

## 复制协议（跨项目复用）

1. 把 `engine/` 整个目录复制到你的项目（自包含 + vendor yaml，无外部依赖）；
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
| `code-presentation` | engine/code-presentation.mjs | 晋升后 PTC mode 呈现（`tools.presentAs('ptc')`），成功 compaction/end 释放 |
| `prompt-config-engine` | engine/prompt-config-engine.mjs | 提示词配置执行器（per-config `promotion: main / include-subagents` 门控） |
| `tool-config-engine` | engine/tool-config-engine.mjs | 自定义工具引擎：preset.yml `customTools` 段 → 官方转换器物化标准 JSON Schema（`custom-tools/*.yml`）→ 运行时 `ctx.tools.register`（执行器 shell/http/delegate/fs/ask-user；行 `requireApproval` 门；delegate 经 `ctx.tools.execute` 嵌套调度走完整官方工具管线） |
| `subagent-tool-policy` | engine/subagent-tool-policy.mjs | generation-scoped subagent/subagent_fork shadow：只安装到当前预设后代；spawn/fork 分别绑定官方 provider，foreground 读取 `SubagentRun.result`，continuable 读取 `childId` 并传顶层 signal；实例参数在 body 前校验，扩权经 approval 门，provider 能力不足 fail loud |
| （纯模块） | engine/subagent-tool-policy-core.mjs | 策略 validate/compile/resolve/buildParameters 单一 seam（纯模块：不 import dsh-tools、不写文件，.engine 与 host 两侧共用；bridge 预览与运行时同一 resolver） |
| （纯模块） | engine/classify-task.mjs | `createOrderedTaskClassifier`：有序正则任务规则确定性分类（taskRules order 升序，首个命中生效） |
| character-tools / world-book-tools / session-var-tools | engine/character-tools.mjs / engine/world-book-tools.mjs / engine/session-var-tools.mjs | 按预设模块分别挂载角色卡、世界书、会话变量模型工具；宿主只提供注册服务，工具随 agent scope 生命周期清理 |
| `compaction-epoch` | engine/compaction-epoch.mjs | 晋升状态机（被上面各模块共用；非插件行） |
| `tool-filter` | engine/tool-filter.mjs | 常驻工具白名单/黑名单（与晋升无关的常量掩码） |

## pre-step 协调器与独立指令文件来源（2026-09-14）

`prompt-config-engine` 行不再无条件自建 pre-step 监听器：

- 宿主插件提供 `promptToolPreStep` 协调服务时，引擎行把本 mount 的提示词配置注册给协调器
  （`registerPreset`），由协调器用**同一个** `engine/executor.mjs#runPreStepBatch` 统一执行
  预设来源与独立指令文件来源；任一时刻每个 scope 只有一条执行路径。
- 没有该服务（引擎被复制到无宿主的目录复用）时，引擎行仍自带 pre-step 监听器，只执行自身
  预设配置；引擎不 import `src/host`，也不强制协调服务存在。
- 协调服务迟到（插件后加载 / HMR）时，引擎行先撤下本地执行再启用管理路径；协调服务消失时
  反向恢复独立执行，不会双跑，也不存在「两个执行器各注入一次」。
- 来源作用域来自注册 ctx（`@deepseek-ai/dsh-scope`）：同一 mount 内唯一，父 scope 的来源对
  子代理可见、兄弟 scope 互不串，scope dispose 即释放；总线顺序与锚定预设一致——协调器与
  `context-gate` 同组注册，门控仍在更外层，已注入消息照样受 `allowKinds` 约束。

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

- 六个插入点彼此独立，没有跨层全局运行顺序。
- `order` 只在同一插入点内生效。
- UI / 写盘展示顺序固定为 `pre-step → system-section → runtime-context → agent-request → llm-stream → tool-pipeline`；这是展示与写盘顺序，不是运行时优先级。
- 模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` 是控制通道，不构成提示词文本优先级。
- 生成文件名使用 4 位零填充前缀（`0000-`），避免大角色卡 / 大预设超过 10 条后字典序错乱。

## 晋升语义（epoch-aware）

- 晋升信号：`tool/call` 和/或 `assistant/message`（`promoteOn`，默认 either）；
- 成功 `compaction/end` 为晋升边界：压缩后回到受控相位，重新晋升再恢复；失败压缩保持原相位；
- `context-gate.instructionHint` 以 `session.deriveMessages()` 的模型可见 surface 去重：hint 仍可见时不重复，被压缩遮蔽后才重新提示；
- 子代理：默认视为已晋升（继承完整上下文/目录）；`includeSubagents: true` 时跟随主会话相位；
- 严格门控模式（通用 opt-in 扩展）：`promoteGate: true` 要求首段 reasoning minimal-like
  （`we` 无 `let me`）+ 工具调用才晋升，`maxPromoteSteps`（默认 4）步数兜底，
  `promoteAfterFirstResponse: true` 无工具首响应/首轮结束即晋升。

## 配置参考（params 扁平键 ↔ 模块行 config）

字段映射集中在 `src/shared/engine-params.ts#ENGINE_PARAM_DEFINITIONS`；host 装配、bridge 回显与配置卡共享该目录。能力各自的 `includeSubagents`、`promoteOn`、启停和提示文本都可在所属卡片设置，依旧没有跨模块全局顺序；内部服务路径由生成器管理。

自定义模型工具保持 `customTools` 资产及 `tool-config-engine` 模块链路。保存方与运行时复用 `engine/tool-definition.mjs`，保存前编译官方参数 DSL 并完整验证；`customToolRequireApproval` 控制需用户批准的执行器种类。工具预览只是有效工具面的只读视图，不承担安装、连接或注册职责。

优先级：参数桥（params / UI）> `moduleConfigs`（模板/ST 行级直写）> 行默认。
moduleConfigs 只补充参数桥未覆盖的键，不再锁定覆盖 UI 可管理参数。

| params 键 | 落点（config 键） | 默认 |
|---|---|---|
| `usePtcMode` | code-presentation.usePtcMode | false（opt-in） |
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
档）；`phase_advance`（名字可配）推进阶段；调用更高阶段工具 = 直达（自动
跳到其档）；阶段状态由 durable tool/call 事件推导（resume/reload 自动恢复，
无文件），compaction 不重置；阶段文案经 `stageSectionTemplate` 参数化
（引擎只注入动态状态 section `stage-status`，不写死引导文本——引导类内容
一律 promptConfigs 参数化）。

## 组合示例

只要 PTC（不窄化目录）：

```yaml
modules:
  - code-presentation
```

PTC + 首轮锚定：

```yaml
modules:
  - context-gate
  - tool-bootstrap
  - code-presentation
moduleConfigs:
  tool-bootstrap:
    bootstrapTools: [bash, str_replace_editor]
  code-presentation:
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

- 组合重建：`pnpm rebuild:composition`（只生成 `library/` 的官方切块/变体；`source/local/` 保持本地源文件，不复制）；
- 本地新增模块放 `engine/compositions/source/local/<name>.yml`，重建脚本校验后直接装配；
  官方行变体在 `OFFICIAL_MODULES` 显式登记并生成到 `library/`；两处同名会 fail loud；
- 验证三连：`pnpm typecheck` + `pnpm lint` + `pnpm test`。
