# 工具呈现、执行与 Team 委派

## Agent 级能力声明的公共原语（2026-10-22）

`engine/agent-capability.mjs` 收三件事：受众判定（`capabilityAudience`，与 `isDelegated` 同一判据）、Agent scope 的声明表（`createAgentCapability`：session → {scope, key, disposers, data}）、以及 key/scope 变化时先挂新声明、成功后再撤旧的。`mount` 返回 `undefined` 表示依赖未就绪：保留上一轮声明、下次装配重试——旧闸比无闸安全。`scope.effect` 负责 Agent 释放时摘除自己。执行器冲突检测与晚到服务等待由 `present-as` 及官方执行器处理，原语不引入模式开关。`present-as` 只复用受众判定；`tool-visibility` 复用声明表，在 mount 返回值中保存 guard disposer、无集合调用的 failOpen 状态与解锁快照；有集合调用只读步骤准入。装配层与注册层的受众判定仍用既有 `isDelegated`，本轮没有统一。

## 工具结果与Web功能段

普通 `tool-result` 动作的 `action: edit-text` 使用 `edits: [{ region, match, text }]`；`region` 只接受 `web-notice` 或 `sandbox`，`match` 为非空精确字面量，`text` 允许空串。它只编辑已验证官方owner生成的结果说明，不重新执行renderer，不改程序输出、原值、错误身份、isError、meta或准入决定。Web包装须完整匹配其说明段，正文同词不参与替换；沙箱说明从真实结果事实与原渲染回执定位，缺失、歧义或owner引用被替换时保留原内容并报告不可用。

原 `execute` 引用不变，原render/projectContent/finalizeContent保留this、参数和异常。project阶段只记录同一次执行的结果与已接受计划；其它post策略全部结算后，才在final出口求条件、消费次数并编辑。原finalize返回内容，或post接管内容、值、错误、meta、isError时，结果编辑让位。同一执行内条件共用判定帧；模型取已接受步骤冻结的modelSelection，变量与次数仍在最终出口读取和结算。关闭、更新或释放来源不改在途计划，也不重新执行工具；保留模型事实不复活已关闭步骤的调用权限。

`web-notice` 支持已标记的官方Web结果；`sandbox` 支持已标记的bash、pwsh、FS、str_replace_editor及PTC结果。启动期须通过包的 `/early` 出口，在目标工具包首次加载前接入；当前仅支持 `0.2.2-rc.2` 的固定发行产物，完整指纹和唯一结构锚点在 `result-text-early.mjs` 与 `fs-tool-early.mjs` 核验。FS读取额度与结果标记由同一加载owner组合，各组分别校验必要锚点，共同产物指纹失配则都透传。不改官方磁盘文件。普通加载不能补标已缓存工具，同名自定义工具也不当作真实owner；缺early、版本/指纹失配或必要slot被接管时保持原行为。

同规则结构分支中显式关联的装配正文，在实际装配toolSet缺少所需真实结果owner时局部暂停；无关规则继续。结果条件仍在结果出口求值，不在装配期提前消费；条件或受众未命中不误报依赖不可用。依赖恢复后按正常后续装配重判，暂停期间关闭的规则不重开、不重放旧调用。运行观测沿 `tool:results` 报告，保存配置不代表能力已就绪。

limit-breaker 的 Web 引用包装、Web 身份、Web 功能、沙箱结果、交付物引用与 PTC 沙箱说明六条规则随内容模块移出本插件；本文只保留这些动作与条件的引擎契约，内容由外部插件提供。

## 工具与参数说明

普通 `assembly` 动作可声明 `target.toolDescriptions: [{ name, parameter?, match, text }]`。`name` 为实际工具名称；省略 `parameter` 只修改工具说明，填写时只修改该顶层参数的 `description`。`match` 必须为非空精确字面量，`text` 为字符串且允许空串删除目标句。不接受正则、执行代码、任意schema路径或约束字段；同一说明内原文必须恰好出现一次，缺目标、缺参数、缺句子或重复匹配保持原文并沿规则诊断报告具体原因。已知网络/镜像条目带完整行前缀，未知混合正文不按关键词清空。

该说明投影复用原真实Agent的 `resolve → prepareAssembly → assemble` 步骤，先固定条件和说明配置，再由官方native/PTC生成目录及SDK。它不重注册工具、不替换执行函数，不改变schema类型、必填、值域、输出或实际审批/沙箱/网络权限；发现候选和原registry保持。热更新、关闭与条件失配只作用后续步骤；旧步骤保留已接受说明，原集合移除/释放仍为上限。裸装配缺少真实步骤时只诊断并透传，不伪造工具集合。

