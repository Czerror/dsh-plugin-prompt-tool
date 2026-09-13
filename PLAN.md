# DSH 0.1.5-rc.2 适配、模型路由重构与依赖治理计划

## 1. 状态、基线与本轮边界

- 更新日期：2026-09-13。
- 状态：**待实施**。本轮只编写修改方案，不安装依赖、不修改运行代码、不迁移用户预设、不操作运行中的 DSH。
- 旧「模块列表与引擎设置归一重构计划」按用户确认视为已完成，原文保留在文末折叠归档；旧约束与旧测试统计不作为本计划的实施状态。
- 插件审查基线：`dev`，提交 `228000c2379521c7514726fe6cc206c8b6501aee`，插件版本 `0.7.2`。
- 官方目标版本：`0.1.5-rc.2`，tag `dsh-v0.1.5-rc.2`，提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`；官方 Release 发布于 2026-09-10。
- 本地官方 checkout 是 `master`，并不等于发布 tag。**读取目标源码使用 `git show <tag>:<path>`；不能把目录当前状态或 package.json 中同名版本号当成发布源码证明。**
- 前轮审查记录：`typecheck`、`lint`、`test` 内的 build 通过；完整测试 646 项，644 通过、2 失败，均在 `test/host/rebuild-composition.test.mjs`；`git diff --check` 通过。这是混合本地依赖环境的结果，不是纯发布包 rc.2 的认证结果。
- 本轮新增范围：模型目录与路由职责重构、官方模型元数据接入、新增明确用途的直接依赖、发布包安装与宿主契约验证。不能沿用上一轮「不重构模型、不引入依赖」作为排除项。

完成目标：修复官方组合漂移，建立可复现的 rc.2 依赖基线，使模型选择、默认同步、子代理路由和 UI 文案各有唯一责任方；保留现有提示词引擎及用户数据边界，并以确定性测试和隔离 smoke 验收。

## 2. 约束与审查结论校正

### 2.1 必须保持的边界

1. 只修改本插件。官方源码、已安装官方包和当前运行 profile 不作为修复目标。
2. `preset.yml` 保持预设行为的唯一来源；settings 只承载部署轴。模型字段继续使用顶层 `model` / `subagentModel`，不另建路由数据库。
3. 六个官方插入点保持独立，`order` 不跨插入点排序，不增加全局调度器。
4. `src/index.ts` 只编排；host、runtime、client、shared、engine 各归其位。
5. Skills、角色卡、世界书和自定义工具仍复用 provider、host 工厂及 `rebuildPreset()`，不在 UI 新建转换或装配通道。
6. YAML 用 Document API，保留注释、未知字段和合法空值；完整临时生成成功后才原子切换。system 目录只读，用户 AGENTS.md 只更新受管块。
7. 保留 loopback、Host/Origin 校验、请求体上限、路径白名单、预设身份校验及审批边界；模型凭证不进入 bridge、settings descriptor、日志或测试 fixture。
8. 不重启或终止当前 DSH，不抢占端口；smoke 仅使用临时 `DSH_HOME`、独立目录和随机端口。
9. 新依赖必须有实际消费方、版本、归属与验收，不能借此引入第二套状态框架、模型 SDK、DI 容器或万能路由层。

权威约束：[领域词汇](CONTEXT.md)、[预设定义 ADR](docs/adr/0001-preset-definition-is-authoritative.md)、[插入点 ADR](docs/adr/0002-insertion-points-remain-independent.md)、[UI 架构](docs/ui-architecture.md)、[参数架构](docs/architecture-params.md)、[引擎复用](docs/engine-reuse.md)。组合编辑实施前同时读取 [组合编辑技能](preset/creative/skills/editing-cordis-compositions/SKILL.md)。

### 2.2 不能照搬为事实的旧表述

- `^0.1.5-alpha.1` 并不排斥 `0.1.5-rc.2`。问题是验证下限、锁文件和解析来源没有统一，不是这个 semver 范围必然装不进 rc.2。
- 实测只有 `dsh-client-ui-layout`、`dsh-client-ui-sidebar` 锁在 alpha.1；大量其他官方包被 `pnpm-workspace.yaml` 的 `link:../deepseek-harness/...` 覆盖。不能称所有已安装包都还是 alpha.1。
- rc.2 仍声明 `shell.overlay`、`sidebar.footer.action`、`settings.plugins.tab`。几何探针属于依赖宿主内部 DOM 的脆弱实现，不是已经证明这些 slot 被删除。
- 官方 minimal 已移除 `filesystem`；同时 standard / ptc / cordis 新增 `present` 行。只修掉第一条报错仍不够，后者也必须进入组合覆盖检查。
- 官方 `agentDefaultModel.currentSelection()` / `saveSelection()` 仍存在。模型路由重构针对共享可变状态、重复接线、错误可见性与模型元数据，不伪称官方 API 已被移除。
- `subagentModelSelection` 是服务名，不是独立包名；其设置入口来自已发布包 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`。
- `dsh.client.inject` 是包名说明关系；运行时等待由导出的服务名 `inject` / `ctx.inject` 负责，非基座运行时 require 由 `dsh.client.external` 声明，三者不能互相代替。

## 3. 工作项、优先级与依赖

