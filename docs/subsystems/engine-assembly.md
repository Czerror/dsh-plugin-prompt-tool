# 引擎装配、发布与跨项目复用

## 规则编译与发布

### 编译与作用域绑定

规则是唯一行为定义。插件读取模块定义、校验切片，再经 `compileRules → createRuleRuntime(...).replace` 装配到 Agent scope；一次性调用仍可使用 `mountRuleSources`。这是两段式生命周期：`compileRules` 只编译与校验（产物每条规则携带 `conditionTrees`，选项里的 `ctx` / `standingMountFor` / `variableStore` / `manifestCheck` 会被显式剥掉），条件在来源注册前由 `rebindConditions` 绑定。原因是 `preset` 谓词要挂载 scope 的 ctx（`conditions/preset.mjs` 把服务查询基准绑在构造期），准备期拿不到——那边绑出来的 `preset` 条件是恒 UNAVAILABLE 的静默死条件。需要官方模块导出的兜底时，由调用方通过 options 传 `standingMountFor`；重绑含 `preset`、含 `variable`、含 `manifest`、含 `phase` 且未显式 `subscribe: false`、或含 `anchor.after` 动作引用的树，其余谓词原样保留。规则实例、条件绑定和运行状态按 Agent 私有，不跨 Agent 复用可变的准备产物。模块不进入官方会话预设注册表；九个插入点各有生命周期，不形成插件自定义的全局管线。

### 保存、热更新与失败恢复

编辑保存与运行注入分别负责：客户端只提交合法草稿，普通保存完成写盘与切片验证后立即确认 `persisted`，运行发布由装配通道按 300ms 合并。发送消息不等待自动保存；官方 `systemPrompt.assemble()` 开始、同步 provider 求值之前，插件提前处理已保存规则定义的变化。`refreshOnly` 同样提前发布并等待真实结果；显式发布、文件观察与请求前检查使用同一调度通道，同版本不会重复重挂。变量值仍在模板求值时读取，不因值更新重挂规则。

启用表与参与模块的 `module.yml` 每 200 ms 检查一次。直接修改文件与页面保存一样，只影响后续实际发生的官方入口，不重跑在途请求、不补执行过去入口。文件观察和监听随插件释放，不修改官方 Loader 或 profile。

装配记录只含实际贡献模块。未变化来源保留注册及初始化 owner；未启用模块保存不重挂 Agent。跨模块排序仍聚合计算，共享派生组仅在成员或有效内容变化时更新，共享工具由成功来源共用。失败尝试不保留工具或监听器；检索工具在依赖就绪后同步注册，第二项失败先清理第一项。

一次发布内，相同模块定义的读取、签名与编译准备供多个 Agent 复用；实际读取的模板、组合与配置参与失效检查，准备及挂载提交前再次核对版本。每个 Agent 重新创建条件闭包与模块配置，按其真实作用域校验服务；批内复用不共享计数、绑定或释放状态。根作用域仅提交显式 `process` 贡献，且等待 Agent 批次可发布后提交，单个 Agent 退出不撤回进程贡献。

| 失败位置 | 保留与回退 | 重试条件 |
|---|---|---|
| 单模块读取、校验或挂载 | 首次失败跳过；有有效版本则恢复旧贡献，健康模块继续更新；旧版本也挂载失败则撤销该模块并报告两次失败 | 文件变化或显式刷新；同一坏版本不逐请求重复撤装 |
| 依赖尚未到达 | 正常等待，已有贡献继续；模块及共享能力全部初始化成功后，才更新该 Agent 的模块 `lastGood`，准备成功不等于初始化成功 | 等待依赖，不误报失败 |
| 初始化回调失败 | 撤销所属贡献并尝试恢复 `lastGood`，无快照则跳过；共享能力失败影响当前声明它的来源集合，诊断保留来源和原因 | 修改该模块定义或显式刷新；其他模块更新不触发重试 |
| 全局部署配置、跨模块 `complete`／`sections.append` 冲突、无法归属单模块的公共注册错误 | 整体拒绝并尝试恢复原装配，不自动选赢家 | 按故障修正候选 |
| 单次运行期维护、检索或动作错误 | 各业务处理，不触发模块回退 | 沿各业务契约 |

