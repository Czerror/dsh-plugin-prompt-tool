---
name: dsh-module
description: 给 DSH 写一个 prompt-tool 模块：一份 $DSH_HOME/.prompt-tool/modules/<id>/module.yml 定义规则（if → then）、注入正文、人设、共享参数、自定义工具与子代理策略。模块由插件在各 Agent 自己的 scope 里装配，启停只由存储根 config.yml 的启用表决定，与官方会话预设互不干涉。Use when 用户要新建/改写/审查一个模块、把规范或人设做成常驻注入、给模块配九层注入与条件动作、让模型多出工具或委派能力、把 GitHub 仓库／CLI／HTTP 服务／文档／SillyTavern 资源移植成模块、或排查模块已启用却不生效、注入没到达模型。
---

# dsh 模块

最短路径：写 `$DSH_HOME/.prompt-tool/modules/<id>/module.yml` → 把 `<id>` 加进 `$DSH_HOME/.prompt-tool/config.yml` 的 `enabled` → 重启 DSH 服务。

**本技能里的路径相对插件包根，不在本技能目录下**：`engine/`、`modules/`、`templates/` 都在插件包里。包名 `dsh-plugin-prompt-tool`，定位用环境变量 `$env:DSH_PROFILE_DIR`（bash 里读 `$DSH_PROFILE_DIR`），包就在它的 `node_modules/` 下。读包内文件用**文件读取工具**——Desktop 部署下包可能落在 `app.asar` 里，shell、glob、grep、node 都打不开它。找不到包时以 `reference.md` 为准，它是那些源码的摘要。

行为写在 `module.yml` 的 `rules` 里，参数写在 `layerSettings` 里，能力段写在顶层（`persona` / `variables` / `customTools` / `subagentToolPolicy`）——`module.yml` 是唯一要编辑的文件，旁边的 `rules/` 切片由插件从它物化。

一个模块 = 一个目录 `$DSH_HOME/.prompt-tool/modules/<id>/`，`module.yml` 是**唯一完整定义**与恢复依据。`rules/<规则id>.yml`、`rules/_settings.yml`、`rules/variables.yml` 是插件从它物化出的切片，只读；改了会被单向重切回来。

模块不是官方预设：它不进官方预设册、不切换会话预设、也不依赖宿主扫描。装配由插件在**每个 Agent 自己的 scope** 里做，成员由存储根 `$DSH_HOME/.prompt-tool/config.yml` 的 `enabled` 列表决定。所以「这个模块装了什么」与「会话用的是哪个官方预设」是两件互不干涉的事。

先判这次做哪一种，再往下走：

| 你要的效果 | 落点 |
|---|---|
| 把规则、规范、人设、提示词注入到某层某个时机 | 第 2～3 步（规则与层） |
| 让模型多出工具、委派、内容资产、模型参数 | 第 3 步末尾补 `modules` 与能力段 |
| 把外部项目（仓库／CLI／HTTP／文档／ST 资源）搬进来 | 先读第 6 步的形态表，再回到第 1 步 |
| 审查一个已有模块 | 直接跳「审查已有模块」 |

**只审不改**：用户要的是判断（「这个定义对不对」「为什么没生效」）时，逐条给依据与改法就收尾——不写盘、不重启、也不顺手「修好」再报告，除非他明确让你改。

## 第 1 步 立文件与身份

```yaml
# $DSH_HOME/.prompt-tool/modules/my-rules/module.yml
id: my-rules            # 必须与目录名一致；^[a-z0-9][a-z0-9-]*$，全小写
name: 我的规则
version: 1.0.0
engineCompat: ">=0.4.2"
description: 一句话说明，只给人看
modules:                # 这个模块启用哪些引擎能力行
  - rule-engine         # 声明了 rules 就要它
rules: []               # 规则在这里；空模块不自动生成正文或规则
```

- 先解析 `$DSH_HOME` 再动手：PowerShell 读 `$env:DSH_HOME`，bash 读 `$DSH_HOME`；它未设置时插件回落到 `~/.dsh`。别假设默认路径就是现场在用的那个，也别把模块写到别的根。
- 目录建在存储根 `modules/` 下；包内 `modules/` 是启动时的补建来源（随包分发三个：`ponytail`、`tool-surface`、`skill-surface`），同名用户目录保持原样。
- 顶层字段：`id` `name` `version` `engineCompat` `description` `modules` `rules` `layerSettings` `persona` `variables` `customTools` `subagentToolPolicy` `configOrder` `moduleConfigs` `meta` `order`。