| 编号 | 优先级 | 修改目标 | 主要证据 / 修改入口 | 验收编号 |
|---|---|---|---|---|
| A-01 | P1 | 修复 minimal 已删除行的来源映射，保留 Anchored 所需本地编辑能力 | `scripts/rebuild-composition.mjs:185`、`preset/minimal/preset.yml`、`preset/anchored/preset.yml` | C-01～C-04 |
| A-02 | P1 | 补齐官方 `present` 组合及三个基型的模块顺序 | `scripts/rebuild-composition.mjs:159`、`preset/{standard,ptc,creative}/preset.yml` | C-02、C-05 |
| A-03 | P1 | 固定 rc.2 发布依赖，消除默认构建的同级源码 link | `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | D-01～D-03 |
| A-04 | P2 | 对齐 client external 与 bundle manifest，保留必要 Web 自愈 | `tsdown.config.ts:15`、`src/web-surface.ts:35` | D-04、H-01～H-03 |
| A-05 | P1 | 移除对全局 `subagents.start` 的 monkey patch，显式约束本插件路由范围 | `src/runtime/models.ts:154`、`src/host/manifest.ts:712`、`engine/subagent-tool-policy.mjs` | M-06～M-09 |
| A-06 | P2 | 模型目录按实例隔离、动态 effort、默认同步可等待、错误可观察 | `src/runtime/models.ts:39`、`src/client/data/session-model-face.ts`、`src/client/features/models/ModelRouteCard.tsx:26` | M-01～M-05、M-10～M-12 |
| A-07 | P2 | 去掉宿主 DOM 几何探针，保持全局工作台与官方 slot | `src/client/app/workbench/SidebarGeometryProbe.tsx:35`、`register-workbench.tsx` | U-01～U-04 |
| A-08 | P2 | Client 文案接入官方 locale；修正仍指向已移除右侧栏的提示 | `SettingsTab.tsx`、`FloatingTrigger.tsx`、各 feature 文案 | U-05、U-06 |
| A-09 | P1 | 固定上游 fixture，增加真实发布依赖与实际行为的验证 | `test/host/rebuild-composition.test.mjs:10`、`test/host-contract.test.mjs`、`test/client-bundle-facade.test.mjs` | D-01、D-03、V-01～V-03 |

实施分六个 Wave：W0 基线与依赖 → W1 组合与迁移 → W2 构建和 profile → W3 模型路由 → W4 UI 与 locale → W5 全量验收。W3、W4 都依赖 W0 的类型与发布基线；W5 依赖前述全部完成。可以拆主题提交，但不能只修两条失败就宣称整份计划完成。

## 4. W0：依赖基线与新依赖落地

### 4.1 现有依赖统一

- 本次目标 DSH 系列开发依赖精确锁定 `0.1.5-rc.2`；已有 peer 范围下限更新为 `^0.1.5-rc.2`。这只声明兼容范围，不替代后续版本的实测。
- Cordis 开发依赖锁定 `4.0.2`，peer 下限为 `^4.0.2`。Schemastery、React 等不属于 DSH 同版本系列，不批量改成 rc.2，也不顺带升级主版本。
- 移除提交配置中指向 `../deepseek-harness` 的默认 overrides。发布包验证必须在不存在同级官方源码的临时消费项目中通过。
- 若维护者确需源码联调，用不入库的显式本地开发配置；不能让它改变发布锁文件或被 CI 默认启用。
- 清理已不消费的版本例外及右侧栏残留 override；不通过关闭整个供应链等待策略、跳过完整性校验来解决安装问题。
- 用包管理器重建 `pnpm-lock.yaml`，不手写 lock。验证 Node engines 与 rc.2 CLI 实际范围，再同步本项目声明和 README；不继续把未验证的 Node 20 标成完整宿主兼容范围。

### 4.2 拟新增的直接依赖

以下 DSH 包的 `0.1.5-rc.2` 元数据与 exports 已于 2026-09-13 从官方 npm registry 读取确认；“新增”指新增本项目直接声明，部分目前仅通过本地 override 或传递依赖可见。**本轮尚未安装。**

| 依赖 | 安装归属 / 版本 | 具体用途 | 运行时边界 |
|---|---|---|---|
| `@deepseek-ai/dsh-agent` | dev，`0.1.5-rc.2` | 用公开 AgentOptions / 模型选择类型校验生成器和路由适配 | 类型 import 为主，不能私自再安装一份会话模型选择监听器 |
| `@deepseek-ai/dsh-llm` | dev，`0.1.5-rc.2` | LlmRuntime、LlmCallConfig、模型 reasoning 元数据及路由校验类型 | 能力从已注入 `ctx.llm` 取得，不自行创建模型客户端 |
| `@deepseek-ai/dsh-agent-default-model` | dev，`0.1.5-rc.2` | 类型化 `currentSelection` / `saveSelection`，替代匿名结构强转 | 动态等待宿主服务，不新注册同名服务 |
| `@deepseek-ai/dsh-subagent` | dev，`0.1.5-rc.2` | start / continuable 请求与 provider capability 的公开类型 | 不修改 registry 方法，不在根 scope 强加子代理默认值 |
| `@deepseek-ai/dsh-tool-subagent` | dev，`0.1.5-rc.2` | 校验生成的官方工具 Config 及公开 `model-selection-settings` 设置契约 | 标准工具行仍由宿主提供；禁止导入未发布的源码内部 helper |
| `@deepseek-ai/dsh-package-manifest` | dev，`0.1.5-rc.2` | DshManifest / DshClientManifest 类型契约测试，约束 bundle/client 元数据 | 不为它新增运行插件行；类型检查之外仍需 JSON 运行时断言 |
| `@deepseek-ai/dsh-client-locale` | dev，`0.1.5-rc.2`；同时补 `dsh.client.inject` | 注册 zh/en 词典、locale slot props 和动态标题 | Client 导出 inject 补 `locale`，注册挂在 effect；不内联第二份 locale service |
| `semver` | dev，精确 `7.8.5` | 新增宿主契约验证脚本使用 `valid` / `satisfies` 检查正式及预发布版本范围 | 仅构建／验证使用，不进入 host 或 client 运行 bundle；npm 元数据许可证为 ISC |

- 类型消费者原则上只进 devDependencies；本来已有的共享 peer 继续保留。若实施引入真正的运行时值 import，必须同时补对应安装关系、host external 或 client module external，并用消费包证明单例身份没有分裂。
- `@deepseek-ai/dsh-api-session-controller`、`dsh-api-remotes`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`yaml`、React 与 Node test runner 已存在，优先复用，不作为“新增依赖”重复安装。
- 本计划不加入 OpenAI/Anthropic SDK、Axios、Redux/Zustand、路由框架或另一套测试框架。新增依赖的需求由上表落实，不靠无使用方的包名凑数量。
- 每个新增包在提交时必须有直接 import／类型测试／脚本消费证据。Node `.mjs` 验证脚本不为了类型提示另加 `@types/semver`。

### 4.3 固定输入与版本检查

1. 新增 `test/fixtures/dsh/0.1.5-rc.2/`，保存重建测试需要的最小官方 preset 文件及必要技能资产，记录来源 tag、commit、文件 SHA-256 与许可证归属；不复制完整官方仓库。
2. `test/host/rebuild-composition.test.mjs` 从该 fixture 复制临时上游，停止依赖机器上的 `../deepseek-harness`。
3. `scripts/rebuild-composition.mjs` 保留显式上游路径入口；正式维护重建必须提供固定 tag 导出的目录，并记录 provenance。不能给任意 master 文件贴 rc.2 标签。
4. 拟新增 `scripts/verify-host-contracts.mjs` 和 `verify:host` script：报告每个直接官方包的版本、解析目标、缺失声明和非法源码 link；使用 semver 检查 peer 范围，同时用精确等值检查目标测试环境确为 rc.2。
5. 新增一个最小版本契约测试，覆盖 alpha.1、rc.1、rc.2、无效版本、错误解析路径；特别证明 `^0.1.5-alpha.1` 可以接受 rc.2，避免维护者再次误诊范围问题。

W0 完成条件：普通消费目录无需官方源码即可安装；精确开发基线、peer 范围、manifest 类型与实际解析来源一致；fixture 自包含且可追溯。

## 5. W1：组合重建与预设兼容

### 5.1 minimal 与 bootstrap-filesystem 分离

- 删除 `OFFICIAL_MODULES` 中从 minimal 提取 `filesystem` 的映射，以及为该官方行改名的 PATCHES / TARGET_MODULE_OVERRIDES 项。
- 将仍被 Anchored 和旧用户预设引用的 `bootstrap-filesystem` 定义放入拟新增的 `engine/compositions/source/local/bootstrap-filesystem.yml`，保持模块 ID 和旧别名归一规则，明确这是本地能力。
- 新发布的 `preset/minimal/preset.yml` 对齐 rc.2 单 shell 工具基型：移除 `bootstrap-filesystem`，保留 `official-persistent-shell` 与本插件显式附加的提示词配置引擎。同步描述中的“双工具”文字。
- `preset/anchored/preset.yml` 保留其显式声明的本地编辑能力，不能因为 official minimal 变成单工具就静默改变 Anchored 的首轮工具集合。
- 已存在用户 minimal 若显式包含 `bootstrap-filesystem`，继续解析到本地模块；不在启动时自动删除用户模块。不再将旧模块列入官方覆盖率统计。
- 同一模块不能同时存在于 source/local 与 library。先由重建脚本在临时输出中形成完整新集合，再切换生成目录，避免重复 ID 或悬空引用。
- 迁移本地文件系统组合时单独验证 sandbox/审批继承：不能因“保留旧能力”将裸 `fs-local` 的绕过行为扩大到其他预设或当作新默认授权；发现授权缺口必须在启用前修复并补回归。

### 5.2 补齐 present 与官方行覆盖

- 增加从 standard 提取 `present` 的官方映射；分别比较 standard / ptc / cordis 的行语义，确实相同时只保留一个共享模块，差异不能按 ID 强行合并。
- 在本地 standard、ptc、creative 的 `modules` 中按各自官方顺序加入 `present`，仍将本地 `prompt-config-engine` 作为明确附加项。
- Anchored/custom 不因这次同步被自动启用文件交付能力；是否装配继续由它们的模块清单决定。
- 最小修复继续保留“必要上游行消失／新行未覆盖则报错”策略，不把报错改成 skip，也不删除严格顺序检查来制造绿灯。
- 先修正明确映射，不另建复杂自动模块发现框架。上游预设目录发现、行切分、别名映射和语义签名的现有 helper 足够使用。

### 5.3 逐文件实施范围

| 文件 | 拟修改内容 |
|---|---|
| `scripts/rebuild-composition.mjs` | 移除失效来源、补 present、固定上游标识、验证官方行与本地附加项的边界；继续原子输出 |
| `engine/compositions/source/local/bootstrap-filesystem.yml`（新增） | 本地编辑能力的唯一源，不再宣称来自 rc.2 minimal |
| `preset/minimal/preset.yml` | 新建默认对齐单工具；persona 的 complete/includeRuntimeContext 契约不变 |
| `preset/standard/preset.yml`、`preset/ptc/preset.yml`、`preset/creative/preset.yml` | 纳入 present 并保持官方行序；同步目标 tag 内确实变化的 persona 和必要技能资产 |
| `src/host/manifest.ts`、`src/shared/engine-capabilities.ts` | 仅更新来源识别、别名和能力事实；保持显式空组合、dormant 参数与重复 ID 拒绝 |
| `scripts/migrate-presets.mjs`、`scripts/rematerialize-presets.mjs` | 复用现有显式迁移入口；必要时补预览／幂等保护，不自动改写自定义预设 |
| `test/host/rebuild-composition.test.mjs`、`composition-modules.test.mjs`、`builtin-presets-parity.test.mjs` | 固定 fixture，断言单工具 minimal、present、别名与生成失败原子性 |
| `test/host/migrate-presets.test.mjs`、`test/host/rematerialize-presets.test.mjs`、`test/presets/anchored/anchored-presets.test.mjs` | 旧双工具 minimal 可用、Anchored 工具集合不漂移、二次运行幂等 |
| `docs/engine-reuse.md`、`docs/architecture-params.md` | 同步官方与本地组合的真实来源、默认值及升级说明 |

W1 完成条件：固定 rc.2 fixture 重建成功；删除行和新增行两个问题都消失；重复／缺行／乱序／缺资产仍失败且不损坏旧产物；既有用户预设不被静默裁剪。

## 6. W2：Client 构建、manifest 与 Web 装配

### 6.1 外部模块与类型契约

- `tsdown.config.ts` 删除 `@deepseek-ai/dsh-client-runtime/client` 残留，将过时 `cordis` 基座名字对齐 `@deepseek-ai/cordis`；注释不再宣称使用 rc8 契约。
- 外部表只保留实际用到的 rc.2 平台模块。未来出现 `dsh-client-store` / `dsh-client-ui-dockkit` 值 import 时再加入，不能为了“完全对齐”无条件引入整张平台表。
- 继续使用 `window.__ModuleLoader__.load({ id, factory })` 惰性登记；不迁移为另一套 loader，也不让 bundle 顶层提前执行样式或服务注册。
- 新增值 import 若不在基座内，先声明 `dsh.client.external`，再验证提供者在 boot graph 中可解析；类型 import 不制造运行时模块边。
- 扩展 `test/client-bundle-facade.test.mjs`：检查实际 require 集合、正确的 Cordis 模块身份、CSS 在 factory 内执行、未声明 external 失败，不能只检查 package.json 中出现某个字符串。
- 新增 manifest 编译契约和 JSON 断言：校验 `dsh.bundle.patch`、client platform、包名说明边、服务名 inject 的分工，不用 `as DshManifest` 强转冒充校验。

### 6.2 清理私有 requires，保留恢复通道

1. 删除 `package.json#dsh.bundle.requires` 和 `src/web-surface.ts` 中对应的 manifest 读取函数，统一使用文件内的 Web bundle 常量；`requires` 不再混入官方命名空间。
2. 保留 `ensureWebSurface()` 对 base-only profile 的兼容修复：只修改当前 profile 的 bundles，base 之后、本插件之前，不重复插入，不覆盖依赖或未知字段。
3. `webServer` 继续动态等待，不进入入口静态 inject；已有 TUI 排除、manifest 原子写入及备份行为保留。
4. 将 `setImmediate` 等延迟修复任务纳入 effect/disposer；插件卸载后不得继续异步写 profile 或安装监听器。
5. 新建安装说明优先使用官方“从 web 模板初始化新 profile”的路径；明确仅适用于不存在的新 profile，不能对既有 profile 反复执行初始化。旧 base-only 安装保留自愈说明。
6. 不从 `patchReload: live` 推导 bundles/manifest 可以无重启完整热装配；需要重启只给用户说明，不代替用户操作服务。

