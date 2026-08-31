# dsh-plugin-prompt-tool 仓库指令

本仓库是 DeepSeek Harness（DSH）的提示词工具插件。核心产品边界是「位置、时机与受众可配置的提示词注入引擎」：`promptConfigs` 驱动六个官方注入层，预设负责组合具体行为。PTC、首轮锚定、router-guide、Flash 路由与其他模型能力增强都属于可选模块或预设，不得硬编码成项目主线或新增全局默认；新实验能力保持 opt-in，并用确定性行为测试验收。

不要修改 DeepSeek Harness 源码仓库。插件只通过本仓库的 `cordis.patch.yml`、`package.json#dsh`、官方 `@deepseek-ai/*` 包和 DSH profile 装配。

修改参数、预设存储或生成链路前，先读 [docs/architecture-params.md](docs/architecture-params.md)。修改 `engine/`、晋升门控或组合模块前，先读 [docs/engine-reuse.md](docs/engine-reuse.md)；编辑 Cordis 组合时同时参考 [preset/creative/skills/editing-cordis-compositions/SKILL.md](preset/creative/skills/editing-cordis-compositions/SKILL.md)。修改 SillyTavern、角色卡或世界书转换前，先读 [SillyTavern.md](SillyTavern.md)。

## 仓库布局

- `src/index.ts`：宿主入口与总装配；负责迁移、预设切换、重建、模型路由、Skills provider、内置模型工具和 settings 生命周期。
- `src/client/`：React Web 工作台；通过官方 SlotRegistry、SettingsScope、Remote 与 sessions 服务接入宿主。
- `src/runtime/`：settings bridge、模型路由、Skills、TUI、角色卡/世界书/session_var 模型工具等宿主运行时适配。
- `src/host/`：`preset.yml` 数据层、迁移、SillyTavern/角色卡/世界书转换和 `writePreset` 物化逻辑。
- `src/shared/`：host/client 共用契约；参数键和 bridge 路径必须在这里保持单一来源。
- `engine/`：生成预设运行时使用的自包含 ESM 引擎；`compositions/source/local/` 是本地组合源，`compositions/library/` 是重建产物。
- `preset/`：内置预设模板；用户运行时预设位于 `$DSH_HOME/.agent-presets/<id>/`，用户预设优先于同名包内模板。
- `templates/`：提示词配置与自定义工具模板。
- `skills/`：随 npm 包发布的 Skills；`skills/manifest.json` 是目录清单。
- `scripts/`：profile 链接、上游快照同步、YAML vendor 同步和组合重建。
- `test/`：Node test runner 契约与回归测试。
- `lib/`：`tsdown` 生成且被 git 忽略；不得手工编辑。

## 环境与常用命令

所有 shell 命令使用 PowerShell 7：`D:\App\PowerShell\7\pwsh.exe`。测试 cwd 固定为 `D:\AI\workspase\_temp`，通过 `pnpm --dir` 指向仓库，不把仓库目录作为测试 cwd。

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'

