# 模块参考

由 `SKILL.md` 的指针进入：挑条件、挑动作、查层字段、查模块名与参数时读它。
权威来源是源码——`engine/rule-spec.mjs`、`engine/conditions/`、`engine/actions/catalog.mjs`、
`engine/schema.mjs`、`src/shared/engine-params.ts`；本文件是摘要，**冲突时以源码为准**。

## 一、条件谓词（`if` 里能写什么）

`if` 是**单键节点**：要么组合算子，要么一个谓词。并排写两个键会直接报错（空对象也报错——
「恒真」和「写漏了」无法区分）。

组合算子：`all` / `any`（非空数组）、`not`（单节点）、`notAny`（非空数组）。

| 谓词 | 字段 | 语义与边界 |
|---|---|---|
| `text` | `keys` / `secondaryKeys` 至少一个非空；`logic`（`any`/`all`/`not`/`notAny`，对齐 ST world_info_logic）；`mode`（`scan` 全文 / `prefix` 词首）；`caseSensitive`；`wholeWords`；`useRegex`（`true` 强制正则 / `false` 强制字面 / 缺省＝只把 `/pattern/flags` 形态当正则）；`stWords`；`subject` | 文本匹配。`subject` 决定匹配哪段文本，缺省由层决定（见第三节） |
| `phase` | `promoted`（缺省 `true`＝只匹配已晋升；`false`；`'ignore'` 必须同时写 `compacted`）；`compacted`；`promoteOn`（`either`/`tool-call`/`assistant-message`）；`includeSubagents`（缺省 false＝子代理视为已晋升）；`promoteGate` + `reasoningPattern`/`reasoningNegativePattern`/`reasoningFlags`；`maxPromoteSteps`；`promoteAfterFirstResponse` | 晋升相位。**单个节点表达不了「两个相位都命中」**，用 `any` 拼 `{promoted: true}` 与 `{compacted: true, promoted: false}` |
| `source` | `kind` / `plugin`（字符串或字符串数组，两个都写是**合取**）；`caseSensitive`（缺省 true）；`match`（`exact` 缺省 / `prefix`） | 消息来源。列举多值要析取时用 `any` 显式写两支 |
| `count` | `of`（`tool-call`/`tool-result`/`assistant-message`/`assistant-chars`/`user-message`/`turn`）；`per`（`session` 缺省 / `turn`）；`min` / `max` / `every`（**至少写一个**，否则恒真）；`includeCurrent`；`delegated` | 计数。冷启动从持久事件流重建，重启后同一结果 |
| `names` | `allow` / `deny`；`caseSensitive`（缺省 true） | 名称名单：工具名（工具通道）、子代理 provider（`subagent/start`、`subagent/end`） |
| `session` | `type`（事件类型，如 `user/message`）；`present`（缺省 `false`＝该事件还没有）；`delegated` | 会话态。判「首轮」用 `{type: user/message, present: false}` |
| `preset` | `presetId` | 当前**挂载**的官方会话预设；取不到时返回 `UNAVAILABLE`（不乐观放行） |
| `scope` | `audience`（`main`/`subagent`）；`modelScope`（`all` 缺省 / `pro` / `flash`） | 受众与模型范围。这是**唯一**该写这些门的地方 |
| `anchor` | `keys`（前缀匹配确认词）；`fallbackAfter` | 锚定确认：首条 assistant reasoning 命中 `keys` 即确认；`fallbackAfter: N` 表示 assistant 消息超过 N 条后也放行 |

拿不到必要事实时谓词返回 `UNAVAILABLE`：`not` **不会**把未知变真，`any` 里已知 `true` 仍可决断，
`all` 里已知 `false` 仍可决断。只有严格 `true` 才执行。

## 二、动作（`then` / `else` 里能写什么）

`then` 是非空数组；每个动作要有唯一非空 `id` 与合法 `kind`。动作级分支写成 `{ if, then, else }`
节点嵌在数组里，可嵌套。`else` 结构上保证必有一支命中。

