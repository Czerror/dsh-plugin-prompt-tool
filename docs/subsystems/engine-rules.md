# 规则条件、插入与会话历史

## 规则条件与动作边界

规则含 `id/name/enabled/layer/group/exclusive/if/then/else`。动作有稳定 id 和 kind；then/else 与嵌套分支内的所有动作 id 在同一规则中唯一。读取投影可生成配置身份，编辑映射保留原始条件和载荷，不把编译默认值写回。

`if` 是单键谓词或 all/any/not/notAny 组合。必要事实缺失为 UNAVAILABLE，不会因 not 变成 true。`variable` 谓词写成 `{ key, op, value, scope }`：op ∈ eq/ne/in/gt/gte/lt/lte/present/absent（缺省 eq），scope ∈ effective/session/module/global/runtime（缺省 effective）；effective 按会话→模块→全局，显式 session 条件只看会话域。`in` 的 value 是非空字符串数组，其余比较 op 的 value 是字符串，`present`/`absent` 不收 value；普通键缺失或非数字比较为假；runtime 事实缺失、读取失败、变量关闭或适配器未绑定为 UNAVAILABLE。适配器按真实 Agent 与来源模块绑定，不能由普通变量伪造 runtime。规则级 else 要有同一规则的 if；事实未知时可能两支都不执行。分支节点不写 kind，不能把 if/then/else 塞进动作对象。

`manifest` 谓词写成 `{ ok: boolean }`，只读来源模块 `assets/manifest.yml` 的 `checks`。检查项失败为 false，清单缺失、损坏或不可读为 UNAVAILABLE。宿主装配取得读取器后，经挂载 options 绑定 `manifestCheck`；准备期不可用。独立 `engine/rule-engine.mjs#apply` 不接入该宿主读取器，因此该路径的 manifest 条件恒 UNAVAILABLE，包括 `not` 也不成立；嵌入调用方可以显式向 `mountRuleSources` 提供读取器。

规则读取器缓存检查结果 1000ms，通过、失败和不可用结果均不因命中续期。账本追加不会提前触发全量解析；到期后的首次求值重新检查。清单本身的 mtime/size 变化会提前失效，清单缺失立即不可用；同戳等长改写在到期时重读识别。显式 `module_manifest check` 始终实时检查，不写变量，也不刷新规则缓存，所以显式结果与自动提示可在剩余 TTL 内不同。首次和到期检查仍同步解析文件，这个缓存只限制重复检查频率。

受众事实由纯模块 `engine/audience.mjs#audienceOf`（条件树）与 `engine/rule-spec.mjs#actionAudiences`（编译后动作）派生：`scope.audience` 精确收窄（同节点带 `modelScope: pro|flash` 时不算精确），`all` 求交、`any` 保守、`not`/`notAny` 只对精确子节点取补，无法收窄的条件按两个受众处理。规则级 `else` 的动作自带 `not(if)`，不再叠加规则级 `if`。宿主装配只读这个结果，不自行遍历条件树。raw rule（编辑器/UI）的只读投影走 `engine/rule-facts.mjs#ruleFacts`：受众是 then/else/嵌套分支动作可能受众的并集，未知时按两个受众处理；空集由 client 展示层按未知处理（见 [客户端受众投影](../../src/client/data/rule-facts.ts)）；它同时回答是否包含 context activation。`ruleFacts` 是展示上界，不参与执行门控。

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

普通 `request-retry` 动作是默认关闭的有界拒绝重试：在 `llm/stream` 下游调用前缓冲开头约 400 个文本字符后判定，匹配范围最多前 600 个字符，遇到推理增量、工具调用或 `finish` 提前决定；块级正文与 `text-delta` 用同一份累积，同一 `index` 已有增量时不再并入块正文。命中后只透传首尝试已到手的 `usage`、结束上游，再以「原 `messages` 末尾追加一条 `user` 正文」发起一次真实 `llm.stream`；不改原 `messages` 元素、不写 durable 历史、不新增用户轮、不改 provider/model/工具目录/取消身份，输出块与 `replayState` 归第二次尝试。一次原始请求最多两次实际调用：首请求与重放请求的 `options` 都进同一 claim 集合，多来源命中共享一次额度，同值共存、异值告警并保留先到装配；第二次不再进入本能力，其自身失败直接冒泡，不叠加本来源的重试。正文优先取 `templateFile`（与 `inject-text` 同一模板解析与越界校验），缺模板时用 `text`；空正文挂载期拒绝。`authored` 目的（`options.purpose`）与已取消请求不重放。用量只沿官方出口，未取得时不补零；命中的首尝试 `finish` 走透传分支，不会与第二次混合。已知代价：追加的 `user` 正文在 wire 层会被部分 provider 并入最后一条 user 消息，且它不落 durable 历史，压缩或恢复后无法重建——这是「不改原 options 与持久历史」的取舍，不是缺陷。

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

