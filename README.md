# dsh-plugin-prompt-tool — 层级提示词注入器

> 官方说「一切皆是插件」。
> 本项目说「**一切皆可注入**」——把 DSH 官方开放 API 的全部注入层级收敛为一个
> 可配置的提示词注入引擎：注入什么、注入到哪一层、什么时候注入，全部由提示词配置决定。

DSH 生态的**提示词注入标准层**：一个 `prompt-config-engine.mjs` 接线官方六个注入层级
（`agent/pre-step`、`systemPrompt.section`、`systemPrompt.context`、`agent/request`、
`llm/stream`、`tools/*`），每条提示词配置的**内容与层级位置都由用户自定义**，提示词配置数据进
settings（UI 直接消费），也支持目录加载 yml/json 提示词配置文件。内置 anchored 默认提示词配置组合，
开箱即用。

> 灵感与来源：首轮工具目录锚定机制来自
> [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)，
> 近距离任务引导来自 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)，
> 缓存铁律与工具面成本原则来自
> [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)。
> 上述项目的模型性能引导原理与实测数据请看各自仓库，本 README 只说明本插件功能。

## 安装

```bash
# 方式 A：npm / registry
dsh plugin --profile prompt-tool add dsh-plugin-prompt-tool

# 方式 B：本地源码（link 覆盖 registry 依赖）
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>

# 初始化：首次启动自动补 dsh-web-app 并提示重启，第二次启动生效
dsh --profile prompt-tool
```

