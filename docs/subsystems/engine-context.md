# 授权检索、上下文溯源与 SELF

## SELF 的可见投递与差量

内置 Soul 的五层、ECHO、VITAL 与账本教材保留话题激活条件，并以 `dedupe: session` 在对应正文已可见时抑制重复。未结提醒保留原条件、开关与工具操作指引；具体账本条目变化只由 SELF 差量投递，不在提醒中再次陈述状态。

`fill: soul-self-changes` 仅支持 `pre-step`：由 SELF 所有者按当前授权与可见的已接纳来源生成基线或变化，无变化返回空；声明使用 `mergeMode: separate`、`dedupe: none`。引擎保留返回的来源标记，不再次求值模板或以配置正文覆盖 SELF。旧 `fill: soul-self` 仍提供完整快照。内置 Soul 判据与简短工具入口独立使用可见会话去重，工具手册仅按需授权回读。

变化投递以来源中的贡献摘要及 `previous`、`textDigest` 校验当前可见链，按稳定贡献标签仅发送新增或修改部分；撤销仅指出原标签，不回显旧正文。比较最近有效状态，A→B→A、标记清空和授权事项关闭均可产生相应更新。当前主导及历史待核对事项同样经过逐项授权后参与变化比较。水位未知或关闭监测时不宣告警告解除，只从有效可见投递链保留此前警告摘要；状态工具继续报告实际测量状态，确认恢复正常后才解除警告。预算省略贡献或大量撤销使差量超预算时，降级为带范围重置说明的当前基线，保留身份与核心预算；省略不冒充业务关闭。

可见投递链的增量索引绑定真实 Session、surface 及其代次，并记录日志与节点游标。普通 append 仅消费新增部分；replace/project、代次变化或游标失效时冷重建，恢复后的新 Session 从当前可见事实重建。取消的提议不算接纳，链中段移出或基线正文改写后重新补齐当前基线。索引只缓存已验证的可见链，权限与当前来源仍每次复核，不作为第二份持久投递账本。

隔离公开 `renderChanges` 配对中，10k 日志连续 5 次无变化调用的新增投递链返回事件数由 100000 降为 0，总返回事件数由 150000 降为 50000；既有 `withEvidence` 全量读取仍在。该计数不代表整体零扫描或耗时显著加速，10k 日志也不等于 10k 可见节点。

<a id="soul-证据准备与资源边界"></a>

## 证据准备与资源边界

知识 owner 管理项目身份、证据操作与历史装载。启动仅按账本 origin 和持久来源元数据恢复登记，不预载历史正文。

### 授权与项目身份

- 辅助整理开始时固定控制凭据；流式片段只核对凭据、owner、模块身份与真实根输入，不读取完整绑定或重算全部历史摘要。持久授权、项目、启停代次及相关记录／学习／发布变化使凭据失效；纯 cursor 推进和无关自动索引不取消操作。
- 真实根输入到达会话事件即取消，不等异步观察。取消钩子和来源 watcher 保留；消费材料及提交时完整复核授权与原始版本，watcher 不保证正文同步版本。
- 项目身份缓存随 owner 释放。绑定、恢复、cwd 推导及 SELF／检索／学习的异步准备解析 Git，支持超时与取消；同步模板冷读不可用。稳定读取不启动 Git，只复核真实目录、祖先、`.git`、gitdir／commondir 指针及目标的文件系统身份；合法主仓库与 worktree 共享 common-dir。
- 身份变化立即拒绝并使控制凭据失效，异步重验完成前再次核对足迹。owner 释放或目录变化后的迟到结果不能恢复旧授权。

### 证据操作与额度

`withEvidence` 接收真实会话和本次完整模块集合，在装配、维护、写入锁之外准备紧凑引用材料。同步 sources、records、learning 与模板只消费当前操作，未准备即不可用。会话间操作隔离，嵌套只复用固定集合；结束、取消或 owner 释放后停止消费。辅助生成及等待 Agent 空闲不占证据操作。

| 资源 | 额度与调度 | 失败、取消与释放 |
|---|---|---|
| 投影材料 | 每 owner 最多 8 MiB JSON UTF-8、100000 条引用；锁外一次预约完整集合，不足时 FIFO 可取消等待 | 单操作超额拒绝并提示缩小范围；同一引用版本冲突则拒绝本次操作、释放预约，来源稳定后可重试，不覆盖其他操作材料 |
| 共享材料 | 相同固定材料共享计量；活动材料不淘汰 | 最后消费者结束即释放 |
| 原始历史 | 准备、检索、辅助整理共用最多两个在途装载槽；同会话在途读取合并，消费者独立取消 | 最后消费者退出才取消底层；不可中断读取结束前仍占槽，迟到结果不回填；完成后不缓存，最终版本复核重新读取 |
| 单会话历史 | 最多 100000 事件、32 MiB JSON UTF-8 | 未接入证据 owner 的通用检索维持原保护 |

