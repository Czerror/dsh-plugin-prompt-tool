# 模块参考

由 `SKILL.md` 的指针进入：挑条件、挑动作、查层字段、查模块名与参数时读它。

权威来源是源码：`engine/rule-spec.mjs`、`engine/conditions/`、`engine/actions/catalog.mjs`、
`engine/schema.mjs` 都在**插件包内**；参数表的源头是 `src/shared/engine-params.ts`（只有源码仓库里有，
装态对应 `lib/` 的编译产物）。本文件是摘要，**冲突时以源码为准**。

**这些路径相对插件包根，不在本技能目录下。** 技能随包分发、装在 `$DSH_HOME/skills/dsh-module/`，
而 `engine/`、`modules/`、`templates/` 在插件包里。包名 `dsh-plugin-prompt-tool`，定位用环境变量
`$env:DSH_PROFILE_DIR`（bash 里读 `$DSH_PROFILE_DIR`）——包就在它的 `node_modules/` 下。读包内文件用
**文件读取工具**：Desktop 部署下包可能落在 `app.asar` 里，shell、glob、grep、node 都打不开它。
找不到包时用本摘要说明边界；需要确认未列出的能力时读取实际安装契约，不猜测支持。

## 一、条件谓词（`if` 里能写什么）

`if` 是**单键节点**：要么组合算子，要么一个谓词。缺省即无条件。

组合算子：`all` / `any`（非空数组）、`not`（单节点）、`notAny`（非空数组）。

| 谓词 | 字段 | 语义与边界 |
|---|---|---|
| `text` | `keys` / `secondaryKeys`，或单独 `minChars` / `maxChars`（含端点的非负安全整数）；`logic`（any/all/not/notAny）；`mode`（scan/prefix）；`caseSensitive`；`wholeWords`；`useRegex`；`wordBoundary`；`subject` | 关键词与长度同时声明时取交集，minChars 不得大于 maxChars；userMessage 读取本批全部真实用户文本。动作级条件必须声明本通道可用的 subject；缺事实不执行 |
| `phase` | `promoted`（缺省 `true`＝只匹配已晋升；`false`；`'ignore'` 必须同时写 `compacted`）；`compacted`；`promoteOn`（`either`/`tool-call`/`assistant-message`）；`includeSubagents`（缺省 false＝子代理视为已晋升）；`promoteGate` + `reasoningPattern`/`reasoningNegativePattern`/`reasoningFlags`；`maxPromoteSteps`；`promoteAfterFirstResponse` | 晋升相位。**单个节点表达不了「两个相位都命中」**，用 `any` 拼 `{promoted: true}` 与 `{compacted: true, promoted: false}` |
| `source` | `kind` / `plugin`（字符串或字符串数组，两个都写是**合取**）；`caseSensitive`（缺省 true）；`match`（`exact` 缺省 / `prefix`） | 消息来源。列举多值要析取时用 `any` 显式写两支 |
| `count` | `of`（`tool-call`/`tool-result`/`assistant-message`/`assistant-chars`/`user-message`/`turn`）；`per`（`session` 缺省 / `turn`）；`min` / `max` / `every`（**至少写一个**，否则恒真）；`includeCurrent`；`delegated` | 消息类信号按可见历史；tool-call/turn 按完整日志，冷启动按相同视图重建 |
| `names` | `allow` / `deny`；`caseSensitive`（缺省 true） | 名称名单：工具名（工具通道）、子代理 provider（`subagent/start`、`subagent/end`） |
| `session` | `type`（事件类型，如 `user/message`）；`present`（缺省 `false`＝该事件还没有）；`delegated` | 会话态。判「首轮」用 `{type: user/message, present: false}` |
| `preset` | `presetId` | 当前**挂载**的官方会话预设；取不到时返回 `UNAVAILABLE`（不乐观放行） |
| `scope` | `audience`（`main`/`subagent`）；`modelScope`（`all` 缺省 / `pro` / `flash`） | 受众与模型范围。这是**唯一**该写这些门的地方 |
| `anchor` | `subject`（userMessage/assistantReasoning/assistantText/toolResult，缺省 assistantReasoning）；`keys`；scan 模式可选既有匹配选项；`after: { action: seed }`；可选正整数 `fallbackAfter` | 当前可见已结算消息确认；缺省 prefix 只按 keys 作 ASCII 忽略大小写的字面前缀匹配，显式 secondaryKeys/caseSensitive/wholeWords/useRegex/logic/wordBoundary 一律拒绝，需这些选项时用 scan。关联只看同规则动作实际投递后的输出；第 N 个含所选内容块的完整输出仍未命中时兜底，中断模型消息不计，省略持续等待 |

