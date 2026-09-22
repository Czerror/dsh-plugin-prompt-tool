# PLAN：预设注册锚点修复（阶段 1）

## 需求与授权

- **用户指令（2026-09-23）**：先否掉 B 方案（profile patch 声明预设会导致每次保存预设都重载整个 profile，破坏工作台 UI 实时编辑准则），随后在对比三条路线后指示「**执行**」——即按建议推进**阶段 1**：保持运行时注册与目录正本，只修掉锚点缺陷。
- **起始基线**：`4fab913beb980f3706d424166aa4cc54b2b36f65`（工作树已回退至该基线，`git diff --stat` 为空）。
- **上游版本**：`D:\AI\GitHub\deepseek-harness` @ `00102833df` / `dsh-v0.1.7-alpha.2`；全局 `dsh` = `0.1.7-alpha.2`。
- **本轮不做**：引擎行改包名说明符 + 退场 `.engine` 物化（阶段 2，官方方向优化项）；`configsDir` 基准改造；profile patch 声明路线（已终止）。

## 审查结论

问题清单与证据见已终止的 [`2026-09-23-plan-preset-assembly-declaration-4fab913.md`](2026-09-23-plan-preset-assembly-declaration-4fab913.md) 的「审查结论」章节，其结论不受方案作废影响：

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | `register()` 以调用方 ctx 的 `baseUrl` 建 Loader 树，插件把 baseUrl 改写成 `.agent-presets/<id>/agent.cordis.yml` → 组合内**包名行**从预设目录起解析、向上无 node_modules → 行 `never started` → `mountPreset` 失败 → **整份预设注册被拒** | `src/host/preset-registry.ts:61` | 阻断 |
| 2 | 默认预设悬空：profile patch 的 `selectedDefault: pt-standard` 指向未注册 id，新会话装配抛 `agent-preset/not-found` | 用户 `profiles/web/cordis.patch.yml:155-159` | 高 |

**修复原理（已查证）**：`vendor/loader/lib/types/config/tree.js:112-131` —— 相对说明符按 `ctx.baseUrl` 解析、包名说明符走 `ctx.baseUrl` 的 node_modules 链。因此**不改写 baseUrl**即恢复包名行解析；代价是预设目录内的**相对说明符**（引擎行 `../.engine/*.mjs`）会改按宿主锚点解析，需在**装配期**换算成绝对 file URL。

**官方立场（已查证）**：`packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md:80`「Resolve assets from installed packages rather than a preset directory」「Keep `!!js` expressions only in plugin configuration or `disabled`」——本轮换算方式与官方方向一致，`!!js` 不用于行 `name`（`config/entry.js:203` 亦证明 name 不插值）。

## 影响面、依赖与护栏

| 模块 | 变更 |
|---|---|
| `src/host/preset-registry.ts` | 停止改写 `baseUrl`；新增装配期「本地模块说明符绝对化」换算 |
| `test/host/preset-registry.test.mjs` | 断言改为「包名行在宿主锚点下解析成功 + 相对行被绝对化 + configsDir 不被改写」 |
| `docs/architecture-params.md` | 补锚点语义与换算规则 |
| `CHANGELOG.md` | 记修复条目 |

**硬约束**

- 换算**只在内存**（构造 `PresetDefinition.plugins` 时），**不得写回** `agent.cordis.yml`：目录正本必须保持相对形态，否则用户改 `DSH_HOME` 或复制整个预设根后引用悬空。
- 只换算 `name` 以 `.` 开头的行；`configsDir` / `strategyDir` / `policyFile` / `triggersFile` 等由引擎按 `import.meta.url` 自解析的键一律不动（引擎仍在 `<预设根>/.engine/`，相对形态继续成立）。
- 递归覆盖 `cordis:group` 的嵌套子行；跳过 `!!js` 表达式节点。
- 不触碰 profile patch、不引入 profile 级重载、不改 bridge 契约与写盘边界。
- 运行中的 DSH 实例只做只读探测；隔离验证使用独立 `DSH_HOME` + 随机端口。

