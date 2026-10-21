# 统一规则引擎复用指南

规则是唯一行为定义。插件读取模块定义、校验切片，再经 `compileRules → mountRuleSources` 装配到 Agent scope，这是一条**两段式**生命周期：`compileRules` 只编译与校验（产物每条规则携带 `conditionTrees`，选项里的 `ctx` / `standingMountFor` 会被显式剥掉），**条件绑定由 `mountRuleSources` 在注册前完成**（内部调 `rebindConditions`）。原因是 `preset` 谓词要挂载 scope 的 ctx（`conditions/preset.mjs` 把服务查询基准绑在构造期），准备期拿不到——那边绑出来的 `preset` 条件是恒 UNAVAILABLE 的**静默死条件**。需要官方模块导出的兜底时，由调用方通过 options 传 `standingMountFor`；重绑含 `preset`、含 `phase` 且未显式 `subscribe: false`、或含 `anchor.after` 动作引用的树，其余谓词原样保留。模块不进入官方会话预设注册表；九个插入点各有生命周期，不形成插件自定义的全局管线。

编辑保存与运行注入分别负责：客户端只提交合法草稿；发送消息不等待自动保存，运行使用磁盘已保存的有效定义。官方 `systemPrompt.assemble()` 开始、同步 provider 求值之前，插件核对本地定义与人设来源；变化才复用现有配装更新注册，没有变化不重挂。变量值仍在模板求值时读取，不因值更新重挂规则。

插件同时观察启用表与已参与模块的 `module.yml`（200ms 文件检查），使直接修改文件也能更新后续事件的注册。正文、参数、启停、增删、条件、受众和插入点修改从后续实际发生的官方入口生效；不会重跑进行中的请求，也不补执行已经过去的入口。文件不可读、无效定义或候选注册失败时保留最后有效贡献并告警，文件恢复有效后自动重试。监听与文件观察随插件释放，不修改官方 Loader 或 profile。

字段和磁盘事务见 [参数框架](architecture-params.md)，外部来源转换见 [SillyTavern 导入](SillyTavern.md)，设计决策见 [ADR-0013](adr/0013-native-context-module-state.md)。

## 原生运行与工具面

### 工具、能力与公开入口

工具名称与能力归属的唯一目录为 `src/shared/engine-capabilities.ts` 的 `MODULE_TOOL_NAMES` / `MODULE_TOOL_CAPABILITIES`。注册、委托建议与补装消费该目录。

| 能力 | 实际模型工具 | 所有者 |
|---|---|---|
| `module-rule-tools` | `module_rules_read`、`module_rules_edit` | 完整原始规则与按域 revisions |
| `module-variable-tools` | `module_variables` | global/module 两级持久变量 |
| `module-memory-tools` | `module_memory_read`、`module_memory_append` | 当前受控模块 memory.md |
| `module-import-tools` | `module_import` | 来源预览、选择、凭据和候选安装 |
| `tool-config-engine` | 模块声明的自定义工具 | 官方工具注册、执行和批准管线 |

未声明的工具能力不注册。四个模块工具外壳通过 `ctx.inject` 等待各自 `pt-module-*` provider，贡献随 disposer 撤回。来源模块内的模板变量按该来源读写；模型工具目标由执行 Agent 的配装记录确定（只含已启用的规则模块；人设来源是人设卡的独立引用，可以指向未启用的模块，正文写入走 persona 端点），`expectedModuleId` 只校验，不选择任意模块或目录。

旧 character/world_book/session_var 工具、对应能力与 ST 运行文件退出公开面；外部标准中的世界书名称仍可出现在导入类型和来源记录中。没有新旧双读、角色专属存储或任意文件工具。

### 执行、状态与接入

