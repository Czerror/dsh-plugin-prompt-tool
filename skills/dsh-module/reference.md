# 模块参考

按任务读取对应章节。路径均相对实际插件包根；技能复制目录不等于包根。包内契约优先于本摘要，查一个问题只展开对应文件。

## 契约入口

| 要确认的事实 | 随包入口 |
|---|---|
| 条件名称与字段 | `engine/conditions/index.mjs` 的 `PREDICATE_FACTORIES`，再读对应条件文件 |
| 执行点能取得的事实 | `engine/conditions/subject.mjs` 的 `CHANNELS`、`channelTextSubjects`、`channelFactSubjects` |
| 动作字段、执行点、降级 | `engine/actions/catalog.mjs` 的 `ACTION_KINDS`；最小形状见 `engine/actions/examples.mjs` |
| 注入层、策略、字段矩阵 | `engine/schema.mjs` 的 `getEngineMeta()`，或运行实例的 bridge `/meta` |
| 规则候选校验 | `engine/rule-spec.mjs` 的 `compileRules`；运行中用规则工具的 `validateOnly` |
| 宿主控制的作用域与值 | `engine/host-control-catalog.mjs` 及它引用的 validator |
| 能力行与行级默认配置 | `engine/compositions/source/local/`；模块实例见 `modules/` |
| 共享参数的键、类型与磁盘归属 | 工作台参数信息；离线只读检索 `lib/index.mjs` 中的 `ENGINE_PARAM_DEFINITIONS` |
| 声明样例 | `templates/`（通常是一条规则，合入 rules）；自定义工具见 `templates/tools/` |

源码 checkout 的参数权威文件为 `src/shared/engine-params.ts`。npm 包不包含 `src/`、`docs/`、根 `module.yml` 或开发 `scripts/`；安装环境按上表查，读取编译产物只用于核对，不编辑它。无法读取包或运行契约时，报告缺项，不猜未列出的能力。

## 条件与事实

`if` 是单键节点：一个谓词，或 `all/any/notAny` 的非空数组、`not` 的单节点。省略 if 才表示无条件。只有严格 true 执行 then，已知 false 才走 else；必要事实不可用时两支都不执行。

| 谓词 | 选型与易错处 |
|---|---|
| `text` | keys 关键词或 minChars/maxChars 长度；两者同时声明时取交集，subject 必须在执行点可用；pre-step 的 userMessage 读取本批真实用户文本 |
| `phase` | 晋升/压缩相位；promoted 缺省 true，`'ignore'` 必须同时声明 compacted；“已晋升或已压缩”用 any 两支 |
| `source` | kind/plugin 同时写为合取；精确或前缀匹配，支持字符串数组 |
| `count` | of/per/min/max/every；至少约束一个计数边界。消息类计数看可见历史，tool-call/turn 看完整日志 |
| `names` | 工具通道的工具名，子代理事件的 provider 名；allow/deny 与大小写选项见条件实现 |
| `session` | 指定事件 type 是否 present；缺省 false 表示该事件尚不存在，不等于“首条真实用户消息已接纳且只注入一次” |
| `preset` | 当前挂载的官方 presetId，无法查询为 UNAVAILABLE |
| `scope` | audience: main/subagent；modelScope: all/pro/flash |
| `anchor` | 匹配已接纳、当前可见的结算输出；after.action 关联本规则实际投递，详见下文 |
| `variable` | key、op、value、scope；scope 缺省 effective，另有 session/module/global/runtime；eq/ne/in/数字比较/present/absent，value 用字符串或字符串数组 |
| `tool` | `{ name: 工具名 }` 查询本步骤真实可执行工具及依赖；缺失为 UNAVAILABLE，不能用 not 推断“工具不存在” |
| `manifest` | `{ ok: true/false }` 查询来源模块清单 checks；缺清单/读取器或损坏为 UNAVAILABLE |
| `soul` | `{ pending: true }` 查询当前来源模块的到期事项；需要绑定真实会话与提醒事实 |

按执行点选事实：

- pre-step 有本批真实用户文本；按子代理任务内容分档，在此组合 `scope.audience: subagent`。
- tools/pre-execute 有工具名与参数；post-execute 另有结果。
- system-section/runtime-context 在 assembly 判定，能沿真实 Agent 查询会话、模型、变量等事实；没有当前用户文本、工具名或 source。当前输入文本匹配应放 pre-step。
- llm/stream 本身没有文本 subject；可按真实 Agent/sessionId 查询会话事实。
- subagent/start/end 有 provider/id/local 等事件事实，没有任务正文；文本用 subagentInfo。

