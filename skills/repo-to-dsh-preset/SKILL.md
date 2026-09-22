---
name: repo-to-dsh-preset
description: 把 GitHub 仓库做成 dsh 预设：先判定仓库形态（规范 / CLI / HTTP 服务 / 文档 / 库 / 数据），再从本插件的引擎能力族里挑组合（注入 / 门控 / 工具面 / 外部能力 / 内容资产 / 控制层 / 节拍 / 委派 / 模型），超出能力边界时明确告知用户。Use when 用户要把 GitHub 项目接入为预设、把开源工具用法固化成预设、把项目文档变成注入规则、给预设装调用该项目的能力，或问某个仓库能不能做成预设。
---

# 从 GitHub 仓库到 dsh 预设

预设是**声明式装配**：一个目录 + `preset.yml` + 重建出的组合。移植一个仓库，是在本插件的引擎能力里挑一组装进去 —— 不只加一个自定义工具。

## 第 1 步 判形态：仓库的哪一块能被移植

| 仓库形态 | 可移植的部分 | 主要落在 | 前提 |
|---|---|---|---|
| 规范 / 方法论 | 规则文本 | 注入族 | 无 |
| CLI 工具 | 命令用法与约定 | 注入族 + 外部能力族（shell）+ 工具面族 | 该 CLI 已装在机器上 |
| HTTP 服务 / API | 接口调用 | 外部能力族（http）+ 门控族（用 PTC 组合多步调用） | 端点与凭据由用户提供 |
| 文档 / 手册 | 操作流程 | 外部能力族（内嵌技能） | 无 |
| 库 / SDK | 只有它的命令行入口 | 外部能力族（shell） | 需要用户批准安装 |
| 数据 / 模型 | 只能被上面几种引用 | 内容资产族 | 取决于引用方 |
| 别的 agent 平台插件 / MCP 服务器 | 不能直接搬 | 宿主平面（见第 5 步） | 需要用户在创造模式下操作 |

**完成判据**：能一句话说出"移植哪一块、动哪几个能力族、前提是什么"；说不出来就回到本表再判。

## 第 2 步 引擎能力族：这次要动哪几个

| 能力族 | 装什么模块 | 什么时候用 | 关键旋钮 |
|---|---|---|---|
| 注入 | `prompt-config-engine` | 把规范、约定、输出格式、决策规则按位置与时机注入 | 六插入点、`audience`、`modelScope`、`dedupe`、`promotion`；策略：首轮锚定 / 每轮引导 / 兜底注入 / 世界书 / 占位符；`variables` |
| 时机与可见面 | 预设顶层 `triggers` 声明（不装模块） | 控制"什么时候能看到什么"：未晋升时清空上下文 / 过滤来源、首轮窄化工具目录、晋升后放开、按相位或计数改请求参数与注入文本 | 声明三要素：`channel`（`system-prompt/assemble` / `agent/request` / `agent/pre-step` / 工具与事件层）、`when`（`phase` / `source` / `count` / `session` / `text` / `names` / `preset` 谓词 + `any` / `all` / `not` / `notAny`）、`do`（`assembly` / `request-params` / `pre-step-filter` / `inject-text` / `decision` / `append-context` / `guard` / `sdk-strip`；见 `docs/engine-reuse.md` 的「组合示例」） |
| 工具面 | `subagent-tool-policy`（子代理）+ 声明（主代理名单） | 让工具面贴合这个项目：子代理工具档、扩权审批；主代理白/黑名单用 `triggers` 声明（`assembly` + `sdk-strip` + `guard` 三条共用同一份名单） | 策略的 `ceiling` / `profiles` / `taskRules` / `modelExpansion` |
| 外部能力 | `tool-config-engine` + 预设内嵌 `skills/` | 真去调用那个项目：五种执行器（`shell` / `http` / `delegate` / `fs` / `ask-user`）；把手册做成按需加载的技能 | `customTools`、`customToolRequireApproval`；`skills/` 要配 `skill-filesystem-cordis` + `tool-skill` |
| 内容资产 | `world-book-tools` + `character-tools` + `session-var-tools` | 按关键词取用知识、角色素材与记忆、会话内状态机 | 世界书条目字段、角色卡库、`session_var` |
| 控制层 | 层 `agent-request` / `llm-stream` / `tool-pipeline` | 改请求参数（模型、温度、上限）、替换模型输出流、在工具管线里放行 / 拦截 / 改写结果 | `params.patch` 或 `replace`、`mode`、`toolNames` + `preDecision` / `postAction` |
| 节拍 | 声明（`count` / `session` 谓词 + `decision` / `append-context` / `inject-text` 动作） | 约束思考与节奏：先深思再动手、按节拍报进度、首轮锚句 | 用谓词与动作自行声明；原首轮锚句 / 深思门 / 进度节拍三个专用模块已随 B7 删除 |
| 委派 | `delegation` + `subagentModel` 段 + `maxDepth` | 把活分给子代理，并给子代理独立的模型、工具档与深度 | `maxDepth`、`subagentModel` 段、`subagentToolPolicy` |
| 模型 | `model` 段 | 这个项目适合的模型与推理档 | `provider` / `name` / `reasoningEffort` / `temperature` / `maxTokens` |

工作台「添加能力」不再提供一键配方（原 `phase-control` / `phase-control-ptc` / `deliberation` 三个配方已随这批模块退场，配方表为空）；能力模块就是 `engine/compositions/library/` 与 `engine/compositions/source/local/` 下的文件名；每个旋钮的完整语义见 `docs/engine-reuse.md` 与 `docs/architecture-params.md`。