投影计量采用去重后的完整 JSON 数组：作用域 `["s", key]`、历史身份 `["h", sessionId]`、引用 `["r", sessionId, seq, sha256, public ? 1 : 0]`，包含转义、数组分隔符和外层括号。该编码预算不保证 Node heap、RSS、原文解码峰值或宿主总内存上限。

原文仍按需读取并复核 raw/public 引用版本与授权；历史 Session、事件及检索投影不作长期验证缓存。失败或取消不改变持久授权、记录、pending 或学习状态，不恢复已撤回学习。

## 授权检索与来源引用

会话检索只公开真实用户／Agent 消息、模型回答和可验证工具结果中的文本正文；过滤插件注入、系统与运行上下文、推理块及模块工具自身回执，避免派生内容被再次当成来源。知识授权的自动历史来源不即时召回本会话当前用户回合新产生的回答和工具结果；显式历史授权仍按其来源范围判定。新会话引用使用 `public1:` 修订，打开时复核原事件及公开正文；旧格式引用仍按原定位与版本协议兼容读取，不能绕过来源授权。

普通 `module_search` 保持 query 调用，匹配副本支持大小写、NFKC 全半角与规范数字千分位，返回 `match: exact/normalized/synonym`；引用偏移与 `module_open` 始终是原文。可选 `synonymsFile` 仅读模块 assets/data 的本地二维词组表（64 KiB、128组、每组2–16词、每词128字符，扩展最多32词）。少于3条直接命中时只扩展一次、精确优先、不递归；默认不扩展，须由调用模块显式配置。

`mode: timeline` 合并已授权账本的可信 `t` 与会话事件 `time`；支持含时区的 ISO `since/until`、limit 和版本 cursor。未知时间明确标 unknown，时间过滤排除未知项；相同时刻按来源与记录位置稳定排序。游标绑定来源声明/内容与过滤条件，追加/收口或撤权后失效。只读查询不写 mark、不扫描未授权会话。

`retrieval` 的 `paths` 声明模块相对文件或以 `/` 结尾的目录白名单，`sessions` 显式列出可读历史会话ID；当前Agent自己的会话自动可读，默认不扫描其它会话。目录枚举拒绝链接／越界，受现有资产数量和64 MiB预算约束。额外历史通过宿主只读句柄读取，成功或失败均关闭；异步返回前重验授权。

search/open 工具只注册一次，多个来源模块按Agent聚合授权，释放来源即撤权。文件引用包含模块、路径、字节版本与字符范围；会话引用包含真实sessionId、实际seq数组、所选事件摘要与范围，不把非单调surface当连续seq区间。open重新校验授权与原文；追加新事件不使旧日志引用失效，修改已引用原文则拒绝。长原文按8192字符分页，返回nextReference；每种search引用均有对应open。派生索引只做增量读取，可清空重建，不写第二账本。

## 上下文运行时与溯源

`context-provenance` 行显式启用，受众为all/main/subagent；`basic` 与 `pruner` 分别传官方策略配置，`auto`、`modelSwitch`、`prune` 默认true。每个Agent只允许一个上下文owner。实例位于插件内部私有Context，原宿主provider保持运行；通过公开依赖快照识别其fiber，只为选中Agent过滤原自动监听，并为属性消费者选择本项目实现。手动命令、程序式范围、自动压力、换模型、请求溢出与裁剪共用选择，不改preset、patch或共享服务方法。显式 `ctx.get`、预先缓存的第三方实例与不经受管消费者的root调用不在属性路由保证内。

摘要来源按实际message身份与surface位置匹配，保存每次调用的局部快照；门牌包含可open的真实seq列表，不按相同正文猜范围。门牌连同官方checkpoint framing计入shrink预算，预算不足或来源无法唯一识别时保留原摘要并告警。裁剪仅在本次新生成marker位置加引用，不替换原文中的同字面marker；引用放不下时保留官方裁剪并报告降级。

Basic的范围接口只适用于打开的turn。idle程序式范围与恢复局部压缩经独立维护事务，使用公开Session事件和同一摘要／计价owner；范围验证、取消、版本与shrink检查通过才提交替换。手动compactNow直接复用官方维护入口，不嵌套维护。换模型使用目标 `EpochHeader.config` 计价，失败不提交目标路由；溢出仅在surface已实际推进时重试，次数由官方策略限制，取消不重试。