**完成判据**：目录名与 `id` 一致、`module.yml` 能被解析——工作台模块页能列出它（列表就是 `/meta` 的 `modules`），或只读读取接口能看到。

## 第 2 步 写规则：`if` → `then`

规则字段：`id` `name` `enabled` `layer` `group` `exclusive` `if` `then` `else`。

```yaml
rules:
  - id: my-rules-main          # 稳定身份，禁用也要合法；不含 / \ : * ? " < > | 与控制字符
    name: 规则正文
    enabled: true
    layer: system-section
    then:
      - id: inject             # 动作 id 在整条规则内唯一（含分支里的）
        kind: inject-text
        config:
          layer: system-section
          strategy: static
          order: 190
          text: |-
            规则正文……
```

- `if` 是**只有一个键**的节点：组合算子 `all` / `any` / `not` / `notAny`，或九个谓词之一。`if` 缺省 = 无条件。九个谓词、每个的字段与语义见 `reference.md` 第一节。
- `then` 非空数组；动作按数组顺序在同一执行点执行，条件只求值一次。
- 分支写 `else`（承接规则级 `if` 的反面）；一个动作要自己有分支，就把它写成 `{ if, then, else }` 节点嵌在 `then` / `else` 里，可继续嵌套。一个 `else` 结构上保证必有一支命中，适合「两档互斥、总得给一档」。
- 互斥档位：同模块内同名非空 `group` 里任一规则写 `exclusive: true`，整组最多一条启用。切换要**先关旧档再开新档**，或由工作台显式激活目标卡（它会在一次事务里关掉同组其他卡）。
- 条件拿不到必要事实时返回 `UNAVAILABLE`：只有严格 `true` 才执行。

**完成判据**：模块保存成功（保存路径会用 `compileRules` 编译完整候选，不合法直接拒绝），或手动编译通过：

```powershell
node --input-type=module -e "import {compileRules} from './engine/rule-spec.mjs'; import {parse} from 'yaml'; import {readFileSync} from 'node:fs'; const d=parse(readFileSync(process.argv[1],'utf8')); compileRules(d.rules ?? [])" '<module.yml 绝对路径>'
```

（在仓库根执行；只做校验，不写盘。）

## 第 3 步 选层与动作

**层是官方扩展点，不是一个管线**：九个层彼此独立，没有跨层运行顺序。规则顶层的 `layer` 只用于展示与分组，真正生效的层取**动作**里的 `config.layer`。

| 层 | 真实入口 | 主要用途 |
|---|---|---|
| `pre-step` | `agent/pre-step` 消息批 | 每轮/首轮注入、来源过滤、按任务给子代理分档 |
| `system-section` | `ctx.systemPrompt.section` | 常驻系统段；`params.complete` 可独占整个 system prompt |
| `runtime-context` | `ctx.systemPrompt.context` | 动态快照（沙箱、审批、委派事实） |
| `agent-request` | `agent/request` | 改模型请求参数（provider/model/temperature/maxTokens/stop） |
| `llm-stream` | `llm/stream` | 包装或替代模型输出流 |
| `tool-pipeline` | `tools/*` | 工具放行/拦截/改写结果 |
| `turn-stop` | `agent/turn-stopping` | 命中后强制续跑一步（引擎内每轮 1 次、每会话 3 次上限） |
| `subagent-start` | `subagent/start` | 向新子代理注入上下文 |
| `subagent-end` | `subagent/end` | 记录或向主会话投递子代理结果 |

三条容易踩的约束：

1. **层字段白名单**：`position` 用在 `pre-step`；`subject` / `match` 用在 `pre-step`、`tool-pipeline`、`turn-stop`、`subagent-start`、`subagent-end`；`audience` 用在 `pre-step`、`system-section`、`agent-request`、`tool-pipeline`。全表见 `reference.md` 第三节。
2. **注册制层的条件写在规则级 `if`**：`system-section` 与 `runtime-context` 用 `if` 表达条件（走条件文本贡献通道，每次 assembly 求值；`system-section` 配 `if.scope.audience` 是常见写法）；动作级 `{ if, then, else }` 分支用在带逐轮时机的层（`pre-step` 等）。
3. **通用门写在规则级 `if`**：`audience` / `modelScope` / `promotion` / `subject` / `match` 都在规则 `if` 里；`system-section` 的静态注册 `audience` 是写在动作 `config` 里的唯一例外。

