# 宿主控制动作

规则等待真实宿主 owner，依赖观测跟随当前来源、作用域与已接受步骤。字段、默认值和校验由 [宿主控制能力目录](../../engine/host-control-catalog.mjs) 持有。

## Agent 级控制

### 工具结果裁剪

`compaction-tool-result-pruner` 按宿主解析的官方构造器身份发现全部存活 Fiber，并在各 owner 自己的 Context 等待、门控原 Pruner；正式 standard 组合内层 isolate 不影响发现。就绪与停用资格按当前 Agent 的官方 scope 和真实 session 身份核对，其他 Agent 的 owner 不提供就绪。晚到或重挂后在后续正常装配重判，释放立即使旧门控失活。规则解除后下一次官方扫描恢复裁剪，仍在当前上下文里的旧工具结果也会被扫描。第三方外层包装保留。

### Messages 当前系统正文

普通规则 `host-control / messages-current-system` 仅接受 `value: true`，独立于 `current-system-snapshot`，不隐式开启它。单独生效时，Messages 顶层 system 使用当前请求历史中最后一条非空 system 正文，空正文不擦除已有正文，原 `options.system` 前缀保持。两者在同一步同时获准时，按真实消息来源先放本步已接受的完整 `system-prompt` 正文，再按原顺序组合其他来源 system；其他来源的空白、换行和同文贡献保持，不按正文全局去重，不把这些正文降为中途 system。工具增删通知仍沿官方 developer 路径，工具配对、ID 和内容校验不绕过。

Messages 资格复用真实 Agent 的 sealed 工具步骤、原 prepared adapter 身份与 snapshot owner 判据，热更新不混入旧步及重试，缺 owner、取消、释放或路由重挂停止旧资格。缺失必要 owner 只暂停该动作及显式依赖正文，无关规则继续。可选 early 接入逐一校验 npm 官方发布包 `@deepseek-ai/dsh-llm-deepseek@0.2.2-rc.2` 的完整发行指纹和唯一锚点。需用户重启 DSH 后生效，真实 CLI/Web 综合验收另行执行。

Responses 同段包含系统正文和工具删除时，正文沿系统角色映射，工具删除沿固定 PI 的当前工具集合折叠；关闭时保留官方角色判据。

### 请求身份与系统角色

请求身份首段与系统角色由两个独立 `host-control` 动作控制：`oauth-identity-prefix` 和 `provider-system-role`，均只接受 `value: true`。前者只跳过 Anthropic OAuth builder 自动添加的 Claude Code 身份首块，用户正文中的相同句子保留；认证、headers、工具名、缓存与其他正文保持官方路径。后者只调整 completions 与 responses 的系统正文角色判据：原推理与 compat 条件允许 developer 时，仅 `URL.hostname` 精确为 `api.openai.com` 或真正的 `.azure.com` 子域保留 developer，其余使用 system。工具增删通知的既有 developer 语义不改；相似后缀、userinfo 和 query 不授权原生角色。