修改范围：`package.json`、`tsdown.config.ts`、`src/web-surface.ts`、`src/index.ts` 中 Web 编排段、`test/host/web-surface.test.mjs`、`test/host-contract.test.mjs`、`test/client-bundle-facade.test.mjs`、README。

W2 完成条件：标准 web profile 无多余写盘；base-only profile 一次修复且卸载无残留；bundle 仅引用真实平台／已声明模块；原有 slot 与设置通道仍可装配。

## 7. W3：模型目录与模型路由重构

### 7.1 当前问题与重构目标

当前链路包括：`model/subagentModel` 读写、`buildModuleConfigsFromParams()` 的 delegation 配置、`modelRequestConfigs()` 的请求覆盖、`installDefaultModelRoute()` 的全局默认同步、对 `subagents.start` 的替换，以及 UI 的 `session.selectModel`。它们不是同一种“切换模型”。

重构目标是**分清责任并保留可证明的行为**：

- `src/runtime/models.ts` 的模块级 `catalogCache['default']` 不再在多个 Context／实例间共享。
- 不再替换全局 `subagents.start`，避免把当前编辑预设的默认模型泄漏到其他预设或第三方调用。
- 官方默认模型保存可以等待、报告失败和处理晚到服务；不能把吞掉 Promise 拒绝等同于同步成功。
- UI effort 来自当前 provider/model 的官方元数据，不再将 `off / low / high / max` 当成所有模型的固定档位。
- 保留当前会话选择、宿主默认、预设请求覆盖、子代理构造参数四种语义，不引入跨插入点的全局优先级引擎。

### 7.2 四条路由路径与确定行为

| 路径 | 数据所有者与写入通道 | 本计划确定的行为 |
|---|---|---|
| 当前会话模型 | 官方 `modelSelection` 投影与 `remote.session.selectModel()` | 继续走官方命令；当前步骤使用 assembly 时捕获的选择，并发切换在后续步骤生效；官方顺带持久化新会话默认的行为保留并在 UI 说明 |
| 主会话预设默认 | `preset.yml#model`；宿主 `agentDefaultModel.saveSelection()` | 为兼容现有产品行为，激活预设或其模型字段改变时同步宿主新会话默认；仅浏览／编辑非激活预设不能同步，不直接修改已运行 Agent 的 options |
| 预设请求参数 | `model/subagentModel` 的 effort、temperature、maxTokens，经既有 `modelRequestConfigs()` | 保留现有按 audience 的 agent-request 覆盖；UI 明示这是请求覆盖，不假装它只影响新会话；用户显式高级配置仍按该插入点现有 order/策略处理 |
| 子代理构造路由 | 所选预设生成的 tool-subagent / fork 配置或本地策略配置 | 默认值在对应预设 scope 内生效；合法显式调用参数优先，未指定才用该预设子代理默认，再按官方规则继承父会话；外部直接调用 registry 不受本插件暗中改写 |

主会话默认同步是当前行为的保留项，并非新设计的“每预设全局隔离”。若未来要取消它，应单独修改产品行为与迁移约定，本次不能顺带删除。

### 7.3 类型与字段规范化

- 优先使用新增官方依赖的类型，以及 `Pick` / `Parameters` 等派生的最小测试接口；保留外部 JSON 的运行时检查，不用类型强转跳过检查。
- `MODEL_SEGMENT_MAP`、`ENGINE_PARAM_DEFINITIONS` 和现有保存队列继续是字段来源；不建立第二套模型参数键表。
- provider/model 按对处理：均空表示不指定；同时非空表示完整选择；只给一个在保存边界报清楚的校验错误，不静默拼成另一服务商下的模型。
- effort 空值遵守所在通道：会话选择省略 effort 恢复官方 provider/default；预设字段清空意味着不再生成该字段的请求覆盖；完整默认模型替换时不保留上一个模型的 effort。
- 仅设置主会话 effort 时，读取宿主当前 provider/model 合并后保存；无有效当前路由时不写非法选择，返回明确未同步原因。
- 温度、输出上限继续复用已有数值校验；`0`、空字符串、未设置不可混淆，尤其不能误改 bootstrapMaxTokens 的显式零值语义。
- 模型目录仅作展示，不是授权白名单。用户已保存但暂不在 advertised catalog 的模型仍可回显；实际切换由宿主解析和校验，失败不得换成另一个模型。

### 7.4 目录与缓存

1. Web 模型选择优先消费官方 `remote.session.modelCatalog()` 的 `default / groups / routableProviders / failures`，其中 `groups[].models[].reasoning` 提供 efforts 与 defaultEffort；不从名称推断能力。
2. Host/TUI 缺少 session-controller 时，继续通过已注入 LlmRuntime 的 `listProviders()`、`listModels()`、`resolveModelInfo()` 取得元数据。保持方法绑定，禁止解构导致 `this` 丢失。
3. 以官方模型目录类型为内部数据合同，旧 bridge `modelCatalog: Record<string, string[]>` 只作为该数据的兼容投影，不再自行再次查 provider。
4. 缓存改为按插件实例拥有的状态；只有确需按服务复用时才使用按真实服务身份索引的 WeakMap，禁止常量 key 跨实例共享。刷新期间同一实例复用一个 in-flight 任务。
5. 初期保留现有 10 分钟 TTL 与 Host 兜底链路的单 provider 1500ms 超时上限，不凭直觉调整性能数字。订阅官方 `llm/adapters-updated`，服务重挂、显式刷新及客户端连接重置使相关缓存失效。
6. 用 generation 防止旧请求晚到覆盖新目录；provider 的一次失败不清空其他成功分组，错误来源随目录返回。官方方法不接收 AbortSignal 时，只承诺超时后不采用结果，不宣称底层请求已经取消。
7. `/describe` 保持快照读取，不触发整批远端模型查询；目录只在显式模型页面加载／刷新时查询，默认模型回显从官方当前值读取，不能被 10 分钟缓存冻结。

### 7.5 默认同步生命周期与错误传播

- 重构 `installDefaultModelRoute()`：公开可等待的同步操作，按宿主当前值比较，未变化不重复写 settings；比较不能只看上次本插件写入值，否则会漏掉官方 UI 的改动。
- `ctx.inject(['agentDefaultModel', 'settings'], ...)` 等待可选服务；依赖晚到时补一次同步，服务或插件卸载时取消未开始的任务，旧 generation 的结果不更新当前 UI。
- 只在激活预设、相关模型字段或服务状态变化时同步；技能扫描、tooltip、工具预览等无关操作不能触发默认写盘。
- 快速切换 A/B 预设或连续设置模型时，沿用现有保存协调机制串行确认；旧预设晚到结果不能成为最终默认值。不为此另建一套通用任务队列框架。
- 所有 `applyDefaultModel()` 调用方、settings 回调、bridge 保存和 TUI 命令都必须检查返回状态或注册受管任务；不留下吞错的 fire-and-forget。
- 跨预设写盘与宿主 settings 同步不是一个原子事务。若文件已保存而宿主同步失败，UI 必须分别显示“预设已保存”和“默认模型同步失败”；不能声称全量回滚，也不能丢掉草稿并显示全部成功。
- 在 `src/shared/bridge-contract.ts` 先定义拟新增 `modelSync` 结果（`synced / unchanged / unavailable / failed` 与安全消息），再同步 host、client 和契约测试。预设保存响应中的这个附加结果不改变统一 `ok/value/code/message` 包装；会话选择继续用官方结果合同。
- 对保存失败保留可重试提示，不无限自动重试；结构化错误不包含 API key、base URL 中的秘密或原始敏感请求体。

### 7.6 子代理路由去 monkey patch

