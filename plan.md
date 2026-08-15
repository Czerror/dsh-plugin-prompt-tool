# dsh-plugin-prompt-tool 重新设计计划（v2）

> 目标：完整实现 dsh-anchored-standard 功能（原版机制），在首轮 "we" 锚定确认后注入
> prompt-tool 提示词。设计依据 = 三个项目的源码/README + 已完成的实测数据。

> 参考项目：
> - [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（集成上游，preset 原版复制）
> - [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（复杂度启发式 / 近距离注入）
> - [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)（缓存铁律 / 开发工具链）
> - 姊妹项目 [dsh 破限者](https://github.com/1449690477/dsh)（unrestricted-executor 技能包）
> - 本插件 GitHub 仓库：https://github.com/Czerror/dsh-plugin-prompt-tool

## 〇、发布规划（哪些内容进远程仓库）

**发布**：package.json、README.md、AGENTS.md、prompt.md、plan.md、cordis.patch.yml、
tsdown.config.ts、.gitignore、pnpm-lock.yaml（复现构建）、preset/（4 文件）、
prompt/（SKILL.md + references/）、src/（host + client）、scripts/sync-anchored.mjs。

**不发布**：node_modules/、lib/（构建产物，clone 后 `pnpm install && pnpm build` 生成）、
artifacts/（本地调试残留）。

## 〇、上游更新对照（anchored-standard PR #14，2026-08-15）

拉取覆盖后上游的关键变化（`a1e1c1d` / merge `95b98af`）：

| 项 | 旧版（本计划初稿） | 新版（当前上游） | 对 prompt-tool 的影响 |
|---|---|---|---|
| 首轮工具 schema | 平台 shell + `read` | **官方 Minimal 真实工具对**：持久 `bash` + `str_replace_editor` | 完全复制即可；Windows 下 `bash` 为 PTY 持久 shell，`pwsh` 晋升后仍可用 |
| 首轮输出预算 | `bootstrapMaxTokens: 1024` 固定 | **opt-in，默认无 cap**（adapter 默认 256000 流过） | 实测（issue #11）：Minimal schema 在 256000 下锚定 5/5（`We need` 首行、`we` 1.4、`let me` 0.0），而 pwsh/read 等标准家族 schema 在 256000 下 11/11 全失败——**工具 schema 是决定性变量，不是 cap** |
| agent.cordis.yml 结构 | 无 Minimal 组 | 新增 `persistent-shell` 组（dsh-terminal + dsh-terminal-bash + dsh-tool-bash-persistent）与 `bootstrap-filesystem` 组（dsh-fs-local + dsh-tool-str-replace-editor），与官方 minimal 字节一致；`tool-bash` 行全平台禁用（避免 `bash` 名重复注册） | 完全复制；prompt-injector 仍插在 tool-bootstrap 行后 |
| tool-bootstrap 参数 | `shellTools`+`commonTools` | `bootstrapTools: [bash, str_replace_editor]`；cap 监听器仅在显式设置 cap 时注册 | prompt-injector 逻辑不变（we 检测 + promoted 检测与参数无关） |
| 验证工具 | 无 | `verify/run-verify.mjs` + `verify-runner.mjs`：preset-roster compose + CLI driver，`--stop-after-first-assistant` 只测首请求（秒级） | 本地 harness 源码未构建（`apps/cli/lib/bin.js` 不存在），暂继续用 prebuilt rc.6 的 dsh web HTTP API；将来构建 harness 后可切换 |
| cap 行为差异 | — | rc.5 源码 checkout 上 cap 能到达首请求；rc.6 prebuilt 包会覆盖为 adapterDefaults | 与我们无关（默认不设 cap） |

结论：**设计骨架不变**（完全复制原版 + prompt-injector 附加件），只是复制源更新为
新版文件，测试断言从 `pwsh/read + 1024` 改为 `bash/str_replace_editor + 无 cap`。

## 一、三个项目分析结论

### 1. dsh-anchored-standard（原版，2026-08-15 最新）

机制（`preset/tool-bootstrap.mjs` + `agent.cordis.yml`）：

- 首轮请求近似 Minimal：工具面收窄为 1 个平台 shell + `read`；`bootstrapMaxTokens: 1024`；
  剥离 `skill-catalog` / `agent-instructions` 两类自动注入（`suppressedContextSources`）。
- `promoteOn: either`：首个 `tool/call` **或** `assistant/message` 落库即晋升，
  request #2 起完整目录 + 正常预算 + 恢复注入。**不会卡死**。
- 关键实现细节：
  - `tool-bootstrap` 行必须排第一 + 插件 `inject: []` + 监听器 `prepend: true`
    → 剥离是 waterfall 的最后一个 transform，能真正删掉后面监听器注入的消息。
  - 首轮 maxTokens 用 `agent/request` 监听（`prepend: true`）设置，晋升后显式移除
    （header 的 maxTokens 会被下一请求种子继承，不显式移除会粘整个会话）。
  - 降级安全：缺 bootstrap 工具 → 全目录 + 一次性告警；过滤器异常 → 保留全部。

### 2. dsh-router-standard（v0.1.0）

机制（`router-core.mjs` + `router-bootstrap.mjs`）：

- 首条用户消息分类 → spec（读优先）/ react（写优先）/ weak（模型自路由）。
  实测行为带：spec [0,0.15]、transition [0.2,0.45]（陷阱）、react [0.5,1.0]。
- 复杂度启发式 `isComplexTask`：文本 >120 字符或含重构/设计/架构等词 → 复杂任务。
- **近距离信号原则**（实测 P14/P16/P20）：行为引导必须放用户消息之后（inbox.append /
  pre-step），放 system（远距离）会衰减甚至反向；固定文本保持缓存命中 92-94%。
- `applyPersona` 只换 persona section，保留 plan-mode section（避免 plan 失忆）。
- 模型不能自路由（P3/P5/P8），必须外部路由。

可复用点：`isComplexTask` 正则、近距离注入模式、会话事件推导状态（resume 安全）。

### 3. dsh-super-injector（v0.3.x）

机制：运行时插件注入生产线（`dev_inject_plugin` / `dev_reload_package` / `dev_stage_*` /
`dev_install_package`），junction 链接 + `ctx.loader.create` + `ctx.effect` 资源清理 +
registry 持久化恢复。

对 prompt-tool 的约束（铁律 4/6/8）：

- 缓存原则：静态文本放 system 头部，动态内容走消息尾；**严禁动态拼接进 system**
  （system 前缀任何变化 = 全会话缓存全灭）。
- 首轮锚定：工具面大时首轮只露核心 1-2 个工具，首个 tool/call 后恢复（就是 anchored 机制）。
- 资源注册挂 `ctx.effect`，peerDeps 用范围声明。

prompt-tool 是 preset 形态插件，不依赖 injector 运行时注入；injector 仅作为
后续开发/热重载工具链使用。

## 二、实测结论（决定设计的硬事实）

| 实验 | 结果 |
|---|---|
| 原版 anchored（旧版 pwsh+read + maxTokens 1024）+ 复杂英文任务 | we 锚定 **5/5**（全部 "We need"） |
| 新版 anchored（Minimal 真实 schema：bash+str_replace_editor，**无 cap**，256000） | 锚定 **5/5**（issue #11 上游实测：`We need` 首行、`we` 1.4、`let me` 0.0；标准家族 schema 11/11 全失败） |
| 原版 anchored + 简单任务 | we ≈ 0%（模型直接调工具干活，不产出 reasoning） |
| zero 变体（0 工具首轮）+ 简单任务 + 固定锚定消息 | we 锚定 **5/5**，但多一次模型调用 |
| zero 变体 + persona 句当锚定消息 | we 仅 60%（差） |
| 决定锚定的因素 | **任务复杂度**（不是工具数量）；maxTokens 1024 起决定性作用（官方端点实测 26/32 vs 0/5） |
| 原版 2 工具 + 锚定消息（"Tools are not open yet"） | 不产生 we（模型回复 "The user says..." 叙述语气，本次实测） |

推论：

1. **回到原版**（2 工具 + 1024 + suppressedContextSources），放弃 zero 变体
   （多一次调用、无收益、且原版已原生支持上下文剥离）。
2. **放弃锚定消息**：原版 2 工具下锚定消息不产生 we（见上表末行）；复杂任务
   原版机制本身 5/5 "We need"，简单任务模型直接调工具干活（轨迹正确，无需 we）。
3. 提示词注入走消息层（pre-step / inbox），不进 system（缓存铁律）。

## 三、新设计

### preset 文件布局（完全复制原版 + 一个附加件）

```
preset/
  agent.cordis.yml      ← 原样复制 anchored-standard（tool-bootstrap 行第一 +
                           25 工具标准目录），仅在 bootstrap 段后追加
                           prompt-injector 一行（见下）
  tool-bootstrap.mjs    ← 原样复制（字节一致，不做任何修改）
  preset.yml            ← 复制，name/description 改为 prompt-tool
  prompt-injector.mjs   ← 新增（唯一自研件），替换现有的
                           zero-tool-bootstrap.mjs + anchor-turn.mjs
```

`agent.cordis.yml` 的 bootstrap 段变为（其余全部原样）：

```yaml
- id: tool-bootstrap
  name: ./tool-bootstrap.mjs
  config:
    shellTools: [bash, pwsh]
    commonTools: [read]
    promoteOn: either
    bootstrapMaxTokens: 1024
    suppressedContextSources: [agent-instructions, skill-catalog]

- id: prompt-injector
  name: ./prompt-injector.mjs
  config:
    promptText: |-
      __PROMPT_TOOL_TEXT__
```

### prompt-injector.mjs 职责

零依赖、`inject: []`、注册在 tool-bootstrap 之后（不抢剥离顺序）。

**唯一监听器 — 锚定确认后注入（`agent/pre-step`）：**

- 每会话注入一次，状态机：
  - `promoted` = 会话已出现首个 `tool/call` 或 `assistant/message`
    （与 tool-bootstrap 的 promoteOn: either 同定义）；
  - `weAnchored` = turn1 的 assistant/message 存在 reasoning block 且
    `/^we\b/i` 匹配（复用 zero 版已验证的检测逻辑）；
  - 注入条件：`promoted && (weAnchored || 当前最大 turn > 锚定轮 turn)`：
    - we 确认 → 锚定轮结束后的下一轮注入（满足"确认锚定后再注入"）；
    - we 未确认 → 最多再等一轮，仍无 we 则强制注入（兜底，绝不卡死）。
  - 注入内容 = `promptText` 一条 user 消息（`source.kind: 'plugin'`），
    放在 decision.messages 之前（近距离信号）；
  - 注入后 `injectedPrompt` 记录，绝不重复注入。
- 不触碰 tools 目录、maxTokens、上下文剥离——全部留给原版 tool-bootstrap。

**已废弃的设计**（实测推翻）：`agent/inbox/inserted` 监听 + `isComplexTask`
分流 + 简单任务锚定消息。实测证明 2 工具下锚定消息不产生 we，且 inbox
消息结构（扁平 UserMessage）导致提取错误需修正——直接删除整条路径，简单任务
走兜底注入（turn1 模型正常干活，turn2 注入提示词）。

### src/index.ts 改动

- `writePreset()`：复制 anchored 原版 `agent.cordis.yml`（替换 `__PROMPT_TOOL_TEXT__`
  占位符）+ 原版 `tool-bootstrap.mjs` + `preset.yml` + 新增 `prompt-injector.mjs`。
- 删除对 `zero-tool-bootstrap.mjs` / `anchor-turn.mjs` 的复制逻辑。
- 其余不动：skill 注册（prompt）、AGENTS.md 常驻层、settings Web UI。

### 不变项

- `cordis.patch.yml`（插件自身装配）保持现状——anchored-standard 是 preset 形态，
  仓库内无 patch 文件，无物可复制。
- `~/.dsh/AGENTS.md` 只写 AGENTS 规则，prompt.md 不进 AGENTS.md（防重复注入）。
- 打包产物、peerDeps 范围声明不变。

## 四、实施步骤

1. 从 `E:\Documents\GitHub\dsh-anchored-standard\preset\` 复制
   `agent.cordis.yml`、`tool-bootstrap.mjs` 到 prompt-tool `preset/`；
2. 按上节修改 `agent.cordis.yml`（追加 prompt-injector 行，其余不动）；
3. 写 `preset/prompt-injector.mjs`（一个 pre-step 监听器 + we 检测 + 兜底轮计数）；
4. 改 `preset/preset.yml`（name: prompt-tool）；
5. 删 `preset/zero-tool-bootstrap.mjs`、`preset/anchor-turn.mjs`；
6. 改 `src/index.ts` 的 `writePreset()`；
7. `pnpm build`；
8. 部署：运行插件装配 → 验证 `~/.dsh/.agent-presets/prompt-tool/` 文件
   与 anchored-standard 原版 diff 仅剩 prompt-injector 行 + preset.yml 头部；
9. 按第五节用 dsh web 测试；
10. 同步 README（中英文）说明新机制。

## 五、测试计划与结果（dsh web）

工具链：启动 dsh web（`--port 0` 自动分配）→ HTTP API：

> **测试工作目录约定（用户全局指令：任何项目的所有测试都必须在 `_temp`）**：所有测试会话的 `cwd` 一律使用临时目录
> `D:\AI\CodexCLI\workspase\_temp`，禁止用任何源码仓库当 cwd
> （模型会在任务中写入产物，污染仓库工作区）。

```
session.create  { agentPreset: prompt-tool }
session.selectModel { deepseek-official / deepseek-v4-pro / reasoningEffort: max }
session.prompt  { text: 任务 }
session.history → 轮询 turn/end（复杂任务 180s+ 超时）
session.export  → zip 内 session.jsonl 逐条断言
```

断言脚本（PowerShell，写入 `%TEMP%`）逐条检查：

- request #1：`tools` 仅 `bash`+`str_replace_editor`（Minimal 真实 schema）；
  `config.maxTokens` 无注入 cap（adapter 默认 256000 或 undefined）；
  无 `skill-catalog` / `agent-instructions` 消息；
- request #2 起：完整工具目录（含 pwsh）；
- turn1 的 assistant/message reasoning 首词 `/^we\b/i`；
- prompt.md 文本恰好出现一次（turn2 或 turn3，绝不重复）。

测试矩阵：

| 组 | 任务 | 次数 | 断言 |
|---|---|---|---|
| A 复杂英文 | "Design and implement ..."（>120 字符） | 5 | we 5/5；注入 5/5；request 结构如上 |
| B 简单英文 | "List the files in the current directory" | 5 | turn1 正常干活；兜底注入 5/5；request 结构 |
| C 中文 | 中文任务 | 1 | 注入后思维链/回答为简体中文 |

**实测结果（2026-08-15，deepseek-v4-pro + reasoningEffort=max，并行会话）：**

| 组 | 结果 |
|---|---|
| A ×5 | we **5/5**；H1=[pwsh,read] maxTokens=1024；H2=31 工具 maxTokens=256000；注入 5/5；首请求前消息纯净（仅 user） |
| B ×5 | turn1 first="The" + tool/call×2（直接干活）；注入 5/5；H1/H2 同上；注入后回复转简体中文 |
| C ×1 | 同 B；turn2 中文回复 ✓ |

验收通过：A 组 we 锚定 5/5、注入 5/5、无重复注入、request #1 结构全部命中；
B/C 组兜底注入 5/5 + 中文生效。测试耗时：并行约 2.5 分钟（串行约 35 分钟，
复杂任务 turn2 无需等结束——注入在 turn2 请求前已落库）。

> 上表为旧版（pwsh/read + 1024 cap）的实测记录。上游更新后需按新断言
> （bash/str_replace_editor + 无 cap）重测：we 锚定依据 = issue #11 的
> 5/5 数据 + 本机复测；B/C 组注入路径不变。

**新版实测（2026-08-15，上游 PR #14 同步后重测，deepseek-v4-pro + max）：**

| 组 | 结果 |
|---|---|
| 复杂英文 ×5 | we **5/5**；H1=[bash,str_replace_editor] maxTokens=256000（无 cap）；H2=33 工具；注入 5/5；首请求前消息纯净（仅 user） |
| 时间线（run2 详查） | 首请求（bootstrap schema）→ "We" reasoning → tool/call → **we 确认后同 turn 下一步注入 prompt.md** → 晋升后 agent-instructions/skill-catalog 恢复 → 模型继续干活 |

新版相对旧版的改善：无输出 cap，模型 turn1 内即可正常干活（旧版 1024 cap 会截断
首轮 text/tool），注入发生在 turn1 内（旧版要等 turn2），全程不需要用户再发消息。

## 六、风险与兜底

- we 未锚定：锚定消息失效 → 强制兜底注入（最多延迟一轮），不影响任务完成。
- 原版上游再更新：`tool-bootstrap.mjs` / `agent.cordis.yml` 保持可重新复制
  （prompt-injector 行是唯一本地差异，冲突面最小）。
- 缓存：promptText 若频繁编辑会改变 pre-step 注入文本 → 仅影响注入轮之后的
  前缀缓存；prompt.md 编辑频率低，可接受（不违反 system 静态铁律）。
