---
name: dsh-prompt-card
description: 手写 dsh 注入卡（prompt card）：把规则包或一组引擎能力写成 .characters/<id>/converted.yml，套用到任意预设、并能干净移除。Use when 用户要把规则或规范做成可复用的注入卡、把引擎能力做成可复用的能力模块或预设能力模块、给卡配强度档位、选择注入层与受众、应用到预设或移除、或审查已有卡是否符合层字段约束。
---

# dsh 注入卡

一张卡 = 一个目录 `.characters/<id>/converted.yml`（预设片段，手写不需要 card.json 与头像）。卡的价值是**跨预设复用**：写一次，套用到任意预设，移除时干净退回。

卡有两种用法，可以只用一种，也可以合在一张卡里：

| 用法 | 往卡里放什么 | 典型诉求 |
|---|---|---|
| 文本卡 | `promptConfigs`（+ `variables`） | 把一段规则、规范、人设注入到任意预设 |
| **能力模块卡** | `modules` + `params`（+ `promptConfigs`） | 把一组引擎能力（指令提示、编辑器上限、委派深度、内容资产模块……）做成可复用模块，装进任意预设 |

第 1～4 步讲文本卡，第 5 步讲能力模块卡，第 6～7 步是应用、验证与移除。

## 第 1 步 定语义：谁、何时、看得见吗

先把规则包的注入语义写成三句话，再往下走：

| 语义 | 选层 | 后果 |
|---|---|---|
| 会话常驻、对用户隐藏 | `system-section` | 每次装配都在系统提示里；受众缺省 = 主会话 + 子代理 |
| 每轮出现在对话流里 | `pre-step` + `dedupe: none`（或 `batch`） | 用户看得见，占对话上下文 |
| 只对某个模型 | `pre-step` + `modelScope` | `system-section` 不支持 `modelScope`，写了会报错 |
| 只给主会话 / 只给子代理 | 支持 `audience` 的层 | `audience: main` / `subagent`；缺省是两边都给 |
| 首次工具调用（晋升）之后才注入 | `pre-step` + `promotion: main` | 由引擎的晋升状态机判定，不依赖任何模块 |

**完成判据**：三句话都能在表里找到落点，且没有用到目标层不支持的字段。

## 第 2 步 查层字段白名单

只有下列字段在对应层合法，越层声明会被引擎拒绝（挂载时报错，不是静默忽略）：

| 层 | 该层额外可用的字段 |
|---|---|
| `pre-step` | `position` `dedupe` `promotion` `audience` `modelScope` `mergeMode` `role` |
| `system-section` | `audience` `mergeMode` |
| `runtime-context` | `mergeMode`（没有 `audience`） |
| `agent-request` | `audience` `modelScope` |
| `llm-stream` | `modelScope` |
| `tool-pipeline` | `audience` `modelScope` |

任何层都能用：`id` `name` `strategy` `layer` `order` `group` `exclusive` `enabled` `text`（或 `texts`）。`order` 小的先注册。

**完成判据**：卡里出现的每个字段都在白名单里。

## 第 3 步 写卡

路径：`$DSH_HOME/.agent-presets/.characters/<id>/converted.yml`。`<id>` 同时是卡 id 与目录名，用小写字母、数字、连字符。

```yaml
id: my-rules
name: 我的规则包
version: 1.0.0
engineCompat: ">=0.4.2"
description: 一句话说明（只给人看，不进提示词）
modules:
  - prompt-config-engine
promptConfigs:
  - id: my-rules-main
    name: 规则正文
    strategy: static
    layer: system-section
    order: 190
    enabled: true
    text: |-
      规则正文……
```

- `text` 才进提示词；`name` 与 `description` 只显示在角色管理页。
- `modules` 按需要声明。没声明时引擎只补必需项：`prompt-config-engine`（缺它配置整体不生效），以及卡里有 world-book 配置时的 `world-book-tools`。

**完成判据**：YAML 能解析、`name` 非空 —— 角色管理页能列出这张卡（可先用只读接口 `listCharacterCards` 核对）。

## 第 4 步（可选）配强度档位

同一个 `group` 加 `exclusive: true` 的几条配置，只有排序最前的那条启用配置会运行；默认档 `enabled: true`，其余 `false`。

