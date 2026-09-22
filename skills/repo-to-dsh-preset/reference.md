# 引擎能力旋钮全表

由 `SKILL.md` 第 2 步的指针进入。三部分：能装什么模块 / 每个旋钮是什么 / 配方现状。

> 权威来源：`src/shared/engine-params.ts` 的 `ENGINE_PARAM_DEFINITIONS`（参数唯一目录）与 `docs/engine-reuse.md`（模块职责）。本文件是它们的中文摘要，**旋钮增删以源码为准**。
> 表中的"默认"是编辑草稿默认值（未配置时的显示初值），不等于运行时被强制写入；空字符串与空列表在保存时按"删键"处理，回落引擎默认。

## 一、模块清单（`modules` 里能写什么）

### 本项目自有（`engine/compositions/source/local/`）

| 模块 | 职责 | 相关旋钮 |
|---|---|---|
| `prompt-config-engine` | 提示词配置执行器（六插入点） | 配置写在 `promptConfigs`，不走 params |
| `tool-config-engine` | 自定义工具：`customTools` → 运行时注册 | `customToolRequireApproval` |
| `subagent-tool-policy` | 子代理工具授权档（按代际安装） | 顶层 `subagentToolPolicy` 段，不是 params 键 |
| `instruction-hint` | 通用指令文件提示（plugin 形态：挂本行 + `enabled: true`） | `instructionHint` |
| `declared-triggers` | 触发器声明入口：读 `triggers.yml` 注册声明（有 `triggers` 段时由 writer 自动装配，不必手写） | 预设顶层 `triggers` 段，不是 params 键 |
| `character-tools` | 角色卡模型工具（列表 / 导入 / 应用 / 移除 / 记忆） | — |
| `world-book-tools` | 世界书条目工具（`note` 可写角色记忆） | — |
| `session-var-tools` | 会话变量工具（`session_var`） | — |
| `filesystem-editor` | 隔离文件系统 + `str-replace-editor`（同一隔离域） | `strReplaceEditorMaxOutputChars` |
| `tool-git-bash` | Windows Git Bash 适配 | `toolGitBashEnabled` |
| `persistent-shell-posix` | POSIX 持久 shell | — |
| `tool-bash-disabled` | 关闭 bash 的适配变体 | — |
| `run-code-env` | PTC 运行环境变量 | — |
| `skill-search` | 技能检索 | — |

### 跟随官方切出（`engine/compositions/library/`，24 个）

工具类：`tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-web`、`tool-todo`、`tool-goal`、`command-goal`、`tool-ask-user`、`tool-present`、`tool-presentation`、`tool-cordis`、`tool-skill`、`tool-plugin-manager`、`tool-plugin-manager-disabled`。
组合类：`planning`、`compaction`、`delegation`、`delegation-ptc`、`agent-instructions`、`skill-filesystem`、`skill-filesystem-cordis`、`persistent-shell`。

模块名就是文件名；两处同名会让生成器直接报错。

## 二、旋钮全表（30 个，按能力族分组）

> 首轮工具面与输出封顶、`stages` 式阶段窄化、pre-step 来源名单、常驻工具白/黑名单、锚句、
> 深思门与进度节拍**没有旋钮**：它们是预设顶层 `triggers` 段的声明（`channel` + `when` + `do`），
> 见 `SKILL.md` 第 2 步与 `docs/engine-reuse.md` 的「组合示例」。子代理工具面只能由
> 顶层 `subagentToolPolicy` 段授权。

### 1 注入与提示词（卡片 `prompt-defaults`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `firstTurnAnchor` | 布尔 | false | 首轮锚定：首条用户消息后插一次锚句 |
| `firstTurnText` | 字符串 | '' | 锚句正文 |
| `firstTurnCustom` | 布尔 | false | 用自定义锚句替代内置模板 |
| `firstTurnWord` | 字符串 | '' | 锚定确认词；空 = 从锚句自动派生 |
| `firstTurnBuild` | 字符串 | '' | 构建档锚句 |
| `firstTurnInspect` | 字符串 | '' | 排查档锚句 |
| `firstTurnDeep` | 字符串 | '' | 深度档锚句 |
| `buildPattern` | 正则 | '' | 构建任务正则（锚定三档分类的 build 档） |
| `complexPattern` | 正则 | '' | 复杂任务正则（锚定 complex 档与引导深度判定共用） |
| `guideText` | 字符串 | '' | 每轮引导句正文 |
| `guideCustom` | 布尔 | false | 用自定义引导句 |
| `guideEnabled` | 布尔 | 未设置 | 引导独立开关；未设置时跟随锚定 |
| `guideWeak` | 字符串 | '' | 引导-简短档正文 |
| `guideDeep` | 字符串 | '' | 引导-深度档正文 |
| `injectPrompt` | 布尔 | true | 兜底注入（prompt-injector 策略）总开关 |
| `instructionHint` | 布尔 | false | 挂 `instruction-hint` 行并开启：晋升后只发一次指令文件路径提示 |

### 2 模型（卡片 `main-model`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `modelProvider` | 字符串 | '' | 主模型 provider |
| `modelName` | 字符串 | '' | 主模型名 |
| `modelReasoningEffort` | 字符串 | '' | 推理档；空 = 继承宿主 |
| `modelTemperature` | 有限数 | '' | 采样温度 |
| `modelMaxTokens` | 正整数 | '' | 单次输出上限 |

### 3 子代理模型（卡片 `subagent-model`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `subagentModelProvider` | 字符串 | '' | 子代理 provider |
| `subagentModelName` | 字符串 | '' | 子代理模型名 |
| `subagentReasoningEffort` | 字符串 | '' | 子代理推理档 |
| `subagentTemperature` | 有限数 | '' | 子代理温度 |
| `subagentMaxTokens` | 正整数 | '' | 子代理输出上限 |

### 4 委派（卡片 `subagent-tools`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `maxDepth` | 深度 | '' | 子代理嵌套深度：数字 / `provider-managed` / 空 |

### 5 编辑器（卡片 `str-replace-editor`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `strReplaceEditorMaxOutputChars` | 正整数 | 16000 | 编辑器单次输出字符上限 |

### 6 自定义工具（卡片 `tool-config-engine`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `customToolRequireApproval` | 列表 | '' | 需要用户批准的执行器：`shell` / `http` / `delegate` / `fs` / `ask-user` |

### 7 工具行开关（卡片 `tool-git-bash`）

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `toolGitBashEnabled` | 布尔 | true | Windows Git Bash 行显式启用（未声明 `enabled` = 关闭） |

## 三、配方

工作台「添加能力」不再提供一键配方（原 `phase-control` / `phase-control-ptc` / `deliberation`
随对应模块一并退场，`ENGINE_RECIPES` 为空）。首轮窄化、来源过滤、工具名单与节拍改为预设顶层
`triggers` 声明，逐条示例见 `docs/engine-reuse.md` 的「组合示例」。

## 四、不在预设里的东西（避免误配）

- 宿主平面：注册表、持久化、沙箱与批准栈、模型路由注册、子代理后端 —— 预设只能消费，不能提供。
- 新模块与新执行器类型：属于插件开发（创造模式下用 `plugin_manager`），不是 `preset.yml` 能表达的。
- MCP 服务器接入：走宿主的配置型 bundle patch，不是预设配置。