pnpm --dir $Repo install
pnpm --dir $Repo build
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo link:profile
pnpm --dir $Repo sync:anchored
pnpm --dir $Repo sync:yaml
pnpm --dir $Repo rebuild:composition
```

实现改动交付前至少运行 `typecheck`、`lint`、`test`。只改文档时运行 `git -C $Repo diff --check` 并核对所有路径与命令。只运行受影响测试可用于开发循环，但最终验证仍运行完整 `pnpm --dir $Repo test`。

## 架构规则

### Cordis 入口与生命周期

- `src/index.ts` 保持编排入口，不把 host、转换或 UI 细节继续堆入其中；已有能力优先落到对应的 `host/`、`runtime/`、`client/` 或 `shared/` 模块。
- `inject` 只使用字符串数组。可选或晚到服务通过 `ctx.inject([...], callback)` 动态等待。
- `webServer` 不进入宿主入口的静态 `inject`：首次 profile 可能尚未安装 `@deepseek-ai/dsh-web-app`。`ensureWebSurface()` 只修复当前 profile 的 bundles，并提示下次启动生效。
- 监听器、工具、watcher 和动态服务统一挂在 `ctx.effect` / disposer 生命周期；重挂前先释放旧实例。
- 仅使用已发布的 `@deepseek-ai/*` 包和 `node_modules` 类型。相对 TypeScript import 保留显式 `.ts`，纯类型依赖使用 `import type`。

### Client UI

- UI 只通过官方 SlotRegistry 挂载：`shell.overlay`、`settings.plugins.tab`、`sidebar.footer.action` 等现有插槽优先复用。
- 不使用宿主 DOM 选择器，不手工创建独立 React root，不依赖宿主内部 class 名或页面结构。
- 标准 settings 字段走 `SettingsScope`；复杂数据、导入导出和预设 CRUD 走 loopback settings bridge；会话预设切换走官方 `remote.agentPresets`。
- Client/host 共用字段、路径和载荷先更新 `src/shared/` 契约，再更新两端与契约测试。

### Settings 与 preset.yml

- `Config` / `PromptSettings` 只承载部署轴：写入开关、预设选择、Skills 目录与开关、路径、顺序和 fallback。引擎行为参数不回填全局 settings。
- 激活预设的 `preset.yml` 是行为配置单一来源：
  - `model` / `subagentModel`：模型路由与采样参数；
  - `params`：引擎行为参数；
  - `promptConfigs`：六层提示词配置；
  - `variables` / `variablesEnabled`：内容模板变量；
  - `customTools`：声明式工具；
  - `moduleConfigs`：参数桥未覆盖的行级配置。
- 组合配置优先级固定为：参数桥（`params` / UI） > `moduleConfigs` > 组合行默认值。
- `PARAM_KEYS`、`ENGINE_PARAM_KEYS`、`WRITER_PARAM_KEYS` 与 `MODEL_SEGMENT_MAP` 必须保持单一来源和编译期/契约测试一致。
- 引擎参数空字符串或空数组表示删键并回落默认；`variables` 的空字符串是合法占位值，不能复用参数删键语义。
- 修改 YAML 时使用 `yaml` Document API 保留注释与未知字段；不得用对象整体 stringify 覆盖用户 `preset.yml`。

### 预设物化与文件安全

- 每个预设直接物化到 `$DSH_HOME/.agent-presets/<id>/`；共享运行时复制到 `.agent-presets/.engine/`，角色卡库存于 `.agent-presets/.characters/`。
- 插件状态只写 `$DSH_HOME/.prompt-tool-state.json`；引擎指纹留在 `.engine/.pt-engine-fingerprint`。不得修改或清理 `$DSH_HOME` 下其他用户/官方文件。
- `writePreset()` 必须先在临时目录完整生成，再以 rename 原子替换；失败时恢复旧目录或保留备份现场。
- `preset.yml` 是源文件，不是生成物。`writePreset()` 只能合并必要元数据，不得覆盖 params、promptConfigs、variables、customTools 或用户注释。
- `AGENTS.md` 常驻规则只操作 `# === prompt-tool managed block begin/end ===` 包围的受管块，保留文件其余内容。
- 测试和脚本必须使用临时 `DSH_HOME`；真实用户预设会遮蔽包内同名模板，任何测试都不得读写真实 `~/.dsh`。

### Engine 与组合模块

- 六层顺序保持：`pre-step`、`system-section`、`runtime-context`、`agent-request`、`llm-stream`、`tool-pipeline`。
- 通用过滤、插值、模型范围、主/子代理受众、幂等和晋升语义集中在 `engine/` 共享模块，不在每种 strategy 重复实现。
- `compaction/end` 是 epoch 边界；修改 context-gate、tool-bootstrap、code-presentation 或 prompt-config-engine 时同步验证主会话、子代理、压缩后重晋升与 disposer 行为。
- 本地组合源改 `engine/compositions/source/local/*.yml`；官方切块和本地源经 `pnpm rebuild:composition` 生成 `engine/compositions/library/`，不得直接修补 library 产物。
- YAML runtime vendor 由 `pnpm sync:yaml` 生成 `engine/vendor/yaml/`，不得手改 vendored 文件。
- 上游 anchored 快照只通过 `pnpm sync:anchored` 更新。同步后保留本项目特有的子代理放行、上下文门控、Web/TUI、Skills 与预设生成语义，不做盲目覆盖。

### Settings bridge 与安全边界

- Bridge 路径唯一来源是 `src/shared/bridge-contract.ts`。新增或改名端点时同步 host 注册、client 调用和 `test/shared/bridge-contract.test.mjs`。
- 成功载荷保持 `{ ok: true, value }`，失败载荷保持 `{ ok: false, code?, message? }`。
- 保留 loopback socket、Host、Origin 校验和请求体大小上限。新写入端点先做白名单、类型/数值校验，再落盘并触发必要重建。
- 不把 secrets、token 或大文本放进 settings descriptor；大内容存文件，bridge 只传所需载荷。

### Skills、导入与模型工具

- 多 Skills 目录按配置顺序合并，首个目录优先；同名目录需保留 duplicate 标记和稳定排序。
- Skills frontmatter 的解析、修复、缓存与 watcher 使用现有 provider 管线，不在 UI 重新实现文件扫描。
- SillyTavern、角色卡和世界书转换复用 `host/` 工厂与排序语义；不要在 UI 或模型工具中复制转换规则。
- 角色卡/世界书/自定义工具写盘后通过现有 `rebuildPreset()` 路径生效，避免第二套热装配通道。
- 会话短期状态使用 `session_var`；跨会话角色记忆写角色卡 `memory.md` 并物化为 world-book 配置。

## 测试规则

- 非平凡分支、解析器、状态迁移、文件写入和安全边界必须留下最小确定性回归测试。
- 测试使用 Node 内置 test runner 和现有 helper；没有明确收益时不引入新测试框架或依赖。
- 文件系统测试创建独立临时目录并设置临时 `DSH_HOME`，结束后清理；禁止共享测试状态或依赖执行顺序。
- 修改参数链路时覆盖保存、读回、空值语义、组合消费与生成文件；修改 bridge 时覆盖契约、guard、错误载荷和重建回调。
- 修改 UI slot 时运行 client contract/no-host-DOM 测试；修改 engine 时运行对应 `test/engine/` 测试；修改预设或生成器时运行 `test/host/` 与 `test/presets/` 对应测试。
- 验收以注入层、位置、时机、次数、受众和 epoch 的确定性断言为准，不使用模型措辞或 `we` / `let me` 分数作为通过标准。

## 运行中的 DSH 服务

- 会话期间不停止、不重启当前运行的 `dsh` / `dsh web` 宿主，不终止其进程，也不抢占其端口启动替代实例。
- `cordis.patch.yml`、bundle 行或 profile manifest 变化需要重启时，只在交付报告标注「需要用户重启 DSH 服务后生效」，由用户决定重启时间。
- 页面刷新、只读 HTTP 探测和使用隔离 `DSH_HOME`、随机端口启动的独立 smoke 环境可以执行，但不得接触当前运行中的用户服务。

## Git 与交付

- 远程仓库是 `https://github.com/Czerror/dsh-plugin-prompt-tool.git`。当前开发工作以 `dev` 分支为主；保留用户已有改动，不执行破坏性 reset/clean，不把其他仓库当作推送目标。
- 每次修改完成并通过验证后，必须在同一轮落地为 Git 提交，并推送到 `origin/dev`，不得只把已完成改动留在工作树。
- 未经用户明确要求，不切换到 `main`、不在 `main` 上提交、不推送 `origin/main`，也不创建 PR；`main` 仅由用户明确授权的发布或集成流程更新。
- 所有交付说明、提交标题与提交正文统一使用简体中文。提交继续采用 Conventional Commits：类型使用 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`，冒号后的主题使用简体中文。
- 提交前检查 diff、验证结果和工作树状态，只暂存本次任务文件。只提交源文件和应跟踪的重建产物；`lib/`、`artifacts/`、`node_modules/`、压缩包和本地记忆不进入版本控制。
- 行为变化同步更新 README 或所属文档；不要把短期调查记录堆进长期架构文档。
- 推送因网络、认证或远端更新失败时，保留本地提交，不做破坏性历史重写；用简体中文明确报告失败原因和所需后续操作。
- 最终结论使用简体中文说明修改内容、验证命令、提交 SHA 与推送分支；若需要用户重启 DSH、重新链接 profile 或重新生成预设，也在结论中明确标注。

## 指令层级

- 本文件：仓库边界、架构不变量、验证与交付规则。
- `docs/architecture-params.md`：参数保存、合并、空值与生成链路。
- `docs/engine-reuse.md`：engine 模块、晋升语义和组合方式。
- `SillyTavern.md`：SillyTavern 预设、角色卡、世界书转换契约。
- `preset/creative/skills/`：Cordis 插件开发与组合编辑的按需工作流。

每条规则只保留一个权威位置；本文件写跨仓库约束，细节由对应文档承载。
