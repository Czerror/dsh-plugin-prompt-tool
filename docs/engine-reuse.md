# engine 复用指南（晋升门控 / PTC 通用模块）

本仓库的引擎（`engine/`）是**自包含**的通用模块库：晋升门控、上下文门控、
工具目录相位、PTC（Code Mode）呈现、提示词注入引擎全部以 cordis 插件行 +
声明式配置提供，任何 dsh 预设可自由装配。

## 复制协议（跨项目复用）

1. 把 `engine/` 整个目录复制到你的项目（自包含 + vendor yaml，无外部依赖）；
2. 组合文件（agent.cordis.yml）以相对路径引用引擎插件行：

   ```yaml
   - id: context-gate
     name: ./engine/context-gate.mjs
   ```

3. 需要按预设参数化时，参考本仓库 `manifest.ts` 的
   `buildModuleConfigsFromParams`（params 扁平键 → 模块行 config 对象合并，
   取代旧 `__TOKEN__` 文本占位符）与 `applyModuleConfigs`（行级/嵌套合并）。

## 晋升门控模块清单

| 模块行 | 引擎文件 | 职责 |
|---|---|---|
| `context-gate` | engine/context-gate.mjs | 注入门控：未晋升时清空运行时上下文 + pre-step kind 白名单；晋升后 deferredSources 延迟注入 / instructionHint 一次性提示 |
| `tool-bootstrap` | engine/tool-bootstrap.mjs | 首轮工具目录窄化（bootstrap 对）→ 晋升后恢复完整目录；bootstrapMaxTokens 封顶；promoteGate 门控；personaSectionsOnly / workspaceLine |
| `code-presentation` | engine/code-presentation.mjs | 晋升后 PTC mode 呈现（`tools.presentAs('ptc')`），compaction/end 释放 |
| `prompt-config-engine` | engine/prompt-config-engine.mjs | 提示词配置执行器（per-config `promotion: main / include-subagents` 门控） |
| `tool-config-engine` | engine/tool-config-engine.mjs | 自定义工具引擎：preset.yml `customTools` 段 → 渲染 `custom-tools/*.yml` → 运行时 `ctx.tools.register`（执行器 shell/http/delegate/fs/ask-user；行 `requireApproval` 门） |
| `compaction-epoch` | engine/compaction-epoch.mjs | 晋升状态机（被上面各模块共用；非插件行） |
| `tool-filter` | engine/tool-filter.mjs | 常驻工具白名单/黑名单（与晋升无关的常量掩码） |

## 提示词配置插入点与顺序

- 六个插入点彼此独立，没有跨层全局运行顺序。
- `order` 只在同一插入点内生效。
- UI / 写盘展示顺序固定为 `pre-step → system-section → runtime-context → agent-request → llm-stream → tool-pipeline`；这是展示与写盘顺序，不是运行时优先级。
- 模型实际收到的提示词文本顺序更接近 `system-section → runtime-context → pre-step`；`agent-request` / `llm-stream` / `tool-pipeline` 是控制通道，不构成提示词文本优先级。
- 生成文件名使用 4 位零填充前缀（`0000-`），避免大角色卡 / 大预设超过 10 条后字典序错乱。

## 晋升语义（epoch-aware）

- 晋升信号：`tool/call` 和/或 `assistant/message`（`promoteOn`，默认 either）；
- `compaction/end` 为边界：压缩后回到受控相位（首轮条件重现），重新晋升再恢复；
- 子代理：默认视为已晋升（继承完整上下文/目录）；`includeSubagents: true` 时跟随主会话相位；
- 门控模式（liangshen 扩展）：`promoteGate: true` 要求首段 reasoning minimal-like
  （`we` 无 `let me`）+ 工具调用才晋升，`maxPromoteSteps`（默认 4）步数兜底，
  `promoteAfterFirstResponse: true` 无工具首响应/首轮结束即晋升。

## 配置参考（params 扁平键 ↔ 模块行 config）

优先级：参数桥（params / UI）> `moduleConfigs`（模板/ST 行级直写）> 行默认。
moduleConfigs 只补充参数桥未覆盖的键，不再锁定覆盖 UI 可管理参数。