终端拒绝、文件升级、删除移动、网络和镜像说明可通过普通工具条件及精确说明配置投影到提供对应工具的任意预设。当前字面量对齐官方0.2.2-rc.2的bash/pwsh/fs实际目录；来源旧升级长句已演进为 `sandboxPermissionsDescription`，只适配当前实测句式，未知变体保留并诊断。文案中的自动放行不改变真实准入；真实操作拒绝与原错误仍由官方owner处理。

PTC的 `run_code` 是官方执行器生成的保留传输，不在原registry目录中；同一 `toolDescriptions` 配置在最终模型schema出口投影其说明，保留参数约束、执行器、原结果及真实批准管线，不注册或遮蔽该名称。普通工具继续使用原步骤视图投影；缺传输或句式不匹配原样保留并诊断。

`assembly.target.skillDescriptions: [{ name, match, text }]` 按真实技能名与非空精确字面量修改模型可见摘要，允许空替文，不接受参数路径。配置随已接受步骤固定，仅在对应真实Agent的模型预步与工具调用中投影 `skills.snapshot/get/list`；管理查询、无身份、跨Agent或无封存步骤的调用原样透传。原技能名、provider、资源、正文和调用能力不变，原registry不被修改。缺服务、缺目标和匹配歧义保留原文并诊断，正常重判可恢复；关闭只作用后续步骤。

`skill-catalog` 首次渲染使用同一步骤已验证的技能说明：全部来源完成 `prepareAssembly` 后、官方 `assemble` 开始前结算目标，原填充器读取原始目录并按当前真实 Agent 的步骤投影一次，不重复渲染模板。provider 过滤、字段、截断和空结果语义沿用原填充器；无已验证步骤、身份不符、步骤关闭或取消时不投影，不开放 pending 步骤的通用服务读取。等待结算后再次检查取消与安装存活，装配失败及释放仍关闭步骤。

说明规则沿现有卡片显示与保存版本匹配的实际观测，正文草稿或旧版本观测不显示假成功。子代理范围说明使用既有 `subagent:delegation` 上下文与subagent受众，不改任务或范围守卫。PTC说明中的自动批准文字不改变实际审批决定；结果render不是说明元数据，也不在此投影中修改。

## 工具面收窄与按需解锁

`tool-visibility` 是工具面的唯一声明：一份 allow/deny 名单同时投影到装配目录、`tools:sdk` 正文与执行闸，并可声明发现来源。受众统一写在规则或分支的 scope 条件。宿主先准备来源并调用原 `tools.resolve`，再在 `system-prompt/assemble` 内结算 SDK 正文与步骤准入。宿主返回装配后，用同一策略筛选线上的工具 schema，完成目录并封存步骤。独立动作直接使用原服务时也按指定作用域筛选 schema；无 Agent 的调用只预览。allow 与 deny 都不注册额外 `restrict`，避免继承工具与本层工具口径不同，也不破坏发现候选。

包装的 `ResolvedToolSet` 只暴露 `view` 与 `dispose`；每次 view 先委托原集合，官方 scope、when、替换与移除始终是上限。状态为 pending / sealed / closed，pending 的透明 view 只供装配读取，执行入口与 guard 拒绝 pending 和 closed。原集合与包装集合按同一 Agent 关联同一步骤；native、PTC 和 delegate 都传递该集合，执行只读封存名单。失败、取消与最后一个 owner 释放都会关闭集合，原资源仅释放一次；重试复用封存装配，不重算规则或放宽准入。

其他插件可包装已适配的 `systemPrompt.assemble` 并调用先前取得的方法。即使包装器传回同一步的原始工具集合或派生取消信号，这条调用链也只准备和封存一次。宿主收到包装器提供的装配上下文，封存结果保留包装器对提示词的修改。对同一步骤发起的独立并发请求共用最终结果。

步骤 guard 每个 root 只安装一份，由 root 的注入生命周期持有，只查询弱引用步骤关联。最后一个装配 owner 释放会撤销服务适配并关闭集合；仍持有原服务和原/包装集合的调用继续被拒绝，包括不读取集合 view 的 PTC `run_code` 保留入口。重挂复用该 guard，新集合正常装配封存后恢复执行；root 释放时 guard 一并撤销。