- 普通规则按真实执行点判定。条件/动作资格先于模板求值，禁用或受众不符的 setter 不影响 reader。
- `template-evaluation.mjs` 返回正文、读取域和单域变更集；`template-frame.mjs` 通过显式变量 adapter 读取、CAS 提交和发布。
- 执行身份由运行 Agent、取消信号与官方 turn/step durable 边界确定；assembly 与其后的 pre-step 共用同一次执行。账本独立于 mount，提交后重挂或重复出口只重用结果。
- 同执行后续卡读取前卡提交的值；变量 revision 只作 CAS，不成为重放键。冲突最多重试当前未提交卡，保留其随机抽样。
- 发布失败返回/记录已持久化状态，只重试发布；不重复自增。预览或无法确认真实执行身份时只读，赋值拒绝。
- 账本有界且在进程内；不承诺任意崩溃后的跨进程 exactly-once。

人设适配器归主插件运行态。包补丁只注册 `dsh-plugin-prompt-tool`，不覆盖官方 system-prompt 的 inject/intercept，不要求它等待 Loader 或本插件服务。独立人设早入口已移除。

人设策略来源由 host 的 `selectedPersonaModules(root)` 提供：config.yml.personaSources 为 main/subagent 各保存一个模块 ID 或官方默认，仅读取所选模块的对应受众字段。正文仍归模块定义，rules/_settings.yml 只作校验投影；选择来源不启用模块 rules，不进行多模块逐字段合并。

人设段由装配通道在**每个 Agent 自己的 scope** 注册同名 `deployment:persona-prefix` / `deployment:persona-suffix`。同名段按 scope 链遮蔽、近者胜（`@deepseek-ai/dsh-scope` 的 `ScopedLayers.merge`），所以全局部署人设与预设挂在祖先 scope 的 persona 行都被替换，不需要接管任何人的 fiber。段落位置取 `getSectionOrder()`；未声明的字段、位置与 `complete` 从最近的已有声明继承（同层被接住的声明优先，其次是祖先的官方 persona 行，最后是根部署人设），找不到继承源也照常注册——遮蔽一个不存在的声明本身无害，不再因为「未观察」拒绝配装。继承的官方正文直接沿用原 `text`，不被当作本插件模板重执行；自定义正文继续读取来源模块变量。

单选来源不代替独占校验：人设的 `complete` 与同受众规则的 `complete` 仍在撤旧之前预检，冲突时保留上次有效配装。人设是装配通道里的一段普通贡献，随装配 fiber 一同挂载与释放——没有独立的人设事务、维护锁，也不重载任何官方 fiber；不操作私有 layers，不替换 Agent scope，不在截断后拼回系统段。

AgentSetup 窗口内注册的同层同名段会被接住：装配时先撤销它、再注册我们的段落，撤销凭据保留原 `PromptSection`，因此本插件人设优先于 `@deepseek-ai/dsh-subagent` 的 per-child persona 这类直接声明。窗口之外出现的同层声明撤不掉，装配失败并保留旧装配，由告警说明；释放后回落祖先声明，不回装被撤段落。升级代码、patch 或 bundle 后需要用户重启服务，插件不自行重启。

## 统一入口与模块职责

| 文件或目录 | 职责 |
|---|---|
| `rule-spec.mjs` | 唯一规则编译、身份和字段校验 |
| `branch.mjs` | 分支判据与展开；host 完整树遍历共用同一语法 |
| `rule-runtime.mjs` | 同点排序、资格、作用域挂载和释放 |
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
| `tool-config-engine.mjs` | 自定义工具定义到官方注册 |
| `instruction-files.mjs` | 指令文件探测的判据：候选清单与目录链算法的单一来源（项目根标记由各消费者给）+ 引擎侧异步执行器 |

相对路径均基于包根的 `engine/`。`actions.mjs`、`predicates.mjs`、`strategies.mjs` 只是已有入口，不把实现堆回 barrel。`engine/vendor/yaml/` 是版本化分发快照，通过 package script 生成，不手改。

### 插件侧怎么引入引擎（类型边界）

`engine/*.mjs` 是纯 JS，`tsconfig.json` 不开 `allowJs`/`checkJs`。因此每个**被 `src/` 静态引入**的引擎模块都配一份手写 `.d.mts`（与 `.mjs` 同目录同名）：