装配细节见官方[《打包与安装插件》](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

## 兼容性

- 需要 DSH `0.1.0-rc.8+`（agent preset 机制、`system-prompt/assemble` 钩子、
  `agent/pre-step` 瀑布、`settings.section` 一级设置段（官方术语））。
- 不硬编码内部实现：宿主面只用官方 Context 服务与事件 API
  （`systemPrompt` / `tools` / `llm` / `agent/*` / `session/*` / `tools/*`）。
- Web 设置桥只监听本机回环请求；插件不发起网络请求、不增加遥测。

## 特性

- 🔌 **六层一次接线**：一个引擎注册官方全部可注入层级，层与层之间共享同一套提示词配置
  过滤与降级语义。
- ✍️ **一切皆可配置**：提示词配置的 `id / name / enabled / layer / strategy / position /
  dedupe / promotion / subagents / modelScope / configKind / order / role / text /
  texts / templateFile / fill / variables / params / identity / mergeMode / group /
  exclusive` 全部开放。
- 🧑‍🤝‍🧑 **子代理作用域三态**：`subagents: none`（仅主会话）、`inherit`（主会话与
  子代理都适用）、`only`（仅子代理）——身份类提示词可以只针对子代理注入。
- 🗂️ **内容与执行分离**：每条提示词配置一个 yml（或 json），放在模块文件夹；YAML 使用内置 vendored yaml 包完整解析（列表、行尾注释、block scalar 等全部支持）
  `prompt-configs/`，引擎按文件名数字前缀顺序扫描执行。
- 🧩 **三源合并**：默认四条提示词配置 < `promptConfigsDir`（目录文件） <
  `promptConfigs`（settings 数组）——同名 `id` 覆盖、新 `id` 追加。
- 🖥️ **提示词配置编辑器就绪**：设置面板主菜单一级 section（不占「插件」分类）只保留
  提示词配置页：列表 / 单条表单 / 模板插入 / **目录导入** / 保存前权威校验。
  标准 settings 字段经 rc8 官方 `settingsScope`（共享 describe mirror）读写；
  `/api/prompt-tool/settings/describe` 仍输出完整描述与 live runtime facts，
  `/api/prompt-tool/settings/configs-validate` 复用引擎校验，
  `/api/prompt-tool/settings/templates` 输出内置模板库。
- 🧭 **侧边栏独立工作台**：新建会话行下方的「提示词工具」入口打开中央列工作台，
  顶部标签页为六个注入层级 + Skills 设置；层页内按层管理提示词配置
  （开关按钮 / 上移下移复制删除 / 展开编辑框），pre-step 层还承载
  preset.md / AGENTS.md 编辑与全部入口开关。

- 🧱 **内置模板库**：`templates/*.yml` 覆盖六层与两个 placeholder 数据源，每个文件都是
  可直接复制的单条提示词配置；`/api/prompt-tool/settings/templates` 只读输出模板列表，
  编辑器"插入模板"直接消费。
- 🧪 **内置六种内容策略**：`static`（固定文本/外部模板）、`first-turn-anchor`（任务自动
  锚句）、`guide-auto`（弱/深度引导）、`custom-fallback`（自定义锚定词命中后注入一次，
  未命中最多等两轮兜底）、`instruction-hint`（指令文件提示）与 `placeholder` 动态填充器
  （`instruction-hint` / `env-facts` / `skill-catalog` 三个数据源）。
- 🛡️ **失败不伤会话**：单条提示词配置失败只跳过该提示词配置并 `warnOnce`；配置错误（未知 layer /
  strategy / fill、坏 yml）在挂载时 fail loud。
- 🔁 **持久幂等**：`dedupe: session` 的提示词配置以持久 session events 判重，进程重启 /
  插件重载不重复注入。
- 📦 **anchored 默认预设**：`preset/anchored/preset.yml` 是插件**唯一配置入口**——
  `modules` 决定 23 个行/组模块装配顺序,`params` 驱动引擎开关(`usePtcMode`、`bootstrapMaxTokens`、
  `firstTurnAnchor`…),`hostDefaults` 提供宿主开关默认值,`content` 携带 presetText/agentsText;
  settings(Web/TUI)仅作运行时覆盖。用户写一个参数 YAML 即可复刻 anchored 全部能力。

## 默认行为

除 `id` 必填外，所有字段都有默认值；内容为空一律不注入（fail loud 仅限配置错误）：

| 字段 | 默认值 |
|---|---|
| `enabled / strategy / layer / configKind / order / position / dedupe / promotion / subagents / modelScope / role` | `true / static / pre-step / ordered / 0 / after-user / none / none / none / all / user` |
| `name / sourceKind / form / summary / identity / text / texts / templateFile / fill / variables / params / mergeMode / group` | `id / id / notice / '' / {field:plugin,value:id} / '' / [] / 无 / 无 / {} / {} / separate / 无` |

- `mergeMode`：`separate`（默认）同位置多条配置先后插入为独立消息；`merged`
  同位置（`merged:<position>` 分组键）的多条配置拼接为一条消息。
  该组合对文本型层通用：`pre-step`（消息批）、`system-section`（system 段）、
  `runtime-context`（运行时快照）都可用 `mergeMode / order / texts` 自由拼接；
  `agent-request / llm-stream / tool-pipeline` 按 `order` 排序注册。
- `order`：数值小者更靠近插入锚点；同值保持配置声明顺序，同时决定 `merged`
  组内的拼接顺序。单条配置用 `texts` 数组可一次注入多个 text 内容块。
- `custom-fallback`：`params.firstTurnWord` 默认 `"we"`，可自定义任意锚定词（如
  `"我是xxx"`）。晋升后首个 reasoning 命中锚定词立即注入一次；
  未命中最多等满两轮 assistant 消息兜底注入。
- `dedupe: session` 按持久 session events 幂等；`batch` 只对当前消息批去重。
- `promotion`：`none` 不要求晋升；`main` 主会话晋升状态；`include-subagents`
  子代理跟随自身晋升状态。
- `group + exclusive: true` 时同一组只执行排序后第一个 `enabled` 的提示词配置。
- 单条失败跳过并 `warnOnce`；未知枚举、坏 yml、目录不可读在挂载/生成时 fail loud。
- `agent-request + replace: true` 会用 `params.patch` 整体替换调用配置，需提供完整
  `provider/model` 等字段；未写 `replace` 时是安全的浅合并透传。

## 与相关项目的定位差异

| | dsh-super-injector | dsh-anchored-standard | dsh-router-standard | **dsh-plugin-prompt-tool** |
|---|---|---|---|---|
| 形态 | 运行时插件手术台：注入/热重载/卸载完整插件包 | 两阶段工具目录锚定 preset | 首轮 persona 与近距离引导方案 | **层级提示词注入器**：统一提示词配置 + 可替换默认预设 |
| 适用 | 装/换成品模组、开发闭环 | 需要 Minimal 首轮锚定的会话 | 需要任务分类引导的会话 | 想自定义“注入什么、注入到哪一层”的部署 |
| 联动 | 注入本插件包后可被其热重载 | 本项目默认预设的来源 | 本项目默认提示词配置策略的来源 | 默认组合即两者方案，提示词配置层可整体替换 |

## 生态定位：官方之下的注入标准层

官方把「装什么」定义为配置（cordis.patch.yml / profile bundles / repositories），
本插件承接「装完之后**往哪注入、注入什么、何时注入**」这一层：

| 生态入口 | 层 | 一句话分工 |
|---|---|---|
| 官方 bundle / repository | 装配层 | 唯一官方入口，配置即状态 |
| dsh-anchored-standard / dsh-router-standard | 策略来源 | 提供默认提示词配置与 agent 组合的行为依据 |
| **prompt-config-engine** | **注入执行层** | 官方六层 API 的唯一接线点，提示词配置驱动 |
| prompt-configs/*.yml + settings | **内容配置层** | 用户自定义注入内容与层级位置 |
| anchored 单一参数 `preset.yml` | **默认预设** | 纯参数可替换模板(PTC / gate / bootstrap / 提示词配置) |

## 设计原则

1. **不发明协议**：只使用官方 Context 服务与事件；提示词配置文件就是数据，引擎行为与官方
   瀑布语义一致（`await next()`、不截断下游）。
2. **配置即状态**：提示词配置数组进 settings，目录文件只是第二来源；生成目录可随时重建，
   手改内容应放在用户源目录而不是生成目录。
3. **引擎只负责注入**：内容判定（锚句/引导/we）是内置策略，但每个策略都只产出
   `text` 与消息 patch——新增注入内容不新增引擎分支。
4. **只动自己注册的东西**：过滤只针对本插件提示词配置，绝不改写其他插件的消息面。
5. **可逆且自愈**：提示词配置失败跳过、服务缺失降级、生成目录幂等重建并清理历史残留。
6. **缓存原则**：静态内容走 `system-section`（system 头），动态内容走
   `pre-step` / `runtime-context`（消息面），不把动态文本拼进 system。

### 四层默认值体系（预设参数从哪来）

预设行为由 preset.yml 单一配置源下发，共四层默认值，各层职责不重叠：

| 层 | 载体 | 职责 | 覆盖关系 |
|---|---|---|---|
| hostDefaults | preset.yml `hostDefaults:` | settings 层默认值（写入开关/路径） | 被用户 settings 覆盖 |
| params | preset.yml `params:` | 引擎行为默认（锚定/引导/PTC/门控/工具参数） | 被运行时 settings 覆盖（resolvePresetParams 合并） |
| moduleConfigs | preset.yml `moduleConfigs:` | 引擎库组合行级 config（persona 文本/超时/白名单等） | 行默认值的预设级覆盖 |
| promptConfigs | preset.yml `promptConfigs:` | 注入提示词配置（策略/层/位置/时机） | 被用户 promptConfigs 与目录合并 |

引擎内置参数（如 tool-bootstrap 的 `promoteGate` / context-gate 的 `messageSources`）只从
moduleConfigs 读取，不写入 settings 层——用户环境 settings.yaml 保持精简，预设行为全部
由 preset.yml 决定。

## 提示词配置全家桶

| `layer` | 官方通道 | 提示词配置参数 |
|---|---|---|
| `pre-step` | `agent/pre-step` 消息批（默认层） | `position / dedupe / promotion / subagents(none / inherit / only) / modelScope / strategy` |
| `system-section` | `ctx.systemPrompt.section` 静态 system 段（支持官方 `{{variable}}`） | `order / text / templateFile / variables / params.complete / params.sectionName` |
| `runtime-context` | `ctx.systemPrompt.context` 动态运行时快照 | `order / text / templateFile / variables / params.contextName` |
| `agent-request` | `agent/request`（LlmCallConfig 修改） | `params.patch`（浅合并）/ `params.replace`（整体替换） |
| `llm-stream` | `llm/stream`（流包装） | `params.mode=pass\|replace`；replace 用 `text` 替代模型流 |
| `tool-pipeline` | `tools/pre-execute` / `tools/execute` / `tools/post-execute` | `params.toolNames`（逗号分隔）、`preDecision=allow\|deny\|ask`、`postAction=accept\|replace\|block` |

默认四条提示词配置：`00-near-anchor`（首句任务锚点）、`10-router-guide`（Flash 每轮引导）、
`20-prompt-injector`（we 确认后注入 preset.md 一次）、`30-instruction-hint`
（指令文件存在性提示）。


### 层能力矩阵

| 层 | modelScope | subagents | promotion | dedupe | merge | 文本插值 |
|---|---|---|---|---|---|---|
| pre-step | ✓ | ✓ | ✓ | ✓ | ✓（同 position） | 内置 `DSH_HOME/WORKSPACE/CWD` + variables + filler 变量 |
| system-section | ✗（注册即全局） | ✗ | ✗ | ✗ | ✓（同 order） | variables + 官方 `{{variable}}` |
| runtime-context（static） | ✗ | ✗ | ✗ | ✗ | ✓（同 order） | variables |
| runtime-context（placeholder） | ✗ | ✗ | ✗ | ✗ | 单条 | variables + filler 变量 |
| agent-request | ✓ | ✓ | ✗ | ✗ | 按 order 注册 | params.patch 不插值 |
| llm-stream | ✓ | ✗ | ✗ | ✗ | 按 order 注册 | 不插值 |
| tool-pipeline | ✓ | ✓ | ✗ | ✗ | 按 order 注册 | text 不插值 |

> ✗ 表示该层官方 API 没有逐 agent / 逐消息概念，字段配置了也不会在该层生效，
> 不是配置错误。文本插值规则：只有 `pre-step` 支持内置环境变量与 filler 变量；
> `system-section` / `runtime-context` 的静态文本只替换 `variables` 表
> （`system-section` 额外走官方 `{{variable}}` 渲染）；`agent-request` /
> `llm-stream` / `tool-pipeline` 的 `text` 与 `patch` 原样使用。


## 提示词配置开发指南（一分钟写一个提示词配置）

```yaml
# prompt-configs/40-identity.yml —— 注入 system 静态层
id: identity-section
name: 身份段
enabled: true
layer: system-section
strategy: static
order: -50
text: |
  你是 {{AGENT_NAME}}，回复前先说明正在做什么。
variables:
  AGENT_NAME: prompt-tool
```

```yaml
# prompt-configs/50-request.yml —— 注入调用配置层
id: flash-cap
enabled: true
layer: agent-request
modelScope: flash
params:
  patch:
    maxTokens: 4096
    temperature: 0.3
```


```yaml
# prompt-configs/60-skill-catalog.yml —— 动态技能目录（晋升后注入一次）
id: skill-catalog
name: 技能目录
enabled: true
layer: pre-step                  # 或 runtime-context（每次装配动态刷新）
strategy: placeholder
fill: skill-catalog
position: after-all
dedupe: session
promotion: main
text: |-                         # 可选；变量 SKILL_COUNT / SKILL_NAMES / SKILLS_TEXT
  可用技能 {{SKILL_COUNT}} 个：
  {{SKILLS_TEXT}}
params:
  limit: 20                      # 输出数量上限；0 = 全部（谨慎使用）
  fields: name,description       # 输出字段：name / description / whenToUse
  providers: ''                  # provider 过滤；只列本插件技能时填 prompt-tool
  emptyBehavior: skip            # skip=无技能不注入；text=注入 emptyText
```

没有现成示例时可以直接复制 `templates/*.yml`（六层与 placeholder 各一个）作为起点，保存前用 `/api/prompt-tool/settings/configs-validate` 校验。


接入方式二选一，优先级 `promptConfigs（settings）> promptConfigsDir（目录）`：

```yaml
- insert:
    - id: prompt-tool
      name: dsh-plugin-prompt-tool
      config:
        promptConfigsDir: 'D:/my-configs'     # 扫描 *.yml / *.yaml / *.json
        promptConfigs:                      # settings 数组（UI 将直接渲染此数组）
          - id: near-anchor                  # 同名覆盖默认提示词配置
            strategy: static
            text: '自定义锚点内容'
          - id: extra-config                   # 新提示词配置
            layer: runtime-context
            text: '自定义运行时上下文'
```

## 机制

1. **扫描**：源码 `engine/prompt-config-engine.mjs`(生成目录为 `engine/prompt-config-engine.mjs`)读 `config.configsDir`(默认 `../prompt-configs`),
   按文件名数字前缀排序加载 `*.yml / *.yaml / *.json`；
2. **归一化**：`createPromptConfigs` 校验并补全全部提示词配置字段，未知值 fail loud；
3. **接线**：非 `pre-step` 提示词配置按 `layer` 注册官方通道（section/context 注册挂
   `ctx.effect`，事件监听由 fiber 自动清理）；`pre-step` 提示词配置进入统一消息执行器；
4. **合并**：`src/prompt-configs.ts` 的 `mergePromptConfigs` 把默认提示词配置、目录提示词配置、settings 提示词配置
   三源合并后渲染为生成目录的 `prompt-configs/*.yml`；
5. **幂等**：`dedupe: session` 先查进程内 memo，再查持久 session events 中的
   `source.plugin` / `source.kind` 标记；
6. **降级**：服务缺失、单条提示词配置异常、目录不可读都只告警不阻断；生成目录每次重写并
   清理旧平铺脚本残留。

## 踩坑记录

- **引擎行必须等宿主服务**：`export const inject = ['systemPrompt', 'tools', 'llm']`
  由官方依赖图解析；preset 行在 agent 组合内（persona 依赖 systemPrompt），缺服务的
  profile 会在挂载阶段暴露，而不是运行时静默失败。
- **提示词配置目录相对引擎文件**：`configsDir: ../prompt-configs` 与 `templateFile` 都相对
  `prompt-config-engine.mjs` 所在目录解析，移动引擎文件时同步改。
- **手改生成目录会被覆盖**：生成目录每次 `writePreset` 重建；自定义内容请放
  `promptConfigsDir` 或 settings，而不是生成目录。
- **非 `pre-step` 提示词配置不参与消息去重**：`dedupe / position` 只对消息批有意义；
  section / context / request / stream / tool 层的提示词配置用各自的 `params` 控制。
- **动态文本不要进 system**：`system-section` 只放缓存稳定的文本；需要随会话变化
  的内容用 `runtime-context` 或 `pre-step`。

## 验证

```sh
pnpm install
pnpm build        # 生成 lib/
pnpm test         # 提示词配置渲染/合并、六层级接线、preset 生成等单测
pnpm typecheck
pnpm lint
pnpm sync:anchored   # 刷新 upstream/dsh-anchored-standard 内联快照（可加 ref）
pnpm sync:yaml       # 刷新 engine/vendor/yaml（生成目录运行时 YAML 解析器）
pnpm rebuild:composition   # 从官方 deepseek-harness 内置预设源码重建组合模块
```

## 许可

插件本体 MIT（Czerror）。默认预设与提示词配置策略来源见顶部引用；`upstream/dsh-anchored-standard/`
为内联快照（LICENSE / NOTICE / REVISION 保留原版权声明），`preset/` 下 cordis 模板与
脚本基于 DeepSeek Harness 官方 Standard 预设修改，原始版权声明见
`upstream/dsh-anchored-standard/NOTICE` 与 `LICENSE`。

---

**仓库**：https://github.com/Czerror/dsh-plugin-prompt-tool
