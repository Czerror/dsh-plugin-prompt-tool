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
| `text` | `keys` / `secondaryKeys` 至少一个非空；`logic`（`any`/`all`/`not`/`notAny`，不能按名称当作 ST 数字逻辑）；`mode`（`scan` 全文 / `prefix` 词首）；`caseSensitive`；`wholeWords`；`useRegex`（`true` 强制正则 / `false` 强制字面 / 缺省＝只把 `/pattern/flags` 形态当正则）；`wordBoundary`（unicode/ascii-token）；`subject` | 文本匹配。动作级条件必须显式声明本通道可用的 subject；规则级条件缺事实时不执行 |
| `phase` | `promoted`（缺省 `true`＝只匹配已晋升；`false`；`'ignore'` 必须同时写 `compacted`）；`compacted`；`promoteOn`（`either`/`tool-call`/`assistant-message`）；`includeSubagents`（缺省 false＝子代理视为已晋升）；`promoteGate` + `reasoningPattern`/`reasoningNegativePattern`/`reasoningFlags`；`maxPromoteSteps`；`promoteAfterFirstResponse` | 晋升相位。**单个节点表达不了「两个相位都命中」**，用 `any` 拼 `{promoted: true}` 与 `{compacted: true, promoted: false}` |
| `source` | `kind` / `plugin`（字符串或字符串数组，两个都写是**合取**）；`caseSensitive`（缺省 true）；`match`（`exact` 缺省 / `prefix`） | 消息来源。列举多值要析取时用 `any` 显式写两支 |
| `count` | `of`（`tool-call`/`tool-result`/`assistant-message`/`assistant-chars`/`user-message`/`turn`）；`per`（`session` 缺省 / `turn`）；`min` / `max` / `every`（**至少写一个**，否则恒真）；`includeCurrent`；`delegated` | 消息类信号按可见历史；tool-call/turn 按完整日志，冷启动按相同视图重建 |
| `names` | `allow` / `deny`；`caseSensitive`（缺省 true） | 名称名单：工具名（工具通道）、子代理 provider（`subagent/start`、`subagent/end`） |
| `session` | `type`（事件类型，如 `user/message`）；`present`（缺省 `false`＝该事件还没有）；`delegated` | 会话态。判「首轮」用 `{type: user/message, present: false}` |
| `preset` | `presetId` | 当前**挂载**的官方会话预设；取不到时返回 `UNAVAILABLE`（不乐观放行） |
| `scope` | `audience`（`main`/`subagent`）；`modelScope`（`all` 缺省 / `pro` / `flash`） | 受众与模型范围。这是**唯一**该写这些门的地方 |
| `anchor` | `keys`（前缀匹配确认词）；`fallbackAfter` | 锚定确认：首条 assistant reasoning 命中 `keys` 即确认；`fallbackAfter: N` 表示 assistant 消息超过 N 条后也放行 |

拿不到必要事实时谓词返回 `UNAVAILABLE`：只有严格 `true` 才执行；`any` 遇已知 `true`、`all` 遇已知
`false` 仍可决断。

## 二、动作（`then` / `else` 里能写什么）

`then` 是非空数组；每个动作要有唯一非空 `id` 与合法 `kind`。动作级分支写成 `{ if, then, else }`
节点嵌在数组里，可嵌套。else 必须有对应 if；必要事实未知时两支都不执行。

| 动作 | 执行点 | 主要字段 | 失败时 |
|---|---|---|---|
| `inject-text` | 由 `config.layer` 决定（**可注入八层**，见层表；`tool-pipeline` 无注入通道） | `layer`、`strategy`（`static`/`placeholder`/`first-turn-anchor`/`guide-auto`/`anchor-notice`/`context-activation`）、`position`、`dedupe`、`mergeMode`、`role`、`order`、`text`/`texts`、`params`、`templateFile`、`configKind` | 空正文不生成投递；变量赋值模板另按显式求值事务处理 |
| `assembly` | `system-prompt/assemble` 下游 | `target.sections`（`add`/`remove` **或** `keep`）、`target.contexts`（`add`/`remove` **或** `clear`，二者互斥——并存编译期拒绝）；`target.tools` 已移除 | 返回未改动的装配 |
| `tool-visibility` | `system-prompt/assemble` 下游 | `audience`（`main`/`subagent`/`all`）、`allow` 与/或 `deny`（同时给时先保留再剔除）、`requireMatch`（仅 allow）、`discovery`（`{tool, key}`：注册发现工具并回收解锁名）、`notice`（`true` = 引擎生成正文；`{ text }` = 模块自定义正文） | 呈现面失败保留原装配；执行闸失败留痕，不静默放行 |
| `decision` | `tools/pre-execute` / `tools/post-execute` | `phase`（`pre`/`post`）、`decision`（`allow`/`deny`/`ask`）、`action`（`accept`/`replace`/`block`）、`toolNames`、`text`、`reason` | 一律放行／接受——裁决 bug 不卡死调用 |
| `append-context` | `mode: context` → `tools/post-execute`；`mode: continue` → `agent/turn-stopping` | `mode`、`text` | 保持原结果 |
| `request-params` | `agent/request` 下游 | `patch`（浅合并）、`unset`（`{键: 期望值}`）、`replace`（整体替换） | 保持原请求配置 |
| `inbox-prepend` | `agent/inbox/inserted`（emit，无 next） | `target`（`next-turn` 缺省 / `next-step`）、`text` | 不命中即什么都不做 |
| `pre-step-filter` | `agent/pre-step` 下游 | `sources` **或** `keepKinds`（互斥，未声明即不过滤）、`blockPlugins`（正交，空＝关闭） | 异常时保留全部消息 |