- 已有声明的：`rule-spec`／`shared`／`interpolate`／`executor`／`pre-step-source`／`promotion-pool`／`branch`／`tool-definition`／`order`／`rule-runtime`／`compaction-epoch`／`conditions/index`／`template-evaluation`／`template-frame`／`context-activation`／`service-names`／`discovery`／`instruction-files`（2026-10-16 起 `src/` 侧不再用 `@ts-expect-error` 引入）。
- **新增引擎导出时同步改声明**：`src/` 只用到的符号才声明（声明是「插件依赖面」而非引擎全貌）；跨引擎模块引用写成 `import type { X } from './y.mjs'`，**不要**引用 `src/` 的类型（声明文件与 `.mjs` 同目录，`src/` 不在它的解析面内）。
- **声明文件只是类型面**：不进 `lib/` 打包，也不需要改 `package.json`／tsdown（`exports["./engine/*"]` 已覆盖；TS 按 `./x.mjs` → `./x.d.mts` 解析）。
- **为什么有些声明符号 `src/` 从不直接 import，却仍然必要**（别按「无人使用」删它们）：`src/` 消费的是**函数**，不是字段类型——`StandingMountFor` 被 `loadStandingMountFor` 的返回引用、`MountRuleSourcesOptions` 被 `mountRuleSources` 的参数引用、`PreStepBatchOptions` 被 `runPreStepBatch` 的参数引用、`WarnOnce` 被 `createWarnOnce` 的返回引用……它们是**签名的组成部分**。删掉会让签名退回 `unknown`。判据是「它是否支撑某个被消费符号的签名」，**不是**「它自己有没有被 import」。
- **声明的失效方式是静默的，当前没有机制校验**：声明多于实现 ⇒ `src/` 编译通过、运行期拿到 `undefined`；签名写宽（如 `rule-runtime.d.mts` 的 `ctx: unknown`）⇒ 类型不再报错但也不再说实话。这两类都只能靠「新增／改名引擎导出时同步改声明」这条纪律 ＋ 人看。**已做的核对（2026-10-16）**：14 份声明的导出在运行期逐个 `import` 核对，**无漂移、无冗余**。
- **动态加载点的归属与断言**（2026-10-16 核实）：按 id 加载在 `runtime/agent-assembly.ts:121-124`（`join(packageEngineDir(), '<id>.mjs')` ＋ `existsSync`，缺文件静默跳过、缺 `apply` 抛）；固定文件名 URL 动态导入有三处——`runtime/bridge-runtime.ts:590`（`schema.mjs`，断言 `{ getEngineMeta }`）、`runtime/routes/instructions.ts:31`（`rule-spec.mjs`，收在 `ruleEditorMeta()` 里、被调 5 次，断言用的是 `src/shared/rules.ts` 的 `RuleEditorMeta` **副本**而非本目录的声明）、`src/index.ts:200`（`skill-search.mjs`，相对 `import.meta.url`，失败 warn 降级）。引擎内另有 `actions/content.mjs`（按策略名懒加载）与 `host-package.mjs`（按宿主包名，非引擎模块）。
- **这些断言为什么不收成一个接口**：四处加载在**路径基准／失败语义／断言形状／缓存**上各不相同——按 id 那处要求「缺件跳过、缺 `apply` 抛」，`index.ts` 那处要求「失败只 warn」，只有 `bridge-runtime` 与 `instructions` 两处同形（固定文件名 ＋ `packageEngineDir()`）。强行统一会得到一个覆盖四种错误语义的宽 options ＝ 浅接口，故**有意保留内联断言**。
- **`@ts-expect-error` 与「声明不参与」的边界**：上面静态引入的模块由同目录 `.d.mts` 供类型（见上一条）；**走绝对 URL 动态 import 的那几处，`.d.mts` 不参与解析**，类型完全由手写内联断言承担——`rule-spec.mjs` 因此同时有两条类型路径，`src/runtime/routes/instructions.ts` 用的还是 `src` 侧的同名副本。
- `engine/vendor/**` 的 `@ts-expect-error` 来自上游转译产物，随快照整体覆盖，**不手动改**。