1. 搜索并复核 `subagents.start`、`startContinuable`、`agentOptions` 的全部本项目调用方，区分标准工具、策略 shadow、工具委托和外部宿主直派。
2. 删除 `src/runtime/models.ts` 的 `service.start = wrapped` 及 `src/index.ts` 的安装调用；测试断言插件装卸前后 registry 方法身份完全不变。
3. 固定子代理默认值统一由 `buildModuleConfigsFromParams()` 生成到官方工具行和本地策略行。复用同一规范化结果，避免 provider/model、effort、maxTokens 在三处产生不同含义。
4. spawn / fork / continuable 分别验证 provider capabilities 与公开工具 Config。尤其本地策略目前对 fork 的 agentOptions 有单独限制，不能为了“统一”把 spawn 参数强塞给不支持的 fork。
5. 保持显式路由的能力校验、取消信号、最大深度、persona、toolFilter、approval 与返回结果合同；不支持 agentOptions 的后端必须明确拒绝而非静默丢字段。
6. 第三方直接调用宿主 registry 的行为由第三方请求和官方继承规则决定。若本插件未来新增直接委派调用，默认值必须由该调用点显式传入，不能恢复全局包装。
7. 不默认启用官方 model-selectable delegation。已有 `modelSelectionSettings: true` 的标准工具仍遵守会话首次采样、精确允许路由、子会话继承和恢复会话规则；压缩不是重新授权。
8. 本地策略 shadow 如支持调用方显式选模，不得借“固定默认值”绕过已生效的授权表。不公开导入官方 `src/model-selection.ts` 私有 helper；无法通过公开契约证明授权时明确拒绝该组合，不降级成无限制选择。

### 7.7 逐文件范围与停止条件

| 文件 | 修改责任 |
|---|---|
| `src/runtime/models.ts` | 保留宿主适配与既有公开导出；类型化检测、实例缓存、可等待默认同步；删除 registry 包装 |
| `src/runtime/model-catalog.ts`（需要分离缓存时新增） | 只承载目录加载、缓存与失效，不新建模型服务框架；只有实际被 models.ts 消费才创建 |
| `src/index.ts` | 接线目录／同步生命周期，收口相关调用，不承载模型决策细节 |
| `src/host/manifest.ts`、`src/host/write-preset.ts` | 模型字段验证、delegation 配置和请求参数生成；保留 YAML 段及稳定配置 ID |
| `src/shared/engine-params.ts`、`src/shared/bridge-contract.ts` | 修正文案中的固定 effort 假设；增加有真实消费方的目录元数据和同步结果类型 |
| `src/runtime/settings-bridge.ts`、`src/runtime/tui.ts` | 统一目录投影与错误／部分成功状态；继续预设身份和载荷校验 |
| `src/client/data/host-api.ts`、`session-model-face.ts`、`use-prompt-tool-store.ts` | 官方目录／选择 API 适配、连接 generation、当前会话切换订阅、异步结果归属 |
| `src/client/features/models/ModelRouteCard.tsx`、`model-options.ts` | 动态模型与 effort 选项，区分会话选择／默认／请求覆盖，保留未知存量值并显示失败 |
| `engine/subagent-tool-policy.mjs`、`engine/subagent-tool-policy-core.mjs` | 仅收口必要的默认合并／能力与授权检查；不改六层接线，也不新增远程模型 SDK |
| 现有 model、module-configs、参数 bridge、session-model-face、子代理策略测试 | 以请求、生成物和生命周期断言证明兼容，不只测试字符串出现 |

W3 完成条件：所有模型路径有明确来源及回显；保存失败可诊断；两个 Context 的目录互不污染；非目标预设和外部调用不受默认路由污染；官方会话模型选择与自定义请求覆盖的差异在 UI 可见。

## 8. W4：工作台入口、可访问性与 locale

### 8.1 采用的 UI 方案

- 默认方案：`sidebar.footer.action` 渲染真正可见的触发器；`shell.overlay` 继续承载全局抽屉；`settings.plugins.tab` 保留基础设置。
- 不恢复 session-scoped 的 `sidebar.right.pane.tab`，不新增路由系统或第二个工作台状态所有者。当前六页工作台仍是全局配置工作台。
- 删除 `SidebarGeometryProbe.tsx`、注册项、宿主祖先遍历、grid-template-columns 读取及 `--pt-sidebar-edge`。必要时将 `FloatingTrigger.tsx` 改名为 `WorkbenchTrigger.tsx`，控件只消费官方 `wide` props 与现有 controller。
- 这是明确的入口位置调整，不是修补一个已被官方删除的 slot。若产品必须继续左上悬浮，应先另行确定不依赖宿主 DOM 的几何合同；不能悄悄保留原探针并标记本项完成。
- 抽屉是否仍需 body portal 由 rc.2 smoke 验证；本计划先保留它，不因官方有 overlay 就擅自删除现有置顶保障。避免扩大宿主 CSS 选择器或用更高 z-index 修复焦点问题。
- 复用 `src/client/ui/dialog-focus.ts` 与现有 dialog helper，验证焦点陷阱、Escape、关闭后焦点归还、嵌套弹窗、Tab/Shift+Tab、窄屏和 reduced-motion。ARIA 声明不能代替真实键盘行为。
- `dsh-panel-activate` 是私有跨插件互斥协议，不是官方 API。本轮保留既有兼容监听的生命周期；移除它需要证明消费者不再依赖，不能仅因本仓库无其他发送方就删除。

### 8.2 全量用户文案归属

1. 在 `src/client/locales.ts`（新增）注册类型化 zh/en 字典。文本很多时再按现有 feature 分词典，但不复制翻译框架。
2. `src/client/index.ts` 通过官方 locale effect 注册与清理；slot 注册补 locale namespace，label 使用官方支持的动态取值函数。
3. 迁移工作台入口、设置标签、六页标题、按钮、placeholder、tooltip、ARIA 名称、确认文本、加载／保存／错误提示。shared 元数据中的显示标签改为由 UI 翻译 key 映射，shared 不 import client 字典。
4. 官方组件的 chrome 继续复用其既有本地化合同，不为 primitive 另造 fallback 文案。provider/model ID、文件路径、用户内容、prompt 文本和协议 code 保持原值。
5. 修正 SettingsTab 仍提示“从会话右上角右侧栏打开工作台”的旧文案，并同步 README 与 `docs/ui-architecture.md` 的入口说明。
6. 保留 Host 错误 code；客户端已知错误用本地化提示，未知错误使用安全消息。不把任意英文 wire 数据当翻译 key，也不借本轮迁移重写所有 TUI 日志。
7. 无刷新切换宿主语言时已打开工作台的标签同步更新；缺 key 的回退规则沿用官方 locale，不维护另一份独立字典状态。

修改范围：`src/client/app/workbench/`、`src/client/locales.ts`、各 feature 文案与 data 状态提示、必要的 shared 显示 key、`test/client/slot-workbench-contract.test.mjs`、`no-host-dom.test.mjs`、`dialog-focus.test.mjs`、拟新增 `test/client/locale-contract.test.mjs` 与 UI 权威文档。

W4 完成条件：无宿主 DOM 几何探测；标准 slot 装卸正常；单一状态所有者保留草稿；中英文、键盘和窄屏验收通过。

## 9. W5：固定基线、真实宿主与发布验证

- 单元／契约层：继续 Node 内置 runner 和现有 helpers；新增的版本、目录竞态、部分成功、locale 与组合 fixture 测试是当前目标的回归，不建立每个函数一套框架。
- Host 集成层：用发布包真实 Cordis scope 和工具注册，覆盖两个并存预设、主会话、spawn/fork/continuable、压缩、释放与重挂。模型请求使用可控假 provider 记录配置，不调用付费模型、不带真实凭证。
- Client 契约层：保留 bundle factory smoke，并增加使用真实 SlotRegistry 的注册／释放验证；正则源码检查只能作为守卫，不能充当实际 DOM 或数据流证明。
- 浏览器层：隔离 Web smoke 检查入口、设置保存、目录失败、语言切换、官方模型选择器互通、草稿保留和键盘；使用现有可用浏览器验证设施，不在本计划默认新增测试框架。
- 消费安装层：在没有同级官方源码的临时消费项目中安装本插件测试包与 rc.2 官方包。检查依赖闭包、单例身份、client graph 和实际可装配性；不能只在带 link 的开发树中 typecheck。
- 运行环境至少覆盖一套官方支持的 Node LTS；Windows shell 路径通过真实隔离 smoke，POSIX 行通过平台配置断言或可用 CI 实跑。没有实跑的 OS 明确标注，不以本机测试代替跨平台认证。
- 所有进程 cwd、fixture 根、TEMP/TMP、临时 DSH_HOME 均落在 `D:\AI\workspase\_temp` 下。只清理本轮拥有并检查过绝对路径的临时目录，不清理共享包缓存或用户状态。
- 已生成文件只通过 package scripts 更新，不手工修改或暂存 `lib/`、`engine/compositions/library/`、`engine/vendor/yaml/`；最终测试必须能从固定输入重新生成同一行为，不能依赖本机遗留产物。

## 10. 验收矩阵

以下均为实施完成后的验收条件，不是本轮已通过记录。每条结果要能定位到测试名称或 smoke 步骤；测试总数以实际运行记录为准。

