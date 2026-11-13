# 统一规则引擎复用指南

`compaction-tool-result-pruner` 按宿主解析的官方构造器身份发现全部存活 Fiber，并在各 owner 自己的 Context 等待、门控原 Pruner；正式 standard 组合内层 isolate 不影响发现。就绪与停用资格按当前 Agent 的官方 scope 和真实 session 身份核对，其他 Agent 的 owner 不提供就绪。晚到或重挂后在后续正常装配重判，释放立即使旧门控失活；关闭规则恢复官方裁剪，第三方外层包装保留。不复制裁剪算法，也不修改预设。

`host-control / session-rewind-todos` 独立默认开启，按回退提交时真实 Agent 的规则判定。开启时预览及历史标记提交前核对当前作用域的官方 `todos` 投影；owner 未注册或释放时明确拒绝，正常暂无清单（null）允许，恢复后在下次正常请求重判，关闭时不依赖 todo owner。历史标记提交后，读取官方 `todos` standing-plan 投影（`turn/start` 后无清单即不写），仅将 completed 改为 pending，保持 in_progress、pending、正文与顺序；沿官方 Session 的 `todo/write` 全量事件持久化并更新同一投影，不建立第二状态库。历史重放只解释，不补写待办。标记已提交而待办写入失败时返回带 markerId 的失败目标，明确历史已提交；原边界重试只补待办，不重复回退，已进入新轮则拒绝。关闭、释放不逆转已写结果，后续不再更新。

`host-control / session-rewind` 是默认开启的会话回退资格。producer 固定实际 Agent、所属轮及已接受输入身份，经公开 `cancel(..., { keepInbox: true })` 与有界静止等待后，在 `runMaintenance` 内再次核边界，期间开始的新轮不能被迟到取消或重新选中。回退按当前 surface 的连续输入后缀写空用户 replacement，准确记录来源节点；durable 不改写，重复网络提交不多退一轮，新的明确点击可继续退更早输入。整轮包含本轮真实子代理完成后的已结束官方通知轮；已释放的子会话经官方恢复，在启动屏障内核验父身份、持久边界与空 inbox 后才维护，成功后释放临时驻留；未知通知来源或预览后新轮拒绝。

上一轮从该轮当前可见的第一条已接受用户输入开始撤回相关 surface 后缀；同轮后续接受的输入一并撤回，一次回退仍从最后一条输入开始。整轮将各目标本轮当前可见的真实用户输入按 surface 顺序回填，输入原文间以空行分隔，仅取文本块并保留原文空白；一次回退仍只回填末条输入，保护新草稿且不自动发送。预览同时固定末条输入身份，后来接受新输入时拒绝陈旧提交。上一轮以官方 `subagent/start` 发生时的父轮与子实例为关联证据，同时核对目录事实、持久父身份和本次子执行的输入起点；不按显示名、相同轮号或全部后代猜目标。缺少启动期事实、远程对象、owner 变更或陈旧输入明确拒绝。跨会话逐目标返回结果，失败重试保留同边界，重新授权且只执行未提交目标；去重记录有期限与数量限制，不落第二份持久账本。页面凭据绑定官方 principal，每次向 `remoteAccess.decide` 重核实际目标 `session/prompt` 权限。

Session 解释器在 Agent 创建及插件挂载已有 Agent 时安装，公开派生出口排除确认的空标记并保留原派生缓存与其他消息贡献。规则关闭不恢复被撤内容；重放不补写或重发。释放恢复仍归本来源所有的方法，使保留在第三方包装内的旧贡献失活。卸载后的环境不支持回退历史的完整展示，需恢复插件解释器；不为卸载改写日志。Web 装配与真实三端运行须分别验收，Node 行为回归不能替代浏览器或桌面证据。

普通规则 `host-control / messages-current-system` 仅接受 `value: true`，默认开启，独立于 `current-system-snapshot`，不隐式开启它。单独生效时，Messages 顶层 system 使用当前请求历史中最后一条非空 system 正文，空正文不擦除已有正文，原 `options.system` 前缀保持。两者在同一步同时获准时，按真实消息来源先放本步已接受的完整 `system-prompt` 正文，再按原顺序组合其他来源 system；其他来源的空白、换行和同文贡献保持，不按正文全局去重，不把这些正文降为中途 system。工具增删通知仍沿官方 developer 路径，工具配对、ID 和内容校验不绕过。

Messages 资格复用真实 Agent 的 sealed 工具步骤、原 prepared adapter 身份与 snapshot owner 判据，热更新不混入旧步及重试，缺 owner、取消、释放或路由重挂停止旧资格。缺失必要 owner 只暂停该动作及显式依赖正文，无关规则继续。可选 early 接入逐一校验 `@deepseek-ai/dsh-llm-deepseek@0.2.2-rc.2` 的完整发行指纹和唯一锚点；目标为固定源码构建产物。需用户重启 DSH 后生效，真实 CLI/Web 综合验收另行执行。

Responses 同段包含系统正文和工具删除时，正文沿系统角色映射，工具删除沿固定 PI 的当前工具集合折叠；关闭时保留官方角色判据。

请求身份首段与系统角色由两个独立 `host-control` 动作控制：`oauth-identity-prefix` 和 `provider-system-role`，均只接受 `value: true`，内置卡默认开启。前者只跳过 Anthropic OAuth builder 自动添加的 Claude Code 身份首块，用户正文中的相同句子保留；认证、headers、工具名、缓存与其他正文保持官方路径。后者只调整 completions 与 responses 的系统正文角色判据：原推理与 compat 条件允许 developer 时，仅 `URL.hostname` 精确为 `api.openai.com` 或真正的 `.azure.com` 子域保留 developer，其余使用 system。工具增删通知的既有 developer 语义不改；相似后缀、userinfo 和 query 不授权原生角色。