可选官方包由 `importHostCapability` 在启用时从宿主解析。`HOST_CAPABILITY_PACKAGES` 只限制可导入的包集合，运行期不比对版本；安装期仍受 `engines.dsh` 与 peer 范围约束。API 不兼容在装配时报告，不作前置版本诊断；开发依赖中存在某个包，不代表真实宿主已装配或解析到它。

`verify:host` 只对该显式入口允许已登记的宿主能力，普通静态／动态导入仍检查 peer 与 dev 双声明。真实官方行为须在隔离宿主验证；仓库回归检查公开适配器、流、写盘与拒绝契约，不能代替宿主接入验收。官方 framing 快照升级时须重新核验。

<a id="self动态内容与维护心跳"></a>

## 动态账本上下文与维护心跳

模块通过 `modules: [rule-engine]` 和普通 `inject-text` 动作注入账本动态上下文（SELF）：

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

`soul: { pending: true }` 是窄事实条件，缺来源为UNAVAILABLE，not不反转。该条件在需处理集合或成功压缩 epoch 变化后允许提醒一次，受众由模块规则指定；只消费真实持久投递，A→B→A按最后确认态判断，预览/取消/未投递不消费。可用pre-step与runtime-context；无确认通道的其他层编译时拒绝。runtime-context在官方snapshot内携带不含事项正文的确认标记；重挂从真实会话事件恢复。

`soul-maintenance.pressureThresholds` 显式配置压力分级阈值（例如 `[0.45, 0.6, 0.8]`），维护 `enabled=false` 时也可读取。使用当前会话 `tokenMeter.measure` 与路由匹配的 `requestContext.contextWindow`，无可靠分母/换模型信息未对齐时显示未知。自动SELF仅呈现normal/organize/persist/urgent级别对应的行动提示，同级别的精确token数和比例变化不改变正文；精确值仍由`soul_state status/check`与runtime事实提供。仅提示整理和先落盘，不新增压缩、唤醒或模型调用；不撤回旧会话已经累积的快照。

已有用户副本若仍声明 `strategy: self` 并保留自己的策略资产，继续由既有自定义策略加载器执行。包升级不覆盖用户副本；显式更新为内置声明后才去掉对应 `strategyDir` 与服务名参数。私有 `data/` 不随此变更迁移。

`soul-maintenance` 按来源模块只保留一个owner和一个定时器，维护串行。`intervalMs` 默认60000，`wake` 默认false，`audience` 默认all，`budgetBytes` 默认12288。可取消地等待空闲，再领取实际Agent维护窗口刷新授权索引和CAS诊断快照；owner释放及时交接，正常占用竞争为waiting并按间隔重试，业务失败保留旧快照。

SELF 注入从同一来源模块事实读取 `soul-maintenance.budgetBytes`，维护未启用时显式预算仍有效。缓存最长 1000ms；`module.yml` 的 mtime 或 size 改变立即重读，同戳等长改写及组合依赖变化在到期后的下一次求值重读，命中不续期。定义缺失、内容读取/解析失败或预算非法时沿用最近有效预算，没有历史值才用 12288；失败尝试也按期限重试。恢复为省略预算的有效定义会重新采用默认值。此路径可能与当前装配短暂不同步，不是装配快照接口。

每次 SELF 求值仍校验参与授权、目录与定义文件种类；链接、越界、元数据检查失败、可读定义的 ID 不匹配继续拒绝。容错仅限定义内容，最终快照读取、取消和输出超预算错误不被吞掉。原严格模块目录入口保留其拒绝契约；运行时释放后预算缓存清空。

显式wake才在维护成功退出后发送一次非空followup；取消、关闭、卸载或失去成员资格使迟到结果失效。心跳不改变恢复额度。provider状态区分disabled、idle、running、ready、failed和cancelled；上下文runtime状态区分ready、running、success、no-op、failed、cancelled和disabled。依赖缺失在装配时明确报错，保留上一份有效贡献。SELF缺失通过动态注入标记可见。

runtime-context 的注册文本必须是同步 provider，不能只在 assemble 钩子里改 accepted 文本：官方请求前还会用 `systemPrompt.refreshContext` 按注册 provider 重算 contexts，字符串占位会被重算回空。引擎为条件化 runtime-context 与 placeholder 注册读取 holder 的函数，优先按具体步骤分区，裸装配才按 Agent 分区。公开 refresh 适配根据 accepted assembly 对象身份投影原步骤，不依赖调用者提供 toolSet；刷新结果继续关联同一步骤。同 Agent 并发装配、主子 Agent 与旧步骤重试因此不互相覆盖正文。system-section 不参与该重算，其条件文本仍用官方占位标记。