| 编号 | 场景 | 必须成立的断言 |
|---|---|---|
| C-01 | 对固定 rc.2 minimal 重建 | 不再请求不存在的 filesystem；新内置 minimal 仅有当前 OS 的持久 shell 工具 |
| C-02 | rc.2 standard / ptc / cordis 对照 | persona 外每条官方行被覆盖，present 存在且层内顺序匹配；本地附加项单独计数 |
| C-03 | 旧 minimal 与 Anchored | 显式 bootstrap-filesystem 仍可用；旧别名可读；Anchored 晋升前／后工具集合和授权边界不扩大 |
| C-04 | 缺行、重复、乱序、缺资产、生成失败 | 明确失败且原生成目录完整保留；不得留下双来源同名模块 |
| C-05 | 重建、迁移和重物化重复两次 | 语义结果相同，注释／未知字段保留，不自动改写用户自定义模块清单 |
| D-01 | 无同级官方源码的消费安装 | 发布依赖与类型可以解析，无 link 到开发机路径，所有目标 DSH 包实际为 rc.2 |
| D-02 | semver 与直接声明 | peer 包含目标版本；精确开发基线拒绝误用 alpha/rc.1；每个新增包有真实消费者 |
| D-03 | 两个独立测试目录重建 | 只由固定 fixture 得到相同结果，不读取本地 master、不依赖执行顺序或共享 DSH_HOME |
| D-04 | Client bundle 物化 | require 均由真实基座或明确 external 满足，无旧 runtime 引用、无第二份 Cordis/React 单例 |
| H-01 | web profile 已完整 | 不改 manifest，不重复插入 bundle，不重复注册路由 |
| H-02 | base-only / TUI / 无效 manifest | base-only 只补当前 profile 并提示重启；TUI 排除保持；无效 manifest 不损坏原文件 |
| H-03 | Web 服务晚到、插件卸载／重挂 | 正常补注册；旧 setImmediate、inject、watcher、路由和订阅被释放 |
| M-01 | 当前会话经插件与官方 UI 切换模型 | 两处回显同源；并发切换不拆散同一步的 assembly 模型与请求模型；失败保留原选择 |
| M-02 | 激活预设设置主模型默认 | 只更新宿主新会话默认，不改运行中 Agent options；非激活预设编辑不写全局默认 |
| M-03 | 空路由、半路由、仅 effort、跨模型 effort 清除 | 不保存非法 pair；空值不误变 0；仅 effort 合并有效宿主路由；完整替换不继承旧模型 effort |
| M-04 | A/B 快速切换、异步保存拒绝、服务晚到 | 最终值属于最后有效操作；无 unhandledRejection；部分成功准确回显并可重试 |
| M-05 | 当前选择与预设请求覆盖同时存在 | 用户能分辨选择与覆盖；原 agent-request order / replace / audience 语义保持 |
| M-06 | 两个预设及外部调用并存 | 子代理默认仅来自各自配置；插件从不替换全局 start/startContinuable 方法 |
| M-07 | spawn / fork / continuable 及不支持 agentOptions 的后端 | 分路径验证合同；显式选项优先，不支持时拒绝；signal、persona、toolFilter、深度与审批不变 |
| M-08 | 模型自主选择 opt-in / 允许路由 / 恢复会话 | 默认不启用；非法显式路由不越过授权；现有会话不因设置变化或压缩重新获得选择权限 |
| M-09 | 主会话、子代理、成功与失败压缩、释放／重挂 | 原插入点、位置、时机、次数、audience、epoch 保持；失败压缩不重置，disposer 无重复监听 |
| M-10 | 两个 Context 查询模型目录 | 缓存互不污染；并发同源刷新合并；旧 generation 不回写新数据；类方法 this 不丢失 |
| M-11 | provider 超时／失败／移除及重连 | 保留其他成功分组，提供错误信息；变更使相关缓存失效；describe 不主动远端刷新 |
| M-12 | 不同模型的 reasoning 元数据和手写模型 ID | effort 选项按 provider/model 更新；无能力时不虚构档位；未知存量值保留且切换仍经宿主校验 |
| U-01 | 侧栏展开、折叠及不同宽度 | 实际入口由 footer slot 布局，无祖先查找、grid 解析或全局几何变量 |
| U-02 | 抽屉反复开关、切预设与过滤 | 共用 controller/store，未完成草稿和保存队列不丢失；旧响应不串预设 |
| U-03 | 键盘、嵌套对话框、窄屏、reduced-motion | 焦点限制和归还正确；Escape 不误关无关弹窗；控件有有效可访问名称 |
| U-04 | Slot declarer 卸载／恢复、插件重挂 | 子项跟随声明生命周期；无重复入口、独立 React root 或宿主 DOM 观察 |
| U-05 | zh/en 即时切换 | 标签、按钮、tooltip、ARIA、状态提示同步更新，无已知缺 key；用户内容不被翻译 |
| U-06 | 设置页导引与模型来源说明 | 入口文案对应实际 footer，模型卡清楚区分当前选择、宿主默认、请求覆盖与子代理策略 |
| V-01 | Shared bridge 写入与拒绝路径 | 先校验身份、类型、数值、长度／大小、Host/Origin；失败包装统一，不暴露秘密 |
| V-02 | 全量回归与冷启动消费 smoke | 原有功能不回退，完整门禁无失败；只跑新增测试不能宣布完成 |
| V-03 | 产物来源、运行环境与发布记录 | tag/SHA/包版本/Node/OS/命令退出码可追溯；未跑平台明确列出，当前 DSH 未被重启 |

## 11. 实施阶段验证命令

### 11.1 工作目录与新增检查

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
$TempRoot = 'D:\AI\workspase\_temp'
Set-Location $TempRoot
$env:TEMP = $TempRoot
$env:TMP = $TempRoot

# 拟新增：W0 完成后才存在，不能把计划命令标成已经运行。
pnpm --dir $Repo verify:host
if ($LASTEXITCODE -ne 0) { throw '宿主契约验证失败' }
```

临时 DSH_HOME 由每个测试 fixture 各自创建并清理，不能把上面的共享 TempRoot 直接当所有测试共用的 DSH_HOME。目录读写测试的 fixture 根也必须由该目录下的独立 mkdtemp 生成。

`pnpm --dir` 会让 scripts 在项目目录运行，仅从临时目录发起命令不足以证明测试 cwd 合规。W5 需把 `test` script 的 Node runner 接到最薄的隔离启动入口（拟新增 `scripts/run-tests.mjs`）：先走现有 build，再以临时 cwd、绝对测试路径、独立 TEMP/TMP 环境启动同一 Node test runner，并原样返回退出码。不新增测试框架或改变用例发现范围。

### 11.2 聚焦行为验证

构建后可直接从临时 cwd 运行以下现有测试；新 fixture／新增测试纳入实施后的完整发现范围：

```pwsh
pnpm --dir $Repo build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }

node --test "$Repo/test/host/rebuild-composition.test.mjs" "$Repo/test/host/builtin-presets-parity.test.mjs" "$Repo/test/host/composition-modules.test.mjs"
if ($LASTEXITCODE -ne 0) { throw '组合契约失败' }

node --test "$Repo/test/host/models.test.mjs" "$Repo/test/host/module-configs.test.mjs" "$Repo/test/client/session-model-face.test.mjs" "$Repo/test/client/model-options.test.mjs"
if ($LASTEXITCODE -ne 0) { throw '模型路由契约失败' }

node --test "$Repo/test/engine/subagent-tool-policy-runtime.test.mjs" "$Repo/test/engine/promotion-gate.test.mjs" "$Repo/test/presets/anchored/anchored-presets.test.mjs"
if ($LASTEXITCODE -ne 0) { throw '子代理或晋升契约失败' }