## Wave 1：注册锚点与装配期换算

<task type="auto">
  <name>T1：停止改写 baseUrl，改为装配期换算本地模块说明符</name>
  <files>src/host/preset-registry.ts</files>
  <action>`readDefinition` 中新增 `absolutizeLocalModules(rows, presetDir)`：递归遍历组合行，把 `name` 以 `.` 开头的字符串换成 `pathToFileURL(resolve(presetDir, name)).href`，递归进入 `cordis:group` 的 `config` 子行数组，跳过 `{__jsExpr}` 节点；`plugins` 改用换算结果。注册处 `ctx.extend({ baseUrl: … }).agentPresets` 改回 `ctx.agentPresets`，使 Loader 树继承宿主锚点。</action>
  <verify>`pnpm typecheck`、`pnpm lint` 通过；`test/host/preset-registry.test.mjs` 断言：包名行（`@deepseek-ai/dsh-persona` 类）在宿主锚点下可解析、`../.engine/x.mjs` 被换成 file URL、`configsDir` 保持 `../<id>/prompt-configs` 原样、嵌套 group 子行同样被换算。</verify>
  <security>不新增写盘点；路径换算只读目录、不写回正本；换算基准固定为预设目录，拒绝越界 id（沿用既有 `assertPresetDirectory`/manifest 校验）。</security>
  <done>运行时注册不再依赖 baseUrl 改写，且相对引擎行仍能装配。</done>
</task>

<task type="auto">
  <name>T2：注册契约测试补强</name>
  <files>test/host/preset-registry.test.mjs</files>
  <action>保留既有「候选失败不替换旧注册 / 刷新与释放保留 revision / 排队期间卸载」用例；新增或改写用例覆盖 T1 的换算规则与「相对行不再依赖 baseUrl 改写」。</action>
  <verify>`pnpm --dir $Repo test test/host/preset-registry.test.mjs` 全绿。</verify>
  <security>沿用隔离临时目录与临时 `DSH_HOME`，结束后清理。</security>
  <done>换算规则的每条分支都有确定性断言（含反例：未换算的相对行在宿主锚点下会失败）。</done>
</task>

## Wave 2：端到端验收与文档

<task type="auto">
  <name>T3：真实宿主端到端验收（隔离环境）</name>
  <files>仅 `_temp` 下隔离环境与临时脚本（不入库）</files>
  <action>搭隔离 `DSH_HOME`（profile 名 `web`，node_modules 以绝对 junction 指向本仓库），复制现场 `pt-standard`/`pt-cordis`/`pt-minimal`/`pt-ptc` 与 `.engine`，启动随机端口实例，逐个断言 roster。</action>
  <verify>每个预设 `IN ROSTER` 且工具数与目录形态一致；记录 HTTP 状态与工具数。</verify>
  <security>隔离 home + 随机端口；不重启、不占用用户 3080；不写用户 profile。</security>
  <done>四个 `pt-*` 预设全部在册，验收记录含命令与结果。</done>
</task>

<task type="auto">
  <name>T4：文档与 CHANGELOG</name>
  <files>docs/architecture-params.md、CHANGELOG.md</files>
  <action>在预设装配段落补：注册锚点为宿主锚点、本地模块说明符在装配期换算为绝对 file URL、目录正本保持相对因而不受 `DSH_HOME` 迁移影响；CHANGELOG 记本轮修复。</action>
  <verify>`git -C $Repo diff --check`；文档路径与命令核对。</verify>
  <security>不写入 secrets；不复制指令正文进配置。</security>
  <done>文档与实际行为一致。</done>
</task>

## 回滚与检查点