三面共用 `engine/actions/shared.mjs#toolSurfacePlan`：`required` 只取静态 allow 再剔除 `run_code` 与 deny 覆盖的名字，解锁名不参与。步骤的 `available` 来自官方集合的当前 view，多个动作依序取交集；裸装配只以目录与 SDK 的并集判断展示。`requireMatch` 只对白名单有意义：静态常驻名一个都不在时仅放宽插件 allow，deny 与官方准入继续生效；只缺一部分照常收窄并留一条诊断。官方工具被替换插件取代时，把实际替换名登记进 allow；未安装的替换名不被宣告，也不会单独触发放宽。无集合的程序调用保留独立保守 guard，不冒充模型步骤。

适配覆盖官方调用路径和安装后取得的服务代理引用；Cordis `internal/get` 不保证拦截任意 `ctx.get` 或安装前缓存的原服务。外部持有原服务时应显式传已包装集合，原服务执行仍受已有 guard 约束；未传集合不自动猜出步骤。直接/裸装配不自动 resolve、不猜模型或 signal，传入未知集合时明确拒绝。

PTC 下装配目录只有保留传输 `run_code`，实际工具声明位于 `tools:sdk` 正文。`run_code` 不参与 allow/deny 名单：allow 不点名也保留，`requireMatch` 不计它，deny 不得声明它。SDK 正文裁剪与实际程序绑定读取同一封存准入；SDK 文本不能反过来授予工具权限。可见面裁到空时保留传输仍存在，因此 native 收窄声明可以直接与 PTC 共存。

按需发现由同一份声明的 `discovery` 字段拥有（`{ kind }`，工具名与解锁键由适配器元数据提供；可选写 `tool`/`key` 只作断言）：动作在首次装配时用 `ctx.get('promptToolDiscovery')` 按 agent 解析适配器，从本会话 durable `tool/call` 与 PTC 嵌套 `tool/ptc-dispatch` 参数提取显式字符串名单，只做加法且不能越过 deny。两类事件名由 `engine/history.mjs` 的 `TOOL_INVOCATION_EVENT_TYPES` 统一；观察工具执行时读两类，观察模型动作/相位晋升仍只看顶层 `tool/call`。工具本身由适配器行注册——声明了 `discovery` 的模块必须把对应行（`tools` → `tool-search`、`skills` → `skill-search`）列进 `modules`，缺行在装配准备期失败。工具名按真实注册名称匹配；坏参数逐条忽略，缺会话回落静态 allow；适配器未注册时告警一次并跳过解锁回收，不阻断装配。

首轮提示用同模板普通 inject-text 动作组合 count 条件与 session 去重；strategy: placeholder、fill: tool-catalog、params.action 引用同规则 tool-visibility 动作。只读变量 RESIDENT_TOOLS 取引用声明的静态 allow 去 deny，再按所有工具面动作结算后的最终准入过滤；另一动作的 deny 也会移除该名字。runtime-context 的目录 resolver 延迟到全部来源结算后回填，普通带副作用模板不重复求值；pre-step 位于 resolve → assemble 之后，按原 `modelSelection` 对象与 Agent 的唯一关联读取 sealed 步骤。关联歧义、pending 或 closed 时跳过目录指引，不按模型字符串或 Agent 最新一步猜测。裸装配按最终目录与 SDK 展示信息回填；没有步骤且观测不到工具面时才保留声明名单回退。DISCOVERY_TOOL 来自当前 Agent 的发现适配器工具名。

发现搜索仍通过 `toolScopeSnapshot(tools, agent).visible` 读取原注册候选，包含尚未解锁的工具，不改读封存集合。解锁只影响下一次 resolve/assemble，新集合准入不能反写旧集合或其重试，deny 始终优先。此方案取代 [ADR-0012](../adr/0012-progressive-disclosure-restrict.md) 的 restrict 与「当场刷新」历史方向；ADR 保留当时理由，当前采用步骤封存与下一请求生效。

模型提示以可观察的就绪与完成状态为准：`query` 命中仅表示发现候选，`toolNames` 回执仅表示提交解锁名单；下一次模型请求的工具声明（PTC 为 `tools:sdk`）包含目标工具才表示可调用，不必等待用户下一轮。工具操作完成仍以实际调用结果和所需证据为准。技能收窄提示在工作前搜索相关技能；名称和简介只用于判断适用性，适用技能正文通过 `skill_load` 在下一次模型请求进入上下文后，才可据其要求执行；当前可见正文已加载时复用，无适用技能时继续任务。