拿不到必要事实时谓词返回 `UNAVAILABLE`：只有严格 `true` 才执行；`any` 遇已知 `true`、`all` 遇已知
`false` 仍可决断。

## 二、动作（`then` / `else` 里能写什么）

`then` 是非空数组；每个动作要有唯一非空 `id` 与合法 `kind`。动作级分支写成 `{ if, then, else }`
节点嵌在数组里，可嵌套。else 必须有对应 if；必要事实未知时两支都不执行。

| 动作 | 执行点 | 主要字段 | 失败时 |
|---|---|---|---|
| `inject-text` | 由 config.layer 决定（**六层可注入**，agent-request/llm-stream/tool-pipeline 只作展示归属） | layer、strategy（static/placeholder/context-activation）、position、dedupe、mergeMode、role、order、text/texts、params、templateFile、configKind | 空正文不生成投递；变量赋值模板另按显式求值事务处理 |
| `assembly` | `system-prompt/assemble` 下游 | `target.sections`（`add`/`remove` **或** `keep`）、`target.contexts`（`add`/`remove` **或** `clear`，二者互斥——并存编译期拒绝）；`target.tools` 已移除 | 返回未改动的装配 |
| `tool-visibility` | system-prompt/assemble 下游 | allow 与/或 deny（先保留再剔除）、requireMatch（仅 allow）、discovery（{ kind }；tool/key 可选，只作断言）；受众归 scope，提示归普通注入动作 | 呈现面失败保留原装配；执行闸失败留痕，不静默放行 |
| `tool-gate` | tools/pre-execute | decision（allow/deny/ask）、reason；工具名归 names 条件 | 一律放行——裁决 bug 不卡死调用 |
| `tool-result` | tools/post-execute | action（accept/replace/block）、text（仅 replace/block）；工具名归 names 条件 | 一律接受——结果处理 bug 不把调用变成失败 |
| `append-context` | tools/post-execute | text；续跑用 inject-text 的 turn-stop 层 | 保持原结果 |
| `request-params` | `agent/request` 下游 | `patch`（浅合并）、`unset`（`{键: 期望值}`）、`replace`（整体替换） | 保持原请求配置 |
| `stream-output` | llm/stream | mode（pass 缺省 / replace）、text（替代正文） | 保持原流 |
| `inbox-prepend` | `agent/inbox/inserted`（emit，无 next） | `target`（`next-turn` 缺省 / `next-step`）、`text` | 不命中即什么都不做 |
| `pre-step-filter` | `agent/pre-step` 下游 | `sources` **或** `keepKinds`（互斥，未声明即不过滤）、`blockPlugins`（正交，空＝关闭） | 异常时保留全部消息 |

通用规则：

- 名单类参数（allow/deny/sources）写成逗号分隔字符串或字符串数组都接受。
- 工具可见面的 `allow` 与 `deny` 可以同时给：对齐官方 `ToolRestriction`，先按 `allow` 保留、再按 `deny` 剔除。
- `maxPerTurn`（正整数）用在 `assembly` / `tool-gate` / `tool-result` / `append-context` / `request-params` /
  `inbox-prepend` / `pre-step-filter` 上；它数的是「本动作本轮生效几次」，
  与 `count` 谓词（数持久事件）是两回事。
- `complete` 与 `suppressRuntimeContext` 是**固定注册效果**：所在规则不带 `if`（注册期即生效）。

### 禁用或收窄某个工具

工具的装配面由**会话原有预设**与各模块共同决定，所以「禁用」必须同时落到呈现与执行两层——只做一层会留下可见痕迹：

```yaml
rules:
  - id: no-web
    then:
      - id: hide-web
        kind: tool-visibility
        deny: [web_search, web_fetch]
        reason: 本模块不开放联网工具
```

一份 deny 名单同时裁装配目录、tools:sdk 正文，并在 agent scope 注册执行闸——会话原有预设装的行也归它裁决，经 run_code 的子调用同样被拒。要让禁用只作用于子代理，在规则或分支写 if.scope.audience: subagent；不设受众条件则两者都执行。

要收窄，用同一动作的 allow 白名单（范例见 modules/tool-surface/module.yml），并按需声明 discovery：

```yaml
- id: narrow
  kind: tool-visibility
  allow: [pwsh, read, write, edit, glob, grep, todo_write, skill_search, skill_load, tool_search, bash]
  discovery: { kind: tools }
  requireMatch: true
```