服务名绑定也在这条边界上：宿主与引擎共用的服务名（pre-step 协调服务、四个模块工具外壳）只有 `engine/service-names.mjs` 一个真值源，`src/` 与引擎侧的各引用点都从它取，**改名不得手抄**。手抄的失效方式是静默的——引擎查不到协调服务就回退自身的独立执行路径，模块工具外壳等不到 provider 就不挂工具，两边都不报错。这也是「引擎可单独复制」的一部分：名字随 `engine/` 一起走，复制方不必问宿主；`test/engine/service-names.test.mjs` 只作防下次手抄的源级守卫。

### 引擎契约（加载器视角）

组合源 `engine/compositions/source/local/*.yml` 里的行分两类，加载器（`src/runtime/agent-assembly.ts:186-204`）按 `name` 判断：

- **本地引擎行**：`name: ./engine/<id>.mjs`。加载器按行 `id` 拼出同一路径 import，执行 `apply(ctx, config, { agent })`；`config` 是模块定义里解析后的行配置。
- **官方 recipe 行**：`name` 是 `cordis:group` 或 `@deepseek-ai/dsh-*` 包名，没有本地 `.mjs`。这些行由会话原有预设提供，加载器在 `engine/<id>.mjs` 缺席时跳过，不校验引擎形状。

一个**本地引擎模块**必须满足五条：

1. **身份**：文件位于 `engine/<id>.mjs`，与行 `id` 一致；行 `name` 若存在应为 `./engine/<id>.mjs`（加载器不读 `name`，一致性由 `test/host/engine-contract.test.mjs` 校验）。
2. **入口**：导出 `apply` 函数；缺 `apply` 在装配准备期抛错（`agent-assembly.ts:193`）。
3. **依赖**：`inject` 缺省或为字符串数组；数组元素是宿主服务名（`tools`、`systemPrompt`、`llm`、`skills` 等）。
4. **配置**：`configContract.parse(raw, plugin)` 缺省或为函数；装配准备期会调用一次做 fail-fast（`agent-assembly.ts:202-203`），引擎在 `apply` 内可以再解析以取得规范化配置——当前两边都保留，**这是有意为之的 fail-fast ＋ normalize 两段**，不是遗漏。
5. **清理**：`apply` 返回函数时，装配 fiber 把它作为 disposer 收走（`agent-assembly.ts:436-437`）；不返回则依赖注册时自带的 effect。

**不做通用能力注册表**：引擎之间按名调用目前只有发现引擎一个真实消费者（`promptToolDiscovery`，见 `discovery.mjs`）。等到出现第二个按能力解析的消费者（例如技能面成为可见面的发现来源），再按两个真实用例定接口；在此之前，新增引擎照抄 `discovery.mjs` 的「服务名 + 注册表 + 按 agent 键控」形状，而不是先建注册表。

**触发式债务**：`apply` 内二次解析配置与加载器准备期解析并存（如上）；发现适配器的宿主挂载与行挂载不对称（宿主挂载的 `skill-search` 不登记 adapter，今天无消费者）。两者都等具体触发条件再动，不在本轮顺手改。

## 复制协议（跨项目复用）

复制完整 `engine/` 可复用纯编译器、动作、条件、历史与模板求值。宿主接线仍需要相应官方服务，四个模块工具外壳还需要 Prompt Tool 的 provider。独立引擎不偷偷读取插件 DSH_HOME 或 session 变量表。

`instruction-files.mjs` 只提供探测（纯函数 + 引擎侧执行器）；`instruction-hint.mjs` 既可挂载为行，也为 placeholder 填充器提供消息构造——复制方可以只要探测、不挂该行。执行器与宿主探测都只走到最近的项目根为止（marker 首命中即停），不继续向盘根探测。