node --test "$Repo/test/host/web-surface.test.mjs" "$Repo/test/client/slot-workbench-contract.test.mjs" "$Repo/test/client/dialog-focus.test.mjs" "$Repo/test/client-bundle-facade.test.mjs"
if ($LASTEXITCODE -ne 0) { throw '宿主或客户端契约失败' }
```

### 11.3 最终门禁

```pwsh
foreach ($Script in @('typecheck', 'lint', 'test', 'build')) {
  pnpm --dir $Repo $Script
  if ($LASTEXITCODE -ne 0) { throw "$Script 失败，停止本轮交付" }
}
git -C $Repo diff --check
if ($LASTEXITCODE -ne 0) { throw 'diff --check 失败' }
```

- 锁文件冷安装、rc.2 固定源码重建、消费包和浏览器 smoke 使用独立临时项目，记录真实目录、包版本、随机端口与结果；不在这里提供会误操作当前用户 profile 的可直接执行命令。
- 不执行 `pnpm rebuild:composition` 的无参数默认读取后就宣布 rc.2 通过；输入必须是固定 tag 导出的临时上游目录。
- 不将 SSR 的 useLayoutEffect 警告当成浏览器实测成功，也不把本地源码包的 typecheck 当作 npm 消费安装成功。
- **本次文档交付只运行 diff／路径／链接／结构核对。上述代码验证留待实施，不重跑完整构建测试，也不把旧测试结果更新为本轮结果。**

## 12. 风险、迁移、回退与停止条件

| 风险 | 控制与回退 |
|---|---|
| 把旧 minimal 双工具行为当作官方新默认 | 新内置 minimal 对齐单工具；用户已有显式模块继续可用；迁移预览列出来源与行为变化 |
| 移动 bootstrap 模块造成重复或失效 | 稳定 ID、旧别名兼容、双来源拒绝；临时集合全部成功再原子切换，不清理无关文件 |
| 本地 filesystem 组合扩大权限 | 在本插件拥有的 scope 内验证 sandbox/审批继承；授权无法证明时不能启用，不用旧实现为绕过开脱 |
| 本地 master 与发布包混用导致假绿 | 固定 tag/SHA、fixture 哈希、无源码目录消费安装；发现不同来源不强转类型绕过 |
| 新依赖分裂 Cordis/React 单例或泄漏私有源码路径 | 检查实际 bundle import 和 exports；运行时值按 face 声明 external；无用依赖删除 |
| 默认同步失败但预设已保存 | 返回分阶段状态，保留可重试提示；不自动回滚用户后来保存的内容，不承诺跨两种存储的原子事务 |
| 去掉全局子代理 patch 改变第三方直派行为 | 明确限定支持边界；本插件入口显式传参，第三方调用恢复官方默认继承；用双预设／外部调用测试锁定 |
| UI 入口位置变化与用户习惯冲突 | 文案、README、截图一起更新；不恢复被移除的 session 右侧栏作为暗中第二入口 |
| 取消探针却遗漏焦点或窄屏行为 | 复用现有 dialog helpers，实际键盘和响应式 smoke 作为完成门禁 |
| 多阶段改动被误当成已实施 | 每个 Wave 只在验收有证据时勾选，计划提交与功能提交分开；保留未验证项和下一步 |

回退按主题提交实施，必要时另建修复／revert 提交，不 reset/clean 或覆盖用户历史。数据变动先完整备份到本插件拥有的临时／备份目录；恢复仅针对确认过的目标文件，不清理其他 profile、官方目录或用户 AGENTS.md 非受管内容。

依赖或 bundle/profile 变化需重新加载时，交付写明“需要用户重启 DSH 服务后生效”。本地模块／预设生成变化需重新物化时，给出具体预设和备份方式，由用户决定何时执行；不能在计划阶段自行执行。发布包安装／构建后出现新错误先查固定基线，禁止通过删严格断言、跳过测试或恢复开发机 link 掩盖。

## 13. 待办与交付要求

- [ ] W0：固定官方 fixture、精确发布依赖、新依赖消费及 verify:host。
- [ ] W1：本地 bootstrap 来源、单工具 minimal、present 覆盖、迁移与原子重建验证。
- [ ] W2：构建 external、manifest、Web 自愈与卸载生命周期。
- [ ] W3：模型目录／effort／同步结果、去全局子代理 patch、完整路由回归。
- [ ] W4：实际 footer 入口、移除 DOM 探针、官方 locale 与键盘／窄屏验收。
- [ ] W5：隔离 test runner、全量门禁、发布消费安装、真实浏览器 smoke。
- [ ] 同步 README、CHANGELOG、UI/参数/引擎权威文档；记录行为变化和必须由用户执行的重载／物化动作。
- [ ] 交付实际命令、退出码、失败或未验证项、验收矩阵映射、提交 SHA 与 `origin/dev` 推送结果。

本计划只变更 `PLAN.md`。实施后每次提交只暂存本主题源文件／测试／文档，使用中文 Conventional Commit 并推送 `origin/dev`；不切换或推送 main，不创建 PR，生成目录和本地记忆不入提交。全部 Wave、验收和必要验证完成前，不将总状态标记为已完成。

## 14. 资料与证据定位

官方源码均以 `dsh-v0.1.5-rc.2` 的 `git show` 内容为准，不能将下列路径的当前 master 内容混作发布证据：

| 官方源码路径 | 用途 |
|---|---|
| `packages/preset/agent-presets/presets/{minimal,standard,ptc,cordis}/agent.cordis.yml` | minimal 单 shell、其他三个基型的 present 与真实行序 |
| `packages/util/package-manifest/src/types.ts` | bundle 只有 patch；client inject/external/平台字段的正式合同 |
| `packages/client/web/src/platform.ts`、`seed.ts` | 正确平台模块身份，rc.2 无旧 client-runtime 预载项 |
| `packages/client/ui-layout/src/client/index.ts`、`AppFrame.tsx` | shell.overlay 仍存在；布局 DOM 不属于扩展 slot 保证 |
| `packages/client/ui-sidebar/src/client/contract/slots.ts` | sidebar.footer.action 仅提供 wide 的公共 owner props |
| `packages/client/ui-sidebar-right/src/client/contract/slots.ts` | 右侧栏 tab 为 session scope，不是全局工作台替换目标 |
| `packages/client/AGENTS.md`、`packages/client/ui-settings-plugins/src/client/index.ts` | Client 依赖声明、locale、设置 tab 与生命周期用法 |
| `packages/core/agent-default-model/src/index.ts` | currentSelection/saveSelection 的完整替换和异步写入 |
| `packages/core/agent/src/model-selection.ts` | 官方会话选择对 assembly、请求和切换通知的一致性；仅用于理解宿主行为，不新增私有源码 import |
| `packages/api/session-controller/src/catalog.ts`、`src/index.ts` | 官方 modelCatalog 及 selectModel 公开入口，动态 reasoning 元数据 |
| `packages/subagent/tool-subagent/src/index.ts`、`src/model-selection-settings.ts` | 官方构造参数、modelSelectionSettings opt-in 与首次会话采样 |
| `packages/subagent/subagent/src/index.ts` | registry start、continuable 与能力拒绝；不能由全局包装改变其合同 |
| `packages/boot/app-boot/src/profile.ts`、`apps/cli/src/plugin.ts` | profile 模板、bundles 顺序与安装后 reconciliation |

在线核对来源：官方 GitHub Release `deepseek-ai/deepseek-harness` 的 `dsh-v0.1.5-rc.2`；官方 npm registry 中第 4.2 节各包的精确版本元数据（核对日 2026-09-13）。依赖声明事实通过 npm 元数据核对，实际消费者类型／构建／运行兼容性必须由 W0/W5 补充验证，不能从“已发布”直接推导“集成已通过”。

## 15. 已完成旧计划归档

以下仅保留历史设计与当时的测试记录，不作为 rc.2 计划的待办、非目标或验收结果。旧计划已按用户确认结束；历史测试失败由当前基线重新判断。

<details>
<summary>展开：已完成的模块列表与引擎设置归一重构计划</summary>

### 模块列表与引擎设置归一重构计划（历史原文）

## 1. 状态与目标

- 更新日期：2026-09-08。
- 状态：代码实施完成；客户端契约、类型检查、lint 和构建通过，完整测试仍有 4 项未触及本轮文件的既有组合／人设失败。
- 目标：将前端引擎设置归入“模块列表”下六个插入点对应的模块卡，按能力影响的行为组织编辑入口，移除“通用设置／引擎能力设置”双视图。
- 完成条件：单一列表可访问原有提示词配置与能力设置，分类正确、字段不重复、保存不串预设，运行时行为保持不变。
- 本计划替换过期修复记录，不重新执行或撤销旧修复；已有实现与历史由 Git 保留。

## 2. 已确认的设计原则

1. **按行为归类，不按监听事件归类。** 六个插入点在 UI 中组织能力的行为归属，不是底层 hook 的目录。
2. **`anchor-turn` 归入 `pre-step` 卡内设置。** 它监听 `agent/inbox/inserted`，但改变前置行为能力；实际事件不构成 UI 分类限制，不因此移入公共配置或改写监听事件。
3. **统一入口，不合并运行时模型。** 提示词配置仍为 `promptConfigs`；能力模块仍由模块事实决定存在性，参数沿用所属预设的保存链路。
4. **一项能力一个参数归属。** 跨插入点影响可用说明表达，不拆散能力、不复制可写字段、不重复装配。
5. **复用现有字段体系。** 不增加第二份字段清单、默认值、校验、参数映射或状态库。
6. **六个插入点保持独立。** UI 分组和筛选不产生全局执行顺序，也不改变模块实际注册的 hook。

这些原则遵循 [领域词汇](CONTEXT.md)、[预设定义权威 ADR](docs/adr/0001-preset-definition-is-authoritative.md) 和 [插入点独立 ADR](docs/adr/0002-insertion-points-remain-independent.md)，不替代两项 ADR。

## 3. 当前实现与复用位置

| 当前职责 | 已有文件 | 本次处理 |
|---|---|---|
| 主会话维护插入点筛选和双视图状态 | `src/client/app/workspace/pages/MainSessionPage.tsx` | 移除双视图状态，保留单一筛选与 store |
| 通用／能力两个面板互斥挂载 | `src/client/features/prompts/PromptConfigsEditor.tsx` | 收敛为一个模块列表，不保留第二套引擎设置面板 |
| 提示词配置筛选、草稿、排序、批量操作和保存 | `src/client/features/prompts/PromptConfigList.tsx` | 保留操作所有权，组合能力卡时不把能力当作提示词配置 |
| 能力身份、装配事实、显示分类与创建配方 | `src/shared/engine-capabilities.ts` | 复用现有定义，仅在有实际消费者时补展示元数据 |
| 能力卡过滤、展开与删除 | `src/client/features/modules/EngineModuleList.tsx` | 并入统一列表，删除旧双视图专用编排 |
| 参数目录与字段渲染 | `src/shared/engine-params.ts`、`src/client/features/modules/EngineParamFields.tsx` | 保留类型、默认值、校验、字段归属及参数桥 |
| 通用折叠卡形态 | `src/client/ui/EngineModuleCard.tsx` | 继续复用，不新建万能配置卡 |
| 模型与自定义工具专用编辑器 | `src/client/features/models/ModelRouteCard.tsx`、`src/client/features/tools/CustomToolsCard.tsx` | 调整所在区域，保留领域接口与保存方式 |

实施前 [UI 权威文档](docs/ui-architecture.md) 描述双视图；本轮已将展示契约同步为单一模块列表。本计划记录实施状态，不能把文档更新当作运行验收完成。

## 4. 目标界面与行为分类

### 4.1 单列表信息架构

```text
主会话
  模块列表
    公共配置：模型选择、模板变量、预设生成默认值
    工具栏：插入点层级/策略筛选、合并创建菜单（添加能力 / 工具模块）、提示词配置操作
    平铺卡片：提示词配置卡（按层序/order 排序）、已装配能力模块卡、自定义工具卡
