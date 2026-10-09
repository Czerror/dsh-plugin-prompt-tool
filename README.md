# dsh-plugin-prompt-tool — 层级提示词注入器

> 一切皆可注入：把 DSH 官方开放的全部注入层级收敛为一个可配置提示词注入引擎——注入什么、注入到哪一层、何时注入，全由提示词配置决定。

DSH 生态的提示词注入层：`rule-engine.mjs` 按「条件触发 → 执行动作」对接九个官方插入点。每张配置卡对应一条独立规则，可组合多条件与多动作；提示词注入也是动作。包内模块库提供复制起点；模块不注册为官方会话预设。

> 能力来源：工具目录锚定与晋升门控移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT，上游已于 2026-09-10 冻结），近距离引导参考 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)，缓存铁律参考 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)。**本项目只移植引擎能力，不再分发上游预设**：锚定/深思链路由模块与规则按需声明。

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

技能**留在各自的来源目录里**（项目 `.dsh/skills`、项目 `.agents/skills`、你添加的技能文件夹、`$DSH_HOME/skills`、`~/.agents/skills`、官方内置）。引用目录复用官方 filesystem provider 发现与监听；管理页按当前会话快照标注生效、同名遮蔽和未确认状态。用户根与显式引用目录中的普通技能均可开关、删除；删除移入对应来源根的回收站，保留资源和恢复记录。插件随包分发内置技能（`skills/dsh-module`），安装与每次启动按「只补缺失」补建到 `$DSH_HOME/skills`——已有同名目录保持原样，用户改过或删过的不会被铺回来；新增技能可创建或复制导入，同名导入先确认，成功后不保存技能历史版本。

**停用 = 改写技能文件的调用策略**：模型端写 `disable-model-invocation`、用户端写 `user-invocable`。单端开关只修改该端，保留另一端的最新状态；正文、注释和未知字段保留，提交前校验原文并原子替换。官方工具与可选 `skill_search/skill_load` 都执行调用策略。状态文件 `$DSH_HOME/skills/.system/prompt-tool/skills.yml` 只保存引用目录 `folders`（v4）；技能清单与调用策略均不进入 settings。详见 [docs/skills-management.md](docs/skills-management.md)。

### 当前格式与宿主要求

module.yml 保存模块完整定义，支持 UI 自动保存和直接手改完整文件；rules/ 是校验后供 UI 与运行时使用的切片，手改切片或校验失配会从完整定义恢复。旧 promptConfigs、triggers、模型路由与锚定快捷参数须先离线迁移；运行时不自动双读。共享能力参数归 layerSettings，指令正文保持独立权限通道。

升级旧模块前，由用户停止相关 DSH 服务，再使用安装包提供的 `prompt-tool-migrate-rules`，或在已构建仓库中执行：

```powershell
$Repo = 'D:/AI/GitHub/dsh-plugin-prompt-tool'
pnpm --dir $Repo migrate:rules -- --root '<DSH_HOME>/.prompt-tool/modules' --characters-root '<DSH_HOME>/.prompt-tool/.characters' --check
pnpm --dir $Repo migrate:rules -- --root '<DSH_HOME>/.prompt-tool/modules' --characters-root '<DSH_HOME>/.prompt-tool/.characters' --apply
# 需要恢复时，保持服务停止，并用相同目录执行 --rollback
```

目录必须显式指定为存在的绝对路径；没有角色库时省略 `--characters-root`。先全量预检，再生成完整候选、校验来源版本并原子替换；原文件保留在各根的 `.rules-migration-backup`。重复应用无改动，回滚只覆盖仍与迁移产物一致的目录。无法证明等价的手写组合、互斥多启用冲突、失效旧参数或自定义策略目录会拒绝迁移，要求先整理。迁移完成后由用户重新启动 DSH。

技能调用策略只接受官方 frontmatter 键，状态文件只接受 v4；不提供旧布局迁移、回滚或备份脚本。

只有 `dsh-base` 的 profile 缺少 Web 能力时，插件仅报告诊断；所需 bundle 由官方插件管理流程装配，插件不改写 profile 或重启服务。

需要 DSH `0.2.0-rc.1+`（Cordis `4.0.4`）：设置接入 ConfigForms，模块定义与物化文件保存在插件自己的存储根 `$DSH_HOME/.prompt-tool/`（宿主从不扫描该目录），运行时装配由插件的配装通道在每个 Agent 的 scope 里完成，**按存储根 `config.yml` 的启用表逐模块装配**。官方组合模块快照随包分发（`engine/compositions/library/`），不再从官方预设同步——那套生成器已随内置预设目录退场。Node 需要 `^22.19.0 || >=24.0.0`，与官方宿主一致。升级后需要用户重启 DSH 服务。