来源替换、Agent 结束或插件卸载后的迟到初始化，不能撤销新贡献或重新启用旧模块。

普通保存不等待后台发布；失败只写日志和 `/meta` 的 `publicationFailures`，不进入 `moduleWarnings` 或工作台。显式刷新发布健康模块后仍返回故障诊断；切片已提交后的失败及显式重试失败，均保留 `persisted/publicationPending`。

磁盘保存与发布的交界见 [保存确认](params-write.md#磁盘保存与发布确认)，外部来源转换见 [SillyTavern 导入](../SillyTavern.md)，设计决策见 [ADR-0013](../adr/0013-native-context-module-state.md)。

## 原生运行与工具面

### 工具、能力与公开入口

工具名称与能力归属的唯一目录为 `src/shared/engine-capabilities.ts` 的 `MODULE_TOOL_NAMES` / `MODULE_TOOL_CAPABILITIES`。注册、委托建议与补装消费该目录。


未声明的工具能力不注册。五个模块工具外壳通过 `ctx.inject` 等待各自 `pt-module-*` provider，贡献随 disposer 撤回。来源模块内的模板变量按该来源读写；模型工具目标由调用方显式 moduleId 声明，缺声明拒绝，执行 Agent 的配装记录只作候选提示。`expectedModuleId` 仅作身份一致性校验，不选择模块或目录。模块规则正文要调模块工具时，必须把来源模块 id 写死（例如 `moduleId: your_module_id`）；引擎不提供模块身份插值宏，模块复制或改名后需同步正文。

旧 character/world_book/session_var 工具、对应能力与 ST 运行文件退出公开面；外部标准中的世界书名称仍可出现在导入类型和来源记录中。没有新旧双读、角色专属存储，也没有任意路径工具：模块私有文件只允许 memory.md、assets/（只读）与 data/（只追加）。

### 内置资产与用户覆盖

所有内置模块同 ID 补建/新建只物化 `module.yml` 与其规则切片，`assets/` 留在插件包内。`resolveModuleReadPath` 逐文件先读用户目录，缺失才按完整 moduleId 回退包内同名模块；用户空文件是覆盖，坏编码、权限错误和链接不回退。`module_file_read`、注入 `templateFile`、manifest 清单与初始化来源、检索文件和近义表共用此顺序；检索目录合并两层文件名后逐文件解析，仍受原来源白名单约束。`memory.md`、`data/` 读写始终只在用户目录，写入接口不会选包内落点。

包内资产随插件更新，不写回用户定义；已有覆盖不自动删除。模板正文在规则编译时读取，更新插件代码/包内资产后需用户重启服务或重新装配，不能以文件已更新推断旧会话已经刷新。改名复制/另存时补齐包内资产并保留用户覆盖，之后独立维护；不剥离 `-copy` 或数字后缀。正文中写死的工具 moduleId 仍需按原契约手工同步。

自定义模块可用 runtime-context 提醒追加事实索引或交接，用条件化 system-section 定期检查遗漏。提醒不放宽账本的唯一归属、去重、出处或 lead/promise 授权要求；不应记录过程流水、可重建事实和无出处断言。引擎可验证提示是否投递，不能保证模型遵从或调用工具，也不在后台代写账本。

### 执行状态与接入

`repeat-tool-reminder` 与 `compaction-tool-result-pruner` 是独立的 `host-control` 能力，`value: true` 分别停用官方重复工具调用提醒与工具结果修剪。缺少 owner 时仅暂停命中分支，owner 晚到在下一次正常装配恢复；关闭规则影响后续步骤，已接受调用保留快照。重复提醒过滤只移除官方来源，其他 stop、block、追加上下文和普通压缩保持不变。修剪按 Agent/session 隔离，disposer 与 owner 释放撤回后续正常装配贡献；repeat 取消透传已接受的官方结果，不泛化取消服务方法。成功压缩推进 Epoch，失败压缩不推进。

- 普通规则按真实执行点判定。条件/动作资格先于模板求值，禁用或受众不符的 setter 不影响 reader。
- `template-evaluation.mjs` 返回正文、读取域和单域变更集；`template-frame.mjs` 通过显式变量 adapter 读取、CAS 提交和发布。
- 执行身份由运行 Agent、取消信号与官方 turn/step durable 边界确定；assembly 与其后的 pre-step 共用同一次执行。账本独立于 mount，提交后重挂或重复出口只重用结果。
- 同执行后续卡读取前卡提交的值；变量 revision 只作 CAS，不成为重放键。冲突最多重试当前未提交卡，保留其随机抽样。
- 发布失败返回/记录已持久化状态，只重试发布；不重复自增。普通预览或无法确认真实执行身份时只读，赋值拒绝。人设挂载预检通过模板 owner 在副本中验证 module/global 变更集，不提交、不重试发布、不读取或消费执行凭据；真正带执行身份的装配仍走原 CAS 与单次提交。同步人设的 session 赋值在预检和执行两阶段都拒绝。
- 账本有界且在进程内；不承诺任意崩溃后的跨进程 exactly-once。

人设适配器归主插件运行态。包补丁只注册 `dsh-plugin-prompt-tool`，不覆盖官方 system-prompt 的 inject/intercept，不要求它等待 Loader 或本插件服务。独立人设早入口已移除。

persona 动作与普通规则共用来源、if/then/else、启停和 configOrder，由统一 ruleRuntime 持有资格、最后有效贡献、替换与 disposer。所有启用模块的命中动作按既有顺序分别聚合 prefix/suffix；非空片段用两个换行连接，显式空串阻止继承但不清除其它片段，字段全省略才读取官方。主子按真实 Agent 分别聚合；complete/includeRuntimeContext 显式值冲突拒绝整组。旧顶层 persona、config.yml.personaSources 与独立正文 bridge 已退役，读取根拒绝且不自动迁移，需用户手工重建。

官方 SystemPrompt 在 waterfall 前读取同步 provider 并保存 complete 副本，因此动态人设在原 `systemPrompt.assemble()` 之前由统一准备阶段求条件、预检普通 complete/sections.append 并提交完整注册；不能靠 waterfall 末尾修改 complete 生效。同一次原 assemble 固定已接受候选。同 Agent 的准备和原 assemble 串行，不同 Agent 可并发；全局 refresh 事务等待各 Agent 的锁，避免定义替换交错进行中的装配。

人设在每个 Agent 自己的 scope 注册同名 deployment:persona-prefix/suffix，以 scope 链遮蔽祖先声明。未声明字段、位置与 complete 继承最近有效官方声明；继承正文直接沿用原 text，不重新执行模板，自定义片段仍按各自来源模块读取变量与只读 runtime。includeRuntimeContext:false 增加本插件抑制；true 仅撤本插件抑制，不能撤销祖先 scope 的抑制或强开上下文。

AgentSetup 捕获的同层声明保留原 PromptSection 与 owner 生存状态：命中时暂撤，完全失配、事实不可用或卸载时恢复；原 owner 已释放则不复活。窗口之外的同层声明无法安全撤换时报告错误并保旧。条件失配与错误不同：失配撤回插件贡献、真实回到官方；配置、求值或注册失败保留最后有效组，不半提交。来源停用、规则删除及 Agent 释放均沿 ruleRuntime 清理，不保留第二条 persona fiber/signature。升级代码、patch 或 bundle 后需要用户重启服务，插件不自行重启。

## 统一入口与模块职责

| 文件或目录 | 职责 |
|---|---|
| `rule-spec.mjs` | 唯一规则编译、身份和字段校验 |
| `branch.mjs` | 分支判据与展开；host 完整树遍历共用同一语法 |
| `rule-runtime.mjs` | 按 Agent 的来源增量、同点排序、资格、作用域挂载和释放 |
| `host-control-catalog.mjs` | 宿主能力的静态身份、执行范围、原值校验与进程/Agent接线登记 |
| `host-control-agent.mjs` | Agent宿主能力的来源贡献、原阶段准备、事件/按需接线、观测与释放协调 |
| `host-control-process.mjs` | 进程宿主能力的来源发布、可选接入、可用性观测、撤回与释放 |
| `conditions/` | 谓词、三值条件与通道事实 |
| `actions/` | 实际动作；`content.mjs` 只选择正文 |
| `executor.mjs` | pre-step 资格快照、批处理、位置、去重与提交 |
| `pre-step-source.mjs` | 来源形状、ctx 绑定、promotion 唯一性与判定上报分派 |
| `layers.mjs` | 非 pre-step 层、官方同步 provider 和条件化文本 |
| `context-activation.mjs` | batch/history 扫描、候选选择、递归、时间窗和诊断 |
| `template-evaluation.mjs` | 有界模板解析与原生 module/global 操作 |
| `template-frame.mjs` | 显式变量 adapter、执行凭据、持久提交和发布重试 |
| `history.mjs`、`compaction-epoch.mjs` | 可见/完整历史与 epoch-aware 晋升 |
| `discovery.mjs` | 发现引擎：共享搜索/排序/截断渲染与按 agent 键控的适配器注册表 |
| `tool-search.mjs`、`skill-search.mjs` | 工具与技能的发现适配器：注册元数据，并各自注册工具 |
| `tool-config-engine.mjs` | 自定义工具定义到官方注册；shell 超时/输出上限与 fs 真实路径 containment |
| `instruction-files.mjs` | 指令文件探测的判据：候选清单、目录链与项目根标记的单一来源 + 引擎侧异步执行器 |
| `env-safety.mjs` | `env-facts` 使用的敏感环境名与安全环境白名单 |
| `path-safety.mjs` | `instruction-hint` 与 custom `fs` 共用的 realpath containment（symlink/junction 不越信任根） |

相对路径均基于包根的 `engine/`。`actions.mjs`、`predicates.mjs`、`strategies.mjs` 只是已有入口，不把实现堆回 barrel。`engine/vendor/yaml/` 是版本化分发快照，通过 package script 生成，不手改。

宿主能力目录是内部静态接线，不提供动态注册协议。具体能力仍拥有值、字段冲突、真实owner、平台和发行指纹政策。通用条件求值器执行接入侧绑定的依赖，不导入目录或具体能力；冻结结果、短路、局部自依赖绕过、诊断及与非宿主检查的交错顺序保持原语义。

Agent接入保持步骤准备、真实接受、Hook事件与工具后处理各自时机，不以最新Agent状态替代已接受身份。进程接入独立于单个Agent的寿命，仅在外层装配协调器原可发布点更新来源：默认值owner先于命令owner，随后释放旧token。批次中途失败在发布前退出；局部失败被隔离后，有效贡献仍可能先发布再汇总报错。撤回影响后续构造或调用，不追溯改写已有实例，也不增加跨owner原子事务。

### 插件侧怎么引入引擎（类型边界）

`engine/*.mjs` 是纯 JS，`tsconfig.json` 不启用 `allowJs`/`checkJs`。类型边界分为两种：

- 静态引入由同目录同名的手写 `.d.mts` 提供类型。新增或改名导出时同步声明；只声明插件依赖面及其签名所需类型，不按类型是否被直接 import 判断去留。跨引擎类型用 `import type { X } from './y.mjs'`，不引用 `src/` 类型。声明不生成到 `lib/`，现有 `exports["./engine/*"]` 已覆盖解析路径。
- 绝对 URL 动态 import 由调用点的内联断言提供类型，`.d.mts` 不参与解析。`agent-assembly.ts` 按能力 id 加载：缺文件跳过（官方行另记诊断），缺 `apply` 抛错；`bridge-runtime.ts` 加载 `schema.mjs`，`routes/instructions.ts` 加载 `rule-spec.mjs` 并使用 `src/shared/rules.ts` 的 `RuleEditorMeta`；`src/index.ts` 相对包入口加载 `skill-search.mjs`，失败告警降级。路径基准、失败语义与缓存不同，保持各自断言。

手写声明不会自动证明导出真实存在或签名准确；过多声明可能让编译通过而运行取得 `undefined`，宽泛签名也会掩盖错误。修改导出时须同时核对实现、声明与调用方。引擎内的策略和宿主包仍分别由 `actions/content.mjs` 与 `host-package.mjs` 动态加载；`engine/vendor/**` 的上游转译标注随快照更新，不手改。

服务名绑定也在这条边界上：宿主与引擎共用的服务名只有 `engine/service-names.mjs` 一个真值源，`src/` 与引擎侧的各引用点都从它取，**改名不得手抄**。手抄的失效方式是静默的——引擎查不到协调服务就回退自身的独立执行路径，模块工具外壳等不到 provider 就不挂工具，两边都不报错。这也是「引擎可单独复制」的一部分：名字随 `engine/` 一起走，复制方不必问宿主。回归通过 `test/host/agent-assembly.test.mjs` 与模块工具行为测试验证实际挂载、调用和释放。

### 引擎契约（加载器视角）

组合源 `engine/compositions/source/local/*.yml` 的行分两类。加载器 `src/runtime/agent-assembly.ts` 按行 `id` 查找本地文件：

- **本地引擎行**：`name: ./engine/<id>.mjs`。加载器按行 `id` 拼出同一路径 import，执行 `apply(ctx, config, { agent })`；`config` 是模块定义里解析后的行配置。
- **官方 recipe 行**：`name` 是 `cordis:group` 或 `@deepseek-ai/dsh-*` 包名，没有本地 `.mjs`。这些行由会话原有预设提供，加载器在 `engine/<id>.mjs` 缺席时跳过并记录诊断，不校验引擎形状；声明它们不会让插件自行挂载官方包。

行级 `disabled` 由模块事实的受控求值处理：只接受 `true`/`false` 和 `process.platform ===/!== '...'`；未知表达式 fail loud，disabled 行不进入运行集合。

一个**本地引擎模块**必须满足五条：

1. **身份**：文件位于 `engine/<id>.mjs`，与行 `id` 一致；行 `name` 若存在应为 `./engine/<id>.mjs`（加载器不读 `name`）。以实际组合加载和 `verify:pack` 的包内引擎执行验证可用性。
2. **入口**：导出 `apply` 函数；缺失时在装配准备期抛错。
3. **依赖**：`inject` 缺省或为字符串数组；数组元素是宿主服务名（`tools`、`systemPrompt`、`llm`、`skills` 等）。
4. **配置**：`configContract.parse(raw, plugin)` 缺省或为函数；准备期调用以提前拒绝非法配置，`apply` 内可再次解析取得规范化配置。
5. **清理**：`apply` 返回的函数由装配 scope 作为 disposer 收走；不返回则依赖注册时自带的 effect。

**不做通用能力注册表**：引擎之间按名调用目前只有发现引擎一个真实消费者（`promptToolDiscovery`，见 `discovery.mjs`）。等到出现第二个按能力解析的消费者（例如技能面成为可见面的发现来源），再按两个真实用例定接口；在此之前，新增引擎照抄 `discovery.mjs` 的「服务名 + 注册表 + 按 agent 键控」形状，而不是先建注册表。

**触发式债务**：`apply` 内二次解析配置与加载器准备期解析并存（如上）；发现适配器的宿主挂载与行挂载不对称（宿主挂载的 `skill-search` 不登记 adapter，今天无消费者）。两者都等具体触发条件再动，不在本轮顺手改。

## 默认身份接管

普通 `persona` 动作可选 `stripDefaultIdentity: preset | harness`，条件、受众、规则与模块启停沿既有运行时。`preset` 只移除已解析 `deployment:persona-prefix` 开头准确的 `You are a coding agent powered by the {{model}} model.`，后接空白或结尾；`harness` 只移除 `harness:identity` 的准确全文 `You are an AI agent powered by DeepSeek Harness.`。自定义 persona 前缀不参与默认身份接管，其余字节保持。

变换在公开装配适配器的最终结算出口进行，同次装配使用已接受候选；不重读 provider、不遮蔽身份声明、不修改已有历史。目标不匹配原样保留。预检不产生成功观测；真实装配沿既有规则诊断账本按动作与真实 Agent 记录目标结果及已保存版本，独立于条件缺事实计数。成功发布替换或释放来源时清除其身份观测，内容哈希启停回环也须重新观测；普通条件计数保留。规则卡只接纳当前目标、已保存版本且无正文草稿的观测，未选分支不抵消有效成功，同目标其他有效动作或 Agent 的真实失败不被成功掩盖。关闭或释放后自然回到仍存活的声明，不复活已释放 owner。

## 复制协议（跨项目复用）

复制完整 `engine/` 可复用纯编译器、动作、条件、历史与模板求值。宿主接线仍需要相应官方服务，五个模块工具外壳还需要 Prompt Tool 的 provider。独立引擎不偷偷读取插件 DSH_HOME 或 session 变量表。`env-safety.mjs` 与 `path-safety.mjs` 是纯安全 helper，随复制协议一起带走；`env-facts` 白名单外键在构造期 fail loud，`instruction-hint` 的 `params.file` 只允许指令文件候选名且 realpath 必须落在 cwd→最近项目根或 DSH_HOME。

`instruction-files.mjs` 只提供探测（纯函数 + 引擎侧执行器）；`instruction-hint.mjs` 既可挂载为行，也为 placeholder 填充器提供消息构造——复制方可以只要探测、不挂该行。执行器与宿主探测都只走到最近的项目根为止（marker 首命中即停），不继续向盘根探测。

优先内联 `rules`、自定义工具与策略；独立入口的文件方式按该入口参数声明使用。显式内联空值表示无贡献，非法值不能回退旧文件掩盖错误。模块生产路径不生成 rules.yml、agent.cordis.yml 或第二套工具目录。

需要持久变量时向挂载接口传 `variableStore`：

```js
const dispose = mountRuleSources(ctx, sources, { variableStore })
// read(moduleId, { agent, signal }) -> { module, global, session?, effective, revisions, enabled }
// readRuntime(moduleId, key, { agent, signal }) -> string | undefined
// commit(moduleId, { scope, changes, expectedRevisions }, { agent, signal }) -> 状态或 Promise<状态>
// publish(moduleId) -> 仅重试已提交快照发布
```

adapter 的目录、权限、原子写与版本责任归接入方。缺少 adapter 不能完成持久赋值；要观察模板求值的读取与变更，走 `renderTemplate()` 的返回（`engine/template-frame.mjs`），不经 `mountRuleSources` 的 `variableStore` 时模板按未解析处理。复制验收应在隔离目录通过显式 adapter 测公共注入行为，而非依赖开发机变量或原仓库路径。

`renderTemplateAsync` 在规则的 assembly/pre-step 出口等待异步 session 提交；同步 `renderTemplate` 保留旧域赋值并在提交前拒绝 session setter。执行凭据保存进行中的 Promise，重入/重挂不重复提交；已提交后取消只阻止正文发布。裸引用按 session→module→global，session 值为字面数据；runtime.get 只读权威值，禁止写入与回退。官方 PromptContext 仍是动态内容出口，不另造上下文管线。

runtime 事实授权按真实 Agent 的有效规则来源校验；persona 动作使用同一来源身份读取，条件候选只读，正文同步出口仍拒绝 session setter。不存在独立人设来源授权旁路。

各变量域的读取与求值见 [模板求值](variables.md#模板求值)。

## 重建与验证

服务端构建保留对随包 `engine/` 的外部引用，与 early 入口加载同一份引擎模块；不得将其内联为第二份模块级 owner 状态。客户端仍按原客户端配置打包。`verify:pack` 验证服务端入口导入前后已发布构造默认的行为、显式配置与贡献撤回。

源文件与随包产物的生成命令见 [package.json](../../package.json) 中的 scripts。根 `module.yml` 的生成入口是 `rebuild:module-template`，示例默认关闭，普通规则变量需手动建立。交付检查遵循仓库约定，宿主与包接入另核对 `verify:host`、`verify:pack`。永久测试断言公共行为，覆盖注入、写盘、bridge 载荷、安全拒绝和 UI 入口注册，期望来自独立规格或字面样例。