`dedupe: session` 按当前模型可见上下文去重，压缩或替换后可能再次注入。它与可见消息计数均不承诺“整段会话终身仅一次”；按需求验收压缩、恢复和多次 assembly。

## 动作与执行点

字段白名单与可运行例子以契约入口为准；表中只列选择依据。

| 动作 | 用途与边界 |
|---|---|
| `inject-text` | 在六个注入层投递正文；config.layer 决定位置，空正文不投递 |
| `persona` | 原官方 assemble 前准备人设与选项；见人设与变量 |
| `assembly` | assemble 下游调整 sections/contexts；tools 改用 tool-visibility；keep 与 add/remove、clear 与 add/remove 各自互斥 |
| `tool-visibility` | 同时控制工具呈现和执行面；allow 后再 deny，允许同时声明 |
| `tool-gate` | tools/pre-execute 的 allow/deny/ask；reason 属于此动作；工具名用 names 条件 |
| `tool-result` | tools/post-execute 的 accept/replace/block；另有 edits，具体结构读实现 |
| `append-context` | 工具结果后追加上下文；续跑用 turn-stop 注入 |
| `request-params` | agent/request 下游改 patch/unset/replace；unset 需期望值，replace:true 需 provider/model；专用 maxTokens 有 early 依赖 |
| `request-retry` | llm/stream 检测拒绝前缀后最多重放一次，text/templateFile 给第二次尾部 user 正文；不是网络重试或备用模型切换 |
| `stream-output` | llm/stream 的 pass/replace，替代 text 不改请求 |
| `inbox-prepend` | 收件箱前置消息，target 为 next-turn/next-step |
| `pre-step-filter` | sources 或 keepKinds 互斥；blockPlugins 正交；instructionHint 只处理可靠识别的官方指令 |
| `instruction-policy` | 当前 Agent 的 fileIds 关闭贡献与 intro；不改持久策略或原指令文件，不提供强制开启 |
| `host-control` | capability/value 选择宿主额度、审批、文件、请求投影等控制；先查作用域与依赖 |
| `subagent-params` | provider: spawn、明确 tool 与 maxDepth；仅约束所选委派入口 |

动作分支是数组中的 `{ if, then, else }` 节点，不把 if 写进带 kind 的动作。通用排序与 `maxPerTurn` 是否可用，由规则编译器检查；maxPerTurn 计本动作本轮生效次数，count 计事件。

### 工具可见面

禁用工具的一条完整规则：

```yaml
id: no-web
then:
  - id: hide-web
    kind: tool-visibility
    deny: [web_search, web_fetch]
```

一份声明裁目录、PTC 的 tools:sdk 正文与执行闸。仅限子代理时，加规则条件 `if: { scope: { audience: subagent } }`。

收窄用 allow，可选 `requireMatch: true`：仅当常驻名单一个也未出现在当前工具面时放宽，部分缺席照常收窄；解锁名不参与放宽判定。按需发现用 `discovery: { kind: tools }`，模块同时声明 `tool-search` 能力行。discovery 的 tool/key 只是断言，实际工具名由适配器决定。

提示用普通注入的 `strategy: placeholder`、`fill: tool-catalog`、`params: { action: 可见面动作id }`；目标须有 allow。只读变量 RESIDENT_TOOLS/DISCOVERY_TOOL 来自实际目录，不复制名单，不开启 templateEvaluation。PTC 保留传输工具 run_code，不必加入 allow。

### 宿主控制

从 `engine/host-control-catalog.mjs` 查 capability 的 scope，再读对应校验器。Agent 规则使用当前真实步骤；process 能力要求规则 `executionScope: process`，不能附 Agent 条件，只影响其声明的后续进程行为。

审批自动决定、文件写入、升级、沙箱软默认等会改变权限边界；按用户授权选择具体 value，不由名称猜开关含义。依赖验证失败或能力不可用时查看诊断与受影响分支，不能通过写 YAML 绕过真实 owner。

`persona.instructionsMaxBytes`、`request-params.maxTokens` 及部分 host-control 依赖官方入口前的 `dsh-plugin-prompt-tool/early` 与发行指纹。具体依赖看能力实现及运行诊断；编译通过不证明 early 已生效。缺接缝时受影响声明暂停，不自行改宿主或重启。

## 注入层