`peerDependencies` 里的 `@deepseek-ai/dsh-*` 声明为 `>=0.2.0-rc.1`（无上界）：宿主在加载插件时会逐条校验这些 peer，范围写死到某个次版本会让每次宿主升版都判为不兼容；这个范围覆盖 0.2.0 及以上，同时把已知不兼容的更早版本挡在外面。实际锁定的版本以 `pnpm-lock.yaml` 为准。`minimumReleaseAgeExclude` 由 pnpm 维护——安装时 pnpm 会把 lockfile 拿去比对供应链策略，因此升级 DSH 后跑一次 `pnpm install` 即可，不要手工逐条增删。

## 特性

- 🔌 **九个官方插入点按需接线**：一个引擎接入声明所需的插入点，共享同一套过滤与降级语义
- ✍️ **一切皆可配置**：`layer / strategy / position / promotion / audience / modelScope / mergeMode / order / text / texts / fill / variables / params` 全开放
- 🧑‍🤝‍🧑 **消息受众三态**：`audience: main / subagent`，省略 `audience` 表示公用；身份类提示词可只注入子代理
- 🗂️ **完整定义与校验切片**：module.yml 保存完整行为，rules/<id>.yml 保存正文，_settings.yml 保存顺序和启停，variables.yml 保存模板变量；失配单向恢复，不生成旧宿主装配产物。
- 🧩 **显式互斥**：同模块同组中任一卡声明互斥时，启用目标卡会原子关闭同组其他卡的总开关；重排不改变启用状态。
- 🖥️ **可拖动悬浮工作台入口**：工作台经官方 `shell.overlay` 渲染悬浮触发器与 body portal 抽屉；按钮可拖动、位置存插件自己的 localStorage、窗口变化自动夹回可见区（不读宿主布局树，已移除 `sidebar.footer.action` 几何探针）；五页（主会话/子代理/工具预览/技能设置/模块）在抽屉内渲染，抽屉用 fixed + z-index 置顶，不被宿主导航栏遮挡
- 🧪 **条件与内容分离**：`if` 支持组合判断（另有 `else` 分支）；注入动作支持 `static / first-turn-anchor / guide-auto / anchor-notice / placeholder / world-book`。旧 `custom-fallback` 拆为锚点条件与通知内容。
- 🛡️ **失败不伤会话**：单条失败跳过 + `warnOnce`；配置错误挂载时 fail loud；`dedupe: session` 持久幂等
- 🧭 **通用 instruction-hint 引擎**：模块可通过 `strategy: placeholder` 与 `fill: instruction-hint` 提示指令文件存在；实现位于 `engine/instruction-hint.mjs`。`layerSettings.pre-step.instructionHint` 可启用该能力，按模型可见 surface 去重，重挂不重复，被压缩遮蔽后才再次提示
- 📦 **Bridge 载荷**：JSON 请求统一 32 MiB 硬上限并明确返回 413；角色卡原始图片走 64 MiB 流式通道，按 PNG 魔数识别。
- 📂 **技能管理**：官方发现与会话快照统一技能来源、生效和遮蔽状态；单端开关写回技能文件。支持目录包与直属 Markdown 技能、创建、两种复制导入，以及用户根和引用根的可恢复删除；技能局部刷新保留其他页面草稿。
- 🎭 **SillyTavern 导入**：JSON 预设、角色卡和独立世界书转换为本地预设——按官方顺序表保留启停，赋值模板运行时求值；不等价能力明确报告，采样参数由宿主管理
- 🎴 **角色卡导入**：PNG／JSON／YAML 角色来源经统一预览后成为普通模块；PNG 保留原图，更新保留模块记忆与用户资产。
- 📦 **预设交换**：文件夹、ZIP、原生 JSON/YAML 与 ST 来源共用识别、预览和完整候选安装；导出可选完整 ZIP 或仅定义 YAML。资源、覆盖及分享边界见 [资产交换文档](docs/asset-transfer.md)。
- 📚 **世界书**：`character_book` 转 world-book 策略配置（`keys` 命中触发 / `constant` 常驻 / 正则键自动检测 / `selectiveLogic` 组合逻辑），与模块卡片同一存储与编辑（模块列表「世界书」过滤 + 批量启用/禁用）
- 🛠️ **自定义工具**：module.yml `customTools` 段声明式定义模型工具（执行器 shell/http/delegate/fs/ask-user，`{{args.x}}` 参数插值）；参数与输出经官方 `dsh-tools` 转换器物化为标准 JSON Schema，非法参数产生标准工具错误，delegate 经 `ctx.tools.execute` 嵌套调度走完整官方工具管线；`customTools.scope` 暂不支持（显式拒绝）
- 🛡️ **子代理工具策略**：module.yml 顶层 `subagentToolPolicy` 段（opt-in）声明 ceiling、profiles、角色卡绑定、有序任务规则与受控模型扩权；`subagent` 固定走 spawn、`subagent_fork` 固定走 fork，按官方 `SubagentRun`/continuable 契约创建并在窗口内冻结 toolFilter；模型选择器和扩权参数在工具 body 前校验，模型路由经过 LLM preflight；UI 从官方 sessions snapshot 读取当前会话，并可编辑、停用、预览策略及查询存活 Agent 工具面
- ♻️ **Session 日志读取**：引擎冷启动与幂等扫描统一走官方 `session.snapshotEvents()`（DSH `0.1.2-alpha.4+`），不再读取已移除的 `session.events` 数组。
- 🧩 **模板变量**：顶层 `variables` 提供 `{{key}}` 插值，注入动作的 `config.variables` 可局部覆盖。正文、匹配词、分类阈值与模型偏好由规则或模板显式提供；业务配置为空就不生成对应内容，引擎不内藏默认锚句。
- 💬 **会话变量工具**：`session_var`（list/get/set/clear）——模型维护角色状态（`{{心情}}` 等），会话级覆盖预设默认；不得占用插值保留名（内建 `DSH_HOME`/`WORKSPACE`/`CWD` 与动态宏名 `time`/`pick` 等，命中即拒绝写入并说明原因），ST 运行时宏（`{{lastusermessage}}` / `{{lastcharmessage}}`）从会话事件提取
- 🧩 **工具按模块装配**：角色卡、世界书、会话变量、自定义工具分别由 `character-tools` / `world-book-tools` / `session-var-tools` / `tool-config-engine` 模块提供；不再维护重复的顶层工具开关
- 📐 **显式按需装配**：空模块不自动附加增强能力；模块人设来自顶层 `persona`，官方工具与普通委派仍由会话原有预设提供。首轮门控、来源过滤、工具名单、深思门与进度节拍统一由 `rules` 声明；总入口负责编译调度，`engine/conditions/` 判断，`engine/actions/` 执行。