当前适配仅面向固定官方源码 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c` 构建的 `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.2` 与实际解析的 `@earendil-works/pi-ai@1.3.0`，应用该源码的共享 streamed tool-argument patch。三条协议分别校验完整指纹与唯一锚点，未验证文件不投影。Messages 每次发送完整 system/tools；第三方 completions 缓存键沿该版官方判据，不启用后续版本专有选项。Responses 纯新增工具声明保留原生 developer `additional_tools`；出现删除或同名重声明时，官方将工具历史折叠到顶层当前集合，插件不添加文本通知。角色映射只改变系统正文。

资格在实际 Agent 的工具步骤准备时冻结，loop 只在本次 `llm.prepareCall` 期间携带身份，实际 adapter 将它绑定到原 prepared stream。请求专属模型副本携带该身份，不按 sessionId、最近 Agent 或全局 fetch 关联。热更只影响后续步骤；取消、步骤关闭、规则 owner 撤回或 adapter 注册释放后停止本来源效果，重挂不能复活旧资格。发行适配分别校验 loop、LLM 路由、DSH PI adapter 与 PI provider 的版本、完整指纹和唯一锚点；两个 OpenAI 目标均成功加载才就绪，缺失仅暂停该能力及显式依赖分支，OAuth 能力独立。需要 early 入口与用户重启 DSH 后生效；本地最终载荷不承诺远端服务接受，CLI/Web 综合验收另行执行。

普通规则 host-control/message-shape-guards 使用 value: true，内置卡默认开启。资格在当前工具步骤准备时固定，最终公开 assemble 与 refreshContext 只将缺失或非字符串的 section/context 正文归空，合法字符串、空白和顺序保持；complete 最终还原也经过该出口。未知变量、非法表达式、provider/getter 异常仍由官方抛出。

缺省或非数组 messages 仅在 enter 决定归为空数组；模型切换的前置消费者和最终 turn 消费均使用同一 Agent、modelSelection 所关联的 sealed 步骤。未知 kind、reject、取消和独立异常不变。真实 step 内，Session 的 system/developer/assistant 派生仅过滤缺消息、非数组或空 content，官方投影仍优先，合法消息保原身份；user/tool 不参与该过滤。loop 的 systemNodes/textOf 沿同一步处理空 content，首尝试 runtime-context 原分流与一次投递保持，历史事件不改写。脱离该 Agent 步骤的公开派生调用仍透传。

agent、session、loop 的实际发行物分别验证版本、指纹和唯一结构，并由实际 Agent.model、Session.surface 和 loop 实例联合握手。任一必要 owner 缺失仅暂停本能力和显式依赖分支，预算与当前系统快照能力独立。热更新只影响后续步骤，关闭、释放、取消或旧步骤结束后不能借新 owner 复活。rc.2 JSONL v4 仍拒绝缺 message 或非数组 system content，容错不绕过持久格式校验；空 content 数组可正常持久化。需 early 入口和用户重启 DSH 后生效；真实 CLI/Web 综合验收另行执行。

普通规则 `host-control / current-system-snapshot` 使用 `value: true`，内置卡默认开启。它复用请求前 `prepareAssembly`，把资格与兼容状态固定在原工具步骤；请求按已接受 assembly 对象身份读取同一个 sealed 步骤和局部 renderedPrompt，热更新、裸装配及同 Agent 并发装配不改变在途步骤与重试。按真实 Agent 隔离主子受众，取消沿官方信号；规则关闭影响后续步骤，owner 释放、步骤关闭或当前接缝失配立即停止本来源投影，旧资格不借新 owner 复活。

当前正文只整理 `system-prompt` 来源：通过官方 Session.append 追加 surface replacement，使当前首条 system 与同一步 durable 日志正文一致；不改写任何既有 durable 事件。空白、仅头、仅尾、截断或不同换行的旧来源补为本步精确完整正文，不全局 trim；请求投影将本步正文放在首条，其他来源即使先有 system 消息也保留原内容与相对顺序。可见事件复用 currentEvents 及其降级契约。后续同来源节点只清空一次，请求投影移除这些空节点；相同正文的重复步骤不制造新事件。关闭后回官方后续路径，已提交的新正文仍是历史事实，不恢复旧历史头。

早入口验证官方 agent-loop 实际版本、发行指纹及 snapshot 独立锚点，只有实际 constructor marker 与本 Agent 存活 owner 同时存在才就绪。缺失只暂停包含该动作的显式依赖分支，无关规则继续；owner 恢复后在下一次正常装配重判，不轮询补发。需用户重启 DSH 并选用 early 入口后生效；CLI/Web 综合验收另行执行。

`host-control / provider-hook-decisions` 的 `value` 选择 `claude-code: true` 或 `codex: true`（也可同时选择）。普通内置模块两卡默认开启。它保留官方 Hook 执行、原始审计和 context，仅绕过本 owner 的 UserPromptSubmit、PreToolUse、PostToolUse、Stop 的 deny 出口，以及 Claude 独有 ask 出口；其他 owner 和下游拒绝保持。四事件在接受时冻结当前 Agent 自己的规则计划，只取该事件的 modelSelection，缺模型时模型条件 unavailable，不读取 Agent 下一步模型。关闭、撤回和 owner 释放影响后续调用，不重放历史动作。

两个可选官方包逐一验证实际解析版本、完整发行指纹和四事件 anchor；缺失或失配仅暂停显式依赖该目标的分支，并显示原因。owner 必须成功读取配置，且经官方 scope 路由对当前 Agent 可达；消费结果时仍检查 owner 存活和调用取消。在途热改保持已接受计划，释放或取消不能沿旧计划授权。重新装配 owner 后在下次正常重判恢复，early 入口需用户重启 DSH 后生效。该动作不接受投递次数预算或 outermost 排序。nested 仅指部署中实际解析到的另一份副本，未装配不声称已验证；原生 Stop deny 会 steer、prompt deny 会 reject，不另建空动作或旁路伪用户正文。真实 CLI/Web 组合验收另行执行。

升级请求由三个独立 `host-control` 能力控制，`value: true`，内置卡默认开启：`escalation-criteria` 跳过阶梯、缺审批服务与缺 Agent 的显式检查，但仍调用真实审批（缺服务仍会失败）；`escalation-grant` 直接返回本次 requestedMode；`escalation-outcome` 只将 rejected/cancelled/unavailable 三种审批结果转为本次 mode，不吞其他错误或任务总取消。直接授信优先于其他两项，但不关闭工具管线或其他 owner 的拒绝。

四个官方调用者（文件、bash、pwsh、PTC）在各自已有原始发行指纹 owner 内组合适配，传递当次 exec 的 toolSet/modelSelection；sandbox 独有早期入口只改其升级函数。身份不进入原审批请求或审计正文，不从最近 Agent 猜步骤。规则按当前 Agent 可达的真实 caller 及其 scope/生命周期判定依赖；可选目标未装配不阻断其他路径，实际缺失或失配的路径不可借其他 caller 就绪。await 前固定步骤快照，撤回影响后续步骤，owner 释放后不复活。需用户重启 DSH 并选用 early 入口后生效；已有用户模块不自动追加卡片。

`host-control / approval-decisions` 的 value 接受独立布尔字段 autoGrant、autoReviewPassthrough、toolAskAllow。三个内置卡默认开启。autoGrant 保留官方请求审计，仅在工具管线向原审批服务请求期间继承同一步身份；其他缺身份审批不授权。autoReviewPassthrough 只透传该自动审核 owner，独立 guard 保留；toolAskAllow 在取得审批服务后直接允许，包括缺服务及原审批拒绝，不表示全局工具 guard 失效。任务取消保留。各 owner 分别按发行包指纹校验，缺失仅暂停命中分支；真实服务释放后不可复活。需用户重启 DSH 并选用 early 入口后生效，当前已有用户模块不追加卡片。

命令直通由普通规则 `host-control / command-confine-passthrough`、`value: true` 和显式 `executionScope: process` 控制，内置卡默认开启。它独立于软默认：公开生命周期只包装官方 LocalSandboxProvider 当前实例的 confine，作用后续调用，返回原 argv 的副本及空拒绝签名/runner 失败规则，不执行命令。缺目标仅暂停此能力。无 Agent 参数的共享 owner 不读会话、受众或最近步骤；原路径的参数、this、同步/异步返回和异常身份保持，直通仍尊重 caller 取消。关闭影响后续调用，在途保留接受快照；撤回仅恢复仍由本来源拥有的方法，第三方后置包装不覆盖，释放实例不复活。不修改宿主文件，真实 CLI/Web 验收另行执行。

规则 `executionScope` 缺省 `agent`；`process` 每模块在现有发布队列贡献一次，即使没有活动 Agent 也初始化、观察保存并撤回。进程规则接受无条件的命令 confine 直通，以及三个构造默认动作：`host-control` 的 `sandbox-soft-default: danger-full-access`、`approval-composition-default: never` 和 `approval-config-default: never`（值写在 `value`）。会话、受众、消息及嵌套 Agent 条件、Agent 注入动作均拒绝；不自动开启其他规则。定义、切片、规则工具与模块导出保留作用域。

这三个动作只影响启用后经官方 Loader 真正重新构造的策略或审批实例，已构造对象与既有会话不追改；关闭恢复后续构造默认。沙箱与审批组合默认只替换官方 base 的省略配置表达式，环境显式覆盖和用户显式配置保留，非法组合仍由官方 permission-presets 拒绝。不能把已启动进程中保存成功或普通重启等同于先前已构造对象生效。需要早期入口、精确 Loader 与策略/审批发行产物验证；缺入口、缓存或失配的原因经既有规则诊断显示，已验证也只标记后续构造可用。

新主会话 full-access 继承由官方 permission-presets 原生提供：部署是 full-access 且用户没有指定其他默认时，新会话采用 full-access；显式默认、后续用户选择和既有日志保持，子代理仍走官方捕获与委派策略事件。插件不添加同义开关，也不覆盖用户钉选。

`host-control/delegation-limits` 的 `value.maxDepth` 为非负安全整数，`value.askTimeout` 为1–2147483秒整数；至少声明一项。内置核心模块分别提供默认开启的深度10和等待300秒规则。深度仅替代官方spawn工具省略的配置，显式配置与provider-managed保留；等待仅替代调用的timeout=-1，省略和有限值由官方owner处理。两个早期owner分别校验，缺失只暂停显式依赖该目标的分支。参数按当前Agent已接受步骤封存，后续重判才接受更新；关闭不改已创建子代理或在途提问，取消沿原信号。普通入口缺失早期owner时需用户重启DSH并选用early入口。

规则是唯一行为定义。插件读取模块定义、校验切片，再经 `compileRules → createRuleRuntime(...).replace` 装配到 Agent scope；一次性调用仍可使用 `mountRuleSources`。这是两段式生命周期：`compileRules` 只编译与校验（产物每条规则携带 `conditionTrees`，选项里的 `ctx` / `standingMountFor` / `variableStore` / `manifestCheck` 会被显式剥掉），条件在来源注册前由 `rebindConditions` 绑定。原因是 `preset` 谓词要挂载 scope 的 ctx（`conditions/preset.mjs` 把服务查询基准绑在构造期），准备期拿不到——那边绑出来的 `preset` 条件是恒 UNAVAILABLE 的静默死条件。需要官方模块导出的兜底时，由调用方通过 options 传 `standingMountFor`；重绑含 `preset`、含 `variable`、含 `manifest`、含 `phase` 且未显式 `subscribe: false`、或含 `anchor.after` 动作引用的树，其余谓词原样保留。规则实例、条件绑定和运行状态按 Agent 私有，不跨 Agent 复用可变的准备产物。模块不进入官方会话预设注册表；九个插入点各有生命周期，不形成插件自定义的全局管线。

编辑保存与运行注入分别负责：客户端只提交合法草稿，普通保存完成写盘与切片验证后立即确认 `persisted`，运行发布由装配通道按 300ms 合并。发送消息不等待自动保存；官方 `systemPrompt.assemble()` 开始、同步 provider 求值之前，插件提前处理已保存规则定义的变化。`refreshOnly` 同样提前发布并等待真实结果；显式发布、文件观察与请求前检查使用同一调度通道，同版本不会重复重挂。变量值仍在模板求值时读取，不因值更新重挂规则。

插件同时观察启用表与已参与模块的 `module.yml`（200ms 文件检查），使直接修改文件也能更新后续事件的注册。正文、参数、启停、增删、条件、受众和插入点修改从后续实际发生的官方入口生效；不会重跑进行中的请求，也不补执行已经过去的入口。单个模块读取、校验或挂载失败时，首次加载跳过该模块；已有有效版本则恢复该模块的旧贡献，健康模块继续更新。旧版本也无法挂载时撤销该模块并报告两次失败。文件变化或显式刷新可以重试，同一坏版本不在每次请求时重复撤装。监听与文件观察随插件释放，不修改官方 Loader 或 profile。

装配记录只包含实际参与贡献的模块。未变化的普通规则来源与模块能力保留注册；未启用模块保存不重挂 Agent。规则的跨模块排序仍聚合计算，共享派生组在成员或有效内容变化时可以更新；共享工具仍由成功来源共同使用。失败尝试的工具和监听器不会保留。显式刷新在发布健康模块后仍返回故障诊断；普通保存不等待这个结果，后台失败只写日志与 `/meta` 的 `publicationFailures`，不进入 `moduleWarnings`，也不在工作台显示。切片提交后失败和显式重试失败仍保留 `persisted/publicationPending`。全局部署配置、跨模块 `complete`／`sections.append` 冲突，以及无法归属单个模块的公共注册错误仍整体拒绝并尝试恢复原装配，不自动选择赢家。

晚到服务的初始化同样受模块装配管理。依赖尚未到达是正常等待，已有规则贡献可以继续；只有模块及其共享能力的初始化全部成功后，才更新该 Agent 上该模块的最后有效快照（`lastGood`）。未变化来源保留原初始化所有者，增量更新不把一次准备成功当作初始化成功。初始化回调随后失败时，撤销所属模块的贡献并尝试恢复该快照，无有效快照则跳过；共享能力失败影响当前声明它的来源集合。故障诊断保留来源与原因。同一失败定义不会因其他模块更新而自动重试，修改该模块定义或显式刷新可以重试。来源已替换、Agent已结束或插件已卸载后，迟到状态不能撤销新贡献或重新启用旧模块。检索工具在依赖就绪后同步注册，第二项注册失败先清理第一项，不留逃离模块初始化链路的工具fiber。运行期单次维护、检索或动作错误仍由各自业务处理，不因此触发模块回退。

字段和磁盘事务见 [参数框架](architecture-params.md)，外部来源转换见 [SillyTavern 导入](SillyTavern.md)，设计决策见 [ADR-0013](adr/0013-native-context-module-state.md)。

## 原生运行与工具面

### 工具、能力与公开入口

工具名称与能力归属的唯一目录为 `src/shared/engine-capabilities.ts` 的 `MODULE_TOOL_NAMES` / `MODULE_TOOL_CAPABILITIES`。注册、委托建议与补装消费该目录。

| 能力 | 实际模型工具 | 所有者 |
|---|---|---|
| `module-rule-tools` | `module_rules_read`、`module_rules_edit` | 完整原始规则与按域 revisions |
| `module-variable-tools` | `module_variables` | global/module/session 持久变量 |
| `module-file-tools` | `module_file_read`、`module_file_append` | 模块私有文件：memory.md、assets/（只读）、data/（只追加） |
| `module-manifest-tools` | `module_manifest` | `assets/manifest.yml` 的 next/check/apply，只写 data/、不覆盖 |
| `module-import-tools` | `module_import` | 来源预览、选择、凭据和候选安装 |
| `soul-ledger` | `soul_ledger`、`soul_state` | 真实身份、主导资格、逐项收口与会话短状态/只读诊断 |
| `retrieval` | `module_search`、`module_open` | 来源白名单、版本引用和原文回取 |
| `tool-config-engine` | 模块声明的自定义工具 | 官方工具注册、执行和批准管线 |

未声明的工具能力不注册。五个模块工具外壳通过 `ctx.inject` 等待各自 `pt-module-*` provider，贡献随 disposer 撤回。来源模块内的模板变量按该来源读写；模型工具目标由调用方显式 moduleId 声明，缺声明拒绝，执行 Agent 的配装记录只作候选提示。`expectedModuleId` 仅作身份一致性校验，不选择模块或目录。模块规则正文要调模块工具时，必须把来源模块 id 写死（例如 `moduleId: soul`）；引擎不提供模块身份插值宏，模块复制或改名后需同步正文。

旧 character/world_book/session_var 工具、对应能力与 ST 运行文件退出公开面；外部标准中的世界书名称仍可出现在导入类型和来源记录中。没有新旧双读、角色专属存储，也没有任意路径工具：模块私有文件只允许 memory.md、assets/（只读）与 data/（只追加）。

### 内置资产与用户覆盖

所有内置模块同 ID 补建/新建只物化 `module.yml` 与其规则切片，`assets/` 留在插件包内。`resolveModuleReadPath` 逐文件先读用户目录，缺失才按完整 moduleId 回退包内同名模块；用户空文件是覆盖，坏编码、权限错误和链接不回退。`module_file_read`、注入 `templateFile`、manifest 清单与初始化来源、检索文件和近义表共用此顺序；检索目录合并两层文件名后逐文件解析，仍受原来源白名单约束。`memory.md`、`data/` 读写始终只在用户目录，写入接口不会选包内落点。

包内资产随插件更新，不写回用户定义；已有覆盖不自动删除。模板正文在规则编译时读取，更新插件代码/包内资产后需用户重启服务或重新装配，不能以文件已更新推断旧会话已经刷新。改名复制/另存时补齐包内资产并保留用户覆盖，之后独立维护；不剥离 `-copy` 或数字后缀。正文中写死的工具 moduleId 仍需按原契约手工同步。

Soul 的常驻 `soul-tools` 在 runtime-context 提醒完成跨回合任务、重要定案、踩坑时及时判断是否追加事实索引，退场时记录一次交接；`soul-tick` 保持每 12 轮 system-section 自检并加问账本遗漏。两者遵守唯一归属、已有记录去重与出处要求，不记录过程流水、可重建事实或无出处断言，不放宽 lead/promise 授权。提示投递可确定性验证，是否遵从并实际调用工具仍取决于模型，不由后台代写账本。

### 执行状态与接入

`repeat-tool-reminder` 与 `compaction-tool-result-pruner` 是默认开启的 `host-control` 能力，`value: true` 分别停用官方重复工具调用提醒与工具结果修剪。缺少 owner 时仅暂停命中分支，owner 晚到在下一次正常装配恢复；关闭规则影响后续步骤，已接受调用保留快照。重复提醒过滤只移除官方来源，其他 stop、block、追加上下文和普通压缩保持不变。修剪按 Agent/session 隔离，disposer 与 owner 释放撤回后续正常装配贡献；repeat 取消透传已接受的官方结果，不泛化取消服务方法。成功压缩推进 Epoch，失败压缩不推进。

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

### 插件侧怎么引入引擎（类型边界）

`engine/*.mjs` 是纯 JS，`tsconfig.json` 不开 `allowJs`/`checkJs`。因此每个**被 `src/` 静态引入**的引擎模块都配一份手写 `.d.mts`（与 `.mjs` 同目录同名）：

- 已有声明的：`rule-spec`／`audience`／`rule-facts`／`shared`／`interpolate`／`executor`／`pre-step-source`／`promotion-pool`／`branch`／`tool-definition`／`order`／`rule-runtime`／`compaction-epoch`／`conditions/index`／`template-evaluation`／`template-frame`／`context-activation`／`service-names`／`discovery`／`delivery`／`instruction-files`／`source-kind`／`instruction-blocks`（2026-10-16 起 `src/` 侧不再用 `@ts-expect-error` 引入）。
- **新增引擎导出时同步改声明**：`src/` 只用到的符号才声明（声明是「插件依赖面」而非引擎全貌）；跨引擎模块引用写成 `import type { X } from './y.mjs'`，**不要**引用 `src/` 的类型（声明文件与 `.mjs` 同目录，`src/` 不在它的解析面内）。
- **声明文件只是类型面**：不进 `lib/` 打包，也不需要改 `package.json`／tsdown（`exports["./engine/*"]` 已覆盖；TS 按 `./x.mjs` → `./x.d.mts` 解析）。
- **为什么有些声明符号 `src/` 从不直接 import，却仍然必要**（别按「无人使用」删它们）：`src/` 消费的是**函数**，不是字段类型——`StandingMountFor` 被 `loadStandingMountFor` 的返回引用、`MountRuleSourcesOptions` 被 `mountRuleSources` 的参数引用、`PreStepBatchOptions` 被 `runPreStepBatch` 的参数引用、`WarnOnce` 被 `createWarnOnce` 的返回引用……它们是**签名的组成部分**。删掉会让签名退回 `unknown`。判据是「它是否支撑某个被消费符号的签名」，**不是**「它自己有没有被 import」。
- **声明的失效方式是静默的，当前没有机制校验**：声明多于实现 ⇒ `src/` 编译通过、运行期拿到 `undefined`；签名写宽（如 `rule-runtime.d.mts` 的 `ctx: unknown`）⇒ 类型不再报错但也不再说实话。这两类都只能靠「新增／改名引擎导出时同步改声明」这条纪律 ＋ 人看。**已做的核对（2026-10-22）**：19 份声明的导出在运行期逐个 `import` 核对，**无漂移、无冗余**。
- **动态加载点的归属与断言**（2026-10-16 核实）：按 id 加载在 `runtime/agent-assembly.ts:126-145`（`join(packageEngineDir(), '<id>.mjs')` ＋ `existsSync`，缺文件按官方行诊断/未知行跳过、缺 `apply` 抛）；固定文件名 URL 动态导入有三处——`runtime/bridge-runtime.ts:546`（`schema.mjs`，断言 `{ getEngineMeta }`）、`runtime/routes/instructions.ts:31`（`rule-spec.mjs`，收在 `ruleEditorMeta()` 里、被调 5 次，断言用的是 `src/shared/rules.ts` 的 `RuleEditorMeta` **副本**而非本目录的声明）、`src/index.ts:202-206`（`skill-search.mjs`，相对 `import.meta.url`，失败 warn 降级）。引擎内另有 `actions/content.mjs`（按策略名懒加载）与 `host-package.mjs`（按宿主包名，非引擎模块）。
- **这些断言为什么不收成一个接口**：四处加载在**路径基准／失败语义／断言形状／缓存**上各不相同——按 id 那处要求「缺件跳过、缺 `apply` 抛」，`index.ts` 那处要求「失败只 warn」，只有 `bridge-runtime` 与 `instructions` 两处同形（固定文件名 ＋ `packageEngineDir()`）。强行统一会得到一个覆盖四种错误语义的宽 options ＝ 浅接口，故**有意保留内联断言**。
- **`@ts-expect-error` 与「声明不参与」的边界**：上面静态引入的模块由同目录 `.d.mts` 供类型（见上一条）；**走绝对 URL 动态 import 的那几处，`.d.mts` 不参与解析**，类型完全由手写内联断言承担——`rule-spec.mjs` 因此同时有两条类型路径，`src/runtime/routes/instructions.ts` 用的还是 `src` 侧的同名副本。
- `engine/vendor/**` 的 `@ts-expect-error` 来自上游转译产物，随快照整体覆盖，**不手动改**。

服务名绑定也在这条边界上：宿主与引擎共用的服务名只有 `engine/service-names.mjs` 一个真值源，`src/` 与引擎侧的各引用点都从它取，**改名不得手抄**。手抄的失效方式是静默的——引擎查不到协调服务就回退自身的独立执行路径，模块工具外壳等不到 provider 就不挂工具，两边都不报错。这也是「引擎可单独复制」的一部分：名字随 `engine/` 一起走，复制方不必问宿主。回归通过 `test/host/agent-assembly.test.mjs` 与模块工具行为测试验证实际挂载、调用和释放。

### 引擎契约（加载器视角）

组合源 `engine/compositions/source/local/*.yml` 里的行分两类，加载器（`src/runtime/agent-assembly.ts:147-220`）按 `name` 判断：

- **本地引擎行**：`name: ./engine/<id>.mjs`。加载器按行 `id` 拼出同一路径 import，执行 `apply(ctx, config, { agent })`；`config` 是模块定义里解析后的行配置。
- **官方 recipe 行**：`name` 是 `cordis:group` 或 `@deepseek-ai/dsh-*` 包名，没有本地 `.mjs`。这些行由会话原有预设提供，加载器在 `engine/<id>.mjs` 缺席时跳过并记录诊断，不校验引擎形状；声明它们不会让插件自行挂载官方包。

行级 `disabled` 由模块事实的受控求值处理：只接受 `true`/`false` 和 `process.platform ===/!== '...'`；未知表达式 fail loud，disabled 行不进入运行集合。

一个**本地引擎模块**必须满足五条：

1. **身份**：文件位于 `engine/<id>.mjs`，与行 `id` 一致；行 `name` 若存在应为 `./engine/<id>.mjs`（加载器不读 `name`）。以实际组合加载和 `verify:pack` 的包内引擎执行验证可用性。
2. **入口**：导出 `apply` 函数；缺 `apply` 在装配准备期抛错（`agent-assembly.ts:204`）。
3. **依赖**：`inject` 缺省或为字符串数组；数组元素是宿主服务名（`tools`、`systemPrompt`、`llm`、`skills` 等）。
4. **配置**：`configContract.parse(raw, plugin)` 缺省或为函数；装配准备期会调用一次做 fail-fast（`agent-assembly.ts:213-214`），引擎在 `apply` 内可以再解析以取得规范化配置——当前两边都保留，**这是有意为之的 fail-fast ＋ normalize 两段**，不是遗漏。
5. **清理**：`apply` 返回函数时，装配 fiber 把它作为 disposer 收走（`agent-assembly.ts:507-508`）；不返回则依赖注册时自带的 effect。

**不做通用能力注册表**：引擎之间按名调用目前只有发现引擎一个真实消费者（`promptToolDiscovery`，见 `discovery.mjs`）。等到出现第二个按能力解析的消费者（例如技能面成为可见面的发现来源），再按两个真实用例定接口；在此之前，新增引擎照抄 `discovery.mjs` 的「服务名 + 注册表 + 按 agent 键控」形状，而不是先建注册表。

**触发式债务**：`apply` 内二次解析配置与加载器准备期解析并存（如上）；发现适配器的宿主挂载与行挂载不对称（宿主挂载的 `skill-search` 不登记 adapter，今天无消费者）。两者都等具体触发条件再动，不在本轮顺手改。

### 默认身份接管

普通 `persona` 动作可选 `stripDefaultIdentity: preset | harness`，条件、受众、规则与模块启停沿既有运行时。`preset` 只移除已解析 `deployment:persona-prefix` 开头准确的 `You are a coding agent powered by the {{model}} model.`，后接空白或结尾；`harness` 只移除 `harness:identity` 的准确全文 `You are an AI agent powered by DeepSeek Harness.`。自定义 persona 前缀不参与默认身份接管，其余字节保持。

变换在公开装配适配器的最终结算出口进行，同次装配使用已接受候选；不重读 provider、不遮蔽身份声明、不修改已有历史。目标不匹配原样保留。预检不产生成功观测；真实装配沿既有规则诊断账本按动作与真实 Agent 记录目标结果及已保存版本，独立于条件缺事实计数。成功发布替换或释放来源时清除其身份观测，内容哈希启停回环也须重新观测；普通条件计数保留。规则卡只接纳当前目标、已保存版本且无正文草稿的观测，未选分支不抵消有效成功，同目标其他有效动作或 Agent 的真实失败不被成功掩盖。关闭或释放后自然回到仍存活的声明，不复活已释放 owner。

## 复制协议（跨项目复用）

普通 `assembly.target.sections.replace: [{ name, text }]` 只原位替换实际装配中已存在且正文非空的具名段，保留 order、complete 等官方元数据；目标缺失或正文为空时不补段。计划模式可据此编辑 `plan:policy` 全文，真实开关、日志、审批和退出工具仍归官方 planMode，不按工具是否可见猜测计划状态。

`sections.replace` 与 `contexts.replace` 均可声明 `{ name, match, text }`：`match` 是非空字面量，只替换唯一具名条目内唯一出现的原文，保留其他正文和元数据；缺失或歧义时透传并告警，不接受正则或代码。省略 `match` 沿用非空条目全文替换；`contexts.clear` 不与替换并存。官方审批与沙箱说明属于运行上下文，计划说明属于系统段，不能混用两种目标。上下文替换复用已接受工具步骤的配置快照；官方 `refreshContext` 仍调用原 provider，再应用该步骤已接受的替句，热更新、条件变化和关闭只影响后续步骤，不重算旧步骤条件或改写其他 Agent。

核心破限模块提供独立可开关的审批关闭、审批询问、沙箱只读、中性沙箱和计划说明规则，普通审批关闭说明默认开启，互斥的旁路说明默认关闭，其余说明规则默认开启。两种审批关闭文案复用模块内显式互斥，防止同句不同文本按顺序选赢家。它们只配置模型看到的说明，审批结果、沙箱权限和真实计划状态仍由原所有者决定；文字中的自动放行措辞不构成执行授权。沙箱中性说明只替精确品牌句，动态工作区、附加可写根与临时目录说明保持。未知或已定制原文不靠关键词改写。

普通 `subagent-params` 动作声明 `provider: spawn`、明确的 `tool` 和非负安全整数 `maxDepth`（0 禁止委派）。装配沿当前 Agent 的真实工具集合和 provider.depthLimit 接受参数，存于原 toolStep；同目标同时有效的同值贡献共存，静态异值候选拒绝并保旧，正常重判产生的动态异值冲突暂停该目标贡献并显示原因。缺工具、提供者或能力只暂停此动作所在分支及后代的显式关联正文，无关规则继续；恢复后下一正常步骤重新判断，不重放已有动作。

执行适配复用官方 `tools/execute` waterfall 的真实调用上下文，调用期只代理 `subagents.startActivation`：工具名、spawn、真实 parent 和 sealed step 全部匹配才替换原请求的 maxDepth，其余调用透传。官方 0.2.2-rc.2 使用顶层 `spec.parent` 与 `spec.maxDepth`；适配按该契约核对真实 parent 并替换顶层深度，不兼容旧的嵌套请求形状。深度上下文与 refreshContext 使用同一已接受值；已有工具集合不读热更值，取消仍沿原管线，dispose 关闭步骤。没有第二套深度配置库，也不修改宿主默认深度或 provider。

内置 `unrestricted` 的模块仍默认关闭，八条规则默认开启，各条可独立编辑或关闭。完整默认正文与 Boost 走 `assets/` 资产（`templateFile`），只作 `system-section` 投递：用户覆盖优先、包内缺失才回退、显式空正文不回退也不补正文；两份正文各自只注册一段，不删官方工具、环境或其他来源贡献。跨模块先后由 `configOrder` 决定——正文 100、Boost 200，协议规则须显式占用 100–200 之间的序号，否则会落到正文之前或 Boost 之后。人设和计划正文随普通 module.yml 保存；65536 是可编辑预算初值，仍须原 early 接缝；显式 spawn 深度初值为 1，子代理工具面沿 scope 条件排除 subagent_fork/workflow/ralph，不注册子预设。搜索工具面启用时使用已有 web_fetch 的 deny；需要抓取时用户先关闭该限制，再按实际已安装能力另行配置。模块不隐式启用核心破限规则，不补装官方工具、计划或压缩 owner；现有预设的外围参数继续由其原所有者控制。

内置 `redteam`（红队模式内容）同样是默认关闭的普通模块，十三条规则均默认开启。独立指挥正文、官方指令字节预算、首轮请求额度、晋升后指令提示、spawn深度、子代理叶子工具面、外部平台说明与六角色内容可分别编辑。8192 是请求输出token初值，2 是可编辑晋升兜底步数，65536 是独立的指令字节预算；三者不混用。平台正文显式依赖当前十二个实际可执行的 redteam_* 工具，缺失只暂停此段；普通指挥正文继续。

六角色（plan／recon／assess／vuln-scan／exploit／internal）与六公共段（ENV／BIND／SCORE_RULES／DB_LOOKUP／EVIDENCE／HANDOFF）沿同一套资产与规则机制组合：角色正文在 `assets/roles/`，每个公共段在 `assets/common/` 只有一份文件，六条角色规则按声明序用 `templateFile` 引用它们，声明序即投递序，每段只投递一次。plan 组合 ENV→BIND 且只作用于主会话，其余角色的组合分别是 BIND→DB_LOOKUP→EVIDENCE→HANDOFF（recon／assess）与 BIND→SCORE_RULES→DB_LOOKUP→EVIDENCE→HANDOFF（vuln-scan／exploit／internal），并只作用于子代理。修改公共段只改那一份文件，引用它的角色预览与应用同步变化，未引用的角色保持；角色正文独立编辑，保存、复制与导出保留相对 `templateFile` 引用，不把公共段展开成多份副本。模块变量 `role` 为空表示未分配执行角色，此时六份组合都不投递；同一角色只生成一份，不默认叠加六份。真实子代理的角色身份绑定由团队派工另接，本模块不按 name／description 猜测角色，也不声称已启动子代理。score-rules／db-lookup／evidence 三段的动作带 `tool: redteam_preflight` 分支条件，缺工具只暂停这三段可执行说明，角色正文、BIND、HANDOFF 与完整资产仍可查看／导出；不虚构数据库、计分或工具成功。模块不创建这些工具、SQLite平台、计分、面板或自动角色注入，不通过工具同名推断这些额外能力；具体工具schema、并发限制及目标绑定仍归外部提供者。角色职责直接写进普通任务正文，不声明 redteamRole 标签自动生效。

普通 `request-params.maxTokens` 是正安全整数的瞬时额度贡献，不能与本动作的 `patch/unset.maxTokens` 或 `replace:true` 混用。原 `patch/unset` 的有序组合语义保持。当前真实Agent和请求目标上有效的显式额度同值共存、异值拒绝完整候选并保旧；运行事实翻转形成冲突时，全部冲突额度及其分支后代正文暂停，后续正常重判恢复。只有实际参与同一额度目标的正向phase条件才比较 `maxPromoteSteps`，不同值同样冲突；独立phase追踪器不建立全局互斥。

瞬时额度沿同一 `/early` 入口接入官方 `@deepseek-ai/dsh-agent-loop@0.2.2-rc.2`，入口SHA-256为 `a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1`。包版本、完整指纹与三处唯一锚点必须全部匹配，且目标须在早期入口之后求值。普通入口、已缓存原始实例或指纹失配时只暂停该额度及同分支后代正文，诊断给出原因；不暂停其它规则。官方prepared配置、request/header和实际provider请求使用同一真实额度，不伪造prepared配置。官方loop自身持有上次瞬时覆盖的原值凭据，下一步seed只在其值仍归本贡献时恢复并消费凭据；后续第三方不同值保持，旧patch仍按原行为持久组合。关闭规则、移除模块或直接卸载插件后，恢复不依赖残留监听，不改写已有历史。代码与early入口变更需要用户重启DSH服务，不自动重启。

`phase.promoteAfterFirstTool:true` 显式允许首步已实际调用工具后晋升，默认false，原锚点/首响应语义保持；`maxPromoteSteps` 必须是正安全整数。phase在主/子会话分别计数，只有成功压缩开启新Epoch，失败压缩不重置；这与参考脚本对任意compaction/end重置的行为不同。`pre-step-filter.instructionHint` 为非空可编辑模板，使用 `{{FILES}}` 填入本次可靠识别的官方指令路径。它复用既有指令提示转换，仅在规则命中时把后续官方全文替换为一次提示；已有可见提示时不再重复，无法识别路径和非目标来源保持，撤回后放行后续全文，不补发历史。

显式工具依赖可用 `if: { tool: { name: target_tool } }` 组合原条件树；读取当前真实Agent的原toolStep及官方executable执行集合，不按目录/schema或普通变量判断。缺步骤、缺目标或显式delegate目标链不可执行均为UNAVAILABLE，not/else不能将缺失反转为命中；目标恢复后仅下一次正常集合重判，原次数/Epoch和用户关闭保持。delegate目标只附在当前工具定义的Symbol，不新增状态库；步骤view按官方原集合过滤缺目标/循环链，原工具次序和disposer保持。

内联customTools整组注册失败先撤本组成功项再抛原异常，由原Slot/lastGood处理，不发布半组。较近scope仍可遮蔽祖先，同层重名及run_code保留名由官方拒绝。delegate同名自委派在定义校验时拒绝，其他递归在执行嵌套身份超过32层时明确拒绝；不把当前遮蔽者假装成祖先原实现。HTTP合并caller signal与timeout；shell取消清理本次进程树并保留caller异常身份。

预算依赖沿唯一分支展开器携带的结构路径关联：预算所在分支的后代then/else均依赖它，兄弟分支和其他模块不受牵连；不按条件JSON或正文猜测。预算诊断只在完整计划已接受且真实装配结算后发布；条件miss、缺事实、异常和受众不符分别保留原判定，失败候选不覆盖旧有效观测。

官方指令预算是persona可选正安全整数 `instructionsMaxBytes`，按当前真实Agent的有效动作聚合，同值共存、异值拒绝完整候选并保旧；与prefix/complete同一计划预检。预算不新建指令owner，不复制正文，不改已有baseline/projection或历史。当前步预算附在原toolStep接受计划，modelSelection反查同一步；取消信号为turn级，不能充当step键。后台projection在compose入口读取本Agent已提交计划一次，不修改在途step。

可选包出口 `/early` 仅在目标求值前按包名、版本、完整SHA-256和唯一结构锚点进行内存接入。官方instructions compose局部resolved读取预算，其余读取/身份/投影仍由官方闭包负责。当前支持0.2.2-rc.2入口SHA-256 afbd526d1e3126a368774f24105140adc3ef532ca4aa93cfa0fb1318d5b9b75d；失配保持原行为。运行资格来自已验证接缝及实际scope链官方实例和fs/workingDirectory，依赖缺失只暂停同条件分支的预算动作与关联正文，else及无关规则保持；恢复后正常重判，不补发过去动作。关闭插件注销reader后内存接缝透传，卸载加载钩子不清ESM缓存。

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

## 规则条件与动作边界

规则含 `id/name/enabled/layer/group/exclusive/if/then/else`。动作有稳定 id 和 kind；then/else 与嵌套分支内的所有动作 id 在同一规则中唯一。读取投影可生成配置身份，编辑映射保留原始条件和载荷，不把编译默认值写回。

`if` 是单键谓词或 all/any/not/notAny 组合。必要事实缺失为 UNAVAILABLE，不会因 not 变成 true。`variable` 谓词写成 `{ key, op, value, scope }`：op ∈ eq/ne/in/gt/gte/lt/lte/present/absent（缺省 eq），scope ∈ effective/session/module/global/runtime（缺省 effective）；effective 按会话→模块→全局，显式 session 条件只看会话域。`in` 的 value 是非空字符串数组，其余比较 op 的 value 是字符串，`present`/`absent` 不收 value；普通键缺失或非数字比较为假；runtime 事实缺失、读取失败、变量关闭或适配器未绑定为 UNAVAILABLE。适配器按真实 Agent 与来源模块绑定，不能由普通变量伪造 runtime。规则级 else 要有同一规则的 if；事实未知时可能两支都不执行。分支节点不写 kind，不能把 if/then/else 塞进动作对象。

`manifest` 谓词写成 `{ ok: boolean }`，只读来源模块 `assets/manifest.yml` 的 `checks`。检查项失败为 false，清单缺失、损坏或不可读为 UNAVAILABLE。宿主装配取得读取器后，经挂载 options 绑定 `manifestCheck`；准备期不可用。独立 `engine/rule-engine.mjs#apply` 不接入该宿主读取器，因此该路径的 manifest 条件恒 UNAVAILABLE，包括 `not` 也不成立；嵌入调用方可以显式向 `mountRuleSources` 提供读取器。

规则读取器缓存检查结果 1000ms，通过、失败和不可用结果均不因命中续期。账本追加不会提前触发全量解析；到期后的首次求值重新检查。清单本身的 mtime/size 变化会提前失效，清单缺失立即不可用；同戳等长改写在到期时重读识别。显式 `module_manifest check` 始终实时检查，不写变量，也不刷新规则缓存，所以显式结果与自动提示可在剩余 TTL 内不同。首次和到期检查仍同步解析文件，这个缓存只限制重复检查频率。

受众事实由纯模块 `engine/audience.mjs#audienceOf`（条件树）与 `engine/rule-spec.mjs#actionAudiences`（编译后动作）派生：`scope.audience` 精确收窄（同节点带 `modelScope: pro|flash` 时不算精确），`all` 求交、`any` 保守、`not`/`notAny` 只对精确子节点取补，无法收窄的条件按两个受众处理。规则级 `else` 的动作自带 `not(if)`，不再叠加规则级 `if`。宿主装配只读这个结果，不自行遍历条件树。raw rule（编辑器/UI）的只读投影走 `engine/rule-facts.mjs#ruleFacts`：受众是 then/else/嵌套分支动作可能受众的并集，未知时按两个受众处理；空集由 client 展示层按未知处理（见 `docs/ui-architecture.md` 的 `rule-facts.ts`）；它同时回答是否包含 context activation。`ruleFacts` 是展示上界，不参与执行门控。

| 动作 | 执行点与边界 |
|---|---|
| persona | 原官方 assemble 前准备并聚合身份；audience 可限定 main/subagent，省略覆盖两类，支持动态条件 |
| inject-text | config.layer 指定六个可注入层；agent-request、llm-stream、tool-pipeline 只作动作展示归属 |
| assembly | system-prompt/assemble 的系统段 / 运行上下文投影（工具面不再由它承担） |
| tool-visibility | system-prompt/assemble 下游：一份名单拥有工具目录、SDK 正文、执行闸与发现来源；受众使用 scope 条件 |
| request-params | agent/request；patch/unset 按官方 LlmCallConfig 校验 |
| stream-output | llm/stream；pass 透传或 replace 替换为 text，不修改请求 |
| request-retry | llm/stream；有界拒绝前缀判定，命中后按配置正文至多真实重放一次 |
| tool-gate | tools/pre-execute 的裁决：allow / deny / ask |
| tool-result | tools/post-execute 的 accept / replace / block；edit-text 在真实结果内容出口编辑已验证片段 |
| append-context | tools/post-execute 后追加上下文；续跑统一用 inject-text 的 turn-stop 层 |
| pre-step-filter | 前置消息来源/插件过滤 |
| inbox-prepend | inbox 通知补充上下文 |

普通 `request-retry` 动作是默认关闭的有界拒绝重试：在 `llm/stream` 下游调用前缓冲开头约 400 个文本字符后判定，匹配范围最多前 600 个字符，遇到推理增量、工具调用或 `finish` 提前决定；块级正文与 `text-delta` 用同一份累积，同一 `index` 已有增量时不再并入块正文。命中后只透传首尝试已到手的 `usage`、结束上游，再以「原 `messages` 末尾追加一条 `user` 正文」发起一次真实 `llm.stream`；不改原 `messages` 元素、不写 durable 历史、不新增用户轮、不改 provider/model/工具目录/取消身份，输出块与 `replayState` 归第二次尝试。一次原始请求最多两次实际调用：首请求与重放请求的 `options` 都进同一 claim 集合，多来源命中共享一次额度，同值共存、异值告警并保留先到装配；第二次不再进入本能力，其自身失败直接冒泡，不叠加本来源的重试。正文优先取 `templateFile`（与 `inject-text` 同一模板解析与越界校验），缺模板时用 `text`；空正文挂载期拒绝。`authored` 目的（`options.purpose`）与已取消请求不重放。用量只沿官方出口，未取得时不补零；命中的首尝试 `finish` 走透传分支，不会与第二次混合。

`assembly` 的 `target.sections.append` 按段名在已有系统段正文后追加一次渲染文本，保留原 `order`/`interpolate`，不设置 `complete`；同一装配内 `once` 去重，目标缺失只告警。追加文本走内置插值/动态宏（至少 `{{CWD}}`），模块持久变量不在该动作的插值域。旧 `workspaceLine` 可用「`phase` 条件 + 追加 persona 段 + `\n当前工作目录：{{CWD}}`」表达；旧 `phase1FirstCallInstruction` 用受控相位条件 + 追加目标段名表达，二者都不恢复旧参数键。append 与同一受众的已知 `complete` 显式互斥：装配准备期拒绝，不依赖官方 assemble 在 waterfall 后静默还原。任意第三方 `complete` 不可由本插件观察，仍会被官方还原丢弃；这是明确边界。

正文策略为 static、placeholder、context-activation。placeholder 仅 pre-step/runtime-context，context-activation 仅 pre-step。分类由通用 text 条件和分支选择普通静态正文；text 的 minChars/maxChars 为含端点的非负安全整数，可单独按长度判断，关键词与长度同时声明时取交集，minChars 不得大于 maxChars。userMessage 使用本批全部真实用户文本，不包括插件正文。普通规则无隐式业务正文、锚词、两轮兜底或长度阈值；空文本保持空。确认属于 anchor 条件；旧专用策略及重复动作入口直接替换，无兼容层。工具名只写 names 条件，不再由 tool-gate/tool-result 的参数重复过滤。

### 字词句确认与动作关联

`anchor` 读取宿主内容投影后的当前可见、已结算消息。`subject` 可选 `userMessage`、`assistantReasoning`（缺省）、`assistantText`、`toolResult`；用户消息排除插件注入，推理与回答分别取块。它读取已接纳历史；要匹配本次 pre-step 批中的新用户文本，用 `text.subject: userMessage`。

缺省 `mode: prefix` 只使用 `keys` 作字面前缀匹配（ASCII 忽略大小写）；其它匹配选项在该模式下拒绝。`mode: scan` 复用既有匹配器的 `secondaryKeys`、`logic`、`caseSensitive`、`wholeWords`、`useRegex`、`wordBoundary`。未配置 `fallbackAfter` 持续等待；正整数 N 表示第 N 个含所选内容块的完整输出仍未命中时放行。缺少该内容块的输出、流式片段和中断的模型消息不计数。

```yaml
id: confirm-then-inject
enabled: false
layer: pre-step
then:
  - id: seed
    kind: inject-text
    config:
      strategy: static
      position: before-all
      dedupe: session
      text: 请在推理开头写“已确认”，再处理任务。
  - if:
      anchor:
        subject: assistantReasoning
        keys: [已确认]
        after: { action: seed }
    then:
      - id: body
        kind: inject-text
        config:
          strategy: static
          position: before-all
          dedupe: session
          text: 此处填写确认后要注入的正文。
```

`after.action` 只引用同一规则的稳定动作 id；规则复制或自动改名不需改内部引用。条件按事件 seq 只观察目标实际投递之后的输出，候选生成、入队或方法调用不算投递；目标未接纳或已不再可见时返回 UNAVAILABLE，不能经 not/else 提前放行。保存与编译拒绝缺引用、自引用、依赖环、同规则投递身份歧义，以及无法证明独立投递的 system-section 或 merged 目标；可引用 separate 模式的 pre-step、runtime-context、turn-stop 注入动作。

被引用的 runtime-context 名称必须在完整编译及挂载来源集合中唯一，避免命名快照混淆实际贡献；注册失败中止当次规则挂载尝试并释放已取得的注册。若错误明确属于单个模块，装配方可以清理后以该模块旧版本或排除该模块的新集合重试；跨来源身份冲突仍拒绝整份候选，不自动选择赢家。

关联与去重共用 `engine/delivery.mjs` 的身份及可见投递查询。当前会话的实际投递才是起点，fork 继承消息不能冒充新投递；压缩、裁剪或投影变化后重新判断，必要时重发锚句并重新确认。默认等待下一次正常请求；显式 turn-stop 注入可沿用有界续跑并设置 `dedupe: session`，取消或释放后不续跑。来源 `source.summary` 仍是用户声明的元数据，不自动生成确认或兜底说明；规则诊断沿用 hit/miss。

### 条件判定与事件载荷

同一调用帧的规则判定共享，跨执行点重新判定；after-next 动作先调用下游再判定。动作级条件要匹配本点实际事实，规则级条件则在各执行点独立按三值语义处理。

- pre-step 有本批真实用户文本；按任务给子代理分档应在这里使用 `scope.audience: subagent`。
- tools 通道有工具名、参数或结果；names/source/text 按动作的 channel 白名单校验。
- subagent/start/end 有 provider/id/local 等事件事实，不含任务正文；文本 subject 用 subagentInfo。
- llm/stream 自身无文本 subject；引擎可由 sessionId 查回 Agent，因此 phase/session/count/anchor 等依赖会话的条件可用，查不到为 UNAVAILABLE。
- system-section/runtime-context 的普通文本贡献支持规则级条件及嵌套 if/then/else，在每次 assembly 按该执行点事实求值，不动态重注册段。inject-text 的 complete/suppressRuntimeContext 属固定注册效果，动态 if 组合仍在编译期拒绝；persona 动作由 assemble 前准备阶段支持动态选项。

固定系统段可通过 `config.audience: main/subagent` 限定受众；complete 和 suppressRuntimeContext 都在该 Agent 注册前筛选，非目标受众不注册这些效果。省略受众覆盖主/子两类。独占检查按受众分别聚合：主/子各一条可以同模块或跨模块共存，同受众重叠（包括未限定受众的段）在发布前拒绝；官方人设 complete 也只与该 Agent 的规则比较。`assembly.sections.append` 与 complete 使用同一受众聚合：同受众存在已知 complete 时拒绝 append，append 不会改写 complete 段。

插件管理路径自动传递真实 Agent。独立代码调用 `mountRuleSources`、`applyPromptConfigSources`、`wireLayers` 或 `registerAction` 时，受众限定的固定系统段要求在目标 Agent scope 调用并传入 `options.agent`；共享 standing scope 的文件式入口无法确定受众，明确拒绝该组合。pre-step 来源由 `createPreStepSource` 构造，`applyPromptConfigSources(sources, options)` 从 `source.ctx` 取作用域，不再另收 ctx。普通正文与未限定受众的固定效果保持原注册方式，不能通过返回空正文解除独占或上下文抑制。

工具名单的 allow/deny 互斥。request-params 的 replace:true 必须同时给 provider 与 model。拒绝非法候选发生在保存和挂载前；运行失败按该动作的明确降级报告，不能据一次静态校验声称模型已收到内容。

## 提示词配置插入点与顺序

九层展示序来自 `LAYER_ORDER`；六层可注入清单来自 `getEngineMeta().injectionLayers`。agent-request、llm-stream、tool-pipeline 分别使用请求参数、流输出和工具动作，不能作为 inject-text 的 config.layer。规则顶层 layer 是动作未写 config.layer 时的缺省及展示归属。详细载荷见 [九层契约](injection-point-contracts.md)。

跨模块同点顺序来自 module.yml.configOrder；同点动作按声明顺序，显式 channelOrder 冲突拒绝。order 只管所属官方插入点的位置，不建立跨层总顺序。pre-step 中注入和过滤可以交错 flush，后批继续排在仍存活的同位置消息之后。

注册层的段/上下文顺序不靠官方 order 数值表达：官方先按 order 与名称排好初始槽位，本插件以最外层 prepend 监听 `system-prompt/assemble`，在 `next()` 之后按 `configOrder`（`sequence`）把已注册的段/上下文回填到原槽位；未注册的平台段与其他插件段槽位不动。`complete` 生效时平台在瀑布**之后**才用预捕获的段替换 `sections`，重排器在瀑布内执行、最终输出仍由平台覆盖，该场景不保证顺序。跨档位拖动只改 `configOrder`，不改官方 `order`。

### 同 scope 内的注册顺序（2026-09-22）

Cordis waterfall 普通注册先注册者在外；prepend 注册插到最外层，同为 prepend 时后注册者更外。非注入动作通过 `waterfallPosition: outermost` 表达该要求，同点仍按编译顺序接线。inject-text 的位置属于官方插入层，不接受这个注册后门。

### Agent 级能力声明的公共原语（2026-10-22）

`engine/agent-capability.mjs` 收三件事：受众判定（`capabilityAudience`，与 `isDelegated` 同一判据）、Agent scope 的声明表（`createAgentCapability`：session → {scope, key, disposers, data}）、以及 key/scope 变化时先挂新声明、成功后再撤旧的。`mount` 返回 `undefined` 表示依赖未就绪：保留上一轮声明、下次装配重试——旧闸比无闸安全。`scope.effect` 负责 Agent 释放时摘除自己。执行器冲突检测与晚到服务等待由 `present-as` 及官方执行器处理，原语不引入模式开关。`present-as` 只复用受众判定；`tool-visibility` 复用声明表，在 mount 返回值中保存 guard disposer、无集合调用的 failOpen 状态与解锁快照；有集合调用只读步骤准入。装配层与注册层的受众判定仍用既有 `isDelegated`，本轮没有统一。

## 历史读取与去重

| 入口 | 语义 | 主要消费者 |
|---|---|---|
| `currentEvents(session)` | 模型当前可见 surface | 注入去重、上下文历史扫描、anchor、session.present、最后对话事实 |
| `historyEvents(session)` | 完整 durable 日志 | 晋升重建、模板执行边界、工具解锁、tool-call/turn 计数 |

surface 缺失或非法时可见视图退回完整日志；合法空 nodes 就是空上下文。需要消息数量的消费者按 seq/id 去重，不给所有读取强加同一过滤。count 的消息类信号看可见面，tool-call/turn 看完整日志。取舍见 [ADR-0010](adr/0010-two-history-views.md)。

`dedupe: session` 表示“该身份在当前可见上下文只出现一次”，不是持久历史终身一次。成功压缩或替换遮蔽旧消息后可再次注入；条件未命中或未被接纳不占去重。身份包括来源模块、通道和 identity；旧无模块维的已投递消息保守识别。memo 仅加速，不成为另一份投递真值。

## 晋升语义（epoch-aware）

会话开始及每次成功压缩开启新 epoch。压缩失败不换 epoch；重挂、重启或恢复从 durable 边界重建。tool-call/assistant-message 按显式 promoteOn 推进；子代理参与、推理门和最大步数须由配置选择。PTC 是工具呈现，晋升是状态转移，两者正交。

## 上下文激活与诊断

`selectContextActivation` 在批首对已合格配置求值，候选集合跨所有 flush 共用；过滤掉赢家不另选同组后补。选择分为 candidate/selected 与实际注入后的 commit，未投递不提交时间窗。状态包含概率、候选组、评分、sticky/cooldown/delay 和有界递归；算法与 ST 转换使用同一原生入口。

扫描面必须显式 batch/history，关键词和 scanVariables 通过来源模块两域快照只读求值；赋值表达式拒绝。激活变量读取不获得任意目录或写权限。参数及独立真值表见 [激活映射](SillyTavern.md#世界书到上下文激活)。

`lastContextActivationDiagnostics(session)` 只返回最近一次快照，不重新扫描或抽样。快照区分尚未求值与已求值但为空；记录最多200条，truncated 只限制展示，不改变选择。commit 与快照引用同源，工作台显示实际投递事实。诊断不是永久审计记录，也不证明不可见的第三方行为。

## pre-step 协调器与官方指令过滤

宿主 `src/runtime/pre-step-coordinator.ts` 汇总模块规则与直接来源，在**一个** `prepend` 监听器里显式先过滤官方待注入指令、再执行规则批；顺序是代码事实，不依赖监听器注册先后。来源白名单过滤器使用真实已领取 payload，不将下游增量当原始消息。官方监听器（如 `dsh-tool-skill` 的技能目录）在 `await next()` 之后才 append messages，协调器拿到完整 decision 后先删再跑批；同一 pre-step 中 `instruction-policy` 的动作判定在过滤前固定，并把命中结果带入批执行，避免过滤、导语与批处理跨快照漂移；batch 异常时仍返回已过滤的 decision。协调器自身仍是 `prepend` 监听器，只有这样才能看到官方监听器在 `await next()` 之后追加的消息；「不依赖注册先后」只指 filter 与 batch 的相对顺序。

无协调器的 standalone 路径（`applyPromptConfigSources` 单独执行批）是例外：`prepend` 只由 `options.prepend` 与配置的 `prepend` 决定，纯 `ruleAction` 的 `pre-step-filter` 拿不到最外层，`skill-surface` 在那种部署里可能删不掉官方目录。出现第二个无协调器消费者时，把「需要最外层」上收到动作语义再统一，而不是给判据加更多特例。

协调器服务 v2 持有唯一的 promotion pool/pair，并把它暴露给来源生产者；`registerPreset(sourceId, source)` 消费 source 自带的 ctx/onOutcome/promotion，不再改写 `config.resolve`，也不再从 config 反推模块。批执行由 `runPreStepBatch({ sources })` 合并来源，判定上报使用对象形状；pre-step 来源的 `source.ctx` 绑定 `resolve`，条件帧使用批级 ctx。

逐文件关闭只过滤能够可靠识别的未来官方正文和 change 元数据；无法识别或无法分段时保留并报告。不撤回历史、不补回官方预算裁掉的内容，不以文件卡开关阻止官方磁盘读取。重新开启也不强制重放。

普通规则可声明 `instruction-policy` 动作并给出现有 `fileIds`，只为当前真实 Agent 增加局部关闭贡献。该动作不写共享 `instructions.yml`、不复制正文；多个规则按文件叠加，撤回一条仍保留其它关闭贡献，全部撤回后按最新共享值放行。无可靠 Agent、身份或分段时沿放行诊断，不把规则状态扩成全局开关。

`instructionHint` 默认关闭，只有显式有效 messageTemplate 才将过滤后的正文转成提示；空模板保持原文。正文编辑和文件授权属于独立 owner，见 [指令文件契约](architecture-params.md#指令文件与逐文件过滤策略)。

## 文件读取上限

普通 `host-control` 动作的首个能力是 `capability: file-read-limits`。`value` 至少声明 `maxLineLength`、`maxBytes`、`limit` 中一项，已声明值须为正安全整数；分别表示UTF-16代码单元计数的每行长度、包含行间换行和截断后缀的UTF-8输出字节、默认及最大读取行数。内置规则默认开启，10000/1048576/20000仅为可编辑初值；未声明字段及 `readStreamMinSize` 保持原owner配置。

额度沿普通条件、受众、完整候选及数字草稿/CAS链进入当前Agent的工具步骤。同Agent同字段同值共存，不同字段组合；异值候选拒绝，动态冲突拒绝新步骤，已接受步骤保留快照。调用在首个await之前固定额度，原官方read继续拥有路径、文件读取、流式路由、解码、资源校验、输出及观测；render采用同调用快照，不重挂或复制官方服务。

部署期公开Config捕获在官方闭包，按Agent热改通过既有 `/early` 出口的最窄内存接缝实现。仅核验 `@deepseek-ai/dsh-tool-fs@0.2.2-rc.2`，完整入口SHA-256为 `0e866969b6bf1aa93407ccd9c944b50bc27a1d961b7e4209ed60bd2b73d28805`；指纹及owner登记、定义标记、执行、渲染四处唯一锚点整组匹配才生效。缺early、已缓存、目标失配或真实owner/依赖不可用时三项一起透传，显式关联正文暂停，无关规则继续。依赖恢复后正常重判恢复，暂停期间关闭不会重开，也不重放读取；需启动期接入时只提示用户正常重启。

模型参数说明只定点更新已验证owner的原生默认行数句，保留其他贡献，再沿通用工具说明投影生成目录。关闭后新步骤恢复原owner配置，在途调用和已接受旧步骤保持原值。官方磁盘文件不变；桌面与其他发行物仍须各自验收。

## 工具结果与Web功能段

普通 `tool-result` 动作的 `action: edit-text` 使用 `edits: [{ region, match, text }]`；`region` 只接受 `web-notice` 或 `sandbox`，`match` 为非空精确字面量，`text` 允许空串。它只编辑已验证官方owner生成的结果说明，不重新执行renderer，不改程序输出、原值、错误身份、isError、meta或准入决定。Web包装须完整匹配其说明段，正文同词不参与替换；沙箱说明从真实结果事实与原渲染回执定位，缺失、歧义或owner引用被替换时保留原内容并报告不可用。

原 `execute` 引用不变，原render/projectContent/finalizeContent保留this、参数和异常。project阶段只记录同一次执行的结果与已接受计划；其它post策略全部结算后，才在final出口求条件、消费次数并编辑。原finalize返回内容，或post接管内容、值、错误、meta、isError时，结果编辑让位。同一执行内条件共用判定帧；模型取已接受步骤冻结的modelSelection，变量与次数仍在最终出口读取和结算。关闭、更新或释放来源不改在途计划，也不重新执行工具；保留模型事实不复活已关闭步骤的调用权限。

`web-notice` 支持已标记的官方Web结果；`sandbox` 支持已标记的bash、pwsh、FS、str_replace_editor及PTC结果。启动期须通过包的 `/early` 出口，在目标工具包首次加载前接入；当前仅支持 `0.2.2-rc.2` 的固定发行产物，完整指纹和唯一结构锚点在 `result-text-early.mjs` 与 `fs-tool-early.mjs` 核验。FS读取额度与结果标记由同一加载owner组合，各组分别校验必要锚点，共同产物指纹失配则都透传。不改官方磁盘文件。普通加载不能补标已缓存工具，同名自定义工具也不当作真实owner；缺early、版本/指纹失配或必要slot被接管时保持原行为。

同规则结构分支中显式关联的装配正文，在实际装配toolSet缺少所需真实结果owner时局部暂停；无关规则继续。结果条件仍在结果出口求值，不在装配期提前消费；条件或受众未命中不误报依赖不可用。依赖恢复后按正常后续装配重判，暂停期间关闭的规则不重开、不重放旧调用。运行观测沿 `tool:results` 报告，保存配置不代表能力已就绪。

内置limit-breaker的Web引用包装、Web身份、Web功能、沙箱结果、交付物引用与PTC沙箱说明六条规则均默认开启。Web身份与功能使用显式原文字面候选及channelOrder 10/20处理重叠；候选缺失或歧义保持原段，重复应用不重复改写。交付物规则只删除指定禁止句，保留路径引用说明。身份、功能与交付物装配动作不依赖early；Web引用正文与结果包装同分支，受上述结果owner依赖约束。CLI没有目标Web段时保持原文。文案转换不改变实际权限，不注册或调用交付工具。真实CLI/Web与桌面组合验收另行统一执行，不能用确定性回归代替。

## 工具与参数说明

普通 `assembly` 动作可声明 `target.toolDescriptions: [{ name, parameter?, match, text }]`。`name` 为实际工具名称；省略 `parameter` 只修改工具说明，填写时只修改该顶层参数的 `description`。`match` 必须为非空精确字面量，`text` 为字符串且允许空串删除目标句。不接受正则、执行代码、任意schema路径或约束字段；同一说明内原文必须恰好出现一次，缺目标、缺参数、缺句子或重复匹配保持原文并沿规则诊断报告具体原因。已知网络/镜像条目带完整行前缀，未知混合正文不按关键词清空。

该说明投影复用原真实Agent的 `resolve → prepareAssembly → assemble` 步骤，先固定条件和说明配置，再由官方native/PTC生成目录及SDK。它不重注册工具、不替换执行函数，不改变schema类型、必填、值域、输出或实际审批/沙箱/网络权限；发现候选和原registry保持。热更新、关闭与条件失配只作用后续步骤；旧步骤保留已接受说明，原集合移除/释放仍为上限。裸装配缺少真实步骤时只诊断并透传，不伪造工具集合。

核心模块中的终端拒绝、文件升级、删除移动、网络和镜像五类说明分别默认开启，通过普通工具条件和精确说明配置应用于任何提供对应工具的预设。当前字面量对齐官方0.2.2-rc.2的bash/pwsh/fs实际目录；来源旧升级长句已演进为 `sandboxPermissionsDescription`，只适配当前实测句式，未知变体保留并诊断。文案中的自动放行不改变真实准入；真实操作拒绝与原错误仍由官方owner处理。

PTC的 `run_code` 是官方执行器生成的保留传输，不在原registry目录中；同一 `toolDescriptions` 配置在最终模型schema出口投影其说明，保留参数约束、执行器、原结果及真实批准管线，不注册或遮蔽该名称。普通工具继续使用原步骤视图投影；缺传输或句式不匹配原样保留并诊断。

`assembly.target.skillDescriptions: [{ name, match, text }]` 按真实技能名与非空精确字面量修改模型可见摘要，允许空替文，不接受参数路径。配置随已接受步骤固定，仅在对应真实Agent的模型预步与工具调用中投影 `skills.snapshot/get/list`；管理查询、无身份、跨Agent或无封存步骤的调用原样透传。原技能名、provider、资源、正文和调用能力不变，原registry不被修改。缺服务、缺目标和匹配歧义保留原文并诊断，正常重判可恢复；关闭只作用后续步骤。

`skill-catalog` 首次渲染使用同一步骤已验证的技能说明：全部来源完成 `prepareAssembly` 后、官方 `assemble` 开始前结算目标，原填充器读取原始目录并按当前真实 Agent 的步骤投影一次，不重复渲染模板。provider 过滤、字段、截断和空结果语义沿用原填充器；无已验证步骤、身份不符、步骤关闭或取消时不投影，不开放 pending 步骤的通用服务读取。等待结算后再次检查取消与安装存活，装配失败及释放仍关闭步骤。

说明规则沿现有卡片显示与保存版本匹配的实际观测，正文草稿或旧版本观测不显示假成功。核心模块的子代理范围、PTC升级和技能徽章说明各自默认开启；子代理范围使用既有 `subagent:delegation` 上下文与subagent受众，不改任务或范围守卫。PTC说明中的自动批准文字不改变实际审批决定；结果render不是说明元数据，也不在此投影中修改。

## 工具面收窄与按需解锁

`tool-visibility` 是工具面的唯一声明：一份 allow/deny 名单同时投影到装配目录、`tools:sdk` 正文与执行闸，并可声明发现来源。受众统一写在规则或分支的 scope 条件。宿主与独立规则入口共用 root 上的一份公开服务适配器：先等待来源准备，再调用原 `tools.resolve`；原 `systemPrompt.assemble` 完整返回后依次结算所有来源的工具面动作，最后封存步骤。allow 与 deny 都不注册额外 `restrict`，避免继承工具与本层工具口径不同，也不破坏发现候选。

包装的 `ResolvedToolSet` 只暴露 `view` 与 `dispose`；每次 view 先委托原集合，官方 scope、when、替换与移除始终是上限。状态为 pending / sealed / closed，pending 的透明 view 只供装配读取，执行入口与 guard 拒绝 pending 和 closed。原集合与包装集合按同一 Agent 关联同一步骤；native、PTC 和 delegate 都传递该集合，执行只读封存名单。失败、取消与最后一个 owner 释放都会关闭集合，原资源仅释放一次；重试复用封存装配，不重算规则或放宽准入。

步骤 guard 每个 root 只安装一份，由 root 的注入生命周期持有，只查询弱引用步骤关联。最后一个装配 owner 释放会撤销服务适配并关闭集合；仍持有原服务和原/包装集合的调用继续被拒绝，包括不读取集合 view 的 PTC `run_code` 保留入口。重挂复用该 guard，新集合正常装配封存后恢复执行；root 释放时 guard 一并撤销。

三面共用 `engine/actions/shared.mjs#toolSurfacePlan`：`required` 只取静态 allow 再剔除 `run_code` 与 deny 覆盖的名字，解锁名不参与。步骤的 `available` 来自官方集合的当前 view，多个动作依序取交集；裸装配只以目录与 SDK 的并集判断展示。`requireMatch` 只对白名单有意义：静态常驻名一个都不在时仅放宽插件 allow，deny 与官方准入继续生效；只缺一部分照常收窄并留一条诊断。官方工具被替换插件取代时，把实际替换名登记进 allow；未安装的替换名不被宣告，也不会单独触发放宽。无集合的程序调用保留独立保守 guard，不冒充模型步骤。

适配覆盖官方调用路径和安装后取得的服务代理引用；Cordis `internal/get` 不保证拦截任意 `ctx.get` 或安装前缓存的原服务。外部持有原服务时应显式传已包装集合，原服务执行仍受已有 guard 约束；未传集合不自动猜出步骤。直接/裸装配不自动 resolve、不猜模型或 signal，传入未知集合时明确拒绝。

PTC 下装配目录只有保留传输 `run_code`，实际工具声明位于 `tools:sdk` 正文。`run_code` 不参与 allow/deny 名单：allow 不点名也保留，`requireMatch` 不计它，deny 不得声明它。SDK 正文裁剪与实际程序绑定读取同一封存准入；SDK 文本不能反过来授予工具权限。可见面裁到空时保留传输仍存在，因此 native 收窄声明可以直接与 PTC 共存。

按需发现由同一份声明的 `discovery` 字段拥有（`{ kind }`，工具名与解锁键由适配器元数据提供；可选写 `tool`/`key` 只作断言）：动作在首次装配时用 `ctx.get('promptToolDiscovery')` 按 agent 解析适配器，从本会话 durable `tool/call` 与 PTC 嵌套 `tool/ptc-dispatch` 参数提取显式字符串名单，只做加法且不能越过 deny。两类事件名由 `engine/history.mjs` 的 `TOOL_INVOCATION_EVENT_TYPES` 统一；观察工具执行时读两类，观察模型动作/相位晋升仍只看顶层 `tool/call`。工具本身由适配器行注册——声明了 `discovery` 的模块必须把对应行（`tools` → `tool-search`、`skills` → `skill-search`）列进 `modules`，缺行在装配准备期失败。工具名按真实注册名称匹配；坏参数逐条忽略，缺会话回落静态 allow；适配器未注册时告警一次并跳过解锁回收，不阻断装配。

首轮提示用同模板普通 inject-text 动作组合 count 条件与 session 去重；strategy: placeholder、fill: tool-catalog、params.action 引用同规则 tool-visibility 动作。只读变量 RESIDENT_TOOLS 取引用声明的静态 allow 去 deny，再按所有工具面动作结算后的最终准入过滤；另一动作的 deny 也会移除该名字。runtime-context 的目录 resolver 延迟到全部来源结算后回填，普通带副作用模板不重复求值；pre-step 位于 resolve → assemble 之后，按原 `modelSelection` 对象与 Agent 的唯一关联读取 sealed 步骤。关联歧义、pending 或 closed 时跳过目录指引，不按模型字符串或 Agent 最新一步猜测。裸装配按最终目录与 SDK 展示信息回填；没有步骤且观测不到工具面时才保留声明名单回退。DISCOVERY_TOOL 来自当前 Agent 的发现适配器工具名。

发现搜索仍通过 `toolScopeSnapshot(tools, agent).visible` 读取原注册候选，包含尚未解锁的工具，不改读封存集合。解锁只影响下一次 resolve/assemble，新集合准入不能反写旧集合或其重试，deny 始终优先。此方案取代 [ADR-0012](adr/0012-progressive-disclosure-restrict.md) 的 restrict 与「当场刷新」历史方向；ADR 保留当时理由，当前采用步骤封存与下一请求生效。

tool-catalog 使用普通只读变量插值；`templateEvaluation: true` 在编译时拒绝，避免目录事实被持久变量求值覆盖。被引用动作须声明 allow，未知引用或错误动作种类拒绝；发现适配器不可用时跳过提示并告警。

内置 tool-surface 的规则打开即收窄；`modules` 同时列 `tool-search` 行，工具由该行注册、元数据由发现注册表按 agent 解析，常驻集来自同一声明。普通提示动作在可见用户消息数不超过一条时自动列出**当前可见**的常驻工具并提示发现解锁，按当前上下文去重；观测不到工具面时回落声明名单，观测到工具面但一个常驻名都不在时跳过提示，因此部署层登记的替换名若未安装就不会被宣告。需要晋升门时显式加规则条件；不由引擎偷偷恢复首轮全工具目录。

## 工具呈现（present-as）

`present-as` 行在真实 **Agent scope** 挂载官方 `@deepseek-ai/dsh-tool-executor-native` 或 `@deepseek-ai/dsh-tool-executor-ptc`，等待异步导入与插件初始化完成。`mode: ptc` 只声明保留的 `run_code` 传输与生成的 SDK 段，其余可见能力走程序内绑定；`native` 直接声明与执行当前可用工具。同一 scope 的执行器冲突由官方拒绝。未启用该能力的 Agent 继续由宿主提供执行器，插件不接管部署默认。

`ptc` 需要 `ctx.ptcRuntime`：本行用 `ctx.inject(['ptcRuntime'], ...)` 等它就绪后挂执行器，等不到时先 warn 一次并保持等待，迟到到达再记一次 info。`native` 不依赖 PTC 运行时。执行器与等待的生命周期归挂载 scope；来源替换、Agent 结束或插件释放后，迟到初始化不能恢复旧贡献。

执行器卸载、模块禁用或 PTC 运行时撤回后，新批次以 `TOOL_EXECUTOR_UNAVAILABLE` 明确失败，不自动回退祖先执行器或 native；已接受批次按原执行器排空。显式重挂有效执行器后恢复，新会话也需要有效执行器。装配刷新可为各 Agent 重挂独立贡献，压缩不改变受众。

`mode` 是必填默认；可选 `mainMode` / `subagentMode` 分别覆盖主会话和子代理，省略继承 `mode`。配装通过引擎 `apply(ctx, config, { agent })` 传入真实 Agent，`present-as` 复用 `capabilityAudience` 选择模式，不从 Context 或页面状态猜测身份，也不修改共享配置。随包内置模块 `ptc-mode` 默认不启用，只声明本能力，无需另加规则：官方执行器提供 PTC 调用指引和生成的 SDK 段。

程序当前工作目录使用官方 `process.cwd()`，shell 操作使用当前工具面提供的 `tools.bash(...)` / `tools.pwsh(...)`。默认 Node/per-call 程序的 `process.env` 初始为空，OS 仍保留启动所需环境；宿主嵌套 shell 独立收集安全环境，与程序环境不在同一层。持久运行形式的环境也不能称为恒空，官方不提供等价 `env` 对象。独立 `env-facts` 仍可按白名单注入环境事实；升级时用户副本与旧程序的调整见 [CHANGELOG](../CHANGELOG.md)。

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

`maintenanceCompression` 默认false；开启时在同一上下文运行时做 idle 局部压缩。null表示无操作并停止此次恢复；失败默认停止，只有 `allowFullFallback: true` 才允许升级完整压缩，取消绝不升级。维护窗口只领取一次，恢复消息引用实际成功结果，失败与普通工具裁剪不推进成功压缩epoch。Soul模块显式选择主3／子1额度，维护压缩保持关闭。有意重复的文本仍可能命中检测，可调阈值或关闭。

`lineRepeatChars/crossCallRepeatChars` 通用默认0关闭，Soul显式2048/2048，`maxCycleChars` 为512以覆盖409字符周期。重复行至少6行、覆盖80%且主导行集中50%；跨调用与此前两次合格调用各达到90%行材料覆盖时才判第三次重复。每类只保128行摘要、单行1024字符，跳过引用和围栏代码，取消/卸载清理。固定校准集3类异常检出、3类正常材料无误报，不能外推生产误报率；这是有界行材料相似度，不是语义向量。仍由原coordinator去重和扣额，不补额、不增加恢复执行者。

## 授权检索与来源引用

普通 `module_search` 保持 query 调用，匹配副本支持大小写、NFKC 全半角与规范数字千分位，返回 `match: exact/normalized/synonym`；引用偏移与 `module_open` 始终是原文。可选 `synonymsFile` 仅读模块 assets/data 的本地二维词组表（64 KiB、128组、每组2–16词、每词128字符，扩展最多32词）。少于3条直接命中时只扩展一次、精确优先、不递归；Soul 显式配置，通用默认不扩展。

`mode: timeline` 合并已授权账本的可信 `t` 与会话事件 `time`；支持含时区的 ISO `since/until`、limit 和版本 cursor。未知时间明确标 unknown，时间过滤排除未知项；相同时刻按来源与记录位置稳定排序。游标绑定来源声明/内容与过滤条件，追加/收口或撤权后失效。只读查询不写 mark、不扫描未授权会话。

`retrieval` 的 `paths` 声明模块相对文件或以 `/` 结尾的目录白名单，`sessions` 显式列出可读历史会话ID；当前Agent自己的会话自动可读，默认不扫描其它会话。目录枚举拒绝链接／越界，受现有资产数量和64 MiB预算约束。额外历史通过宿主只读句柄读取，成功或失败均关闭；异步返回前重验授权。

search/open 工具只注册一次，多个来源模块按Agent聚合授权，释放来源即撤权。文件引用包含模块、路径、字节版本与字符范围；会话引用包含真实sessionId、实际seq数组、所选事件摘要与范围，不把非单调surface当连续seq区间。open重新校验授权与原文；追加新事件不使旧日志引用失效，修改已引用原文则拒绝。长原文按8192字符分页，返回nextReference；每种search引用均有对应open。派生索引只做增量读取，可清空重建，不写第二账本。

## 上下文运行时与溯源

`context-provenance` 行显式启用，受众为all/main/subagent；`basic` 与 `pruner` 分别传官方策略配置，`auto`、`modelSwitch`、`prune` 默认true。每个Agent只允许一个上下文owner。实例位于插件内部私有Context，原宿主provider保持运行；通过公开依赖快照识别其fiber，只为选中Agent过滤原自动监听，并为属性消费者选择本项目实现。手动命令、程序式范围、自动压力、换模型、请求溢出与裁剪共用选择，不改preset、patch或共享服务方法。显式 `ctx.get`、预先缓存的第三方实例与不经受管消费者的root调用不在属性路由保证内。

摘要来源按实际message身份与surface位置匹配，保存每次调用的局部快照；门牌包含可open的真实seq列表，不按相同正文猜范围。门牌连同官方checkpoint framing计入shrink预算，预算不足或来源无法唯一识别时保留原摘要并告警。裁剪仅在本次新生成marker位置加引用，不替换原文中的同字面marker；引用放不下时保留官方裁剪并报告降级。

Basic的范围接口只适用于打开的turn。idle程序式范围与恢复局部压缩经独立维护事务，使用公开Session事件和同一摘要／计价owner；范围验证、取消、版本与shrink检查通过才提交替换。手动compactNow直接复用官方维护入口，不嵌套维护。换模型使用目标 `EpochHeader.config` 计价，失败不提交目标路由；溢出仅在surface已实际推进时重试，次数由官方策略限制，取消不重试。

可选官方包由 `importHostCapability` 在启用时从宿主解析；白名单 `HOST_CAPABILITY_PACKAGES` 只限制可导入的包集合，运行期不比对版本（安装期仍受 `engines.dsh` 与 peer 范围约束）。宿主 API 不兼容以装配期真实错误暴露，不作前置版本诊断；三个 `dsh-compaction*` 包不声明为插件依赖；仓库顶层 `node_modules` 未链接它们，引擎解析路径不可达，只能由真实宿主的隔离验证核对，仓库回归只覆盖白名单拒绝与 `dsh-llm` 路径。`verify:host` 只对这一显式入口允许已登记的宿主能力，普通静态／动态导入仍执行 peer 与 dev 双声明检查。真实官方行为在隔离环境验证，仓库回归测试覆盖公开适配器、流、写盘与拒绝契约。官方 framing 快照升级时须重新核验。

## SELF动态内容与维护心跳

SELF 注入由 `modules: [rule-engine]` 承载，在普通 `inject-text` 动作中声明：

```yaml
config:
  strategy: placeholder
  fill: soul-self
  layer: runtime-context
  order: 133
  params:
    contextName: agent:soul-self
```

`soul-self` 是已有 `fill` 字段的内置取值，不是独立能力行。引擎在实际求值时把来源模块、当前 Agent 与取消信号交给插件的 SELF owner；条件、受众、启停、排序和卸载沿用规则引擎。未声明规则时不注入，不需要模块 JS 资产或服务名参数。此内容源也支持 `pre-step`，遵循 placeholder 的插入点限制。

SELF每步直接派生骨架、账本未结/历史待核对与真实身份；业务事实不变时自动正文保持相同，不加入当前时钟、实际活动时间或投递观测时间。官方runtime-context在任一section变化时追加完整快照，因此这些采样值不能驱动整份上下文重复投递。精确时间和观测继续由既有`soul_state status/check`读取，诊断快照保留生成时间。索引状态同步读取provider，不触发历史loader；unbuilt/refreshing/ready/stale/failed/unauthorized分别报告，最近成功观测不代表尚未扫描的外部变化。写入成功立即失效派生观测，索引或快照失败不能把已提交账本报成未写；实时SELF不等后台ready。可恢复失败仅安全快照降级，显示时间与原因；同戳等长改写也按内容版本识别。

`data/SELF.src.md` 的骨架使用通用只读模板，支持自定义变量、会话覆盖和 `{{runtime.get::soul.open}}`。仅骨架作为模板执行；账本、mark 和派生正文不再次展开。用户显式引用`clock.iso`、`pressure.ratio`等高频runtime事实仍逐次求值，会使正文变化；自动正文的稳定性不覆盖这些自定义模板。SELF 的setter与写回默认值明确拒绝，预览不产生持久写，完整骨架和真实身份仍受原UTF-8预算与脱敏保护。

runtime 可读键：`session.id`、`session.audience`（main/subagent）、`clock.iso`、`clock.timeZone`、`soul.total`、`soul.open`、`soul.pendingReview`、`soul.lead`、`soul.leadSessionId`、`soul.mark`、`soul.markAt`、`index.state`、`index.observedAt`、`pressure.state`、`pressure.ratio`。缺少 lead/mark/观测或可靠水位时对应值不可用，不伪造空串或零。条件示例：`variable: { scope: runtime, key: soul.open, op: gt, value: '0' }`；这只比较事实，不替代下述提醒投递协议。

`soul: { pending: true }` 是窄事实条件，缺来源为UNAVAILABLE，not不反转。Soul `soul-ledger-open` 默认主会话，在需处理集合或成功压缩epoch变化后提醒一次；只消费真实持久投递，A→B→A按最后确认态判断，预览/取消/未投递不消费。可用pre-step与runtime-context；无确认通道的其他层编译时拒绝。runtime-context在官方snapshot内携带不含事项正文的确认标记；重挂从真实会话事件恢复。

`pressureThresholds: [0.45, 0.6, 0.8]` 由Soul在soul-maintenance配置显式选择，维护enabled=false也可读取。使用当前会话 `tokenMeter.measure` 与路由匹配的 `requestContext.contextWindow`，无可靠分母/换模型信息未对齐时显示未知。自动SELF仅呈现normal/organize/persist/urgent级别对应的行动提示，同级别的精确token数和比例变化不改变正文；精确值仍由`soul_state status/check`与runtime事实提供。仅提示整理和先落盘，不新增压缩、唤醒或模型调用；本修复不撤回旧会话已经累积的快照。

已有用户副本若仍声明 `strategy: self` 并保留自己的策略资产，继续由既有自定义策略加载器执行。包升级不覆盖用户副本；显式更新为内置声明后才去掉对应 `strategyDir` 与服务名参数。私有 `data/` 不随此变更迁移。

`soul-maintenance` 按来源模块只保留一个owner和一个定时器，维护串行。`intervalMs` 默认60000，`wake` 默认false，`audience` 默认all，`budgetBytes` 默认12288。可取消地等待空闲，再领取实际Agent维护窗口刷新授权索引和CAS诊断快照；owner释放及时交接，正常占用竞争为waiting并按间隔重试，业务失败保留旧快照。

SELF 注入从同一来源模块事实读取 `soul-maintenance.budgetBytes`，维护未启用时显式预算仍有效。缓存最长 1000ms；`module.yml` 的 mtime 或 size 改变立即重读，同戳等长改写及组合依赖变化在到期后的下一次求值重读，命中不续期。定义缺失、内容读取/解析失败或预算非法时沿用最近有效预算，没有历史值才用 12288；失败尝试也按期限重试。恢复为省略预算的有效定义会重新采用默认值。此路径可能与当前装配短暂不同步，不是装配快照接口。

每次 SELF 求值仍校验参与授权、目录与定义文件种类；链接、越界、元数据检查失败、可读定义的 ID 不匹配继续拒绝。容错仅限定义内容，最终快照读取、取消和输出超预算错误不被吞掉。原严格模块目录入口保留其拒绝契约；运行时释放后预算缓存清空。

显式wake才在维护成功退出后发送一次非空followup；取消、关闭、卸载或失去成员资格使迟到结果失效。心跳不改变恢复额度。provider状态区分disabled、idle、running、ready、failed和cancelled；上下文runtime状态区分ready、running、success、no-op、failed、cancelled和disabled。依赖缺失在装配时明确报错，保留上一份有效贡献。SELF缺失通过动态注入标记可见。

runtime-context 的注册文本必须是同步 provider，不能只在 assemble 钩子里改 accepted 文本：官方请求前还会用 `systemPrompt.refreshContext` 按注册 provider 重算 contexts，字符串占位会被重算回空。引擎为条件化 runtime-context 与 placeholder 注册读取 holder 的函数，优先按具体步骤分区，裸装配才按 Agent 分区。公开 refresh 适配根据 accepted assembly 对象身份投影原步骤，不依赖调用者提供 toolSet；刷新结果继续关联同一步骤。同 Agent 并发装配、主子 Agent 与旧步骤重试因此不互相覆盖正文。system-section 不参与该重算，其条件文本仍用官方占位标记。

## 角色委派（官方 Team 单任务）

`src/runtime/role-delegation.ts` 把**已校验的执行角色**绑到一次真实子代理启动上；它不复制角色正文，也不新建第二份任务或成员来源：

- 官方 Team 拥有任务、依赖、归属与版本：`submitTask`／`settle` 只透传 `createTask`／`getTask`／`updateTask`，陈旧修订、未知任务与已终态任务保持官方错误码。
- 官方 subagent 拥有成员、运行、消息与等待：委派走 `subagents.startActivation({ provider: 'spawn', delivery: 'caller', maxDepth: 1 })`，与模型侧工具同一入口。宿主没有默认叶子上限，`maxDepth` 必须由派工方显式给出；provider 未声明 `capabilities.depthLimit` 时 `availability()` 报 `ROLE_LEAF_LIMIT_UNAVAILABLE`，不伪称已施加。
- 角色内容仍由模块 `role-<role>` 规则与 `assets/` 正文拥有。委派只在 `agent/created`（宿主 await，早于子 Agent 首个 assemble）里写入会话级运行时事实 `role`，经 `createModuleVariableAdapter` 的 `runtimeVariables` 通道按真实 child sessionId 覆盖 `effective`，因此首请求已经带着该角色组合与所选协议。
- 只接受六个已校验角色的字面值；`plan` 是真实根会话的指挥角色（其内容规则受众为 main），派给子代理只会得到一个没有角色的静默启动，因此 `delegate` 报 `ROLE_NOT_EXECUTABLE`。名称、描述与任务文本永不授予角色。
- 一次性 intent + 唯一 token：intent 在 `startActivation` **前**登记、在 `agent/created` 消费即删，启动抛错或取消立刻丢弃，取消的启动不会把角色留给下一个无关 child。
- 认领在 created 窗口内发起（此时 child Agent 已由官方注册），`ownerId` 因此是真实子会话；`settle` 只在真实运行 `stopReason: 'completed'`、有 assistant 输出、且任务归属等于该 child 时标完成，陈旧 `expectedRevision` 保留官方 `TEAM_TASK_STALE_REVISION`。一轮结束不等于任务完成。
- 恢复只认官方持久事实：child header 的 `parentSession` 与子会话自己的 `prompt-tool/role-binding` 事件交叉核验；`subagent/descriptor` 无角色字段、`runId` 不随恢复保留，重挂后按 header 与事件重建运行时事实，不按成员名猜角色。
- `release()` 只撤回未消费 intent；`close()` 停止新派工但保留官方任务、已启动子会话与其他来源的工作。`selectCapabilityProtocol(moduleRoot, branch)` 是 05 留给派工的显式协议选择入口，关闭派工不自动切回普通协议。

## 自动派工编排（官方 Team 多任务）

`src/runtime/auto-delegation.ts` 把「一次计划」跑成官方事实：plan 会话给出已授权目标的自包含子任务，编排负责登记官方任务与依赖、真实派发、等待匹配终态并汇总。它复用 07 的 `RoleDelegationRuntime`，不新建任务表、成员库、消息队列或常驻调度器。

- **总开关是模块规则**：`modules/redteam` 的 `auto-delegation` 规则默认 `enabled: false`（规格 34）。关闭时 `run`／`enable` 报 `AUTO_DELEGATION_DISABLED` 且不登记任务；用户经既有规则编辑保存后，运行时下一次调用即按新值判定——不缓存、不重启。规则打开时它只向 main 受众投递运行纪律，不代替任何实际调用。
- **开启事务只做两件事**：经 05 的既有跨模块互斥 `selectCapabilityProtocol(moduleRoot, 'redteam')` 选红队协议，再给真实根会话授 `plan`（`assignRootRole` 拒绝子会话，报 `ROLE_PARENT_REQUIRED`）。团队开关仍由官方管理；关闭（`disable`）只撤回本来源的 plan 角色与未消费资格，不擅自重开普通协议、不删任务、不动已启动子任务。
- **任务书自包含**：`planned` 的六段（目标范围／输入／已知事实／预期产出／验收依据／实际可用工具）缺一段即 `AUTO_BRIEF_INCOMPLETE`，因为子代理不继承父对话。正文只由这六段渲染，不追加计划外内容；角色正文仍由 `role-<role>` 规则与 `assets/` 提供，在子代理首请求投递。
- **官方登记唯一**：`submitTask` 透传 `createTask`（含 `blockedBy`／`writeScopes`）；任务描述首行写稳定标记 `[auto-plan:<planId>/<key>]`，恢复或重挂时用 `listTasks` 读回同一标记的任务复用，**不重复创建**；`status: completed` 或已被其他来源认领的任务**不重复派发**，只按官方视图汇报（`reason: official-status`）。
- **依赖串行、额度内并行**：调度只在前序官方任务 `completed` 后启动后序，`parallel` 默认 1，只对互不依赖的任务并行。官方 `ready` 只表示可认领——启动必须走真实 `delegate`，完成必须等 `settle`（`stopReason: completed` + 有输出 + `ownerId` 匹配 + 版本未陈旧）。`writeScopes` 只是官方冲突提示（`writeScopeWarnings`），不当锁或目录隔离。
- **失败与取消不冒充完成**：派发失败（如角色内容规则被关 → `ROLE_CONTENT_UNAVAILABLE`）或结算抛错，结果记 `failed` 且官方任务保持 `pending`；依赖失败即阻断后序（`blocked`）。用户取消、来源释放或关闭后不再启动后续任务，未启动的记 `cancelled`，官方任务保留可续做。
- **汇总只认匹配事实**：`AutoDelegationSummary.outcomes` 每项带 `taskId`／`childSession`／`runId`／`taskStatus`／`revision`，`completed` 只在全部子任务都有匹配完成时成立。需要继续工作时用 `handoff(parent, childSession, text)`，它透传官方 `subagents.sendMessage`，不另建消息通道。
- **入口**：宿主经 `AUTO_DELEGATION_SERVICE`（`prompt-tool/auto-delegation`）取到编排实例；`agent/created` 里 `assignRoot` 在规则开启时给真实根补上 plan，作为重挂后的恢复入口。
## 自定义工具与宿主契约

工具通过已安装 `@deepseek-ai/dsh-tools` 的 defineTool/官方转换器定义，使用真实 ToolExecution 的 agent、signal、调用身份；异步工作观察或转发 caller-owned signal。delegate 走 `ctx.tools.execute`，保留批准、拒绝和取消管线。

自定义执行器支持 shell/http/delegate/fs/ask-user。定义、参数 Schema、输出和路径在写入边界校验；不依赖工具描述来当权限。fs 用真实路径 containment 限定 cwd，shell 超时与输出超限给出可诊断 error；宿主 API 以安装包类型和官方文档为准，不复制旧版本行号作当前依据。

## 重建与验证

服务端构建保留对随包 `engine/` 的外部引用，与 early 入口加载同一份引擎模块；不得将其内联为第二份模块级 owner 状态。客户端仍按原客户端配置打包。`verify:pack` 验证服务端入口导入前后已发布构造默认的行为、显式配置与贡献撤回。

`host-control` 的 `filesystem-fence` 与 `filesystem-observation` 独立采用当前 Agent 已接受工具步骤的快照（`value: true`），关闭规则恢复后续步骤。可选早期入口只在已核验的官方文件策略 owner 上生效；缺失、结构失配、身份缺失、取消或释放保持原判据，依赖正文暂停，独立分支继续。文件围栏只取消 provider 的目标路径围栏，不修改共享 sandbox mode；观察策略取消 write/edit/delete 的观察意图，允许无观察覆盖并取消观察版本 CAS，read 仍正常记录观察。参数检查、编辑匹配、原子提交、文件系统错误及插件管理面授权保留。`sandbox-file-write` 指向 Seatbelt 的独立写入判据，当前 Windows 平台不适用，macOS 的 exec 身份传播尚不支持，均明确不可用。

只在本插件仓库修改源文件；使用 package scripts 重建 lib 与 YAML vendor 快照，不手改产物或宿主源码。根 module.yml 由 rebuild:module-template 生成，示例默认关闭，普通规则变量需手动建立。

交付从隔离 cwd 执行 typecheck、lint、test、build、diff --check；宿主/包接入另核对 verify:host、verify:pack。永久测试只进入注入行为、写盘语义、bridge 载荷、安全拒绝、UI slot / 入口注册五条 seam，期望来自独立规格或字面样例，断言公共行为。退役接口不留仅证明旧名字不存在的测试。