通用规则：

- 名单类参数（`allow`/`deny`/`sources`/`toolNames`）写成逗号分隔字符串或字符串数组都接受。
- 工具可见面的 `allow` 与 `deny` 可以同时给：对齐官方 `ToolRestriction`，先按 `allow` 保留、再按 `deny` 剔除。
- `maxPerTurn`（正整数）用在 `assembly` / `decision` / `append-context` / `request-params` /
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

一份 `deny` 名单同时裁装配目录、`tools:sdk` 正文，并在 agent scope 注册执行闸——会话原有预设装的行也归它裁决，经 `run_code` 的子调用同样被拒。要让禁用只作用于子代理，写 `audience: subagent`；省略即 `all`。

要**收窄**而非禁用，用同一动作的 `allow` 白名单（范例见 `modules/tool-surface/module.yml`），并按需声明 `discovery` 与 `notice`：

```yaml
- id: narrow
  kind: tool-visibility
  allow: [pwsh, read, write, edit, glob, grep, todo_write, skill_search, skill_load, tool_search, bash]
  discovery: { tool: tool_search, key: toolNames }
  requireMatch: true
  notice: true
```

`discovery` 在 agent scope 注册发现工具，并从持久 `tool/call` 参数回收解锁名（只做加法、跨压缩保留）。`notice` 可写 `true`（正文由引擎按常驻集与发现工具生成，不手抄），也可写 `{ text: 你的正文 }` 覆盖为模块自己的措辞——引擎生成只是缺省值，不是强制。`requireMatch` 在任一常驻工具缺失时放弃裁剪、暴露完整目录（fail-open）。

## 三、九层与字段

层是官方扩展点，彼此独立，没有跨层运行顺序。规则顶层 layer 是动作未声明 config.layer 时的缺省及展示归属；
动作显式声明 config.layer 时优先使用动作值（工具、装配、请求类动作自带执行点）。

| 层 | 官方入口 | 层上合法字段 | 可用策略 | 层内 `params` |
|---|---|---|---|---|
| `pre-step` | `agent/pre-step` 消息批 | `position` `dedupe` `promotion` `audience` `modelScope` `mergeMode` `order` `role` `subject` `match` | 六种全支持 | — |
| `system-section` | `ctx.systemPrompt.section` | `audience` `mergeMode` `order` | `static` | `sectionName` `complete` `suppressRuntimeContext` |
| `runtime-context` | `ctx.systemPrompt.context` | `mergeMode` `order` | `static` `placeholder` | `contextName` |
| `agent-request` | `agent/request` | `audience` `modelScope` `order` | `static` | `patch` `replace` |
| `llm-stream` | `llm/stream` | `modelScope` `order` | `static` | `mode`（`pass`/`replace`） |
| `tool-pipeline` | 仅展示归属（**无注入通道**） | `audience` `modelScope` `order` `subject` `match` | — | 工具链的裁决 / 追加上下文改用 `decision` / `append-context` 动作 |
| `turn-stop` | `agent/turn-stopping` | `modelScope` `order` `subject` `match` | `static` | — |
| `subagent-start` | `subagent/start` | `modelScope` `order` `subject` `match` | `static` | — |
| `subagent-end` | `subagent/end` | `modelScope` `order` `subject` `match` | `static` | `action`（`observe`/`inject-main`） |

三条边界：

1. 层字段按上表用：`position`/`dedupe`/`role`/`promotion` 在 `pre-step`；`subject`/`match` 在
   `pre-step`、`turn-stop`、`subagent-start`、`subagent-end`——`tool-pipeline` 无注入通道，写上不生效。
2. 各层缺省的匹配对象：`pre-step` → `userMessage`、`tool-pipeline` → `toolArgs`、`turn-stop` →
   `assistantText`、`subagent-*` → `subagentInfo`。按任务内容分档放在 `pre-step`——`subagent/start`
   的事件里只有 provider 与 id，没有任务文本。
3. 注册制层（`system-section`、`runtime-context`）的条件写在**规则级 `if`**：它在每次 assembly 走
   条件文本贡献通道求值，`if.scope.audience` 是常见写法；动作级 `{ if, then, else }` 分支留给带逐轮
   时机的层。`complete` 是「唯一 system 段」（同一 scope 一个）。

策略 × 层：`static` 全层；`placeholder` 在 `pre-step`、`runtime-context`；`first-turn-anchor` /
`guide-auto` / `anchor-notice` / `context-activation` 在 `pre-step`——后五者都需要每轮求值的 resolver。

## 四、能力、参数与数据所有权

能力目录以包内 engine/compositions/source/local 的实际文件为准；模块工具统一为 module-import-tools、module-rule-tools、module-memory-tools、module-variable-tools。官方工具、规划、压缩与普通委派由会话原有预设提供，空模块不自动获得这些能力。

共享参数14个，由 ENGINE_PARAM_DEFINITIONS 的 storageLayer 决定磁盘路径：主/子模型各5个路由与采样键，以及 instructionHint、maxDepth、toolGitBashEnabled、customToolRequireApproval。模型卡在装配期合成 request-params 规则；未配置继承宿主。

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