```

- 列表平铺渲染全部卡片；插入点不再作为分类区块，工具栏的插入点层级/策略筛选只过滤卡片、不生成区块。
- 每项能力一张卡，参数在卡内展开；不把不同能力揉成整层万能表单，也不留下独立“引擎设置”页。
- 不为填充界面新增或默认启用能力。
- 提示词配置与能力模块保留不同操作语义，只统一入口、布局与行为分类。
- 当前会话模型选择、模板变量和预设生成默认值保留单一公共入口，不复制到六个分类。部署设置仍在基础设置。
- 公共区域不是第七个插入点，不能仅因能力监听多个 hook 或监听六类以外的事件而将其移入公共区域。
- 保留现有提示词模板、变量、能力及配方创建入口；不要求将不同领域操作改造成一个后台创建接口。
- 合并菜单内部平铺不折叠：提示词模板按插入点层级展开为「添加模板 · 层级」（点击只列该层模板），工具模板与模板变量各有独立入口。
- 保留插入点层级与世界书策略筛选；世界书不是第七个插入点，世界书视图不混入能力卡，层级筛选只作用于对应层的提示词配置与能力卡。
- 保留提示词配置搜索，明确其作用对象；本次不新增参数全文搜索或搜索服务。
- 计数、空状态、排序、批量启停和保存文案必须明确对象；有能力卡时不能因提示词为空就宣称“没有模块”。

### 4.2 首版能力归属

首版沿用现有主显示分类，用能力影响的行为解释归属。这张表不表示实际 hook、覆盖的全部事件或运行先后。

| UI 行为分类 | 现有能力或配置 | 归类说明 |
|---|---|---|
| `pre-step` | `anchor-turn`、`context-gate`、本插入点提示词配置 | 前置锚定、上下文放行及前置消息行为；`anchor-turn` 的实际监听事件不妨碍归类 |
| `system-section` | `tool-bootstrap`、本插入点提示词配置 | 保留该能力的主显示归属；首轮工具窄化、晋升与阶段字段仍在同一能力卡，不因跨行为影响拆分 |
| `runtime-context` | 本插入点提示词配置 | 当前没有独立登记到此分类的能力卡；不复制 `context-gate` 参数制造另一份设置 |
| `agent-request` | 本插入点提示词配置 | 保持请求补丁编辑，不把当前会话模型选择转换为提示词配置 |
| `llm-stream` | 本插入点提示词配置 | 保持流控制配置与字段策略，不新增流处理能力 |
| `tool-pipeline` | `code-presentation`、`tool-filter`、`str-replace-editor`、`deliberation-gate`、`cot-drip`、`tool-config-engine`、自定义工具及本插入点提示词配置 | 工具呈现、过滤、执行及结果行为；不要求实际只监听 `tools/*` |

- 表内登记不等于默认装配；卡片仍由当前预设实际模块事实决定是否出现。
- `str-replace-editor` 沿用 `bootstrap-filesystem` 的现有映射与隔离服务域，不恢复单独装配编辑器的旧实现。
- 跨分类说明引用同一能力，不创建第二份参数或独立开关；“全部”视图不重复显示同一能力。
- 展示分类不写入预设成为新的调度指令，卡片移动不改变运行时注入位置。

## 5. 数据、状态与操作契约

### 5.1 字段与保存

- `ENGINE_PARAM_DEFINITIONS` 继续统一参数归属、默认值、类型、校验和组合映射；普通引擎字段复用 `EngineParamFields`。
- 参数、提示词配置、模板变量、模型选择与自定义工具沿用各自的领域入口，不统一为一种载荷或一个全局事务。
- 不新增 bridge endpoint，不修改响应封装、YAML 字段或预设存储格式，不执行数据迁移。
- 保留参数桥、`moduleConfigs`、行默认的优先级，以及空值回落、合法 `0`、显式 `false` 与空模板变量的区别。
- 未声明且未修改的 UI 默认值不固化为预设覆盖；卡片改位置不改变读回与保存映射。
- 原有自动／显式保存语义不变。“保存全部”若只保存提示词配置，需明确标注范围，不能暗示全模块事务。
- 保存保持串行；失败不阻塞后续任务，成功只确认请求快照，不能覆盖请求期间产生的新编辑。

### 5.2 草稿与预设隔离

- 六个分类复用同一工作台状态所有者，不复制 store、保存队列或参数快照。
- 筛选或折叠不能静默丢失未提交数字、阶段草稿或错误，不能因重新挂载把已编辑值回填为默认值。
- 卡片身份按预设和领域实体稳定区分；若发现局部输入随筛选销毁，只修复对应状态归属，不引入第二套状态框架。
- 预设切换沿用现有切换与保存协调机制；旧预设异步响应不得覆盖新预设，写入仍校验目标预设。
- 保留加载、system 只读和生成关闭时对预设写入的保护；当前会话模型仍按宿主自身权限与选择契约操作，不能把会话选择误当成预设写入。

### 5.3 卡片操作

- 提示词配置保留启停、复制、删除、层内排序和批量操作；这些动作不修改能力模块声明或参数。
- 能力卡保留显式创建、已有配方和局部确认删除；删除声明后保留 dormant 参数，并沿用原重建与模块事实刷新链路。
- `modules: []` 保持空组合；残留参数、官方组合行或仅有默认值不能制造可编辑能力卡。
- 自定义工具继续一工具一卡，保持参数校验、审批和原保存方式；合并入口本身不创建或注册工具能力。
- 模板变量保持预设级资产语义；当前会话模型经官方选择通道更新，不与预设模型参数混成一次写入。

### 5.4 生命周期与按需加载

- 分类仅影响展示，不改监听事件、注册次数、插入位置、时机、消息受众、晋升、epoch 或 disposer。
- 工具预览保持独立只读入口，用户显式打开时才请求；主会话合并列表不触发预设工具预览或全预设扫描。
- 自定义工具数据沿用编辑面自身的加载与取消机制，不扩大成所有预设的启动预加载。
- 保留工作台 slot、打开／关闭、侧栏几何与公共 store 生命周期；不为本次列表重构改宿主接入。

## 6. 影响范围与非目标

### 必要修改范围

- 页面编排：`src/client/app/workspace/pages/MainSessionPage.tsx`。
- 列表编排：`src/client/features/prompts/PromptConfigsEditor.tsx`、`src/client/features/prompts/PromptConfigList.tsx`。
- 能力组合：`src/client/features/modules/EngineModuleList.tsx`。
- 旧双视图样式清理与必要分组布局：`src/client/features/prompts/prompts.module.css`，继续使用 CSS Modules 与宿主语义 token。
- 契约测试：优先扩展 `test/client/engine-module-cards.test.mjs`，按影响补充现有参数、草稿、保存与工具预览测试。
- 落地时同步 [UI 权威文档](docs/ui-architecture.md) 与 [框架 spec](.scratch/prompt-tool-framework/spec.md) 的布局、按需请求和验收描述；本次不同时改写 spec。

### 仅在验证证明需要时修改

- `src/shared/engine-capabilities.ts`：补充有实际用途的展示元数据，不建立新能力注册框架。
- `src/client/features/modules/EngineParamFields.tsx`：仅修复归一暴露的字段身份或未完成草稿丢失，不重写所有控件。
- `src/client/ui/EngineModuleCard.tsx`、`src/client/ui/controls.module.css`：仅处理复用卡片所需的局部布局，不造万能 Card。
- `src/client/features/tools/CustomToolsCard.tsx`：仅处理工具卡嵌入后的必要展示，不复制转换、注册和热装配逻辑。

### 不做

- 不重写引擎、参数桥、保存队列、host 工厂或预设生成器。
- 不改 DeepSeek Harness 源码、已安装官方包、slot 契约、profile 或 `cordis.patch.yml`。
- 不把能力参数转成 `promptConfigs`，不添加假的注入层、可拖动的运行顺序或全局能力开关。
- 不按实际 hook 拆分或排除 `anchor-turn` 等能力，不把六层扩成监听事件列表。
- 不新增能力、模板、后台 API、状态库、测试框架、通用配置注册器或可视化引擎。
- 不重做子代理、技能、角色管理和工具预览页面；只回归共享契约。
- 不处理无关历史问题，不重新执行旧计划的迁移与组合修复。

## 7. 实施阶段

代码实施尚未开始。阶段按依赖顺序推进；每阶段先形成可运行验收，再做最小修改，分别记录原有失败与本次引入的失败。

### 阶段一：分类与回归基线

- [x] 读取本计划引用的 UI、参数和引擎权威文档，复核目标文件、调用方与工作树。
- [x] 记录六个插入点、显式能力、空组合、system 预设和保存行为的基线。
- [x] 在现有 client 测试体系补充单列表与 `anchor-turn` 归入 `pre-step` 的验收，确认新要求能暴露当前双视图缺口。
- [x] 固定全部／单分类／空分类／世界书筛选预期；不从 hook 名推导分类。

退出条件：新验收准确指出待改行为，现有字段归属、能力存在性与保存测试提供可信基线。

### 阶段二：合并模块列表

- [x] 删除双视图状态、对应 props、互斥面板、切换控件及无消费者样式。
- [x] 保留一份插入点筛选，按行为分类组合提示词配置与能力卡。
- [x] 公共入口保留模型、变量和生成默认值；工具链区域展示自定义工具。
- [x] 复用现有卡片和列表组合接口；分组只增加实际调用方所需的最小能力，不复制六套保存逻辑。
- [x] 明确搜索、计数、批量操作、保存与空状态的对象。

退出条件：无需第二视图即可访问原有设置；`anchor-turn` 在 `pre-step` 卡内可配置，无重复字段或虚构能力。

### 阶段三：状态与兼容性回归

- [x] 验证筛选、折叠、未完成数字／阶段草稿及保存期间继续编辑，不因挂载变化丢值。
- [x] 验证预设切换、旧响应、保存失败、合法零值、空值回落、system 只读与生成关闭。
- [x] 验证提示词排序／批量动作与能力创建／删除互不污染；空组合和 dormant 参数不隐式启用能力。
- [x] 验证工具预览按需请求，以及主会话、子代理和共享组件的既有契约。
- [x] 仅在回归证明有缺口时调整局部状态或接口，不扩展后端设计。

退出条件：编辑入口合并后，各领域载荷、校验、草稿与运行行为仍符合原契约。

### 阶段四：验收与交付

- [ ] 完成第 8 节全部验收项和第 9 节完整验证命令；当前完整测试被 4 项既有组合／人设失败阻塞。
- [ ] 验证明暗主题、窄屏和键盘操作，保留截图及操作步骤；当前未运行 live DSH UI smoke，限制见交付说明。
- [x] 同步 UI 权威文档与框架 spec，不以文档更新替代运行证据。
- [x] 检查 diff、生成目录和工作树；只提交本次文件，已创建中文 Conventional Commit，推送 `origin/dev` 后记录 SHA。

退出条件：验收、代码和文档一致；剩余限制已披露，不把后续美化或其它功能并入本轮。

## 8. 可观察验收清单

以公开输入、渲染结果、用户操作和保存载荷验证行为；源码字符串删除、组件改名或模型措辞都不能代替行为断言。

| ID | 给定与操作 | 必须观察到的结果 |
|---|---|---|
| U-01 | 含提示词配置与显式能力的预设，打开主会话 | 单一模块列表可达两类设置，无通用／引擎能力切换；展开所属能力卡即可编辑 |
| U-02 | 依次筛选全部、六个插入点和空分类 | 对应两类卡片准确显示；六类始终可选，空分类不生成模块，全部视图无重复能力 |
| U-03 | 世界书筛选、提示词搜索、混合列表计数与空状态 | 世界书仍为策略筛选；搜索和计数范围明确，能力不当作提示词，也不因提示词为空宣称列表无模块 |
| U-04 | 装配 `anchor-turn`，筛选 `pre-step` 并展开 | 卡内可编辑锚定开关与文本；仍监听 `agent/inbox/inserted`，不为展示修改 hook 或移入公共区 |
| U-05 | 跨行为能力、空组合、仅有 dormant 参数和官方组合分别打开列表 | 显式能力只有一份可写字段；未装配能力不出现，不因参数或官方行制造能力卡 |
| U-06 | 排序、批量启停和保存提示词，再创建与确认删除能力 | 提示词操作不改能力声明／参数；能力仍走原链路，删除保留 dormant 参数，无重复注册 |
| U-07 | 编辑字段、数字和阶段草稿后筛选或折叠 | 未提交输入及错误不被静默丢弃，草稿不回退默认值，不创建第二份状态 |
| U-08 | 保存中继续编辑或按原流程切换预设，并使一个请求失败 | 保存串行，旧响应不覆盖新草稿或新预设；失败不阻塞后续保存，错误与 dirty 状态准确 |
| U-09 | 提交合法 `0`、`false`、空参数、空模板变量及非法数字 | 载荷、回落和校验沿用原契约；未改默认不固化，“保存提示词配置”文案不扩大实际保存范围 |
| U-10 | 在 system 预设、生成关闭或加载时尝试预设写入 | 原有禁写及 host 校验保持；会话模型选择与预设写入边界未混淆 |
| U-11 | 浏览／筛选模块列表，再显式打开工具预览 | 前者不触发预设工具预览或全预设扫描，后者才请求只读工具面；自定义工具沿用自身数据入口 |
| U-12 | 同一预设重构前后运行主会话、子代理、成功／失败压缩及释放／重挂 | 插入点、位置、时机、次数、受众和 epoch 断言一致；失败压缩不重置，成功压缩后重晋升，disposer 不残留重复实例 |
| U-13 | 明暗主题、窄屏、reduced-motion 与键盘操作 | 标签、说明、焦点、展开与确认删除仍可用；无悬空 ARIA 关联，不污染宿主样式 |
| U-14 | 在公共入口编辑模型、变量和生成默认值，并查看基础设置 | 公共配置不重复到六类，会话模型仍走官方通道，部署设置独立；公共区不是第七插入点 |

优先复用的测试：

- `test/client/engine-module-cards.test.mjs`：能力存在性、字段唯一归属、类型、只读和分类展示。
- `test/client/dirty-state.test.mjs`、`test/client/save-queue.test.mjs`、`test/client/param-overrides.test.mjs`、`test/client/prompt-tool-stages.test.mjs`：草稿、排队、参数和阶段。
- `test/client/prompt-config-order.test.mjs`、`test/client/tools-preview.test.mjs`、`test/client/custom-tool-editor.test.mjs`：提示词操作与工具编辑／预览边界。
- `test/client/feature-boundary.test.mjs`、`test/client/style-ownership.test.mjs`、`test/client/slot-workbench-contract.test.mjs`：依赖、样式和宿主生命周期。
- `test/shared/engine-param-schema.test.mjs`、`test/host/engine-capability.test.mjs`、`test/host/module-configs.test.mjs`：参数、模块与装配契约。
- 现有 `test/engine` 测试：主会话、子代理、晋升、压缩和 disposer；最终仍跑完整测试。

仅补充现有验收面无法覆盖的行为，不新建测试框架，不把每个内部函数都变成独立测试目标。

## 9. 验证环境与命令

所有 shell 使用 `D:\App\PowerShell\7\pwsh.exe`。测试和脚本从 `D:\AI\workspase\_temp` 执行，不以仓库为测试 cwd；文件系统测试使用独立临时目录与临时 `DSH_HOME`。

聚焦验证示例，按依赖需要先生成产物：

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo build
node --test "$Repo/test/client/engine-module-cards.test.mjs"
```

代码交付前完整验证：

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

逐条检查退出码；前一命令失败不能用后一命令成功掩盖。交付记录实际命令、退出码、结果与 UI 证据，不固定易变的测试数量。

本轮实际验证记录（2026-09-08）：`typecheck`、`lint`、`build` 通过；新增与受影响 client 契约通过；完整 `pnpm test` 为 609 项中 605 项通过，4 项失败集中于 `rebuild-composition` 的官方 persona 映射和 anchored persona 行为，未触及本轮 UI 文件。未将这 4 项失败包装为重构通过。

## 10. 风险、回退与交付边界

| 风险 | 控制方式 |
|---|---|
| 再次混淆行为分类与实现 hook | U-04 固定 `anchor-turn` 的 `pre-step` 归属，展示元数据不改接线 |
| 把混合列表当成一种配置模型 | 保留领域卡片和保存接口，计数／排序／批量操作明确对象 |
| 筛选重挂导致输入丢失 | 保留单一状态所有者与稳定实体身份，通过 U-07／U-08 验证交互而不只看静态渲染 |
| 多余请求或隐式装配 | 保留模块事实与工具预览按需加载，覆盖空组合和 dormant 参数 |
| 为统一外观过度抽象 | 复用现有列表、字段目录和卡片，只增加真实调用需要的接口 |

- 本次无存储格式变更和数据迁移。UI 回归通过修复提交或经确认的 revert 恢复展示，不覆盖用户预设或改写已有历史。
- 不停止、重启或终止运行中的 DSH，不抢占端口；必要 smoke 使用隔离 `DSH_HOME` 与随机端口。
- 不手工编辑或提交 `lib/`、`engine/compositions/library/`、`engine/vendor/yaml/`；只用既有 scripts 生成。
- 只提交本轮文件，中文 Conventional Commit 推送 `origin/dev`；不切换或推送 `main`，不创建 PR。
- 预期不需要 profile、bundle 或 patch 变更；若发现必须扩大边界，先说明原因及方案。需要服务重载时只标注“需要用户重启 DSH 服务后生效”，不代用户重启。
- 只有实施阶段完成、U-01 至 U-14 有证据、完整验证通过并同步文档，才能宣布重构完成。计划交付不代表功能交付。

</details>