| 动作 | 执行点 | 主要字段 | 失败时 |
|---|---|---|---|
| `inject-text` | 由 `config.layer` 决定（九层） | `layer`、`strategy`（`static`/`placeholder`/`first-turn-anchor`/`guide-auto`/`anchor-notice`/`world-book`）、`position`、`dedupe`、`mergeMode`、`role`、`order`、`text`/`texts`、`variables`、`params`、`templateFile`、`configKind` | 空正文＝不注册 |
| `assembly` | `system-prompt/assemble` 下游 | `target.tools`（`allow` **或** `deny`，可加 `requireMatch`、`allowFrom`）、`target.sections`（`add`/`remove` **或** `keep`）、`target.contexts`（`add`/`remove`/`clear`） | 返回未改动的装配（对 tools 即暴露完整目录） |
| `decision` | `tools/pre-execute` / `tools/post-execute` | `phase`（`pre`/`post`）、`decision`（`allow`/`deny`/`ask`）、`action`（`accept`/`replace`/`block`）、`toolNames`、`text`、`reason` | 一律放行／接受——裁决 bug 不卡死调用 |
| `append-context` | `mode: context` → `tools/post-execute`；`mode: continue` → `agent/turn-stopping` | `mode`、`text` | 保持原结果 |
| `guard` | 注册期（agent scope） | `mask.allow` **或** `mask.deny`、`includeSubagents`、`reason`、`audience` | 静默不注册（**不**退化成放行以外的东西） |
| `sdk-strip` | `system-prompt/assemble` 下游 | `mask.allow` **或** `mask.deny` | 原样返回；只删不增 |
| `request-params` | `agent/request` 下游 | `patch`（浅合并）、`unset`（`{键: 期望值}`）、`replace`（整体替换，不能与 `unset` 同用） | 保持原请求配置 |
| `inbox-prepend` | `agent/inbox/inserted`（emit，无 next） | `target`（`next-turn` 缺省 / `next-step`）、`text` | 不命中即什么都不做 |
| `pre-step-filter` | `agent/pre-step` 下游 | `sources` **或** `keepKinds`（互斥，未声明即不过滤）、`blockPlugins`（正交，空＝关闭） | 异常时保留全部消息 |

通用规则：

- 名单类参数（`allow`/`deny`/`sources`/`toolNames`）写成逗号分隔字符串或字符串数组都接受。
- `allow` 与 `deny` **互斥**（同一声明里二选一）；`deny` 里不能写 `run_code`——它是 PTC 呈现唯一
  可调用的入口，写进去挂载期被拒。
- 需要落在宿主 waterfall 最外层（否决型动作，如预算剥离、工具收窄）时，`waterfallPosition` 是
  **声明式路径**的字段；规则路径写它会以 unknown fields 被拒，模块层没有出口。
- `maxPerTurn`（正整数）只对经 `on(...)` 注册的动作有效，即除 `inject-text`、`guard` 外的全部动作；
  它是「本动作本轮生效几次」，与 `count` 谓词（数持久事件）不是一回事。
- `guard`、`complete`、`suppressRuntimeContext` 是**固定注册效果**：不接受规则级 `if`，也不接受
  `waterfallPosition`。一条规则里只要有 `guard`，整条规则都不能带 `if`。

## 三、九层与字段

层是官方扩展点，彼此独立，没有跨层运行顺序。规则顶层的 `layer` 只用于展示、可省略；
真正生效的层取**动作**里的 `config.layer`（工具、装配、请求类动作自带执行点）。

| 层 | 官方入口 | 层上合法字段 | 可用策略 | 层内 `params` |
|---|---|---|---|---|
| `pre-step` | `agent/pre-step` 消息批 | `position` `dedupe` `promotion` `audience` `modelScope` `mergeMode` `order` `role` `subject` `match` | 六种全支持 | — |
| `system-section` | `ctx.systemPrompt.section` | `audience` `mergeMode` `order` | `static` | `sectionName` `complete` `suppressRuntimeContext` |
| `runtime-context` | `ctx.systemPrompt.context` | `mergeMode` `order` | `static` `placeholder` | `contextName` |
| `agent-request` | `agent/request` | `audience` `modelScope` `order` | `static` | `patch` `replace` |
| `llm-stream` | `llm/stream` | `modelScope` `order` | `static` | `mode`（`pass`/`replace`） |
| `tool-pipeline` | `tools/pre-execute` `tools/post-execute` | `audience` `modelScope` `order` `subject` `match` | `static` | `toolNames` `preDecision` `denyReason` `postAction` |
| `turn-stop` | `agent/turn-stopping` | `modelScope` `order` `subject` `match` | `static` | — |
| `subagent-start` | `subagent/start` | `modelScope` `order` `subject` `match` | `static` | — |
| `subagent-end` | `subagent/end` | `modelScope` `order` `subject` `match` | `static` | `action`（`observe`/`inject-main`） |

三条边界：