| params 键 | 落点（config 键） | 默认 |
|---|---|---|
| `usePtcMode` | code-presentation.usePtcMode | false（opt-in） |
| `bootstrapMaxTokens` | tool-bootstrap.bootstrapMaxTokens | 不封顶 |
| `bootstrapTools` | tool-bootstrap.bootstrapTools | [bash, str_replace_editor] |
| `promoteGate` | tool-bootstrap.promoteGate | false |
| `promoteAfterFirstResponse` | tool-bootstrap.promoteAfterFirstResponse | false |
| `maxPromoteSteps` | tool-bootstrap.maxPromoteSteps | 4 |
| `compactionTools` | tool-bootstrap.compactionTools | [] |
| `personaSectionsOnly` | tool-bootstrap.personaSectionsOnly | false |
| `workspaceLine` | tool-bootstrap.workspaceLine | false |
| `allowKinds` | context-gate.allowKinds | 不过滤（官方 pre-step 行为） |
| `messageSources` | context-gate.messageSources | 不启用 |
| `deferredSources` | context-gate.deferredSources | 不延迟 |
| `deferredGraceSteps` | context-gate.deferredGraceSteps | 0 |
| `instructionHint` | context-gate.instructionHint | false |
| `stages` | tool-bootstrap.stages（`[{name, tools}]`） | 未声明（两相窄化） |
| `stagePreUnlock` | tool-bootstrap.stagePreUnlock | 1 |
| `stageAdvanceTool` | tool-bootstrap.stageAdvanceTool | phase_advance |
| `stageSectionTemplate` | tool-bootstrap.stageSectionTemplate | 默认模板（`{{stage}}/{{stageName}}/{{unlocked}}/{{total}}/{{advanceTool}}`；空 = 不注入） |

## 渐进披露（stages 模式）

`tool-bootstrap` 声明 `stages` 时激活多级阶段窄化（参考 dsh-router-standard
progressive disclosure 自写）：目录 = 当前阶段工具 + 预放（`stagePreUnlock`
档）；`phase_advance`（名字可配）推进阶段；调用更高阶段工具 = 直达（自动
跳到其档）；阶段状态由 durable tool/call 事件推导（resume/reload 自动恢复，
无文件），compaction 不重置；阶段文案经 `stageSectionTemplate` 参数化
（引擎只注入动态状态 section `stage-status`，不写死引导文本——引导类内容
一律 promptConfigs 参数化）。

## 组合示例

只要 PTC（不窄化目录）：

```yaml
modules:
  - code-presentation
```

PTC + 首轮锚定：

```yaml
modules:
  - context-gate
  - tool-bootstrap
  - code-presentation
moduleConfigs:
  tool-bootstrap:
    bootstrapTools: [bash, str_replace_editor]
  code-presentation:
    usePtcMode: true             # PTC 呈现默认 false，这里显式开启
```

渐进披露示例：

```yaml
modules:
  - tool-bootstrap
moduleConfigs:
  tool-bootstrap:
    stages:
      - { name: 了解, tools: [read, glob, grep] }
      - { name: 开发, tools: [write, edit] }
      - { name: 验证, tools: [pwsh, bash] }
    stagePreUnlock: 1
```

liangshen 全量门控（完整示例见 `preset/liangshen/preset.yml`）：

```yaml
moduleConfigs:
  tool-bootstrap:
    bootstrapTools: [bash, str_replace_editor]
    promoteGate: true
    maxPromoteSteps: 4
    promoteAfterFirstResponse: true
    bootstrapMaxTokens: 1024
    compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
    personaSectionsOnly: true
    workspaceLine: true
  context-gate:
    messageSources: [user, goal]
    deferredSources: [agent-instructions, skill-catalog]
    deferredGraceSteps: 1
    instructionHint: true
```

## 重建与验证

- 组合库重建：`pnpm rebuild:composition`（官方源码切块 + `source/local/` 本地模块）；
- 本地新增模块放 `engine/compositions/source/local/<name>.yml`，并在
  `scripts/rebuild-composition.mjs` 的 MODULES 清单登记；
- 验证三连：`pnpm typecheck` + `pnpm lint` + `pnpm test`。
