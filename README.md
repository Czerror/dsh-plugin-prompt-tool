# dsh-plugin-prompt-tool — 层级提示词注入器

> 一切皆可注入：把 DSH 官方开放的全部注入层级收敛为一个可配置提示词注入引擎——注入什么、注入到哪一层、何时注入，全由提示词配置决定。

DSH 生态的提示词注入标准层：一个 `prompt-config-engine.mjs` 接线官方六个插入点（`agent/pre-step`、`systemPrompt.section`、`systemPrompt.context`、`agent/request`、`llm/stream`、`tools/*`），内置五个预设（四个官方基型 + 自定义空白，默认 `pt-standard`），开箱即用。

> 能力来源：工具目录锚定与晋升门控移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT，上游已于 2026-09-10 冻结），近距离引导参考 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)，缓存铁律参考 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)。**本项目只移植引擎能力，不再分发上游预设**：锚定/深思链路以引擎模块与参数开关提供，由使用者在自己的预设里按需装配。

## 安装

```bash
# 1) 新建 profile：从官方 web 模板初始化（仅用于尚不存在的 profile，已存在的 profile 请跳过）
dsh --profile prompt-tool --from-default-profile web

# 2) 安装插件
dsh plugin --profile prompt-tool add dsh-plugin-prompt-tool        # npm 安装
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>          # 本地源码（link 覆盖 registry）

# 3) 启动
dsh --profile prompt-tool
```

从 web 模板初始化会让 profile 自带 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 两层，无需额外的 Web 自愈步骤。`--from-default-profile` 只在 profile 不存在时创建，不要对既有 profile 反复执行；已初始化的 profile 不会被改写。

技能**留在各自的来源目录里**（项目 `.dsh/skills`、项目 `.agents/skills`、你添加的技能文件夹、`$DSH_HOME/skills`、`~/.agents/skills`、官方内置）。引用目录复用官方 filesystem provider 发现与监听；管理页按当前会话快照标注生效、同名遮蔽和未确认状态。用户根与显式引用目录中的普通技能均可开关、删除；删除移入对应来源根的回收站，保留资源和恢复记录。插件不分发顶层 `skills/`，新增技能可创建或复制导入；同名导入先确认，成功后不保存技能历史版本。

**停用 = 改写技能文件的调用策略**：模型端写 `disable-model-invocation`、用户端写 `user-invocable`。单端开关只修改该端，保留另一端的最新状态；正文、注释和未知字段保留，提交前校验原文并原子替换。官方工具与可选 `skill_search/skill_load` 都执行调用策略。状态文件 `$DSH_HOME/skills/.system/prompt-tool/skills.yml` 只保存引用目录 `folders`（v4）；技能清单与调用策略均不进入 settings。详见 [docs/skills-management.md](docs/skills-management.md)。

### 当前格式与宿主要求

预设参数只认 `preset.yml` 的当前字段，没有运行时兼容层。

技能调用策略只接受官方 frontmatter 键，状态文件只接受 v4；不提供旧布局迁移、回滚或备份脚本。

旧的 base-only profile（只有 `dsh-base`）首次启动时，插件会把 `@deepseek-ai/dsh-web-app` 补进该 profile 的 `dsh.profile.bundles`（写前留 `.bak`，幂等），并提示重启；需要重启 DSH 服务后生效，插件不会替你重启运行中的服务。

需要 DSH `0.1.7-alpha.1+`（Cordis `4.0.3`）：设置接入 ConfigForms，插件持有的预设通过官方 agent-preset-registry 注册；宿主不再自动扫描 `.agent-presets`。本插件继续管理该目录里的定义与物化文件。官方组合模块跟随核验过的最新 master（`pnpm rebuild:composition`），记录实际提交并以当前快照离线复验。Node 需要 `^22.19.0 || >=24.0.0`，与官方宿主一致。升级后需要用户重启 DSH 服务。

## 特性