优先内联 `rules`、自定义工具与策略；独立入口的文件方式按该入口参数声明使用。显式内联空值表示无贡献，非法值不能回退旧文件掩盖错误。模块生产路径不生成 rules.yml、agent.cordis.yml 或第二套工具目录。

需要持久变量时向挂载接口传 `variableStore`：

```js
const dispose = mountRuleSources(ctx, sources, { variableStore })
// read(moduleId) -> { module, global, revisions, enabled }
// commit(moduleId, { scope, changes, expectedRevisions }) -> persisted/publication 状态
// publish(moduleId) -> 仅重试已提交快照发布
```

adapter 的目录、权限、原子写与版本责任归接入方。缺少 adapter 不能完成持久赋值；要观察模板求值的读取与变更，走 `renderTemplate()` 的返回（`engine/template-frame.mjs`），不经 `mountRuleSources` 的 `variableStore` 时模板按未解析处理。复制验收应在隔离目录通过显式 adapter 测公共注入行为，而非依赖开发机变量或原仓库路径。

## 规则条件与动作边界

规则含 `id/name/enabled/layer/group/exclusive/if/then/else`。动作有稳定 id 和 kind；then/else 与嵌套分支内的所有动作 id 在同一规则中唯一。读取投影可生成配置身份，编辑映射保留原始条件和载荷，不把编译默认值写回。

`if` 是单键谓词或 all/any/not/notAny 组合。必要事实缺失为 UNAVAILABLE，不会因 not 变成 true。规则级 else 要有同一规则的 if；事实未知时可能两支都不执行。分支节点不写 kind，不能把 if/then/else 塞进动作对象。

| 动作 | 执行点与边界 |
|---|---|
| inject-text | config.layer 指定六个可注入层；agent-request、llm-stream、tool-pipeline 只作动作展示归属 |
| assembly | system-prompt/assemble 的系统段 / 运行上下文投影（工具面不再由它承担） |
| tool-visibility | system-prompt/assemble 下游：一份名单拥有工具目录、SDK 正文、执行闸与发现来源；受众使用 scope 条件 |
| request-params | agent/request；patch/unset 按官方 LlmCallConfig 校验 |
| stream-output | llm/stream；pass 透传或 replace 替换为 text，不修改请求 |
| tool-gate | tools/pre-execute 的裁决：allow / deny / ask |
| tool-result | tools/post-execute 的结果处理：accept / replace / block |
| append-context | tools/post-execute 后追加上下文；续跑统一用 inject-text 的 turn-stop 层 |
| pre-step-filter | 前置消息来源/插件过滤 |
| inbox-prepend | inbox 通知补充上下文 |

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

被引用的 runtime-context 名称必须在完整编译及挂载来源集合中唯一，避免命名快照混淆实际贡献；注册失败中止本次装配并释放已经完成的注册，不带部分候选继续运行。

关联与去重共用 `engine/delivery.mjs` 的身份及可见投递查询。当前会话的实际投递才是起点，fork 继承消息不能冒充新投递；压缩、裁剪或投影变化后重新判断，必要时重发锚句并重新确认。默认等待下一次正常请求；显式 turn-stop 注入可沿用有界续跑并设置 `dedupe: session`，取消或释放后不续跑。来源 `source.summary` 仍是用户声明的元数据，不自动生成确认或兜底说明；规则诊断沿用 hit/miss。

### 条件判定与事件载荷

同一调用帧的规则判定共享，跨执行点重新判定；after-next 动作先调用下游再判定。动作级条件要匹配本点实际事实，规则级条件则在各执行点独立按三值语义处理。