1. 越层字段是**挂载期报错**，不是静默忽略。`position`/`dedupe`/`role`/`promotion` 只在 `pre-step`；
   `subject`/`match` 只在 `pre-step`、`tool-pipeline`、`turn-stop`、`subagent-start`、`subagent-end`。
2. 各层缺省的匹配对象：`pre-step` → `userMessage`、`tool-pipeline` → `toolArgs`、`turn-stop` →
   `assistantText`、`subagent-*` → `subagentInfo`。**`subagent/start` 拿不到任务文本**，在那里用
   `text` 谓词筛任务内容会永远不命中且零诊断——要按任务分档请放到 `pre-step`。
3. 注册制层（`system-section`、`runtime-context`）**不接受动作级分支**——`then` 里的
   `{ if, then, else }` 节点会被编译期拒绝，因为那一层没有逐轮求值时机。**规则级 `if` 不受此限**：
   它在每次 assembly 走条件文本贡献通道求值，所以在 `system-section` 上写 `if.scope.audience`
   是合法写法。`complete` 是「唯一 system 段」，同一 scope 生效超过一个（或与 `persona.complete`
   撞）会被编译期拒绝。

策略 × 层：`static` 全层可用；`placeholder` 只在 `pre-step`、`runtime-context`；
`first-turn-anchor`/`guide-auto`/`anchor-notice`/`world-book` 只在 `pre-step`。
其余组合挂载期报错——因为它们需要每轮求值的 resolver，配了也没人调用。

## 四、模块名与参数

**可写进 `modules` 的名字**（＝ `engine/compositions/source/local/` 下的文件名）：

```
character-tools, dev-tool-search, filesystem-editor, instruction-hint, persistent-shell-posix,
rule-engine, run-code-env, session-var-tools, skill-search, subagent-tool-policy,
tool-bash-disabled, tool-config-engine, tool-git-bash, world-book-tools
```

官方组合块已全部随「与预设彻底解耦」清理：`tool-pwsh`、`tool-fs`、`delegation`、`planning`、
`compaction`、`tool-web` 这些能力由**会话原有的官方预设**提供，模块不需要也不应该重新声明它们。

两个**退役名**：`prompt-config-engine`、`declared-triggers`。写进 `modules` 返回 409
`rules-migration-required`，它们的组合行也已删除。声明了 `rules` 就写 `rule-engine`；名字找不到
时装配期直接报错。

**共享参数**只有四个键，写在 `layerSettings.<层名>.<键>`；层由参数自己的 `storageLayer` 固定，
放错层报 `module-layer-settings-invalid`：

| 键 | 层 | 说明 |
|---|---|---|
| `instructionHint` | `pre-step` | 布尔，默认关：晋升后把官方指令全文换成一次路径提示 |
| `maxDepth` | `subagent-start` | 数字 / `provider-managed` / 空；只在插件子代理策略启用时约束 |
| `toolGitBashEnabled` | `tool-pipeline` | 布尔，默认 true：Windows Git Bash 适配行 |
| `customToolRequireApproval` | `tool-pipeline` | 列表：`shell` `http` `delegate` `fs` `ask-user` |

模型与采样参数不属于共享参数：它们走 `agent-request` 动作的 `patch`，受众由规则 `if.scope` 区分；
写进 `layerSettings` 不会生成任何请求规则（工作台保存会直接拒绝）。

**顶层段**各有所有者，互不混写：

- `persona`：`prefix` / `suffix` / `complete` / `includeRuntimeContext`。
- `variables`：`{{键}}` 插值源；空字符串是合法占位（不按空值删键处理）。
- `customTools`：模型工具定义，执行器五种；结构见仓库 `templates/tools/*.yml`。
- `subagentToolPolicy`：`ceiling` / `defaultProfile` / `profiles` / `characterBindings` /
  `taskRules` / `modelExpansion`；缺省时子代理走官方委派行为。
- `moduleConfigs`：行级 config 直写（优先级低于已声明的共享参数），给参数桥没覆盖的键用。
- `configOrder`：规则 id → 序号；缺省按声明序 ×10。切片里落在 `rules/_settings.yml`。

**目录形态**：`modules/<id>/module.yml` 是定义；旁边的 `rules/<规则id>.yml`、`rules/_settings.yml`、
`rules/variables.yml` 是插件物化的切片，只读，改了会被单向重切回来。`configs/`、`rules.yml`、
`agent.cordis.yml`、`custom-tools/`、`subagent-tools/`、`triggers.yml` 都是旧产物，写盘即清理。