当前适配面向 npm 官方发布包 `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.2` 与实际解析的 `@earendil-works/pi-ai@1.3.0`；开发与 CI 通过 `patches/pi-ai-1.3.0.patch` 保留官方源码 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c` 的共享 streamed tool-argument patch，无需构建官方源码。三条协议分别校验完整指纹与唯一锚点，未验证文件不投影。Messages 每次发送完整 system/tools；第三方 completions 缓存键沿该版官方判据，不启用后续版本专有选项。Responses 纯新增工具声明保留原生 developer `additional_tools`；出现删除或同名重声明时，官方将工具历史折叠到顶层当前集合，插件不添加文本通知。角色映射只改变系统正文。

资格在实际 Agent 的工具步骤准备时冻结，loop 只在本次 `llm.prepareCall` 期间携带身份，实际 adapter 将它绑定到原 prepared stream。请求专属模型副本携带该身份，不按 sessionId、最近 Agent 或全局 fetch 关联。热更只影响后续步骤；取消、步骤关闭、规则 owner 撤回或 adapter 注册释放后停止本来源效果，重挂不能复活旧资格。发行适配分别校验 loop、LLM 路由、DSH PI adapter 与 PI provider 的版本、完整指纹和唯一锚点；两个 OpenAI 目标均成功加载才就绪，缺失仅暂停该能力及显式依赖分支，OAuth 能力独立。需要 early 入口与用户重启 DSH 后生效；本地最终载荷不承诺远端服务接受，CLI/Web 综合验收另行执行。

### 消息形状容错

普通规则 host-control/message-shape-guards 使用 value: true。资格在当前工具步骤准备时固定，最终公开 assemble 与 refreshContext 只将缺失或非字符串的 section/context 正文归空，合法字符串、空白和顺序保持；complete 最终还原也经过该出口。未知变量、非法表达式、provider/getter 异常仍由官方抛出。

缺省或非数组 messages 仅在 enter 决定归为空数组；模型切换的前置消费者和最终 turn 消费均使用同一 Agent、modelSelection 所关联的 sealed 步骤。未知 kind、reject、取消和独立异常不变。真实 step 内，Session 的 system/developer/assistant 派生仅过滤缺消息、非数组或空 content，官方投影仍优先，合法消息保原身份；user/tool 不参与该过滤。loop 的 systemNodes/textOf 沿同一步处理空 content，首尝试 runtime-context 原分流与一次投递保持，历史事件不改写。脱离该 Agent 步骤的公开派生调用仍透传。

agent、session、loop 的实际发行物分别验证版本、指纹和唯一结构，并由实际 Agent.model、Session.surface 和 loop 实例联合握手。任一必要 owner 缺失仅暂停本能力和显式依赖分支，预算与当前系统快照能力独立。热更新只影响后续步骤，关闭、释放、取消或旧步骤结束后不能借新 owner 复活。rc.2 JSONL v4 仍拒绝缺 message 或非数组 system content，容错不绕过持久格式校验；空 content 数组可正常持久化。需 early 入口和用户重启 DSH 后生效；真实 CLI/Web 综合验收另行执行。

### 当前系统快照

普通规则 `host-control / current-system-snapshot` 使用 `value: true`。它复用请求前 `prepareAssembly`，把资格与兼容状态固定在原工具步骤；请求按已接受 assembly 对象身份读取同一个 sealed 步骤和局部 renderedPrompt，热更新、裸装配及同 Agent 并发装配不改变在途步骤与重试。按真实 Agent 隔离主子受众，取消沿官方信号；规则关闭影响后续步骤，owner 释放、步骤关闭或当前接缝失配立即停止本来源投影，旧资格不借新 owner 复活。

当前正文只整理 `system-prompt` 来源：通过官方 Session.append 追加 surface replacement，使当前首条 system 与同一步 durable 日志正文一致；不改写任何既有 durable 事件。空白、仅头、仅尾、截断或不同换行的旧来源补为本步精确完整正文，不全局 trim；请求投影将本步正文放在首条，其他来源即使先有 system 消息也保留原内容与相对顺序。可见事件复用 currentEvents 及其降级契约。后续同来源节点只清空一次，请求投影移除这些空节点；相同正文的重复步骤不制造新事件。关闭后回官方后续路径，已提交的新正文仍是历史事实，不恢复旧历史头。

早入口验证官方 agent-loop 实际版本、发行指纹及 snapshot 独立锚点，只有实际 constructor marker 与本 Agent 存活 owner 同时存在才就绪。缺失只暂停包含该动作的显式依赖分支，无关规则继续；owner 恢复后在下一次正常装配重判，不轮询补发。需用户重启 DSH 并选用 early 入口后生效；CLI/Web 综合验收另行执行。

### Provider Hook 决定

官方 Hook owner 负责执行、审计与输出解释。能力依赖当次会话可达且仍存活的官方 owner。依赖缺失、版本失配或来源撤回时，相关分支暂停并报告原因，其他贡献继续。

### 沙箱升级请求

官方沙箱与审批 owner 负责真实执行权限及请求审计。适配只在已验证的宿主接入点生效，执行身份使用当前已接受的工具步骤。缺少服务、身份或已接受步骤时保持官方路径。

### 审批决定

官方审批 owner 持有请求和审计。会话身份、取消、嵌套调用和来源释放沿官方工具管线处理。能力观测以真实决定出口为准。

### 进程直通与构造默认

这三个动作只影响启用后经官方 Loader 真正重新构造的策略或审批实例，已构造对象与既有会话不追改；关闭恢复后续构造默认。沙箱与审批组合默认只替换官方 base 的省略配置表达式，环境显式覆盖和用户显式配置保留，非法组合仍由官方 permission-presets 拒绝。不能把已启动进程中保存成功或普通重启等同于先前已构造对象生效。需要早期入口、精确 Loader 与策略/审批发行产物验证；缺入口、缓存或失配的原因经既有规则诊断显示，已验证也只标记后续构造可用。

新主会话 full-access 继承由官方 permission-presets 原生提供：部署是 full-access 且用户没有指定其他默认时，新会话采用 full-access；显式默认、后续用户选择和既有日志保持，子代理仍走官方捕获与委派策略事件。插件不添加同义开关，也不覆盖用户钉选。

规则的 `executionScope` 缺省为 `agent`。进程贡献只接受支持的无条件动作，每模块通过发布队列贡献一次，即使没有活动 Agent 也初始化、观察保存并撤回。

### 委派深度与等待上限

`host-control/delegation-limits` 的 `value.maxDepth` 为非负安全整数，`value.askTimeout` 为1–2147483秒整数；至少声明一项。深度仅替代官方spawn工具省略的配置，显式配置与provider-managed保留；等待仅替代调用的timeout=-1，省略和有限值由官方owner处理。两个早期owner分别校验，缺失只暂停显式依赖该目标的分支。参数按当前Agent已接受步骤封存，后续重判才接受更新；关闭不改已创建子代理或在途提问，取消沿原信号。普通入口缺失早期owner时需用户重启DSH并选用early入口。

### 文件策略的可用性

`sandbox-file-write` 依赖 Seatbelt。Windows 不适用，macOS 当前缺少 exec 身份适配，两者均报告不可用。`filesystem-fence` 和 `filesystem-observation` 分别核对所需的早期入口，以及当前 Agent 对应的文件系统服务和已验证的策略提供方。任一依赖缺失、身份不匹配、步骤取消或服务释放时，保留宿主原有判据，依赖该能力的分支暂停，独立分支继续。两项策略分别读取已接受工具步骤的配置快照，关闭影响后续步骤。具体不可用原因见[文件策略状态判定](../../engine/filesystem-policy.mjs)。

## 已接受步骤与说明替换

普通 `assembly.target.sections.replace: [{ name, text }]` 原位替换第一个作者名称相同且正文非空的段，保留 order、complete 等官方元数据。目标缺失或没有非空正文时跳过。计划模式可据此编辑 `plan:policy` 全文，真实开关、日志、审批和退出工具仍归官方 planMode。

`sections.replace` 与 `contexts.replace` 都支持非空字面 `match`，要求名称和原文各自唯一匹配，歧义或原文缺失时透传并告警。`sections.keep/remove` 选择所有原名匹配的段，`sections.append` 命中首个原名匹配的段。`contexts.clear` 与上下文替换互斥。官方 `refreshContext` 调用原 provider 后复用该工具步骤已接受的替换，规则热更新只影响后续步骤。审批和沙箱说明属于运行上下文，计划说明属于系统段。文字说明沿原权限所有者执行。

普通 `request-params.maxTokens` 是正安全整数的瞬时额度贡献，不能与本动作的 `patch/unset.maxTokens` 或 `replace:true` 混用。原 `patch/unset` 的有序组合语义保持。当前真实Agent和请求目标上有效的显式额度同值共存、异值拒绝完整候选并保旧；运行事实翻转形成冲突时，全部冲突额度及其分支后代正文暂停，后续正常重判恢复。只有实际参与同一额度目标的正向phase条件才比较 `maxPromoteSteps`，不同值同样冲突；独立phase追踪器不建立全局互斥。

预算依赖沿唯一分支展开器携带的结构路径关联：预算所在分支的后代then/else均依赖它，兄弟分支和其他模块不受牵连；不按条件JSON或正文猜测。预算诊断只在完整计划已接受且真实装配结算后发布；条件miss、缺事实、异常和受众不符分别保留原判定，失败候选不覆盖旧有效观测。

官方指令预算是persona可选正安全整数 `instructionsMaxBytes`，按当前真实Agent的有效动作聚合，同值共存、异值拒绝完整候选并保旧；与prefix/complete同一计划预检。预算不新建指令owner，不复制正文，不改已有baseline/projection或历史。当前步预算附在原toolStep接受计划，modelSelection反查同一步；取消信号为turn级，不能充当step键。后台projection在compose入口读取本Agent已提交计划一次，不修改在途step。

宿主早期适配在目标求值前检查包、版本、发行指纹和结构锚点。失配只影响明确依赖该能力的分支。文件策略独立随当前 Agent 已接受的工具步骤生效，依赖失配、身份缺失、取消或释放沿原判据处理。参数检查、编辑匹配、原子提交、文件系统错误及插件管理面授权保留。

## 文件读取上限

`host-control` 动作可声明 `capability: file-read-limits`。`value` 至少声明 `maxLineLength`、`maxBytes`、`limit` 中一项，已声明值须为正安全整数；分别表示UTF-16代码单元计数的每行长度、包含行间换行和截断后缀的UTF-8输出字节、默认及最大读取行数。未声明字段及 `readStreamMinSize` 保持原owner配置。

额度沿普通条件、受众、完整候选及数字草稿/CAS链进入当前Agent的工具步骤。同Agent同字段同值共存，不同字段组合；异值候选拒绝，动态冲突拒绝新步骤，已接受步骤保留快照。调用在首个await之前固定额度，原官方read继续拥有路径、文件读取、流式路由、解码、资源校验、输出及观测；render采用同调用快照，不重挂或复制官方服务。

部署期公开Config捕获在官方闭包，按Agent热改通过既有 `/early` 出口的最窄内存接缝实现。仅核验 `@deepseek-ai/dsh-tool-fs@0.2.2-rc.2`，完整入口SHA-256为 `0e866969b6bf1aa93407ccd9c944b50bc27a1d961b7e4209ed60bd2b73d28805`；指纹及owner登记、定义标记、执行、渲染四处唯一锚点整组匹配才生效。缺early、已缓存、目标失配或真实owner/依赖不可用时三项一起透传，显式关联正文暂停，无关规则继续。依赖恢复后正常重判恢复，暂停期间关闭不会重开，也不重放读取；需启动期接入时只提示用户正常重启。

模型参数说明只定点更新已验证owner的原生默认行数句，保留其他贡献，再沿通用工具说明投影生成目录。关闭后新步骤恢复原owner配置，在途调用和已接受旧步骤保持原值。官方磁盘文件不变；桌面与其他发行物仍须各自验收。