声明 discovery 的模块必须在 modules 里列出对应适配器行（tools → tool-search），缺行在装配准备期失败。discovery 在首次装配时按 agent 解析适配器，并从持久 tool/call 参数回收解锁名（只做加法、跨压缩保留）；工具由适配器行注册，discovery.tool/key 可选、只作断言。提示用同规则普通 inject-text 组合 count（user-message，max: 1）与 session 去重，采用 strategy: placeholder、fill: tool-catalog、params: { action: narrow }。只读 RESIDENT_TOOLS 是引用动作 allow 去 deny 后的逗号名单，DISCOVERY_TOOL 是当前 Agent 的发现适配器工具名；模块 text 控制提示正文，保留自动名单而不复制声明。requireMatch 在任一常驻工具缺失时放弃裁剪、暴露完整目录（fail-open），声明名单不等同实时工具面。allow 的执行面由 guard 兜底，不调用 restrict——restrict 的 allow 只收继承面名字，而全局 schemas 视图会漏预设/祖先层工具，局部 allow 反而会把它们裁掉；deny 才用 restrict + guard。PTC 下 tools 数组只有保留传输 `run_code`，实际可见面是 `tools:sdk` 正文；`run_code` 不写进 allow 也保留，且不参与 requireMatch，因此原生收窄声明可以直接与 PTC 共存。

tool-catalog 引用目标必须有 allow；仅支持普通只读插值，`templateEvaluation: true` 拒绝。未知动作引用保存前拒绝，发现适配器不可用则跳过提示并告警。

## 三、九层与字段

层是官方扩展点，彼此独立，没有跨层运行顺序。规则顶层 layer 是动作未声明 config.layer 时的缺省及展示归属；
动作显式声明 config.layer 时优先使用动作值（工具、装配、请求类动作自带执行点）。

层字段矩阵（`position` / `dedupe` / `promotion` / `audience` / `modelScope` / `merge` / `order` / `role` / `placeholder`；config 里写 `mergeMode`）由 `/meta` 的 `layerFieldPolicies` 下发，根 `module.yml` 也由同一份 `engine/schema.mjs` 生成；本文不再抄写，避免第三份副本漂移。

| 层 | 官方入口 | 可用策略 | 层内 `params` |
|---|---|---|---|
| `pre-step` | `agent/pre-step` 消息批 | static/placeholder/context-activation | — |
| `system-section` | `ctx.systemPrompt.section` | `static` | `sectionName` `complete` `suppressRuntimeContext` |
| `runtime-context` | `ctx.systemPrompt.context` | `static` `placeholder` | `contextName` |
| `agent-request` | `agent/request` | — | request-params 动作的 patch/unset/replace |
| `llm-stream` | `llm/stream` | — | stream-output 动作的 mode/text |
| `tool-pipeline` | 仅展示归属（**无注入通道**） | — | 工具链的裁决 / 结果处理 / 追加上下文改用 `tool-gate` / `tool-result` / `append-context` 动作 |
| `turn-stop` | `agent/turn-stopping` | `static` | — |
| `subagent-start` | `subagent/start` | `static` | — |
| `subagent-end` | `subagent/end` | `static` | `action`（`observe`/`inject-main`） |

三条边界：

1. 层字段以 `/meta` 的 `layerFieldPolicies` 为准：`position`/`role`/`promotion` 在 `pre-step`，`dedupe` 另支持 `turn-stop` 的 none/session。
2. 声明式 `config.subject`/`config.match` 已删除；live 条件在规则 `if` 里写 `text.subject` / `anchor.subject`，
   可选值见 `/meta` 的 `subjects`。按任务内容分档放在 `pre-step`——`subagent/start` 的事件里只有
   provider 与 id，没有任务文本。
3. system-section、runtime-context 的普通文本贡献支持规则级 if 和嵌套 `{ if, then, else }`，
   每次 assembly 在条件文本贡献通道按当前事实求值，不动态重注册段；if.scope.audience 是常见写法。
   complete / suppressRuntimeContext 属固定注册效果，仍拒绝动态条件分支；complete 表示同 scope 唯一 system 段。

策略 × 层：static 在六个可注入层；placeholder 在 pre-step、runtime-context；
context-activation 在 pre-step。分类与正文用通用条件和分支组合（模板15），动态内容策略使用既有 resolver。

### 确认后注入