## Web 客户端结构

每条配置保留一张卡，复用原卡壳、折叠箭头和拖拽样式，指令文件卡置顶。卡内通过“规则 / JSON / 设置”平级侧边导航编辑，窄屏改为横向页签。**规则面板按条件作用域组织**：规则级 `if` 是一张条件卡，它管住的 `then` 节点在一段竖线作用域里各自成卡——动作卡与分支卡（卡头即「当 ⟨条件⟩ → ⟨动作⟩」）；每张卡默认收起、卡头单行省略给出「条件 → 动作」一览，展开才编辑，`×` 删除整张卡，`then`/`else` 里的分支节点 `{if, then, else}` 可展开编辑、可继续嵌套。上移、下移与拖拽按钮位于卡头总开关旁。Linear 风格统一桌面控件为 28px、按钮与下拉为胶囊；短输入按字符宽度收紧，下拉按最长选项文案限宽，数字 96px，正文与 JSON 保留完整编辑宽度。粗指针的 44px 触控目标扩大控件本体，不覆盖外部空白。

规则编辑器通过 `/rules` 保存局部修改与完整文件版本，保留在途新输入、未知字段和未完成 JSON 草稿。动态注入支持 `if` / `then` / `else`（旧名 `when` / `do` 已退役，撞上会显式报错）；固定注册的独占、抑制及安全守卫拒绝不支持的动态条件。**动作级 `text` 条件的 `subject` 必须由该动作执行点真实提供**：写错通道或省略会让该动作永不执行且运行期零诊断，因此在编译期拒绝（可用集合见[引擎复用指南](docs/engine-reuse.md#条件判定与事件载荷)）；规则级 `if` 跨执行点各自求值，不受此限。工作台顶部状态栏在存在「因缺事实无法判定」的规则时追加「N 不可用」。具体支持范围见 [引擎复用指南](docs/engine-reuse.md#声明的条件与动作边界)。

Web 客户端按四层组织：

```text
src/client/
├─ app/       # SlotRegistry owner、工作台壳与五页组合
├─ data/      # typed bridge、Fields、状态 facade、保存与脏检测纯逻辑
├─ features/  # prompts / tools / subagents / skills / presets / characters
└─ ui/        # 仅 props/callback 的共享交互与 CSS Modules
```

依赖方向固定为 `app → features → data/ui → shared contract`：跨领域组合只在 `app/workspace/pages/`，feature 不导入其他 feature 内部实现。控件由插件持有，不运行时加载 Harness Client 包；官方能力通过 Cordis 服务与 slot 接入，类型依赖保留。Client bridge 使用 `src/shared/bridge-contract.ts` 的 endpoint key 与 request/value map。样式按 owner 拆分，只共享 `--dsw-alias-*` 主题颜色，安装和释放随插件生命周期。

角色卡与世界书模型工具写入**该执行 Agent 实际配装的提示词层**（启用表 ∩ 磁盘，多个时取启用表第一个），不查询会话绑定的官方预设。保存等待物化完成；已保存但未生效会明确返回失败。失败定义保留诊断，方便修复。
完整的当前目录、slot 生命周期、状态边界、可访问性和维护约束见 [Web 客户端 UI 结构框架](docs/ui-architecture.md)。

### 配置卡与工具预览

- 五页工作台保留搜索、展开和滚动位置；工具、人设、策略以及非法 JSON/数字输入可跨页继续编辑。存在未保存草稿时，模块切换会提示先处理，不会无声覆盖。
- 配置保存与校验位于长列表操作区，失败就近显示；低频卡片操作收进菜单，删除和丢弃文件草稿需明确确认。窄容器自动换行，键盘操作、明暗主题和减弱动效均沿用宿主规范。

- 参数在所属规则的动作中编辑，主／子代理模型参数使用 `request-params` 动作与受众条件。共享能力仍按实际 `modules` 装配显示，当前会话模型继续使用官方选择控件。
- 「指令提示」统一通过「前置步骤 → 内容策略：动态填充 → 填充来源：指令提示」编辑，不再作为独立策略入口。指令文件正文和授权保存仍归独立文件通道，不复制进预设。
- AGENTS.md / CLAUDE.md 这类指令文件复用普通配置卡组件，保留名称、路径、正文和后续官方注入的启停；位置、顺序、晋升、受众与模型范围由官方负责，不提供文件卡控制项。名称和启停落独立指令策略，正文就地编辑、**焦点离开卡片时自动写回原文件**（版本冲突保留草稿并提供「重新读取」，没有单独的保存按钮）。
- 创建菜单始终提供全部层级模板、工具和可添加能力，不受当前列表筛选限制。创建后只展开目标卡片（当它落在当前筛选视野内），不改动层级筛选与搜索词；同一提示词模板可重复创建，自动分配不重复标识。空内容不等于删除，保存和后台刷新保留未完成草稿；工具草稿在层级／世界书筛选往返时不丢失。
- 插件装配自身工具能力，官方文件系统与编辑工具仍由宿主预设提供。自定义模型工具经「添加能力 / 工具模块 → 添加工具模板 / 新建空白工具」配置名称、描述、参数、输出与执行器，保存前完整校验；不安装、连接或管理外部 MCP／DSH 插件。
- 「工具预览」是独立顶层页，参照官方插件目录：顶部统一搜索、可折叠分组、右侧预设选择、双列展开详情卡，窄屏单列。卡片显示「模型可见」，不伪造插件运行状态。当前会话与所选预设分别读取：既有会话仍使用冻结 generation，修改预设只影响后续 generation；不会隐藏同名自定义工具或自动恢复会话。
- 在工具链的 `tool-config-engine` 能力卡中配置哪些自定义执行器需要用户批准；缺少批准服务时拒绝执行。生成目录保持只读，仍由预设重建产生。

## 项目架构

本项目的 Archify 交互式架构图保存在 [`project-architecture/`](project-architecture/)：覆盖 React 工作台、loopback settings bridge、Plugin Runtime、Preset Compiler、Engine & Composition、Skills 与领域扩展以及 DSH Host 的运行链路。

- [打开最终交互式架构图（v2）](project-architecture/project-architecture-v2.html)
- [查看 Archify JSON 源规格](project-architecture/project-architecture-v2.json)
- [查看本轮视觉检查收据](project-architecture/project-architecture-v2.visual-check.json)

`v2` 已按当前 `app / data / features / ui` 客户端结构更新，并通过 showcase 9/9 校验；无 `v2` 后缀的文件保留为首轮构图记录。本轮已使用 Microsoft Edge 完成 visual-check：containment/captures 均通过，保留 1440×900 与 2048×1320 的明暗截图及联系页；自动收据的 `visualReview` 仍为 `pending`，仅表示需要人工查看截图，不代表渲染失败。


## 模块参数体系

初始化从包内 modules/ 补建缺失模块，已有目录不覆盖。包内内置模块三个：`ponytail`（懒惰资深工程师行为规则）、`tool-surface`（工具面收窄到常驻核心集，其余按需解锁）、`skill-surface`（拦掉全量技能目录注入，改按需发现）——后两个默认不启用，需在「模块」页启用并重启。materializeModule 原地校验恢复 rules/，只清理已知旧产物，保留记忆、技能、正文与用户资产。工具和子代理策略从完整定义内联装配。

部署 Config 使用 modulesEnabled 作为模块运行总闸：关闭仅撤回贡献，不清空文件。旧 writePreset 仅作输入兼容，双键冲突拒绝。编辑目标通过 x-module-id 传递，不切换或跟随官方会话预设。

模块行为由一份 `module.yml` 下发，参数所有者各自独立：

| 层 | 职责 |
|---|---|
| `layerSettings.<层名>` | 模块共享参数；磁盘归属由参数目录的 `storageLayer` 固定，不随 UI 分组改变 |
| `moduleConfigs` | 行级 config 直写通道（参数桥未覆盖的键：超时/环境白名单/ST 导入等），不锁定覆盖 UI 可管理参数 |
| `rules` | 独立身份、条件树 `if` 与动作数组 `then` / `else`；注入正文与参数归相应动作 |
| `configOrder` | 规则 ID 到序号的完整定义映射；运行切片中为 _settings.yml.rules[id].order，文件名不带序号 |

### 共享参数一览（全部可选，缺省按对应模块解释）

| 分类 | 键 |
|---|---|
| 策略深度 | `maxDepth`，只约束已启用的插件子代理工具策略；普通官方委派由宿主管理 |
| 指令提示 | `instructionHint`，默认关闭 |
| 工具 | `toolGitBashEnabled` `customToolRequireApproval` |

以上共 4 个公开共享参数。模型参数属于 `request-params` 动作，主／子代理由条件区分；旧模型键与 15 个锚定／引导快捷键只供离线迁移读取，不再提供在线保存入口。无法等价承接的旧值明确拒迁，不丢弃也不静默激活。编辑器输出上限 `strReplaceEditorMaxOutputChars` 由宿主工具配置负责。

> 首轮工具面与输出封顶、pre-step 来源名单、常驻工具白/黑名单、锚句、深思门与进度节拍通过 `rules` 声明（示例见 [engine 复用指南](docs/engine-reuse.md)）；子代理工具面仍由 `subagentToolPolicy` 实例策略授权。

AGENTS.md 走「文件即真相」：文件集合、正文与版本不物化进生成目录，而是由宿主按本会话工作区现场解析（`$DSH_HOME/AGENTS.md` + 工作区 cwd→项目根链的 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md）；工作台中的文件卡指向原文件，卡片定义与正文都不进 `module.yml`。插件不写常驻受管块。

官方指令注入与逐文件开关：

- 官方 `@deepseek-ai/dsh-agent-instructions` 负责发现、读取、预算、更新与压缩恢复，预设须保留官方指令行；插件只在消息进入会话前过滤，不再自行注入文件正文。文件可读不代表已经注入。
- 指令文件卡保留名称、正文编辑和启停；关闭只拦截该文件**后续**的官方注入，历史正文不撤回，重新开启不强制重放。首次请求前关闭即可阻止可识别文件进入新历史；开关不阻止官方读取文件。
- `$DSH_HOME/.prompt-tool/instructions.yml` 只保存 `files[fileId].enabled` 与 `name`，跨预设共享，**默认放行**。不再提供「独立指令文件来源」总开关或文件级位置、顺序、晋升、受众、模型范围；自定义消息仍用普通前置步骤配置。
- 旧策略顶层 `enabled` / `defaults` 及文件级注入参数读取时忽略、下一次成功保存时清理；旧顶层关闭不会转换为逐文件关闭。`module.yml#agentsHints` 仍不生效，策略缺失不因读取自动创建。
- 过滤覆盖官方基线、附加、更新和移除消息，并同步对应 `source.changes`。无法可靠分段的官方内容原样放行并诊断；不识别的文件身份也保持官方内容，不新增远程来源管理。已被官方预算省略的内容不由插件补回。
- 预设级 `instructionHint` 保持可选、默认关闭；启用后先过滤，再把剩余符合条件的官方全文转换为路径提示。它不替换已经进入历史的全文。决策边界见 [ADR-0004](docs/adr/0004-official-instruction-filter.md)。

指令文件正文属于用户自己的文件，不受预设生命周期管辖。工作台按**打开时解析出的会话工作区**读取文件快照（正文 + 文件身份 + 字节版本 + 读取状态一次取回），正文在**焦点离开卡片**（或列表「保存」）时写回原文件：

- 未修改的文件不写盘；预设的 debounce 自动保存与预设切换都不写文件，切换预设只保留文件草稿。
- 每个请求带读取时的 `expectedRevision` 与工作区 `contextId`；外部改动或工作区变化返回 409，草稿保留并提示「重新读取」，不静默覆盖磁盘新版本。
- 读取失败（不可读/超限/文件消失）与「读取成功的空文件」严格区分：前者不可编辑、不可保存，不用空正文掩盖错误。
- 原子写入（tmp + rename，保留原权限），失败保留原文件并清理临时文件；正文不受预设变量插值影响。

模型参数按模块独立保存，不自动回写宿主全局默认。主模型参数作用于主会话请求；子模型 provider/name 与采样参数作用于本地子代理的实际请求，不改写普通官方委派的 spawn 预检。

| 段 | 键 |
|---|---|
| `layerSettings.agent-request`（主对话） | `modelProvider` `modelName` `modelReasoningEffort` `modelTemperature` `modelMaxTokens` |
| `layerSettings.subagent-start`（子代理） | `subagentModelProvider` `subagentModelName` `subagentReasoningEffort` `subagentTemperature` `subagentMaxTokens` `maxDepth` |

读取当前结构后展平到内部 EngineParams，保存只更新 `storageLayer` 指定的层。旧顶层 `params` / 模型段不参与运行参数，规则快捷键的兼容范围见[参数框架](docs/architecture-params.md)。人设独立写在顶层 `persona` 段，由模块配装通道在 Agent scope 注册。示例：

```yaml
persona:
  prefix: You are a coding agent powered by the {{model}} model.
  suffix: Your working directory is {{cwd}}.
  # complete: true               # prefix 独占整个 system prompt
  # includeRuntimeContext: false # 抑制该 scope 的动态 runtime-context 快照
```

工作台「模型路由」卡顶部另有**当前会话**区（仅主对话作用域）：显示活动会话的模型/思维程度（会话 `modelSelection` 投影，缺省回退宿主默认），模型下拉展示全部可用模型并按服务商分组，选择模型时自动回写对应服务商；切换走官方 `session.selectModel`——对当前会话立即生效并被宿主持久化为新会话默认，与官方模型选择器双向同源；子代理会话与宿主默认场景不支持会话级切换。预设参数非空时按请求覆盖会话选择（参数桥优先级不变）。

模块编辑选择与官方会话预设独立。切换编辑模块只改变请求目标；未指定目标时由服务端解析默认目录，bootstrap 的模块身份、参数、变量与配置卡来自同一目录。启用哪些模块由 `config.yml.enabled` 决定。

> 根目录 [module.yml](module.yml) 覆盖 4 个公开共享参数与九层规则。`pnpm rebuild:preset-template` 从权威契约重建；规则默认关闭，共享参数按需取消注释。

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

九个插入点彼此独立，没有跨层全局运行顺序。模块配置在同一插入点、位置内按 `configOrder` 序号排列；`system-section` 与 `runtime-context` 的 `order` 保留官方定位语义。
UI / 写盘按上表分组；这是展示顺序，不是模型提示词优先级。详细支持字段、限制与官方依据见[九层对照](docs/injection-point-contracts.md)。
模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` 是控制通道。

主会话与子代理的配置列表沿用原模块页的拖拽按钮样式，也可聚焦按钮后用上下方向键移动。“当前模块”范围保留配置编辑与本模块排序；点击“跨模块排序”后，同一列表显示已启用模块中符合当前受众和筛选的配置摘要，支持跨模块拖拽和上下移，隐藏配置保留原有槽位。进入前保存当前模块配置草稿，字段等草稿未完成时拒绝切换；返回当前模块时重新读取。模块页不再另设排序区。服务端按模块 ID＋配置 ID 写回轻量序号，拒绝未知、重复身份和过期版本，不接收正文或任意序号。新启用模块的未编号或冲突配置接在尾部，重复启用保序，详见 [排序决策](docs/adr/0006-module-config-order.md)。

- `mergeMode`：`separate`（默认）同位置多条为独立消息；`merged` 同位置拼接为一条
- `order`：官方 system/context 位置、无模块来源的独立引擎与触发器、ST 世界书预算仍保留各自语义，不由排序界面改写
- 文本插值：`{{key}}` 全层支持——配置/预设 `variables` 优先，ST 运行时宏（lastusermessage 等）次之，内置 `{{DSH_HOME}}/{{WORKSPACE}}/{{CWD}}` 兜底，未注册保留字面（system-section 注册期无会话时运行时宏替换为空，不残留）


## SillyTavern 导入

工作台「模块」页按内容识别原生模块与 SillyTavern 来源；ST JSON/YAML 预设卡片经预览确认后，按注入层级映射为本地模块：

- `prompts[]` → `rules[].do` 中的注入动作：system 角色进入 `system-section`，其余进入 `pre-step`；官方 `prompt_order[].order[]` 决定启停与相对顺序，深度位置保留来源并报告降级
- 采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`）**剥离**——模型参数统一由「模型设置」UI / 宿主默认管理
- ST 变量：保留可启停的赋值模板，在运行时顺序求值；声明变量在合并和角色卡应用时保持局部绑定
- ST 管理工具：始终装配 `character-tools`、`session-var-tools` 与 `tool-config-engine`
- `enable_web_search`：`true` → 本插件**不再组装 web 工具行**（`tool-web` 已随预设解耦从模块库退役，联网能力由会话原有预设提供），只在转换报告里如实提示；`false` → 产出三条规则（`assembly` 呈现剔除 + `sdk-strip` 裁 `tools:sdk` 正文 + `guard` 执行层拒绝，共用同一份 `deny: [web_search, web_fetch]`），PTC 下同样生效
- 含有效 `character_book` 条目时自动追加 `world-book-tools` 模块，使导入预设可直接调用世界书管理工具
- 世界书条目级条件：`delayUntilRecursion`（延迟到递归扫描的层级池）、`useGroupScoring`（组内评分淘汰）、`matchCreatorNotes` / `matchCharacterDepthPrompt`（按需扫描卡片备注与深度提示词）按 ST 语义求值；`characterFilter`（角色/标签过滤）、`automationId`（STscript 自动化）、`outletName` 与向量检索**不实现**，只保留来源事实并在预览卡里逐条告警
- 触发键里的 ST 宏（例如只存在于 ST 全局 persona 的 `{{user}}`）登记为「模板变量」空占位并产出诊断：未赋值时该键不参与匹配（不会退化成字面量误判），在模板变量里赋值后按既有匹配路径生效
- 角色卡 `extensions.depth_prompt` 保留为一条**默认禁用**的 pre-step 配置（ST 只在群聊自动注入），可在工作台手动启用
- `modules` 按需装配：`rule-engine` 与上述 ST 管理工具承接转换产物；含 system-section 时补 `persona`（`complete: false` 允许 system 段生效）；含有效世界书条目时补 `world-book-tools`

转换结果是一个普通模块（id 由文件名生成），可在工作台「模块」页的模块列表中直接启用。字段级参数对照与完整示例见 [SillyTavern.md](docs/SillyTavern.md)。

### 角色卡（PNG / JSON）导入

工作台「模块」页将角色卡作为来源导入普通 `.prompt-tool/modules/<id>/`：

- **PNG**：`ccv3` 优先 / `chara` 兜底；按魔数识别并受限解码，原始文件先暂存、预览确认后入库，保留原图。
- **JSON／YAML**：支持 ST 角色数据和自包含原生角色片段。批次逐张预览，不把多份来源合并成一张角色卡；所有大小的文件都先预览再提交。
- 正文映射：`first_mes` → 开场白（`dedupe: session`）、`alternate_greetings` → 备用开场白、
  `description/personality/scenario` → 角色设定；采样参数剥离（模型设置 UI 管理）
- **统一模块身份**：人设、开场白和世界书写完整 module.yml，规则切片与其他模块一致；没有角色专属目录、前缀或登记
- **模块记忆**：memory.md 属于模块，更新保留本地记忆和用户资产；world_book_read_memory 按需读取，不自动注入

### 世界书（world-book 策略）

`character_book` 条目转 world-book 策略配置（与普通模块同一存储/编辑）：

- **ST 注入语义**：常驻候选或主键命中，再按副键逻辑、概率、分组与时序筛选；非常驻无主键不注入；原生手写 world-book 约定保持不变
- **匹配选项**：`caseSensitive` / `wholeWords`；只有 `/pattern/flags` 形式识别为正则，其余为字面键
- **管理**：模块列表顶部下拉选「世界书」过滤（完整模块卡片编辑 + 批量启用/禁用）；
  模型工具 world_book_list/upsert/delete（note 追加模块记忆）与 world_book_read_memory（按需读取）
- **ST 变量**：赋值不在导入时执行；local/global 分表但只在会话内有效，嵌套宏有循环与大小保护。
  深度历史位置、system 角色、token 预算和 ST 扩展脚本不具备完整等价性，详见兼容边界
- **会话变量**：`session_var` 工具（list/get/set/clear）维护角色状态（会话级覆盖预设默认，
  结束即失）；保留名（插值内建与动态宏名）拒绝写入、读取跳过历史脏键；跨会话文本通过 note
  保存在模块 memory.md，读取失败会明确报错

详细转换规则见 [SillyTavern.md](docs/SillyTavern.md)。

## 开发与验证

```sh
pnpm install && pnpm build
pnpm test          # 全量契约与行为测试（隔离 cwd 运行）：参数契约/注入装配/六插入点/生成链路/引擎语义/组合重建/模型路由/UI 契约/安全边界
pnpm typecheck && pnpm lint
pnpm verify:host         # 官方包范围、安装版本、解析目标、类型/运行时依赖与 Client 模块边界
pnpm sync:yaml           # 刷新 engine/vendor/yaml（生成目录运行时 YAML 解析器）
pnpm verify:harness      # 官方开发依赖是否落后于当前发布通道（落后退出 1，registry 不可达退出 2）
pnpm sync:harness        # 跟进：按 dist-tags 改写 devDependencies 并 pnpm install
```

测试由 `scripts/run-tests.mjs` 启动：先跑 build，再以独立临时 cwd 与 TEMP/TMP 启动 Node 内置 test runner，用例路径为绝对路径，避免相对 cwd 的测试污染仓库。

依赖升级后的验证顺序：`pnpm install` → `pnpm verify:host` → `pnpm typecheck && pnpm lint` → `pnpm test`。官方源码联调请使用不入库的显式本地 override，不要恢复 `pnpm-workspace.yaml` 里的 `link:` 默认配置。

官方按通道发布预发布版（`alpha` tag，vendor 包用 `dsh-<版本>` tag），而 semver 的普通范围语法匹配不到预发布版——实测 `>=0.2.0-rc.1` 覆盖 0.2.0-rc.1/rc.2 却不覆盖 0.2.1-alpha.1，也没有任何范围写法能同时覆盖 rc 线与 alpha 线，所以 `devDependencies` 会静默停在旧世代、typecheck 一直对着旧类型面跑。`pnpm verify:harness` 检测这种漂移，`pnpm sync:harness` 从 registry 的 dist-tags 解析目标版本并写成确切版本号。`peerDependencies` 的 `>=` 下限保持不动：宿主用 `includePrerelease` 判定，该下限本就覆盖后续所有版本（含 0.3/1.0 的预发布）。

发布类型声明通过 `deps.dts.neverBundle` 引用官方 SDK，不内联其品牌类型与相对模块扩充；公开类型引用的包须声明为生产或 peer 依赖，不能仅存在于 devDependencies。`deps.onlyBundle` 显式约束内联依赖（服务端为空，客户端仅 `clsx`），新增依赖需重新核对打包边界。客户端仍保留宿主 loader 要求的 CJS 协议，不为消除通用 ESM 建议而切换格式。

## 排障：插件未加载时

启动日志出现 `dsh: skipping profile bundle "dsh-plugin-prompt-tool"` 时，插件整体未加载，预设种子补建也不会运行。插件启动只诊断缺失 Web 能力，不写 profile manifest 或修复包链接。按顺序检查：

1. **看 bundles 列表**：`<DSH_HOME>/profiles/<name>/package.json` 的 `dsh.profile.bundles` 是否含 `dsh-plugin-prompt-tool`。
2. **体检依赖链接**（只读、零写入）：

   ```powershell
   pnpm repair:profile -- --profile web --dry-run
   ```

   它按 dsh 同一口径（`createRequire(<profile>/package.json).resolve.paths`）逐项判定，并额外报出**链接目标是否存在**——「链接在、目标不在」的悬空链接正是最常见的失败形态（例如相对深度算错一层）。
3. **修复**：体检命令始终只读。缺失依赖或链接交给官方插件管理器；在 Harness 中使用 `plugin_manager` 安装或管理 bundle，CLI 的依赖修复入口为：

   ```powershell
   dsh plugin --profile web install
   ```

替换已安装包后需要用户重启 DSH；插件不自动重启服务。

## 许可

插件本体 MIT（Czerror）。`engine/` 中移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的模块，其上游版权与 MIT 许可保存在 [engine/THIRD_PARTY_LICENSES](engine/THIRD_PARTY_LICENSES)，随包发布并由组合行的包名说明符直接引用（不再物化到预设根）；`preset/` 下 cordis 模板与脚本基于 DeepSeek Harness 官方 Standard 等预设修改。上游预设本体不再随本包分发。