九个动作——`inject-text`、`assembly`、`decision`、`append-context`、`guard`、`sdk-strip`、`request-params`、`inbox-prepend`、`pre-step-filter`——各自的字段、执行点与失败降级见 `reference.md` 第二节。几条不写会后悔的：

- 工具面收窄用 `assembly.target.tools`：`allow` 是**白名单**（没点名即裁掉），`deny` 是黑名单，二者取一。配 `requireMatch: true` 让名单里任一工具缺失时整体放弃裁剪、暴露完整目录——宁可多给上下文，也不静默裁成空目录。
- 把解锁做到跨请求，靠 `allowFrom: { tool, key }`：从本会话已持久化的 `tool/call` 参数里回收名单。**只能做加法**，永远解不开黑名单；它必须与发现工具成对出现，否则解锁是一次性的。
- `guard` 是最终拒绝层（`assembly` 只管呈现）：被它点名的工具，即使经 `run_code` 子调用也会在实际执行点被拒。它按**工具名**裁决，`run_code` 作为 PTC 的唯一入口始终可用。
- 禁用或收窄某个工具要三层同做：呈现裁目录（`assembly.target.tools.deny`）、文本裁声明（`sdk-strip.mask.deny`）、执行层拒绝（`guard.mask.deny`）。`guard` 注册在 agent scope，**会话原有预设装的行也归它裁决**——这是模块禁用官方工具的硬手段；完整写法与最小 YAML 见 `reference.md` 第二节。
- `pre-step-filter` 的 `sources` 是严格白名单，且同时作用于被领取的消息批：名单要**枚举全部真实 kind**——没写进去的 kind 会连同它的消息一起消失。`modules/skill-surface/module.yml` 里的 14 种 kind 就是一次实测枚举。

**完成判据**：每个动作的字段都落在该层白名单内；条件与通用门都写在规则级 `if`。

## 第 4 步 挂能力与参数

`modules` 声明这个模块启用哪些能力行；模块名就是 `engine/compositions/source/local/` 下的文件名。参数放在 `layerSettings.<层名>.<键>`，公开共享键四个：

| 键 | 归属层 | 作用 |
|---|---|---|
| `instructionHint` | `pre-step` | 晋升后把官方指令全文换成一次路径提示（默认关） |
| `maxDepth` | `subagent-start` | 已启用的插件子代理策略的递归深度 |
| `toolGitBashEnabled` | `tool-pipeline` | Windows Git Bash 适配行开关 |
| `customToolRequireApproval` | `tool-pipeline` | 需要用户批准的自定义执行器：shell / http / delegate / fs / ask-user |

模型与采样参数走 `agent-request` 动作的 `patch`，受众用规则的 `if.scope` 区分。

其余能力各有自己的顶层段，互不混写：

- `persona: { prefix, suffix, complete, includeRuntimeContext }` —— 人设；`complete: true` 让它独占总个 system prompt（同一 scope 一个）。
- `variables: { 名字: 值 }` —— `{{名字}}` 插值源；空字符串是**有意义的占位**，不按「空值删键」处理。局部覆盖写在动作的 `config.variables`。
- `customTools: [...]` —— 自定义模型工具，五种执行器 `shell` / `http` / `delegate` / `fs` / `ask-user`；结构照 `templates/tools/*.yml` 抄。`shell` 只继承白名单环境变量（`PATH` `HOME` `USERPROFILE` `DSH_*` 等），要透传别的（token、代理）得在工具定义的 `execute.env` 里显式写。
- `subagentToolPolicy: {...}` —— 子代理工具授权（`ceiling` / `profiles` / `taskRules` / `modelExpansion`）；缺省时子代理按官方委派行为，不受本模块约束。

**完成判据**：每个用到的能力都有对应 `modules` 行；每个 `layerSettings` 键都在上表四个之内；`persona.complete` 若为真，同 scope 内只有它一条独占段。

## 第 5 步 启用与验证