九层相互独立；规则 layer 只提供缺省与展示归属，动作显式 config.layer 优先。字段矩阵读 `getEngineMeta().layerFieldPolicies`。

| 层 | 通道/可用策略 |
|---|---|
| pre-step | agent/pre-step：static、placeholder、context-activation |
| system-section | systemPrompt.section：static |
| runtime-context | systemPrompt.context：static、placeholder |
| agent-request | request-params 等专用动作，无 inject-text |
| llm-stream | stream-output/request-retry，无 inject-text |
| tool-pipeline | 工具动作展示归属，无 inject-text |
| turn-stop | agent/turn-stopping：static |
| subagent-start | subagent/start：static |
| subagent-end | subagent/end：static；params.action 为 observe/inject-main |

position/role/promotion 属 pre-step；dedupe 另支持 turn-stop 的 none/session。普通 system-section/runtime-context 文本可动态判条件；inject-text 的 complete/suppressRuntimeContext 是固定注册效果，动态分支仍拒绝，动态人设选项用 persona。

### 确认后注入

同规则先用普通 inject-text 投递锚句，再用分支 `anchor.after.action` 引用该动作；等待条件只包后续正文，不能包住锚句本身。完整样例在 `templates/16-custom-fallback.yml`。

关联目标须为 separate 模式的 pre-step/runtime-context/turn-stop 注入；缺引用、自引用、循环、投递身份歧义、system-section/merged 目标拒绝。未接纳或不再可见的起点为 UNAVAILABLE；旧输出与 fork 继承不算当前会话的新投递。

anchor 默认 prefix 按 ASCII 忽略大小写的字面前缀匹配；正则、副键等需显式 scan。可选 fallbackAfter 为正整数，计含所选内容块的完整输出，中断不计。默认等下次正常请求，显式 turn-stop 续跑仍受预算与取消约束。匹配本批用户正文用 text.userMessage；anchor.userMessage 看已接纳历史。

## 参数与宿主控制

共享模型/能力参数由 ENGINE_PARAM_DEFINITIONS 登记，storageLayer 决定 `layerSettings.<层>.params`，不按 UI 所在层猜路径。数值参数沿当前 schema 的字符串表示；变量空串与参数空值不能混为一谈。

主/子模型路由与采样在装配期生成受众限定 request-params，未配置继承宿主。PTC、Git Bash、指令提示、自定义工具批准使用同一目录。moduleConfigs 仍是合法行级配置；已声明共享参数优先，不能借行配置绕过批准。

能力行从 `engine/compositions/source/local/` 选择，官方工具、规划、压缩与普通委派沿用会话预设。递归深度有 subagent-params；它不等于全局改写所有子代理入口。

present-as 在真实主/子 Agent scope 挂载官方 native/PTC 执行器；依赖缺失明确不可用，同 scope 冲突由官方拒绝。PTC 用官方 `process.cwd()` 与当前工具面的 `tools.bash`/`tools.pwsh`；默认 Node/per-call 环境初始为空，不假设有等价 env 对象。

## 工具与数据所有权

所有模块工具显式传 `moduleId`；UI 当前编辑模块不替代调用主语。工具只访问模块存储根下既有模块。`expectedModuleId` 是 bridge 一致性检查，不是模型工具参数；实际参数与版本字段以当前工具 schema 为准。

| modules 能力 | 工具/用途 |
|---|---|
| module-rule-tools | module_rules_read / module_rules_edit：完整规则与版本事务 |
| module-variable-tools | module_variables：global/module/session 的 list/get/set/delete |
| module-file-tools | module_file_read / module_file_append：memory.md、assets/ 只读、data/ 受限追加 |
| module-manifest-tools | module_manifest：assets/manifest.yml 的 next/check/apply |
| module-import-tools | module_import：预览、选择、候选提交 |
| soul-ledger | soul_ledger / soul_state：账本及真实会话状态 |
| retrieval | module_search / module_open：授权来源检索、引用与读取 |
| tool-config-engine | customTools：shell/http/delegate/fs/ask-user，沿官方批准与取消管线 |

变量先 list/get 取版本再写；set 必须显式字符串，空串有效，delete 才回落。global 影响同安装所有模块；session 只操作真实当前会话，带 revisions.session 等待持久化。

通用文件工具不覆盖文件；`data/02-soul.jsonl` 与旧 `data/02-墨.jsonl` 的追加必须走 soul_ledger。账本作者、时间和关闭权限由真实会话决定，不通过通用 append 绕过。