切档要两步：**先关掉当前档，再打开目标档**。只开目标档时，排序更前的旧档仍然生效，界面不会报错。把换档说明写进卡的 `description`（给人看），不写进 `text`（给模型看）。

**完成判据**：同组每条都带 `exclusive: true`，且只有一条 `enabled: true`。

## 第 5 步 能力模块卡：让卡携带引擎能力

卡里写 `modules` 与 `params`，应用时一起合并进目标预设：模块按声明补齐（缺的补上，并记录来源以便回退），`params` 逐键覆盖目标预设的同名键。

```yaml
id: hint-and-editor
name: 指令提示 + 编辑器上限能力模块
version: 1.0.0
engineCompat: ">=0.4.2"
description: 晋升后只发一次指令文件路径提示，并把编辑器单次输出上限收到 8000
modules:
  - instruction-hint
  - filesystem-editor
  - prompt-config-engine
params:
  instructionHint: true
  strReplaceEditorMaxOutputChars: 8000
promptConfigs: []
```

- **能携带**：`modules`（启用能力）、`params`（引擎旋钮）、`promptConfigs`（注入）、`variables`。
- **不能携带**：`customTools`、`subagentToolPolicy`、顶层 `persona` 文本、顶层 `triggers` 声明 —— 这四样应用时不读取。需要它们就写进目标预设本身，或改走"把仓库做成预设"那条路（见 `repo-to-dsh-preset`）。
- `params` 只写引擎认识的键：写错键名不会报错，会静默无效（渲染层是宽容的）。
- 首轮窄化、来源过滤、工具名单、锚句、深思门与进度节拍**没有能力模块也没有旋钮**：它们是目标预设自己的 `triggers` 声明，卡不能代写（见 `docs/engine-reuse.md`）。

**完成判据**：每个 `params` 键都有对应模块被声明（没有模块，旋钮无处生效）；键名都核对过。

## 第 6 步 应用与验证

工作台「角色管理」→ 应用到当前预设；或让模型调 `character_apply`（目标预设需要装配 `character-tools`）。

应用后核对四件事：

1. 目标 `preset.yml` 出现 `chara-<id>-` 前缀的配置；
2. `modules` 只多出必需项 —— 不会塞进用不到的工具模块；
3. `meta.importedCharacters` 含这个 id；
4. **注入真的到达模型**：预设目录名不能与宿主内置预设同名（`standard` / `ptc` / `minimal` / `cordis`）—— 同名的用户目录会被内置版遮蔽、从不挂载，界面显示"已应用"而模型一个字都收不到（本机真实踩过，整卡静默失效）。确认目录名是 `pt-standard` 这类形态；存疑时开一个新会话，核对系统消息里有没有规则正文；
5. 能力模块卡：目标 `preset.yml` 的 `modules` 里出现卡声明的模块，`params` 里出现卡写的旋钮 —— 旋钮写了而模块没装上，等于没写。

**坑**：卡里有 `system-section`、且目标预设的 `persona.complete` 是 `true` 时，应用会自动把它打开（返回 `personaOpened`）。那是解除了"人设独占"，事前跟用户说清。

## 第 7 步 移除

工作台「角色管理」→ 移除：删掉前缀配置、从 `importedCharacters` 除名，并按记录回退模块；**其他卡声明过、或预设内容仍需要的模块会保留**。

卡是**快照**：应用时把内容复制进 `preset.yml`。改了卡不会同步到已应用的预设 —— 要重新应用一次，而重新应用会覆盖对这几条配置的手工修改。

## 审查已有卡

逐条核对：

1. 字段是否越层（回到第 2 步的白名单）；
2. 该给子代理的规则是否被 `audience: main` 挡掉（缺省才是两边都给）；
3. 档位是否同组互斥、是否只有一条启用；
4. 目标预设的 `persona.complete` 是否被打开过；
5. 卡更新后是否重新应用过（快照）；
6. `modules` 是否只声明了真正需要的（多声明会让预设工具面变大）；
7. 能力模块卡里每个 `params` 键是否都有对应模块（否则旋钮静默失效），有没有误放 `customTools` / `subagentToolPolicy` / `persona` 文本（应用时不读取，写了也不生效）。