1. 把模块 id 加进 `$DSH_HOME/.prompt-tool/config.yml` 的 `enabled`（工作台模块页的开关也写这里），然后**重启 DSH 服务**——手改 `module.yml` 后同样要重启才加载。
2. 注入类改动逐条确认到模型真的收到：
   - 模块被列出且定义有效（工作台模块页 / 只读接口）；
   - 规则编译通过（保存时的编译就是同一个 `compileRules`）；
   - 开一个新会话，在系统消息或对话流里核对正文**真的到了模型**——「已启用」不等于「模型收到」；
   - 工具类改动看工具预览：自定义工具与被放行的工具确实可见，被挡的工具在 `run_code` 子调用里也被拒；
   - 停用一次并重启，确认贡献干净撤回（已落进会话历史的消息保留）。
3. 报告时如实区分「跑了哪些验证」与「只是静态检查」：没有真机现场证据的，就说未验证。

**完成判据**：五条里与本次改动相关的都跑过并留下结论；没有把静态可解析当成运行时生效。

## 第 6 步 把外部项目做成模块

先判能搬哪一块——模块不执行第三方代码，能搬的是**用法**与**接口**：

| 来源形态 | 能搬的部分 | 落在哪个能力 |
|---|---|---|
| 规范／方法论 | 规则文本 | `inject-text`（`system-section` 或 `pre-step`） |
| CLI 工具 | 命令用法与约定 | 注入 + `customTools` 的 `shell` 执行器 |
| HTTP 服务／API | 接口调用 | `customTools` 的 `http` 执行器 + 规则门控 |
| 文档／手册 | 操作流程 | 技能（放进技能来源根，模型按需加载，不常驻上下文） |
| 库／SDK | 只有它的命令行入口 | `shell` 执行器；安装需用户批准 |
| 数据／模型 | 只能被上面几种引用 | 世界书与模块记忆 `memory.md` |
| 别的 agent 平台插件／MCP | 不能直接搬 | 宿主平面，不是模块能表达的 |

挑能力时逐条问「这个来源为什么需要它」，说不出理由的能力族就别装：多装一族就多一份工具面与复杂度。**完成判据**：能一句话说出「搬哪一块、动哪几个能力、前提是什么」。

SillyTavern 预设、角色卡与世界书走工作台导入，不走手写：导入产物**就是普通模块**（同一目录、同一启用表、无角色专属存储），导入后仍要在启用表里启用才参与装配。

**做不到的事要直说，别硬凑一个能跑的假实现**：

| 要求 | 怎么回 |
|---|---|
| 「把这个仓库跑起来／复刻它的运行时」 | 模块不执行第三方代码；能做的是 shell 调它已装的 CLI，或 http 调它的服务 |
| 「把依赖装上」 | 属于宿主与插件通道，需要用户批准 |
| 「加一种全新工具类型／新执行器」 | 要写插件（创造模式预设 + `plugin_manager`），模块只能从既有能力里选 |
| 「加一个新的引擎模块／改门控行为」 | 属于插件开发，模块只能从既有模块库选 |
| 「改宿主默认行为／全局设置」 | 宿主平面；模块只作用于装了它的 Agent |
| 「接一个 MCP 服务器」 | 走宿主的配置型 bundle patch |
| 「把整仓塞进上下文」 | 只提炼规范与接口；整仓进上下文是 token 与权限双重失控 |

## 审查已有模块

逐条核对，每条给出依据（文件与行）：

1. `id` 与目录名一致、符合 `^[a-z0-9][a-z0-9-]*$`；顶层键都在第 1 步那份字段表里。
2. 规则字段是那九个；动作 id 在整条规则内唯一。
3. 每个动作的字段都在该层白名单内（回第 3 步）。
4. 条件与通用门都写在规则级 `if`。
5. 互斥组同组只有一条启用；换档说明写在 `description`（给人看），正文留给模型。
6. `layerSettings` 只用了那四个公开键。
7. 能力声明既存在又必要：`modules` 里的名字都在 `source/local/` 下；用到的 `customTools` / `subagentToolPolicy` / `persona` 都有对应声明。
8. 手改后重载过（模块在启动时读盘）。
9. `rules/` 下的切片保持原样——编辑入口是 `module.yml`。

## 相关技能

- 组合行与插件行层面的细节：`editing-cordis-compositions`
- 需要写新插件或新能力：`cordis-plugin-development`
- 指令文件（AGENTS.md / CLAUDE.md）正文与开关：那不属于模块，见仓库的指令文件文档