manifest 的 dirs、files.to、checks.path 限 data/，files.from 限已有 assets/ 单文件；checks.kind 为 file/text/json/jsonl。next 找首个缺失，check 汇总检查，apply 只建目录和缺失文件，不覆盖删除；未知字段、越界或链接拒绝。

内置 assets 按完整 moduleId 逐文件查找：用户覆盖优先，缺失才读包内同名模块；空文件是覆盖，错误或链接不回退。memory.md/data/ 无包内回退。改名复制或另存由正式流程补齐资产，不从名称后缀猜来源。私有记忆与数据不因规则保存、模块关闭或升级而清理。

## 人设与变量

persona 支持 prefix/suffix、complete/includeRuntimeContext、audience、stripDefaultIdentity、instructionsMaxBytes。命中正文按规则和动作顺序分别拼接；字段全省略才继承，显式空串阻止该字段继承，不清其它片段。布尔显式值或指令预算冲突拒绝整组并保旧；全失配/事实不可用回官方，配置/求值/注册错误保最后有效组。includeRuntimeContext:true 只撤本插件抑制。

stripDefaultIdentity 为 preset/harness，只针对已识别的对应身份正文。instructionsMaxBytes 是正安全整数，依赖见宿主控制。正文与选项归普通规则，不保存顶层 persona 或 personaSources。

裸变量依次取 session→module→global。普通规则手动建立变量；ST 导入才自动登记缺失裸引用为空占位。工作台只编辑 module/global；session 由官方 storageDomain 按来源模块＋真实会话隔离持久化，不随 fork 复制。

赋值模板显式 `params.templateEvaluation: true`，使用 module/global/session 的 set/get/add/inc/dec；单卡只写一个持久域，实际读取域都参与 CAS。session setter 仅在可等待的规则执行和模型工具提交，人设同步出口只读 session。runtime 是只读事实，扫描、预览、SELF 只读。发布重试不重放赋值，不承诺跨进程崩溃 exactly-once。

## 上下文激活

context-activation 只在 pre-step；`params.activation.scan` 显式 batch/history，历史只扫描模型可见的真实对话。scanDepth:0 不扫描聊天、变量或递归正文，常驻项例外。

keys/secondaryKeys、constant、匹配选项与副键逻辑由 activation 拥有；副键先开启 selective，未开或无副键只要求主键命中，空主键不自动常驻。P/S 为主/副键命中数，N 为原副键项数（求值为空仍占一项）：

| selectiveLogic | 条件 |
|---|---|
| AND_ANY | P>0 且 S>0 |
| NOT_ALL | P>0 且 S<N |
| NOT_ANY | P>0 且 S=0 |
| AND_ALL | P>0 且 S=N |

wordBoundary 的 unicode 是原生字母数字边界，ascii-token 是 ST 单词 ASCII/多词子串规则。概率、selectionGroup、评分、sticky/cooldown/delay 与递归约束查 `engine/context-activation.mjs`；候选组与规则 group/exclusive 分开。模块递归由 contextActivationRecursive 开启，默认 false，池跨模块共享。

## 导入与旧格式

ST 预设、PNG/JSON 角色卡和世界书优先走工作台或 module_import。先预览并完成选择，提交原始 files 与返回的两份预览凭据；来源、目标或凭据过期就重新预览。默认另存且不自动启用，报告与生成后的 enabled 一起检查。转换不执行 STscript 或任意来源代码，不支持的宏/控制明确报告。

显式转换旧内部模块时，先保留授权范围内的备份与未知资产，然后逐项转换：

1. world-book/stWorldBook 执行字段改为 context-activation，明确 scan 和具名副键逻辑；来源与不可等价项保留在 source.original。
2. stMacros 与 set/get/add/inc/decvar 按 parser 语义转为 module/global 操作；动作 config.variables 提升到顶层 variables，同名冲突先解决，ST 局部变量不自动变成 session。
3. 顶层 persona 与 config.yml.personaSources 改为普通 persona 规则，保留省略/空串/false 与受众语义，核对新规则启停及排序。
4. 旧能力对照当前目录替换，保留未改分支和参数；memory.md、私有数据与来源证明保持。旧私有标记不能只删除后导出。
5. 在隔离候选中校验、读回并检查不等价报告，再按授权提交；失败保留原定义。

插件不自动迁移上述退役输入；当前合法的 moduleConfigs 不能整段当成旧格式删除。种子只补缺失，不覆盖已有模块或技能副本。