- 代码侧：`git revert` 本轮提交即回到 `4fab913` 行为（重新改写 baseUrl，0.1.7 下预设仍不可用但不引入新状态）。
- 数据侧：本轮**不写任何用户数据**（换算只在内存），无数据回滚需求。
- 中断检查点：T1+T2 完成即可提交；T3 未过则不提交并回到 T1 复核。

## 状态

- [✔] Wave 1：注册锚点与装配期换算（T1 / T2）
- [✔] Wave 2：端到端验收与文档（T3 / T4）

## 验收记录

**T1 / T2（单元与契约）**

- `pnpm typecheck` → 通过（`tsc -p tsconfig.json` 与 `tsconfig.client.json` 均无错误）。
- `pnpm lint` → `Found 0 warnings and 0 errors`。
- `pnpm --dir $Repo test test/host/preset-registry.test.mjs` → **5/5 通过**，含新增用例「装配期换算：相对说明符绝对化，configsDir 与 !!js 保持原样」（断言：相对行换成绝对 file URL、`configsDir` 保持 `../gamma/prompt-configs`、`!!js` 保持延迟节点、group 子行同样换算、包名行不改写、正本不回写绝对路径）与反例「未换算的相对行必须在宿主锚点下失败」。
- `test/host/preset-default-sync.test.mjs` → 7/7 通过。首轮全量跑时该项 1 例失败，原因是该测试的假 ctx 只提供 `extend` 而无 `agentPresets` 属性（实现不再改写 baseUrl）；按真实 cordis ctx 语义补上同名属性后通过——属测试脚手架与新契约对齐，非行为回归。

**T3（真实宿主端到端）**

- 隔离环境 `D:\AI\workspase\_temp\pt-anchor-smoke`（隔离 `DSH_HOME`、profile 名 `web`、`node_modules` 以绝对 junction 指向本仓库、复制现场 `.engine` 与四个 `pt-*` 预设），随机端口实例 `http://127.0.0.1:52370`。
- 经插件自身 `/api/prompt-tool/settings/tool-surface`（`presetId` 逐个探测）结果：

| 预设 | 状态 | 工具数 |
|---|---|---|
| `standard`（官方） | IN ROSTER | 25 |
| `pt-standard` | IN ROSTER | 25 |
| `pt-cordis` | IN ROSTER | 26 |
| `pt-ptc` | IN ROSTER | 25 |
| `pt-minimal` | IN ROSTER | 1 |

- `pt-minimal` 的 `tools=1` 曾作为不明确项查证：官方 `minimal` 在同一实例下同为 `tools=1` 且工具名一致（仅 `pwsh`），与官方源码 `packages/bundle/web-app/presets/minimal.patch.yml` 的行集合（`persona` + `persistent-shell` 组，`tool-bash` 系行在 win32 关闭）吻合——是预期形态，不是装配缺失。

**全量**

- `pnpm test` → **1558/1558 通过**（首个失败轮为 1557/1558，修正 harness 后复跑全绿）。
- `git diff --check` → 无空白问题。

## 实施取舍与已知边界

- 阶段 2（引擎改包名说明符 + 退场 `.engine` 物化 + `configsDir` 基准改造）不在本轮，理由：需要 exports 设计、现场一次性迁移与 7 个测试文件适配，应与本次缺陷修复分离评审。
- 上游已把「目录形态用户预设」判为遗留（`SKILL.md:70`「Nothing reads that directory any more」，迁移后删除目录）；本项目保留目录正本 + UI 实时编辑属**自主背离**，本轮在文档中明确记录该差异。
- 换算后注册定义内含本机绝对路径，仅存在于内存与 Loader 树中，不落盘。

## 测试现场与清理限制

- 隔离环境放在 `D:\AI\workspase\_temp\` 下，验证后清理；测试 cwd 一律设在 `_temp`。
- 用户实例 `127.0.0.1:3080` 仅只读探测；其 `selectedDefault: pt-standard` 需待用户重启后生效，本轮不改用户 profile。