- pre-step 有本批真实用户文本；按任务给子代理分档应在这里使用 `scope.audience: subagent`。
- tools 通道有工具名、参数或结果；names/source/text 按动作的 channel 白名单校验。
- subagent/start/end 有 provider/id/local 等事件事实，不含任务正文；文本 subject 用 subagentInfo。
- llm/stream 自身无文本 subject；引擎可由 sessionId 查回 Agent，因此 phase/session/count/anchor 等依赖会话的条件可用，查不到为 UNAVAILABLE。
- system-section/runtime-context 的普通文本贡献支持规则级条件及嵌套 if/then/else，在每次 assembly 按该执行点事实求值，不动态重注册段。complete/suppressRuntimeContext 属固定注册效果，动态 if 组合仍在编译期拒绝。

固定系统段可通过 `config.audience: main/subagent` 限定受众；complete 和 suppressRuntimeContext 都在该 Agent 注册前筛选，非目标受众不注册这些效果。省略受众覆盖主/子两类。独占检查按受众分别聚合：主/子各一条可以同模块或跨模块共存，同受众重叠（包括未限定受众的段）在发布前拒绝；官方人设 complete 也只与该 Agent 的规则比较。

插件管理路径自动传递真实 Agent。独立代码调用 `mountRuleSources`、`applyPromptConfigSources`、`wireLayers` 或 `registerAction` 时，受众限定的固定系统段要求在目标 Agent scope 调用并传入 `options.agent`；共享 standing scope 的文件式入口无法确定受众，明确拒绝该组合。pre-step 来源由 `createPreStepSource` 构造，`applyPromptConfigSources(sources, options)` 从 `source.ctx` 取作用域，不再另收 ctx。普通正文与未限定受众的固定效果保持原注册方式，不能通过返回空正文解除独占或上下文抑制。

工具名单的 allow/deny 互斥。request-params 的 replace:true 必须同时给 provider 与 model。拒绝非法候选发生在保存和挂载前；运行失败按该动作的明确降级报告，不能据一次静态校验声称模型已收到内容。

## 提示词配置插入点与顺序

九层展示序来自 `LAYER_ORDER`；六层可注入清单来自 `getEngineMeta().injectionLayers`。agent-request、llm-stream、tool-pipeline 分别使用请求参数、流输出和工具动作，不能作为 inject-text 的 config.layer。规则顶层 layer 是动作未写 config.layer 时的缺省及展示归属。详细载荷见 [九层契约](injection-point-contracts.md)。

跨模块同点顺序来自 module.yml.configOrder；同点动作按声明顺序，显式 channelOrder 冲突拒绝。order 只管所属官方插入点的位置，不建立跨层总顺序。pre-step 中注入和过滤可以交错 flush，后批继续排在仍存活的同位置消息之后。

### 同 scope 内的注册顺序（2026-09-22）

Cordis waterfall 普通注册先注册者在外；prepend 注册插到最外层，同为 prepend 时后注册者更外。非注入动作通过 `waterfallPosition: outermost` 表达该要求，同点仍按编译顺序接线。inject-text 的位置属于官方插入层，不接受这个注册后门。

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

宿主 `src/runtime/pre-step-coordinator.ts` 汇总模块规则与直接来源，先处理官方待注入指令，再执行规则。来源白名单过滤器使用真实已领取 payload，不将下游增量当原始消息。

协调器服务 v2 持有唯一的 promotion pool/pair，并把它暴露给来源生产者；`registerPreset(sourceId, source)` 消费 source 自带的 ctx/onOutcome/promotion，不再改写 `config.resolve`，也不再从 config 反推模块。批执行由 `runPreStepBatch({ sources })` 合并来源，判定上报使用对象形状；pre-step 来源的 `source.ctx` 绑定 `resolve`，条件帧使用批级 ctx。

逐文件关闭只过滤能够可靠识别的未来官方正文和 change 元数据；无法识别或无法分段时保留并报告。不撤回历史、不补回官方预算裁掉的内容，不以文件卡开关阻止官方磁盘读取。重新开启也不强制重放。