- 🔌 **六个官方插入点一次接线**：一个引擎注册全部可注入层级，共享同一套过滤与降级语义
- ✍️ **一切皆可配置**：`layer / strategy / position / promotion / audience / modelScope / mergeMode / order / text / texts / fill / variables / params` 全开放
- 🧑‍🤝‍🧑 **消息受众三态**：`audience: main / subagent`，省略 `audience` 表示公用；身份类提示词可只注入子代理
- 🗂️ **内容与执行分离**：每条提示词配置渲染为 `~/.dsh/.agent-presets/<预设>/prompt-configs/` 下的 yml，引擎按文件名数字前缀顺序扫描
- 🧩 **三层合并**：引擎默认（按 params 生成）< 模板默认 promptConfigs < 预设 promptConfigs，同名 `id` 覆盖
- 🖥️ **可拖动悬浮工作台入口**：工作台经官方 `shell.overlay` 渲染悬浮触发器与 body portal 抽屉；按钮可拖动、位置存插件自己的 localStorage、窗口变化自动夹回可见区（不读宿主布局树，已移除 `sidebar.footer.action` 几何探针）；六页（主会话/子代理/工具预览/技能设置/预设配置/角色管理）在抽屉内渲染，抽屉用 fixed + z-index 置顶，不被宿主导航栏遮挡
- 🧪 **六种内容策略**：`static / first-turn-anchor / guide-auto / custom-fallback / placeholder / world-book`（world-book 支持 ST selectiveLogic 选择性触发：任一/副键全中/排除）
- 🛡️ **失败不伤会话**：单条失败跳过 + `warnOnce`；配置错误挂载时 fail loud；`dedupe: session` 持久幂等
- 🧭 **通用 instruction-hint 引擎**：所有预设都可通过 `strategy: placeholder` 与 `fill: instruction-hint` 提示指令文件存在；实现位于 `engine/instruction-hint.mjs`，不绑定任何预设；它的 plugin 形态（挂 `instruction-hint` 行并 `enabled: true`，即参数桥 `params.instructionHint`）按模型可见 surface 去重，重挂不重复，被压缩遮蔽后才再次提示
- 📦 **Bridge 载荷**：JSON 请求统一 32 MiB 硬上限并明确返回 413；角色卡原始图片走 64 MiB 流式通道，按 PNG 魔数识别。
- 📂 **技能管理**：官方发现与会话快照统一技能来源、生效和遮蔽状态；单端开关写回技能文件。支持目录包与直属 Markdown 技能、创建、两种复制导入，以及用户根和引用根的可恢复删除；技能局部刷新保留其他页面草稿。
- 🎭 **SillyTavern 导入**：JSON 预设、角色卡和独立世界书转换为本地预设——按官方顺序表保留启停，赋值模板运行时求值；不等价能力明确报告，采样参数由宿主管理
- 🎴 **角色卡库**：PNG／JSON／YAML 角色卡与原生角色片段经统一预览后逐张入库；PNG 保留原图，更新保留角色记忆，按需应用到当前预设。
- 📦 **预设交换**：文件夹、ZIP、原生 JSON/YAML 与 ST 来源共用识别、预览和完整候选安装；导出可选完整 ZIP 或仅定义 YAML。资源、覆盖及分享边界见 [资产交换文档](docs/asset-transfer.md)。
- 📚 **世界书**：`character_book` 转 world-book 策略配置（`keys` 命中触发 / `constant` 常驻 / 正则键自动检测 / `selectiveLogic` 组合逻辑），与模块卡片同一存储与编辑（模块列表「世界书」过滤 + 批量启用/禁用）
- 🛠️ **自定义工具**：preset.yml `customTools` 段声明式定义模型工具（执行器 shell/http/delegate/fs/ask-user，`{{args.x}}` 参数插值）；参数与输出经官方 `dsh-tools` 转换器物化为标准 JSON Schema，非法参数产生标准工具错误，delegate 经 `ctx.tools.execute` 嵌套调度走完整官方工具管线；`customTools.scope` 暂不支持（显式拒绝）
- 🛡️ **子代理工具策略**：preset.yml 顶层 `subagentToolPolicy` 段（opt-in）声明 ceiling、profiles、角色卡绑定、有序任务规则与受控模型扩权；`subagent` 固定走 spawn、`subagent_fork` 固定走 fork，按官方 `SubagentRun`/continuable 契约创建并在窗口内冻结 toolFilter；模型选择器和扩权参数在工具 body 前校验，模型路由经过 LLM preflight；UI 从官方 sessions snapshot 读取当前会话，并可编辑、停用、预览策略及查询存活 Agent 工具面
- ♻️ **Session 日志读取**：引擎冷启动与幂等扫描统一走官方 `session.snapshotEvents()`（DSH `0.1.2-alpha.4+`），不再读取已移除的 `session.events` 数组。
- 🧩 **模板变量**：仅从预设顶层 `variables` 段提供 `{{key}}` 插值默认值，单条提示词配置的 `variables` 可局部覆盖——模块列表顶部「模板变量」卡片统一编辑（可折叠/清空/停用/失焦自动保存）。`params` 中的旧内容变量及 `params.variables` 不再读取，也不自动迁移；旧预设需自行整理到顶层后重新物化。锚定匹配引擎（anchor-match）统一 custom-fallback 与 world-book 的匹配语义
- 💬 **会话变量工具**：`session_var`（list/get/set/clear）——模型维护角色状态（`{{心情}}` 等），会话级覆盖预设默认；ST 运行时宏（`{{lastusermessage}}` / `{{lastcharmessage}}`）从会话事件提取
- 🧩 **工具按模块装配**：角色卡、世界书、会话变量、自定义工具分别由 `character-tools` / `world-book-tools` / `session-var-tools` / `tool-config-engine` 模块提供；不再维护重复的顶层工具开关
- 📐 **显式按需装配**：`modules: []` 保持空组合；四个官方基型的人设直接由顶层 `persona` 段生成官方行，不再经模块库；不附加其他增强模块。Minimal 保持官方单 shell 基型；带隔离文件系统的本地 `filesystem-editor` 模块（`fs-local` + `str-replace-editor` 同隔离域）只由显式声明它的预设装配。首轮窄化/门控、来源过滤、工具名单、锚句、深思门与进度节拍**不再有专用能力模块**：它们由预设顶层 `triggers` 段的声明按需表达（`writePreset` 物化为 `triggers.yml`，`declared-triggers` 行读入注册；未声明 = 无该行为，不预装 ST 管理工具，也不内置可配置默认值）；声明写错在挂载期响亮失败