tool-catalog 使用普通只读变量插值；`templateEvaluation: true` 在编译时拒绝，避免目录事实被持久变量求值覆盖。被引用动作须声明 allow，未知引用或错误动作种类拒绝；发现适配器不可用时跳过提示并告警。

模块的 `tool-visibility` 规则打开即收窄；`modules` 同时列 `tool-search` 行，工具由该行注册、元数据由发现注册表按 agent 解析，常驻集来自同一声明。普通提示动作在可见用户消息数不超过一条时自动列出**当前可见**的常驻工具并提示发现解锁，按当前上下文去重；观测不到工具面时回落声明名单，观测到工具面但一个常驻名都不在时跳过提示，因此部署层登记的替换名若未安装就不会被宣告。需要晋升门时显式加规则条件；不由引擎偷偷恢复首轮全工具目录。

## 工具呈现（present-as）

`present-as` 行在真实 **Agent scope** 挂载官方 `@deepseek-ai/dsh-tool-executor-native` 或 `@deepseek-ai/dsh-tool-executor-ptc`，等待异步导入与插件初始化完成。`mode: ptc` 只声明保留的 `run_code` 传输与生成的 SDK 段，其余可见能力走程序内绑定；`native` 直接声明与执行当前可用工具。同一 scope 的执行器冲突由官方拒绝。未启用该能力的 Agent 继续由宿主提供执行器，插件不接管部署默认。

`ptc` 需要 `ctx.ptcRuntime`：本行用 `ctx.inject(['ptcRuntime'], ...)` 等它就绪后挂执行器，等不到时先 warn 一次并保持等待，迟到到达再记一次 info。`native` 不依赖 PTC 运行时。执行器与等待的生命周期归挂载 scope；来源替换、Agent 结束或插件释放后，迟到初始化不能恢复旧贡献。

执行器卸载、模块禁用或 PTC 运行时撤回后，新批次以 `TOOL_EXECUTOR_UNAVAILABLE` 明确失败，不自动回退祖先执行器或 native；已接受批次按原执行器排空。显式重挂有效执行器后恢复，新会话也需要有效执行器。装配刷新可为各 Agent 重挂独立贡献，压缩不改变受众。

`mode` 是必填默认；可选 `mainMode` / `subagentMode` 分别覆盖主会话和子代理，省略继承 `mode`。配装通过引擎 `apply(ctx, config, { agent })` 传入真实 Agent，`present-as` 复用 `capabilityAudience` 选择模式，不从 Context 或页面状态猜测身份，也不修改共享配置。模块声明本能力后无需另加提示规则：官方执行器提供 PTC 调用指引和生成的 SDK 段。

程序当前工作目录使用官方 `process.cwd()`，shell 操作使用当前工具面提供的 `tools.bash(...)` / `tools.pwsh(...)`。默认 Node/per-call 程序的 `process.env` 初始为空，OS 仍保留启动所需环境；宿主嵌套 shell 独立收集安全环境，与程序环境不在同一层。持久运行形式的环境也不能称为恒空，官方不提供等价 `env` 对象。独立 `env-facts` 仍可按白名单注入环境事实；升级时用户副本与旧程序的调整见 [CHANGELOG](../../CHANGELOG.md)。

## 重复输出安全截断

`generation-recovery` 是显式选用的本地能力行，通过既有 Agent 装配与 `llm/stream` 接缝工作。模块可这样声明：

```yaml
modules: [generation-recovery]
moduleConfigs:
  generation-recovery:
    enabled: true
    audience: all
    textRepeatChars: 4096
    reasoningRepeatChars: 8192
    maxCycleChars: 256
```

`audience` 可为 `all`、`main`、`subagent`，缺省为 `all`。正文和推理各自检测连续精确重复：至少三个完整周期，并达到各自字符阈值才截断。阈值最小为 3；周期上限默认 256，允许 1–1024 个 Unicode 字符。检测按字符推进，大 delta 内达到阈值就切到该处，不依赖提供方如何分块。引擎直接调用的 `enabled` 缺省关闭，选择组合行后由该行显式开启。