> 旋钮的类型、默认值与作用全表（30 个，按能力族分组），加上全部模块清单，见同目录 `reference.md`；挑旋钮时读它。

字段白名单只在对应层合法：`pre-step` 支持 `position` `dedupe` `promotion` `audience` `modelScope` `mergeMode` `role`；`system-section` 只支持 `audience` `mergeMode`（写 `modelScope` 会报错）；`runtime-context` 只有 `mergeMode`；`agent-request` 与 `tool-pipeline` 支持 `audience` `modelScope`；`llm-stream` 只支持 `modelScope`。

**完成判据**：每个选中的能力族都写得出"这个仓库为什么需要它"；说不出理由的族就别装 —— 多装一族就多一份工具面与复杂度。

## 第 3 步 写预设

- 位置：`$DSH_HOME/.agent-presets/<id>/preset.yml`。
- **目录名不能与宿主内置预设同名**（内置 id 是 `standard` / `ptc` / `minimal` / `cordis`）：同名的用户目录会被内置版遮蔽、从不挂载，界面上一切正常而模型一个字都收不到（真机踩过）。用 `pt-<名字>` 形态。
- 内置预设只读：要改它的行为，复制成新目录再改。
- `modules` 从既有模块库挑。库里没有的能力就是边界，走第 5 步。

```yaml
id: pt-<名字>
name: <显示名>
description: <一句话，给人看>
version: 1.0.0
engineCompat: ">=0.4.2"
modules:
  - agent-instructions
  - tool-bash
  - tool-fs
  - tool-config-engine        # 外部能力
  - skill-filesystem-cordis   # 内嵌技能
  - tool-skill
  - prompt-config-engine
persona:
  prefix: <该项目对 agent 的角色要求>
params:
  instructionHint: true       # 晋升后只发一次指令文件路径提示
triggers:                     # 时机与可见面：声明式（writePreset 物化为 <预设目录>/triggers.yml）
  - id: first-tool-face
    channel: system-prompt/assemble
    when:
      not:
        phase: { promoteOn: either, includeSubagents: false }
    do:
      kind: assembly
      id: first-tool-face
      target:
        tools: { allow: [bash, str_replace_editor], requireMatch: true }
  - id: web-tools-off          # 例：这个项目不需要联网（呈现 + SDK 正文 + 执行层三件套）
    channel: system-prompt/assemble
    do:
      kind: guard
      id: web-tools-off
      mask: { deny: [web_search, web_fetch] }
      reason: 该项目不联网
promptConfigs:
  - id: <前缀>-rules
    name: <规范名>
    strategy: static
    layer: system-section
    order: 190
    enabled: true
    text: |-
      <从仓库提炼的规范正文>
customTools:
  - id: <前缀>-api
    name: <前缀>_api
    description: 调用 <项目> 的 HTTP 接口
    parameters:
      path: { type: string, required: true, description: 接口路径 }
    output:
      schema: { type: object, additionalProperties: true, properties: { body: { type: string } } }
    execute:
      kind: http
      url: 'https://<端点>/{{args.path}}'
```

**完成判据**：`preset.yml` 能解析、`id` 与目录名一致、避开内置名、`modules` 全部来自模块库、`params` 的键都是本插件认识的参数、`triggers` 的 `when` / `do` 形状过声明编译器。

## 第 4 步 验证，并如实报告跑了哪些

1. 组合生成：工作台保存后重建不报错，生成目录出现 `agent.cordis.yml`、`prompt-configs/`、`custom-tools/`。
2. 注入到达模型：新开一个会话，核对系统提示里出现规范正文 ——"已保存"不等于"模型收到"。
3. 工具面符合预期：工作台工具预览里能看到自定义工具与被放行的工具；看不到就是模块或白名单没配好。
4. 声明的时机与可见面真的生效：首轮与晋升后的工具目录是否不同、被剔除的工具是否连 `run_code` 子调用也被拒、按节拍或计数的注入是否出现；委派族看子代理是否拿到独立模型与工具档。
5. 报告：哪些验证跑了、哪些没跑；没跑的明说未验证。

## 第 5 步 边界：超出能力时怎么回用户

| 用户的要求 | 判定 | 怎么回 |
|---|---|---|
| "把这个仓库跑起来 / 复刻它的运行时" | 做不到 | 预设不执行第三方代码。能做的是 shell 调它已装的 CLI，或 http 调它的服务 |
| "把它的依赖装上" | 不是预设的事 | 需要用户批准安装，属于宿主与插件通道 |
| "加一种全新工具，或新的执行器类型" | 要写插件 | 切到创造模式（`cordis`）预设，用 `plugin_manager` 加 `cordis-plugin-development` |
| "加一个新的引擎模块 / 改门控行为" | 改插件本身 | 预设只能从既有模块库选；新模块属于插件开发 |
| "改宿主默认行为 / 全局设置" | 宿主平面 | 预设只作用于一个会话；跨会话的东西在宿主组合 |
| "接一个 MCP 服务器" | 宿主平面 | 走宿主的配置型 bundle patch，不是预设配置 |
| "把整个仓库塞进上下文" | 不做 | 只提炼规范与接口；整仓进上下文是 token 与权限双重失控 |
| "改内置预设" | 拒绝 | 只读，升级会覆盖；复制成新预设再改 |

**完成判据**：每条越界请求都给出"做不到或不是预设的事 + 替代路径 + 需要用户提供什么"，而不是硬凑一个能跑的假实现。

## 相关技能

- 只注入规则文本、不碰工具的轻量做法：`dsh-prompt-card`
- 组合与插件行层面的细节：`editing-cordis-compositions`
- 需要写新插件或新模块：`cordis-plugin-development`