`instructionHint` 默认关闭，只有显式有效 messageTemplate 才将过滤后的正文转成提示；空模板保持原文。正文编辑和文件授权属于独立 owner，见 [指令文件契约](architecture-params.md#指令文件与逐文件过滤策略)。

## 工具面收窄与按需解锁

`tool-visibility` 是工具面的唯一声明：一份 allow/deny 名单同时投影到装配目录、`tools:sdk` 正文与执行闸，并可声明发现来源。受众统一写在规则或分支的 scope 条件。呈现裁剪不等于授权：deny 同时用 `restrict` 覆盖继承面并注册 `guard`；allow **不调用 restrict**，执行面统一由 `guard` 兜底——`restrict` 的 allow 只能收继承面名字，而 `tools.schemas()` 的全局视图不含预设/祖先层工具，局部 allow 反而会把要保留的工具裁掉。作用域快照统一走 `engine/tool-scope.mjs#toolScopeSnapshot(tools, agent)`：`globalNames` 是全局层名字（只供 restrict 的已知名过滤），`visible` 是 agent 可见面（含预设/祖先/本层）；新消费方不得用无 scope 的 `schemas()` 当模型可见面。`requireMatch` 只对白名单有意义：名单工具在目录或 SDK 正文缺失时放弃裁剪、暴露完整目录（fail-open），allow guard 同步放行。三面（目录 / 正文 / 执行闸）共用 `engine/actions/shared.mjs#toolSurfacePlan` 这一份判断——`required` 是 allow ∪ 解锁项再剔除 `run_code` 与 deny 覆盖的名字；`available` 是目录名与正文名的并集，缺项时整体放宽。装配里既无目录也无 SDK 正文时视为没有观察到工具面，不据此改执行闸（保持上一轮状态）。呈现失败与 guard 未注册仍可能让三面不一致，那两条路径不改判据。条件由规则引擎逐轮求值，条件变假时撤销上一轮注册的执行闸。

PTC 下装配目录只有保留传输 `run_code`，实际可见面是 `tools:sdk` 正文。`run_code` 不参与 allow/deny 名单：allow 不点名也会保留，`requireMatch` 不计它；allow 不走 `restrict`，deny 的 `restrict` 也会过滤它。可见面裁到空时也不影响这条唯一入口。因此 `tool-surface` 这类 native 收窄声明可以直接与 PTC 共存，`requireMatch` 在 PTC 下按 SDK 正文判定。

按需发现由同一份声明的 `discovery` 字段拥有（`{ kind }`，工具名与解锁键由适配器元数据提供；可选写 `tool`/`key` 只作断言）：动作在首次装配时用 `ctx.get('promptToolDiscovery')` 按 agent 解析适配器，从本会话 durable `tool/call` 与 PTC 嵌套 `tool/ptc-dispatch` 参数提取显式字符串名单，只做加法且不能越过 deny。两类事件名由 `engine/history.mjs` 的 `TOOL_INVOCATION_EVENT_TYPES` 统一；观察工具执行时读两类，观察模型动作/相位晋升仍只看顶层 `tool/call`。工具本身由适配器行注册——声明了 `discovery` 的模块必须把对应行（`tools` → `tool-search`、`skills` → `skill-search`）列进 `modules`，缺行在装配准备期失败。工具名按真实注册名称匹配；坏参数逐条忽略，缺会话回落静态 allow；适配器未注册时告警一次并跳过解锁回收，不阻断装配。

首轮提示用同模板普通 inject-text 动作组合 count 条件与 session 去重；strategy: placeholder、fill: tool-catalog、params.action 引用同规则 tool-visibility 动作。只读变量 RESIDENT_TOOLS 来自该声明 allow 去 deny 后的逗号名单，DISCOVERY_TOOL 来自当前 Agent 的发现适配器工具名。提示正文由模块 text 控制，自动列名单，不复制配置，也不由工具可见面动作注册提示。

tool-catalog 使用普通只读变量插值；`templateEvaluation: true` 在编译时拒绝，避免目录事实被持久变量求值覆盖。被引用动作须声明 allow，未知引用或错误动作种类拒绝；发现适配器不可用时跳过提示并告警。

内置 tool-surface 的规则打开即收窄；`modules` 同时列 `tool-search` 行，工具由该行注册、元数据由发现注册表按 agent 解析，常驻集来自同一声明。普通提示动作在可见用户消息数不超过一条时自动列出声明常驻名单并提示发现解锁，按当前上下文去重；名单描述的是声明，不保证 requireMatch 退回完整目录后的实时工具面。需要晋升门时显式加规则条件；不由引擎偷偷恢复首轮全工具目录。

## 工具呈现（present-as）

`present-as` 行在 **Agent scope** 声明工具呈现（官方 `ctx.tools.presentAs`）：`mode: ptc` 让注册表只贡献保留的 `run_code` 传输与生成的 SDK 段，其余可见能力走程序内绑定；`native` 是部署默认，只有「PTC 部署里挑出个别 Agent 回 native」才需要显式声明。它调的是与官方 `@deepseek-ai/dsh-agent-tool-presentation` 行**同一个** `presentAs`，故两条路径语义等价、scope 不同（本行 = Agent scope，官方行 = 预设常驻 scope，`modeFor` 沿链路最近者优先）；**同一 scope 二次声明由官方拒绝**（挂载期 fail loud，不静默覆盖）。进程级默认呈现仍归宿主 `tools` 行的 `config.mode`，运行时改不了。

`ptc` 需要 `ctx.ptcRuntime`：本行用 `ctx.inject` 等它就绪再声明，等不到就停在 pending 并由预设注册表指名报告不可用的行，**不静默退回 native**；`ptcRuntime` 刻意不进 `inject`，否则 `native` 行会被绑死在「部署必须有 PTC 运行时」上。`presentAs` 自带 disposer，本行不另包一层。

随包内置模块 `ptc-mode` 就是这两行的组合（默认不启用；启用会重挂所有存活 agent）。PTC 部署通常把本行与 `run-code-env` 装在同一模块里：PTC 下 `run_code` 程序里的 `process.env` 恒为空（官方安全设计），而 PATH／HOME 这类非敏感事实常被需要——`run-code-env` 在每个程序执行前注入一份冻结的 `env` 全局并注册 `## run_code environment` 提示段，且只在存在 `run_code` 传输的 scope 生效，对 native 会话零副作用。规则则不必加：模型收到的指引已由官方的 `PTC_ONLY` 段（只有 `run_code` 能直接调用）与生成的 `tools:sdk` 段提供。

`mode` 是兼容默认；可选 `mainMode` / `subagentMode` 分别覆盖主会话和子代理，省略仍继承 `mode`。配装通过引擎 `apply(ctx, config, { agent })` 传入真实 Agent，`present-as` 复用 `isDelegated(agent.session)` 选择模式，不从 Context 或页面状态猜测身份，也不修改共享配置。刷新为各 Agent 重挂独立贡献，压缩不改变受众，释放后恢复宿主默认。

## 自定义工具与宿主契约

工具通过已安装 `@deepseek-ai/dsh-tools` 的 defineTool/官方转换器定义，使用真实 ToolExecution 的 agent、signal、调用身份；异步工作观察或转发 caller-owned signal。delegate 走 `ctx.tools.execute`，保留批准、拒绝和取消管线。

自定义执行器支持 shell/http/delegate/fs/ask-user。定义、参数 Schema、输出和路径在写入边界校验；不依赖工具描述来当权限。宿主 API 以安装包类型和官方文档为准，不复制旧版本行号作当前依据。

## 重建与验证

只在本插件仓库修改源文件；使用 package scripts 重建 lib 与 YAML vendor 快照，不手改产物或宿主源码。根 module.yml 由 rebuild:module-template 生成，示例默认关闭，普通规则变量需手动建立。

交付从隔离 cwd 执行 typecheck、lint、test、build、diff --check；宿主/包接入另核对 verify:host、verify:pack。永久测试只进入注入行为、写盘语义、bridge 载荷、安全拒绝四条 seam，期望来自独立规格或字面样例，断言公共行为。退役接口不留仅证明旧名字不存在的测试。