正常输出原样通过。触发时闭合开放的文本／推理块，完整流只产生一个 `stop` finish，并关闭上游迭代器。出现过工具调用的本次流保留原行为，即使工具块已经闭合也不截成 `stop`；开放未知块同样不强行闭合。辅助压缩与标题调用、其它会话和未选受众不参与检测。取消或释放后停止本项目检测，不把取消改成正常完成。

通用默认只截断。`silentReasoningChars`（默认0关闭）限制没有正文时的长推理，`recoverEmpty`（默认false）识别回合最后一步仅推理／空输出；前面出现过工具调用不会掩盖最后一步。流与结算沿官方 turn/step 形成同一候选，直到 durable turn/end 后才决定恢复，原流已有 terminal 不重复补发。

`mainRecoveryLimit`／`subagentRecoveryLimit` 默认0，可设0–1000；非零才开启对应受众的自动恢复。额度按会话持久，重挂不清零，同一执行只能消费一次。扣额后等待 `whenIdle`，检查取消、卸载和是否已进入新turn，再发送非空纠正消息。额度耗尽或持久owner不可用明确报告，取消后迟到Promise不会唤醒。

`maintenanceCompression` 默认为 `false`。开启后，恢复流程在 Agent 空闲时请求一次当前官方压缩服务的 `compactNow`。服务不可用、返回 `null`、失败或取消时停止此次恢复。成功后才发送恢复消息。失败和普通工具裁剪均不推进成功压缩 epoch。

`lineRepeatChars/crossCallRepeatChars` 默认 0 关闭，可显式设置行重复和跨调用阈值；较长周期需同步提高 `maxCycleChars`。重复行至少6行、覆盖80%且主导行集中50%；跨调用与此前两次合格调用各达到90%行材料覆盖时才判第三次重复。每类只保128行摘要、单行1024字符，跳过引用和围栏代码，取消/卸载清理。固定校准集3类异常检出、3类正常材料无误报，不能外推生产误报率；这是有界行材料相似度，不是语义向量。仍由原coordinator去重和扣额，不补额、不增加恢复执行者。

## 角色委派（官方 Team 单任务）

官方 Team 拥有任务、依赖、归属和版本，官方子代理服务拥有成员、实际运行和取消。角色内容归来源模块及资产。只有已校验的角色能绑定到真实子代理，身份绑定与官方创建的 Agent 一致。恢复以官方持久会话与任务状态为准，释放撤回待处理意图，已启动工作的取消沿官方入口。

## 自动派工编排（官方 Team 多任务）

多任务编排复用官方任务登记、依赖和版本，默认关闭。输入要求任务范围、已知事实、可用工具和独立验收依据。等待依赖完成后才开始后续任务，并行受任务独立性与额度约束。错误、取消和缺少角色与真实完成分别结算，汇总保留任务与子会话身份。关闭阻止新派工，在途任务与持久状态由官方 owner 管理。

显式工具依赖可用 `if: { tool: { name: target_tool } }` 组合原条件树；读取当前真实Agent的原toolStep及官方executable执行集合，不按目录/schema或普通变量判断。缺步骤、缺目标或显式delegate目标链不可执行均为UNAVAILABLE，not/else不能将缺失反转为命中；目标恢复后仅下一次正常集合重判，原次数/Epoch和用户关闭保持。delegate目标只附在当前工具定义的Symbol，不新增状态库；步骤view按官方原集合过滤缺目标/循环链，原工具次序和disposer保持。

内联customTools整组注册失败先撤本组成功项再抛原异常，由原Slot/lastGood处理，不发布半组。较近scope仍可遮蔽祖先，同层重名及run_code保留名由官方拒绝。delegate同名自委派在定义校验时拒绝，其他递归在执行嵌套身份超过32层时明确拒绝；不把当前遮蔽者假装成祖先原实现。HTTP合并caller signal与timeout；shell取消清理本次进程树并保留caller异常身份。

## 自定义工具与宿主契约

工具通过已安装 `@deepseek-ai/dsh-tools` 的 defineTool/官方转换器定义，使用真实 ToolExecution 的 agent、signal、调用身份；异步工作观察或转发 caller-owned signal。delegate 走 `ctx.tools.execute`，保留批准、拒绝和取消管线。

自定义执行器支持 shell/http/delegate/fs/ask-user。定义、参数 Schema、输出和路径在写入边界校验；不依赖工具描述来当权限。fs 用真实路径 containment 限定 cwd，shell 超时与输出超限给出可诊断 error；宿主 API 以安装包类型和官方文档为准，不复制旧版本行号作当前依据。