## Web 客户端结构

九层提示词配置卡展开后，使用“条件 / 执行 / 内容 / 设置”分栏编辑，窄屏自动改为标签页。页面切换保留未保存草稿；设置视图修改同层共享配置，不复制为每条提示词的局部参数。

声明规则编辑器读写预设顶层 `triggers`，提供条件和动作编辑、完整声明、校验与版本冲突保护。支持七类判断原语、四种组合与九类动作；`inject-text`、`guard` 不接受通用顶层 `when`，界面会提示限制。具体支持范围见 [引擎复用指南](docs/engine-reuse.md#声明的条件与动作边界)。

Web 客户端按四层组织：

```text
src/client/
├─ app/       # SlotRegistry owner、工作台壳与六页组合
├─ data/      # typed bridge、Fields、状态 facade、保存与脏检测纯逻辑
├─ features/  # prompts / tools / subagents / skills / presets / characters
└─ ui/        # 仅 props/callback 的共享交互与 CSS Modules
```

依赖方向固定为 `app → features → data/ui → shared contract`：跨领域组合只在 `app/workspace/pages/`，feature 不导入其他 feature 内部实现；标准控件优先复用 `@deepseek-ai/dsh-client-ui-primitives`。Client bridge 通过 `src/shared/bridge-contract.ts` 的 endpoint key 与 request/value map 调用，业务代码不拼接路径。样式按 owner 拆分，使用 DSH `--dsw-*` 语义 token，不定义插件级全局主题。
完整的当前目录、slot 生命周期、状态边界、可访问性和维护约束见 [Web 客户端 UI 结构框架](docs/ui-architecture.md)。

### 配置卡与工具预览

- 六页工作台保留搜索、展开和滚动位置；工具、人设、策略以及非法 JSON/数字输入可跨页继续编辑。存在未保存草稿时，预设切换会提示先处理，不会无声覆盖。
- 配置保存与校验位于长列表操作区，失败就近显示；低频卡片操作收进菜单，删除和丢弃文件草稿需明确确认。窄容器自动换行，键盘操作、明暗主题和减弱动效均沿用宿主规范。

- 参数在模块列表的配置卡内编辑。引擎能力按实际 `modules` 装配显示，一项已装配能力一张卡，直接编辑自身参数；删除只移除该能力的模块声明。共享参数定义继续拥有字段、校验、默认草稿、保存快照和组合行映射。主／子代理模型保留专用配置卡。
- 「指令提示」统一通过「前置步骤 → 内容策略：动态填充 → 填充来源：指令提示」编辑，不再作为独立策略入口。指令文件正文和授权保存仍归独立文件通道，不复制进预设。
- AGENTS.md / CLAUDE.md 这类指令文件复用普通配置卡呈现（与 `example-pre-step` 同一个卡片组件、同一套展开表单分区），不做独立卡片或新的置顶卡；来源固定的绑定项（标识、注入层、内容策略、填充来源、配置类型、消息角色、合并方式、去重方式、来源类型、消息形式）置灰只读，名称/顺序/拼接位置/晋升范围/消息受众/模型范围可写（落独立指令策略），正文就地编辑、**焦点离开卡片时自动写回原文件**（版本冲突保留草稿并提供「重新读取」，没有单独的保存按钮）。
- 创建菜单始终提供全部层级模板、工具和可添加能力，不受当前列表筛选限制。创建后只展开目标卡片（当它落在当前筛选视野内），不改动层级筛选与搜索词；同一提示词模板可重复创建，自动分配不重复标识。空内容不等于删除，保存和后台刷新保留未完成草稿；工具草稿在层级／世界书筛选往返时不丢失。
- 工具也按模块装配，例如本地 `filesystem-editor` 同域提供文件系统与编辑工具。`library` 只放原样官方模块，本地适配归 `source/local`；模块旧名不兼容、不迁移。自定义模型工具经「添加能力 / 工具模块 → 添加工具模板 / 新建空白工具」配置名称、描述、参数、输出与执行器，保存前完整校验；不安装、连接或管理外部 MCP／DSH 插件。
- 「工具预览」是独立顶层页，参照官方插件目录：顶部统一搜索、可折叠分组、右侧预设选择、双列展开详情卡，窄屏单列。卡片显示「模型可见」，不伪造插件运行状态。当前会话与所选预设分别读取：既有会话仍使用冻结 generation，修改预设只影响后续 generation；不会隐藏同名自定义工具或自动恢复会话。
- 在工具链的 `tool-config-engine` 能力卡中配置哪些自定义执行器需要用户批准；缺少批准服务时拒绝执行。生成目录保持只读，仍由预设重建产生。

## 项目架构

本项目的 Archify 交互式架构图保存在 [`project-architecture/`](project-architecture/)：覆盖 React 工作台、loopback settings bridge、Plugin Runtime、Preset Compiler、Engine & Composition、Skills 与领域扩展以及 DSH Host 的运行链路。

- [打开最终交互式架构图（v2）](project-architecture/project-architecture-v2.html)
- [查看 Archify JSON 源规格](project-architecture/project-architecture-v2.json)
- [查看本轮视觉检查收据](project-architecture/project-architecture-v2.visual-check.json)

`v2` 已按当前 `app / data / features / ui` 客户端结构更新，并通过 showcase 9/9 校验；无 `v2` 后缀的文件保留为首轮构图记录。本轮已使用 Microsoft Edge 完成 visual-check：containment/captures 均通过，保留 1440×900 与 2048×1320 的明暗截图及联系页；自动收据的 `visualReview` 仍为 `pending`，仅表示需要人工查看截图，不代表渲染失败。


## 预设参数体系

包内目录及定义 id 统一为 `pt-standard` / `pt-ptc` / `pt-minimal` / `pt-cordis` / `pt-custom`，默认 `pt-standard`。
初始化直接按同名复制：缺哪个目录只补哪个，已有目录不覆盖，也不运行时探测官方名称或重命名。
用户保存时以当前预设自身的 `preset.yml` 生成运行产物；现有用户预设不自动改名。

预设行为由一份 `preset.yml` 单一配置源下发，参数所有者各自独立：

| 层 | 职责 |
|---|---|
| `layerSettings.<层名>` | 同层共享的引擎行为参数（锚定/引导/PTC/门控/模型/工具），经参数桥落位组合行；UI 内嵌真实配置卡，优先级最高 |
| `moduleConfigs` | 行级 config 直写通道（参数桥未覆盖的键：超时/环境白名单/ST 导入等），不锁定覆盖 UI 可管理参数 |
| `promptConfigs` | 独立命名的注入规则，`params` 仅属于该规则；与预设默认及生成配置按 id 合并 |

### 共享参数一览（全部可选，缺省按对应模块解释）

| 分类 | 键 |
|---|---|
| 锚定 | `firstTurnAnchor` `firstTurnCustom` `firstTurnText` `firstTurnWord`（空 = 自动从锚句派生确认词）`firstTurnBuild` `firstTurnInspect` `firstTurnDeep` |
| 引导 | `guideCustom` `guideText` `guideWeak` `guideDeep`（复杂判定 fallback 复用锚定的 `complexPattern`） |
| 指令 | `instructionHint`（挂 `instruction-hint` 行并 `enabled: true`，晋升后只发一次文件路径提示） |
| 人设 | preset.yml 顶层 `persona` 段（官方 `@deepseek-ai/dsh-persona` 行 config 同构）：`prefix`（必填）/ `suffix` / `complete` / `includeRuntimeContext`；`complete` 独占 system prompt，与提示词配置的「独占」互斥；子代理独立人设走 `moduleConfigs.tool-subagent.persona`（官方 per-child persona，不继承主会话） |
| 深度 | `maxDepth`（0 禁止委派 / `provider-managed` / 正整数） |

> 首轮工具面与输出封顶、`stages` 式阶段窄化、pre-step 来源名单、常驻工具白/黑名单、锚句、深思门与进度节拍都没有共享参数键：它们改由预设顶层 `triggers` 段声明（示例见 [engine 复用指南](docs/engine-reuse.md)）。其中 `stages` 阶段窄化与「晋升后才切 PTC 呈现」是本轮的两项净损失；子代理工具面只能由 `subagentToolPolicy` 实例策略授权。

> 注：`injectPrompt`（params）= 锚定确认后注入 preset.md 的开关。AGENTS.md 走「文件即真相」：文件集合、正文与版本**不再物化进生成目录**，而是由宿主按**本会话工作区**现场解析（`$DSH_HOME/AGENTS.md` + 工作区 cwd→项目根链的 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md）；工作台里的文件卡就是该文件，编辑框里的内容保存后直接写回原文件，卡片定义与正文都不进 preset.yml。插件不写常驻受管块。

独立指令来源与指令策略（2026-09-14 起）：

- 注入由宿主侧 pre-step 协调器统一执行（预设卡 + 独立指令文件卡同一批算法、每个 scope 只有一个执行器）；正文以 `Instructions from: <路径>` 头 literal 注入，不经过预设变量插值。
- 行为开关在 `$DSH_HOME/.prompt-tool/instructions.yml`：启停、层内序号、位置、晋升、受众、模型范围。**默认 `enabled: false`**（安全缺省：键缺失即视为关闭，只有显式 `enabled: true` 才参战；策略文件不因读取自动创建），需在工作台模块列表工具栏的「独立指令文件来源」总开关里显式开启；与官方 `@deepseek-ai/dsh-agent-instructions` 同装时由负责人冲突规则让位（同一正文只由一方注入）。`preset.yml#agentsHints` 已不再生效（旧字段不迁移、不删除）。
- 同一文件同版本在可见上下文里只注入一次；文件内容变化会在下一个合适时机注入新版本；成功压缩后同版本会重新注入一次；已注入过的文件被清空/删除只发一次失效通知，历史正文不撤回。
- 负责人冲突：预设里仍挂着官方 `@deepseek-ai/dsh-agent-instructions` 行时，独立来源**不注入**（同一正文只由一方注入），工作台会显示该状态；要用插件来源请先在预设里去掉官方指令行/模块再开启策略。

指令文件正文属于用户自己的文件，不受预设生命周期管辖。工作台按**打开时解析出的会话工作区**读取文件快照（正文 + 文件身份 + 字节版本 + 读取状态一次取回），正文在**焦点离开卡片**（或列表「保存」）时写回原文件：

- 未修改的文件不写盘；预设的 debounce 自动保存与预设切换都不写文件，切换预设只保留文件草稿。
- 每个请求带读取时的 `expectedRevision` 与工作区 `contextId`；外部改动或工作区变化返回 409，草稿保留并提示「重新读取」，不静默覆盖磁盘新版本。
- 读取失败（不可读/超限/文件消失）与「读取成功的空文件」严格区分：前者不可编辑、不可保存，不用空正文掩盖错误。
- 原子写入（tmp + rename，保留原权限），失败保留原文件并清理临时文件；正文不受预设变量插值影响。

模型参数按预设与所属层独立保存。主模型路由和采样参数只覆盖该预设的模型请求，不自动回写宿主全局默认；子代理路由继续由该预设的委派参数提供。

| 段 | 键 |
|---|---|
| `layerSettings.agent-request`（主对话） | `modelProvider` `modelName` `modelReasoningEffort` `modelTemperature` `modelMaxTokens` |
| `layerSettings.subagent-start`（子代理） | `subagentModelProvider` `subagentModelName` `subagentReasoningEffort` `subagentTemperature` `subagentMaxTokens` `maxDepth` |

读取当前结构后展平到内部 EngineParams；保存只更新所属层。预设与代码同步维护当前格式，不提供旧 `params` / 模型段的兼容读取、离线迁移或迁移备份，字段归属见[参数框架](docs/architecture-params.md)。人设仍统一写顶层 `persona` 段；子代理独立人设由 `moduleConfigs.tool-subagent.persona` 声明。示例：

```yaml
persona:
  prefix: You are a coding agent powered by the {{model}} model.
  suffix: Your working directory is {{cwd}}.
  # complete: true               # prefix 独占整个 system prompt
  # includeRuntimeContext: false # 抑制该 scope 的动态 runtime-context 快照
```

工作台「模型路由」卡顶部另有**当前会话**区（仅主对话作用域）：显示活动会话的模型/思维程度（会话 `modelSelection` 投影，缺省回退宿主默认），模型下拉展示全部可用模型并按服务商分组，选择模型时自动回写对应服务商；切换走官方 `session.selectModel`——对当前会话立即生效并被宿主持久化为新会话默认，与官方模型选择器双向同源；子代理会话与宿主默认场景不支持会话级切换。预设参数非空时按请求覆盖会话选择（参数桥优先级不变）。

预设事实同样跟随官方会话：官方「新建会话」旁的预设选择器走**会话级**切换（只改那个空白会话，不改宿主默认预设），插件读会话投影 `agentPreset` 后自动把工作台切到该预设——跟随只写同一份插件预设事实（不重复切换会话），官方侧选完，主会话页的配置、参数与工具预览即刻对应该预设。目标预设不在插件管理目录（例如官方随包预设）时**不跟随**并提示；当前预设仍有未保存草稿时保持不动，等草稿处理完再跟随。

> 根目录 [preset.yml](preset.yml) 覆盖全部 30 个共享参数与九层规则。`pnpm rebuild:preset-template` 从权威契约重建；规则默认关闭，共享参数按需取消注释。

## 提示词配置（九个官方插入点）

| `layer` | 官方通道 | 关键参数 |
|---|---|---|
| `pre-step` | `agent/pre-step` 消息批（默认层） | `position / dedupe / promotion / audience / modelScope / strategy` |
| `system-section` | `ctx.systemPrompt.section` 静态段 | `order / text / templateFile / variables / params.complete / params.sectionName` |
| `runtime-context` | `ctx.systemPrompt.context` 动态快照 | `order / text / variables / params.contextName` |
| `agent-request` | `agent/request`（LlmCallConfig） | `params.patch`（浅合并）/ `params.replace`（整体替换） |
| `llm-stream` | `llm/stream`（流包装） | `params.mode=pass\|replace` |
| `tool-pipeline` | `tools/*`（pre/execute/post） | `params.toolNames`、`preDecision=allow\|deny\|ask`、`postAction=accept\|replace\|block` |
| `turn-stop` | `agent/turn-stopping` | 条件命中后通过 steer 继续；每轮1次、每会话3次上限 |
| `subagent-start` | `subagent/start` + `Agent.inject` | 子代理事件匹配与注入文本；模型/深度在卡内共享设置 |
| `subagent-end` | `subagent/end` + 可选 `Agent.inject` | `params.action=observe\|inject-main`，后者投递到所属主会话 |

九个插入点彼此独立，没有跨层全局运行顺序；`order` 只在同一插入点内生效。
UI / 写盘按上表分组；这是展示顺序，不是模型提示词优先级。详细支持字段、限制与官方依据见[九层对照](docs/injection-point-contracts.md)。
模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` 是控制通道。

默认四条：`00-near-anchor`（首句锚点）、`10-router-guide`（每轮引导）、`20-prompt-injector`（we 确认后注入 preset.md 一次）、`30-instruction-hint`（指令文件提示）。

- `mergeMode`：`separate`（默认）同位置多条为独立消息；`merged` 同位置拼接为一条
- `order`：数值小者更靠近插入锚点，同时决定 `merged` 组内拼接顺序
- 文本插值：`{{key}}` 全层支持——配置/预设 `variables` 优先，ST 运行时宏（lastusermessage 等）次之，内置 `{{DSH_HOME}}/{{WORKSPACE}}/{{CWD}}` 兜底，未注册保留字面（system-section 注册期无会话时运行时宏替换为空，不残留）


## SillyTavern 导入

工作台「预设配置」页按内容识别原生预设与 SillyTavern 来源；ST JSON/YAML 预设卡片经预览确认后，按注入层级映射为本地预设：

- `prompts[]` → `promptConfigs`：system 角色进入 `system-section`，其余进入 `pre-step`；官方 `prompt_order[].order[]` 决定启停与相对顺序，深度位置保留来源并报告降级
- 采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`）**剥离**——模型参数统一由「模型设置」UI / 宿主默认管理
- ST 变量：保留可启停的赋值模板，在运行时顺序求值；声明变量在合并和角色卡应用时保持局部绑定
- ST 管理工具：始终装配 `character-tools`、`session-var-tools` 与 `tool-config-engine`
- `enable_web_search`：`true` → 额外组装 `tool-web`（fetch 启用）；`false` → 产出三条 `triggers` 声明（`assembly` 呈现剔除 + `sdk-strip` 裁 `tools:sdk` 正文 + `guard` 执行层拒绝，共用同一份 `deny: [web_search, web_fetch]`），PTC 下同样生效
- 含有效 `character_book` 条目时自动追加 `world-book-tools` 模块，使导入预设可直接调用世界书管理工具
- 世界书条目级条件：`delayUntilRecursion`（延迟到递归扫描的层级池）、`useGroupScoring`（组内评分淘汰）、`matchCreatorNotes` / `matchCharacterDepthPrompt`（按需扫描卡片备注与深度提示词）按 ST 语义求值；`characterFilter`（角色/标签过滤）、`automationId`（STscript 自动化）、`outletName` 与向量检索**不实现**，只保留来源事实并在预览卡里逐条告警
- 触发键里的 ST 宏（例如只存在于 ST 全局 persona 的 `{{user}}`）登记为「模板变量」空占位并产出诊断：未赋值时该键不参与匹配（不会退化成字面量误判），在模板变量里赋值后按既有匹配路径生效
- 角色卡 `extensions.depth_prompt` 保留为一条**默认禁用**的 pre-step 配置（ST 只在群聊自动注入），可在工作台手动启用
- `modules` 按需装配：`prompt-config-engine` 与上述 ST 管理工具始终存在；含 system-section 时补 `persona`（`complete: false` 允许 system 段生效）；含有效世界书条目时补 `world-book-tools`

转换结果是一个普通预设（id 由文件名生成），可在工作台预设切换器中直接使用。字段级参数对照与完整示例见 [SillyTavern.md](docs/SillyTavern.md)。

### 角色卡（PNG / JSON）与角色卡库

工作台「角色管理」页导入角色卡到**角色卡库**（`~/.dsh/.agent-presets/.characters/<id>/`）：

- **PNG**：`ccv3` 优先 / `chara` 兜底；按魔数识别并受限解码，原始文件先暂存、预览确认后入库，保留原图。
- **JSON／YAML**：支持 ST 角色数据和自包含原生角色片段。批次逐张预览，不把多份来源合并成一张角色卡；所有大小的文件都先预览再提交。
- 正文映射：`first_mes` → 开场白（`dedupe: session`）、`alternate_greetings` → 备用开场白、
  `description/personality/scenario` → 角色设定；采样参数剥离（模型设置 UI 管理）
- **导入到当前预设**：参数合并进当前预设 promptConfigs（`chara-<卡>-` 前缀、幂等）；可一键移除
- **角色记忆**：`memory.md` 跟随角色卡跨预设，应用时合并为 world-book constant 配置注入

### 世界书（world-book 策略）

`character_book` 条目转 world-book 策略配置（与普通模块同一存储/编辑）：

- **ST 注入语义**：常驻候选或主键命中，再按副键逻辑、概率、分组与时序筛选；非常驻无主键不注入；原生手写 world-book 约定保持不变
- **匹配选项**：`caseSensitive` / `wholeWords`；只有 `/pattern/flags` 形式识别为正则，其余为字面键
- **管理**：模块列表顶部下拉选「世界书」过滤（完整模块卡片编辑 + 批量启用/禁用）；
  模型工具 `world_book_list/upsert/delete`（`note` 写入角色卡记忆）
- **ST 变量**：赋值不在导入时执行；local/global 分表但只在会话内有效，嵌套宏有循环与大小保护。
  深度历史位置、system 角色、token 预算和 ST 扩展脚本不具备完整等价性，详见兼容边界
- **会话变量**：`session_var` 工具（list/get/set/clear）维护角色状态（会话级覆盖预设默认，
  结束即失）；跨会话长期记忆用 `world_book` note（持久 memory.md 跟随角色卡）

详细转换规则见 [SillyTavern.md](docs/SillyTavern.md)。

## 开发与验证

```sh
pnpm install && pnpm build
pnpm test          # 全量契约与行为测试（隔离 cwd 运行）：参数契约/注入装配/六插入点/生成链路/引擎语义/组合重建/模型路由/UI 契约/安全边界
pnpm typecheck && pnpm lint
pnpm verify:host         # 官方包基线：声明范围、安装版本、解析目标（拒绝源码 link）、缺失声明与 inject peer
pnpm sync:yaml           # 刷新 engine/vendor/yaml（生成目录运行时 YAML 解析器）
pnpm rebuild:composition # 只生成官方切块/变体；source/local 本地源不复制（失败安全）
```

测试由 `scripts/run-tests.mjs` 启动：先跑 build，再以独立临时 cwd 与 TEMP/TMP 启动 Node 内置 test runner，用例路径为绝对路径，避免相对 cwd 的测试污染仓库。

依赖升级后的验证顺序：`pnpm install` → `pnpm verify:host` → `pnpm typecheck && pnpm lint` → `pnpm test`。官方源码联调请使用不入库的显式本地 override，不要恢复 `pnpm-workspace.yaml` 里的 `link:` 默认配置。

发布类型声明通过 `deps.dts.neverBundle` 引用官方 SDK，不内联其品牌类型与相对模块扩充；公开类型引用的包须声明为生产或 peer 依赖，不能仅存在于 devDependencies。`deps.onlyBundle` 显式约束内联依赖（服务端为空，客户端仅 `clsx`），新增依赖需重新核对打包边界。`test/host-publish-contract.test.mjs` 直接校验 `lib/*.d.mts` 与官方 SDK 的类型兼容性；客户端仍保留宿主 loader 要求的 CJS 协议，不为消除通用 ESM 建议而切换格式。

## 排障：插件未加载时

启动日志出现 `dsh: skipping profile bundle "dsh-plugin-prompt-tool"` 时，插件**整体未加载**——dsh 在包解析阶段就跳过了它，插件自己的自愈层（web 表层补装配、预设种子补建）也不会运行。按顺序查三步：

1. **看 bundles 列表**：`<DSH_HOME>/profiles/<name>/package.json` 的 `dsh.profile.bundles` 是否含 `dsh-plugin-prompt-tool`。
2. **体检依赖链接**（只读、零写入）：

   ```powershell
   pnpm repair:profile -- --profile web --dry-run
   ```

   它按 dsh 同一口径（`createRequire(<profile>/package.json).resolve.paths`）逐项判定，并额外报出**链接目标是否存在**——「链接在、目标不在」的悬空链接正是最常见的失败形态（例如相对深度算错一层）。
3. **修复**：去掉 `--dry-run` 重跑即可自动重建悬空或缺失的链接（只写 profile 私有层，真实文件与目录绝不删除，不改动 `profiles/node_modules` 兜底层）。若脚本报告需人工处理、或依赖本身缺失，走官方通道：

   ```powershell
   dsh plugin --profile web install
   ```

修复后需**重启 DSH** 生效。

## 许可

插件本体 MIT（Czerror）。`engine/` 中移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的模块，其上游版权与 MIT 许可保存在 [engine/THIRD_PARTY_LICENSES](engine/THIRD_PARTY_LICENSES)，随包发布并由组合行的包名说明符直接引用（不再物化到预设根）；`preset/` 下 cordis 模板与脚本基于 DeepSeek Harness 官方 Standard 等预设修改。上游预设本体不再随本包分发。