九层展示序来自 `LAYER_ORDER`；六层可注入清单来自 `getEngineMeta().injectionLayers`。agent-request、llm-stream、tool-pipeline 分别使用请求参数、流输出和工具动作，不能作为 inject-text 的 config.layer。规则顶层 layer 是动作未写 config.layer 时的缺省及展示归属。详细载荷见 [九层契约](../injection-point-contracts.md)。

跨模块同点顺序来自 module.yml.configOrder；同点动作按声明顺序，显式 channelOrder 冲突拒绝。order 只管所属官方插入点的位置，不建立跨层总顺序。pre-step 中注入和过滤可以交错 flush，后批继续排在仍存活的同位置消息之后。

注册层的段/上下文顺序不靠官方 order 数值表达：官方先按 order 与名称排好初始槽位，本插件以最外层 prepend 监听 `system-prompt/assemble`，在 `next()` 之后按 `configOrder`（`sequence`）把已注册的段/上下文回填到原槽位；未注册的平台段与其他插件段槽位不动。`complete` 生效时平台在瀑布**之后**才用预捕获的段替换 `sections`，重排器在瀑布内执行、最终输出仍由平台覆盖，该场景不保证顺序。跨档位拖动只改 `configOrder`，不改官方 `order`。

### 同 scope 内的注册顺序（2026-09-22）

Cordis waterfall 普通注册先注册者在外；prepend 注册插到最外层，同为 prepend 时后注册者更外。非注入动作通过 `waterfallPosition: outermost` 表达该要求，同点仍按编译顺序接线。inject-text 的位置属于官方插入层，不接受这个注册后门。

## 历史读取与去重

| 入口 | 语义 | 主要消费者 |
|---|---|---|
| `currentEvents(session)` | 模型当前可见 surface | 注入去重、上下文历史扫描、anchor、session.present、最后对话事实 |
| `historyEvents(session)` | 完整 durable 日志 | 晋升重建、模板执行边界、工具解锁、tool-call/turn 计数 |

surface 缺失或非法时可见视图退回完整日志；合法空 nodes 就是空上下文。需要消息数量的消费者按 seq/id 去重，不给所有读取强加同一过滤。count 的消息类信号看可见面，tool-call/turn 看完整日志。取舍见 [ADR-0010](../adr/0010-two-history-views.md)。

`dedupe: session` 表示“该身份在当前可见上下文只出现一次”，不是持久历史终身一次。成功压缩或替换遮蔽旧消息后可再次注入；条件未命中或未被接纳不占去重。身份包括来源模块、通道和 identity；旧无模块维的已投递消息保守识别。memo 仅加速，不成为另一份投递真值。

按需提醒可组合关键词条件与 `dedupe: session`：历史关键词持续命中时，可见上下文中的说明不随工具步骤重复追加；旧注入被压缩或替换遮蔽后，仍须满足关键词条件才重新投递。包升级不覆盖用户模块，需要去重时须在其注入配置中显式声明。

## 晋升语义（epoch-aware）

会话开始及每次成功压缩开启新 epoch。压缩失败不换 epoch；重挂、重启或恢复从 durable 边界重建。tool-call/assistant-message 按显式 promoteOn 推进；子代理参与、推理门和最大步数须由配置选择。PTC 是工具呈现，晋升是状态转移，两者正交。

`phase.promoteAfterFirstTool:true` 显式允许首步已实际调用工具后晋升，默认false，原锚点/首响应语义保持；`maxPromoteSteps` 必须是正安全整数。phase在主/子会话分别计数，只有成功压缩开启新Epoch，失败压缩不重置；这与参考脚本对任意compaction/end重置的行为不同。`pre-step-filter.instructionHint` 为非空可编辑模板，使用 `{{FILES}}` 填入本次可靠识别的官方指令路径。它复用既有指令提示转换，仅在规则命中时把后续官方全文替换为一次提示；已有可见提示时不再重复，无法识别路径和非目标来源保持，撤回后放行后续全文，不补发历史。