先用普通 `inject-text` 动作投递自定义锚句，再在嵌套分支写 `if: { anchor: { keys: [已确认], after: { action: seed } } }`，then 使用另一个普通注入动作声明正文与位置。完整示例见包内 `templates/16-custom-fallback.yml`，运行边界见 [引擎指南](../../docs/engine-reuse.md#字词句确认与动作关联)。不要把等待条件放在锚句动作的父级，否则锚句也无法投递。

`after.action` 仅引用同规则 separate 模式的 pre-step/runtime-context/turn-stop 注入动作；缺引用、自引用、循环、投递身份歧义、system-section 与 merged 目标在编译时拒绝。未实际接纳或已不再可见的起点返回 UNAVAILABLE，旧输出和 fork 继承不算当前会话的新投递。当前可见上下文变化后重判；默认等下次正常请求，显式 turn-stop 续跑仍受预算和取消信号约束。

直接匹配当前 pre-step 用户消息用 `text.subject: userMessage`（模板14）；`anchor.subject: userMessage` 看已接纳历史。确认词只写条件，正文只写动作；source.summary 是用户元数据，不生成动态确认/兜底说明。旧 first-turn-anchor、anchor-notice 策略与专属参数已移除，不保留兼容入口，也不自动修改用户模块。

## 四、能力、参数与数据所有权

能力目录以包内 engine/compositions/source/local 的实际文件为准；模块工具统一为 module-import-tools、module-rule-tools、module-memory-tools、module-variable-tools。官方工具、规划、压缩与普通委派由会话原有预设提供，空模块不自动获得这些能力。

共享参数由 `ENGINE_PARAM_DEFINITIONS` 唯一登记，`storageLayer` 决定磁盘路径：主/子模型各有路由与采样键，另含 PTC 呈现（presentAsEnabled、ptcMainMode、ptcSubagentMode）、run_code 环境（runCodeEnvEnabled、runCodeEnvKeys）、Git Bash（toolGitBashEnabled、路径、超时、输出上限）、指令提示（instructionHint 及 promoteOn/includeSubagents/模板）和工具批准（customToolRequireApproval）；完整键、options 与默认值以源码为准，不在摘要抄数量。模型卡在装配期合成 request-params 规则；未配置继承宿主。子代理递归深度归官方 `subagent.maxDepth`，插件不提供。

- persona.main/subagent：各模块保存 prefix/suffix/complete/includeRuntimeContext，省略继承、空文本清空、false 明确值；rules/_settings.yml 只作校验投影。
- config.yml.personaSources：main/subagent 各单选官方默认或一个模块 ID，不存正文、不自动启用 rules。只读取所选受众字段，不跨模块逐字段合并；有效官方人设与启用规则的 complete 仍预检，配装失败保留旧状态。
- variables：模块持久值，覆盖同安装 global；空串保留，删键才回落。普通规则手动建立变量，ST 导入自动登记缺失裸引用为空占位。
- customTools：shell/http/delegate/fs/ask-user，定义见包内 templates/tools。delegate 走官方工具管线。
- subagentToolPolicy：授权上限、工具档、角色绑定、任务规则与受控扩权；缺省官方委派。
- moduleConfigs：已声明共享参数优先于行级配置，不能绕过工具批准。
- configOrder：模块内规则id→非负序号，排序不修改正文和启停。

## 五、上下文激活与模板

`context-activation` 只在 pre-step 使用。`params.activation.scan` 必须为 batch 或 history；历史只扫描模型可见的真实对话，排除插件/指令/工具回执。`scanDepth:0` 不扫描聊天、变量和递归正文，常驻例外。

匹配共有字段：keys、secondaryKeys、constant、caseSensitive、wholeWords、useRegex、wordBoundary、selectiveLogic。词边界 unicode 为原生字母数字边界，ascii-token 为 ST 单词 ASCII/多词子串规则。副键先开启 activation.selective；P=主键命中数，S=副键命中数，N=原副键项数：

| 具名逻辑 | 条件 |
|---|---|
| AND_ANY | P>0 且 S>0 |
| NOT_ALL | P>0 且 S<N |
| NOT_ANY | P>0 且 S=0 |
| AND_ALL | P>0 且 S=N |

未开 selective 或无副键只要求 P>0；空主键不自动常驻。求值为空的副键仍占一项。activation 还拥有 scanVariables、概率、selectionGroup、评分、sticky/cooldown/delay、递归排除与延迟层级；它的候选组与规则 group/exclusive 不同。模块递归用 contextActivationRecursive，默认 false，池跨模块共享。

原生模板显式设置 params.templateEvaluation:true。module/global 的 set/get/add/inc/dec 在暂存变更集求值；同卡读到先前写入，单卡只写一个域，所有读取域都参与 CAS。扫描/预览只读。真实执行提交后跨出口和重挂不重放；跨进程崩溃不保证 exactly-once。

## 六、退役输入的显式转换

旧 world-book/stWorldBook/stWorldBookRecursive/stMacros/stSource、动作 config.variables、扁平 persona 和旧工具能力不作为运行兼容面。重新导入标准 ST 或按 SKILL.md 的转换步骤改写；保留原件和私有记忆，不能靠删来源标记绕过分享保护。旧 API 别名不等于新工具授权。