## 上下文激活与诊断

`selectContextActivation` 在批首对已合格配置求值，候选集合跨所有 flush 共用；过滤掉赢家不另选同组后补。选择分为 candidate/selected 与实际注入后的 commit，未投递不提交时间窗。状态包含概率、候选组、评分、sticky/cooldown/delay 和有界递归；算法与 ST 转换使用同一原生入口。

扫描面必须显式 batch/history，关键词和 scanVariables 通过来源模块两域快照只读求值；赋值表达式拒绝。激活变量读取不获得任意目录或写权限。参数及独立真值表见 [激活映射](../SillyTavern.md#世界书到上下文激活)。

`lastContextActivationDiagnostics(session)` 只返回最近一次快照，不重新扫描或抽样。快照区分尚未求值与已求值但为空；记录最多200条，truncated 只限制展示，不改变选择。commit 与快照引用同源，工作台显示实际投递事实。诊断不是永久审计记录，也不证明不可见的第三方行为。

## pre-step 协调器与官方指令过滤

宿主 `src/runtime/pre-step-coordinator.ts` 汇总模块规则与直接来源，在**一个** `prepend` 监听器里显式先过滤官方待注入指令、再执行规则批；顺序是代码事实，不依赖监听器注册先后。来源白名单过滤器使用真实已领取 payload，不将下游增量当原始消息。官方监听器（如 `dsh-tool-skill` 的技能目录）在 `await next()` 之后才 append messages，协调器拿到完整 decision 后先删再跑批；同一 pre-step 中 `instruction-policy` 的动作判定在过滤前固定，并把命中结果带入批执行，避免过滤、导语与批处理跨快照漂移；batch 异常时仍返回已过滤的 decision。协调器自身仍是 `prepend` 监听器，只有这样才能看到官方监听器在 `await next()` 之后追加的消息；「不依赖注册先后」只指 filter 与 batch 的相对顺序。

无协调器的 standalone 路径（`applyPromptConfigSources` 单独执行批）是例外：`prepend` 只由 `options.prepend` 与配置的 `prepend` 决定，纯 `ruleAction` 的 `pre-step-filter` 拿不到最外层，`skill-surface` 在那种部署里可能删不掉官方目录。出现第二个无协调器消费者时，把「需要最外层」上收到动作语义再统一，而不是给判据加更多特例。

协调器服务 v2 持有唯一的 promotion pool/pair，并把它暴露给来源生产者；`registerPreset(sourceId, source)` 消费 source 自带的 ctx/onOutcome/promotion，不再改写 `config.resolve`，也不再从 config 反推模块。批执行由 `runPreStepBatch({ sources })` 合并来源，判定上报使用对象形状；pre-step 来源的 `source.ctx` 绑定 `resolve`，条件帧使用批级 ctx。

逐文件关闭只过滤能够可靠识别的未来官方正文和 change 元数据；无法识别或无法分段时保留并报告。不撤回历史、不补回官方预算裁掉的内容，不以文件卡开关阻止官方磁盘读取。重新开启也不强制重放。

普通规则可声明 `instruction-policy` 动作并给出现有 `fileIds`，只为当前真实 Agent 增加局部关闭贡献。该动作不写共享 `instructions.yml`、不复制正文；多个规则按文件叠加，撤回一条仍保留其它关闭贡献，全部撤回后按最新共享值放行。无可靠 Agent、身份或分段时沿放行诊断，不把规则状态扩成全局开关。

### 指令提示的晋升与重置

模块级 `instructionHint` 默认关闭。启用后，每个来源模块独立处理逐文件过滤后即将注入的官方消息。工作台共享参数默认包含子代理，默认晋升条件 `either` 表示首次工具调用或助手消息均可触发。主会话与参与的子代理在首个请求保留全文，晋升后使用路径提示；成功压缩开启新一轮，首个请求再次保留全文。直接编写引擎组合行时，省略 `includeSubagents` 的默认值为 false。见[共享参数声明](../../src/shared/engine-params.ts)和[引擎行配置](../../engine/instruction-hint.mjs)。

仅在晋升条件成立且有有效 `messageTemplate` 时转换。空模板保留原文，官方内容无法可靠分段时原样放行并记录诊断。转换只影响待注入消息，已进入历史的正文保留。正文编辑和文件授权见[指令文件契约](params-editors.md#指令文件与逐文件过滤策略)。
