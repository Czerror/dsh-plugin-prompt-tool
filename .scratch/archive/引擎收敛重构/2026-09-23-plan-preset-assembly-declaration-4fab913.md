# PLAN：预设装配切换到 profile patch 声明行（B 方案）

## 需求与授权

- **用户指令（2026-09-23）**：「检查上游 dsh 官方 0.1.7 版本更新内容，本项目的预设管理适配出现配装 bug」→ 诊断报告后用户裁定：**「B方案」**，即跟随官方 0.1.7 架构，把预设改为 profile patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行。
- **起始基线**：`4fab913beb980f3706d424166aa4cc54b2b36f65`（工作树干净，除既有未跟踪文件）。
- **上游版本**：`D:\AI\GitHub\deepseek-harness` @ `00102833df` / tag `dsh-v0.1.7-alpha.2`；全局 `dsh --version` = `0.1.7-alpha.2`。
- **已确认取舍**：
  1. 预设改由 profile patch 声明，装配路径与官方一致；`$DSH_HOME/.agent-presets/<id>/` 目录保留为**正本**（编辑、导出、引擎资源仍在目录内）。
  2. 允许写入当前 profile 的 `cordis.patch.yml`（官方 `configEditor.documentPath` 即此文件，官方预设编辑器写的就是它）；不写 home 级 patch，不碰其他 profile。
  3. 升级后需用户重启 DSH 才生效的范围：本插件自身的 bundle 行；预设行的**新增/变更**走 `reconcileProfilePatches` 热重载，不需要重启。

## 审查结论

| # | 问题 | 位置 | 严重度 | 判定证据 |
|---|---|---|---|---|
| 1 | 预设注册整份被拒：`register()` 以调用方 ctx 的 `baseUrl` 建 Loader 树，插件把 baseUrl 改写成 `.agent-presets/<id>/agent.cordis.yml`，导致组合内**包名行**从预设目录起解析、向上无 node_modules → 行 `never started` → `mountPreset` 失败 | `src/host/preset-registry.ts:61`（`4fab913` 新增） | 阻断 | 真实实例经插件 `/tool-surface`：官方 4 预设与 `custom`、`pt-custom` 在册，`pt-standard`/`pt-cordis`/`pt-minimal`/`pt-ptc`/`liangshen`/`beta-2-42` 全部 `tool-surface-unknown-preset`；干净隔离实例复现同一模式；A/B 对照证实锚点差异 |
| 2 | `pt-custom` 之所以侥幸在册，是其组合仅含一条相对路径行，恰因锚点被改到预设目录才可解析——根因的反证 | 同上 | 中 | 隔离实例与真实实例一致 |
| 3 | 默认预设悬空：profile patch 的 `agent-preset-registry.config.selectedDefault: pt-standard` 指向未注册 id | 用户 `profiles/web/cordis.patch.yml:155-159` + `syncHostDefault` | 高 | `dsh --dump-config` 显示该值；`registry.policy()` 取 `selectedDefault ?? default`，`retain()` 对该 id 抛 `agent-preset/not-found` |
| 4 | 生成侧本地引用形态与 patch 装配不兼容：patch 行的模块说明符必须绝对化，`configsDir` 必须保持相对（引擎按 `import.meta.url` 自解析） | `src/host/write-preset.ts`、`engine/prompt-config-engine.mjs:78`、`engine/schema.mjs:109` | 高 | 原型实测：`configsDir` 写绝对路径报 `The URL must be of scheme file`；改为相对 + 模块 `name` 绝对化后 `pt-standard`/`pt-cordis` 均 `IN ROSTER`（25/26 工具） |

**B 方案可行性（原型已证）**：把预设转成 `- insert: [{id: preset-<id>, name: '@deepseek-ai/dsh-agent-preset', config: {id, name, order, plugins}}]` 写进隔离 profile 的 `cordis.patch.yml`，真实 dsh 启动后两个预设均正常装配，且含 `@deepseek-ai/dsh-plugin-manager/tools` 行的 `pt-cordis` 无 broken——patch 装配路径对 bare 包名有兜底，不需要额外守卫。

**官方实现复用点**（本次设计的依据，来自上游源码）：

- `packages/boot/config-editor/src/index.ts`：`configEditor` 服务，`documentPath = profileContext.patchPath`；`edit(entry, change)` 提供校验 → 文件锁 → YAML Document 保留注释 → `!!js` 还原 → 原子写 → 失败回滚 → `hmr.runExclusive` 串行化 → `reconcileProfilePatches` 热重载。
- `packages/boot/app-boot/src/index.ts:264`：`reconcileProfilePatches(ctx, patches, binName, requiredIds)` 是热重载入口。
- 官方注释（`packages/bundle/web-app/presets/standard.patch.yml`）：「Edits saved from the Web editor override this row's `config.plugins` by id from the profile patch」——即官方预期形态为 **insert 行 + 顶层覆盖行**。

## 影响面、依赖与护栏

**涉及模块**

| 模块 | 变更性质 |
|---|---|
| `src/host/preset-registry.ts` | 删除运行时注册（整份退场，含其测试） |
| `src/host/preset-declaration.ts` | 新增：目录 → patch 声明行（首插 / 对账 / 移除） |
| `src/index.ts` | 接线替换：`agentPresets` 注册 → `configEditor` + `profileContext` + 声明同步 |
| `src/host/write-preset.ts` | 生成侧规则：模块说明符绝对化（仅 `name` 以 `.` 开头的行） |
| `docs/architecture-params.md`、`README.md`、`CHANGELOG.md` | 行为变化同步 |

**任务依赖顺序**：T1 → T2 → T4 → T5；T3 与 T1 无依赖，可并行；T6 依赖 T1–T5；T7 依赖 T6；T8 依赖 T7。

**硬约束与禁止项**

- 只写 `profileContext.patchPath`（当前 profile 的 `cordis.patch.yml`）；**不写** home 级 patch、不写其他 profile、不写包内 system 预设目录。
- patch 编辑只触碰 `id` 以 `preset-` 开头且 `name` 为 `@deepseek-ai/dsh-agent-preset` 的行；其余行、注释、`!!js` 表达式逐字保留。
- 首插写盘复用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`；失败必须回滚到写前内容。
- `profileContext` 或 `configEditor` 缺失时（非 profile 宿主、单测）**降级**：不装配、不报错，仅保留目录正本；不改变既有 bridge 契约与写盘边界。
- 不新增 bridge 端点语义；`selectedDefault` 的写入沿用既有 `syncHostDefault` 通道。
- `lib/`、`engine/compositions/library/`、`engine/vendor/yaml/` 仍按脚本生成，不手工编辑。

## Wave 1：装配通道（预设改由 patch 行声明）

<task type="auto">
  <name>T1：新增预设声明模块（目录 → profile patch 行）</name>
  <files>src/host/preset-declaration.ts（新增）、src/host/manifest.ts（复用 `listPresets`/`loadPresetSpec`）、package.json（如新增依赖）</files>
  <action>实现三个纯函数 + 一个服务适配层：`declarationOf(root, id)` 从 `preset.yml` + `agent.cordis.yml` 生成声明 config（含 `plugins` 与绝对化后的模块说明符）；`upsertDeclarations(document, declarations)` 在 YAML Document 中按行 id 幂等插入/更新本插件管理的 insert 行；`removeDeclarations(document, ids)` 移除对应 insert 行与顶层覆盖行。写盘路径取自 `profileContext.patchPath`，用 `withFileLock` + `writeFileAtomic`，`!!js` 节点按官方 `config-editor` 的手法还原为 tag。</action>
  <verify>新增单测 `test/host/preset-declaration.test.mjs`：给定含用户行与注释的 patch，断言插入后用户行与注释逐字保留、二次调用幂等、删除只移除本插件行；`!!js` 表达式往返后语义不变（`isJsExpr` 可见）。预期全绿。</verify>
  <security>写盘面：路径必须来自 `profileContext.patchPath` 且限定当前 profile；拒绝任何越界 id；写前备份内容、失败回滚；不读不写 secrets。覆盖授权、白名单、版本冲突三类边界。</security>
  <done>模块通过单测，且在任何非 profile 环境（无 `profileContext`）下为纯只读降级。</done>
</task>

<task type="auto">
  <name>T2：宿主接线替换运行时注册</name>
  <files>src/index.ts、src/host/preset-registry.ts（删除）、test/host/preset-registry.test.mjs（删除）</files>
  <action>移除 `createPresetRegistrySync` 与其 `ctx.inject(['agentPresets'])` 接线，改为 `ctx.inject(['configEditor', 'profileContext'], …)`：启动与预设变更时把目录声明同步进 profile patch；已存在的行优先走官方 `configEditor.edit(entry, change)` 更新 `config.plugins`，首次出现走 T1 的 insert。保留 `registrySync` 语义等价物（`refreshPresets` 的调用点改为声明同步）。</action>
  <verify>`pnpm typecheck`、`pnpm lint` 通过；`pnpm test` 中预设相关用例全绿；隔离实例启动后 roster 出现 `pt-standard`。</verify>
  <security>不扩大 bridge 端点；不新增文件写入点（只经 T1 的受控通道）；保持 loopback 与请求体上限不变。</security>
  <done>插件不再调用 `agentPresets.register`，预设仅由 patch 行装配。</done>
</task>

<task type="auto">
  <name>T3：生成侧模块说明符绝对化</name>
  <files>src/host/write-preset.ts、engine/compositions/library/*（仅当快照生成脚本需要）、scripts/rebuild-composition.mjs（如需）</files>
  <action>渲染组合时，对 `name` 以 `.` 开头的行输出绝对 `file://` URL；`configsDir`/`strategyDir` 等由引擎按 `import.meta.url` 自解析的键**保持相对形态**，不绝对化。</action>
  <verify>新增/扩展单测断言：渲染产物中引擎行 `name` 为 `file://` 绝对 URL、`configsDir` 仍为 `../<id>/prompt-configs`；`pnpm --dir $Repo rebuild:composition` 无意外 diff。</verify>
  <security>不涉及外部输入；写入仍限定预设目录内。</security>
  <done>生成产物可直接用于 patch 声明且被引擎加载成功（T7 端到端复核）。</done>
</task>

## Wave 2：一致性、生命周期与清理

<task type="auto">
  <name>T4：启动对账（补缺失行 / 清理幽灵行）</name>
  <files>src/host/preset-declaration.ts、src/index.ts</files>
  <action>启动时按 `listPresets(DEFAULT_PRESET_DIR, { includeCompatibility: true })` 对账：目录存在而行缺失 → 插入；行存在而目录消失 → 移除该行（含顶层覆盖行）；`prompt-tool` 兼容快照同样纳入。对账失败只告警，不影响插件其余功能。</action>
  <verify>单测覆盖：只有行无目录 → 行被移除；只有目录无行 → 行被补；两者一致 → patch 字节不变（文件未被重写）。</verify>
  <security>只操作本插件 id 前缀的行；不触碰用户行；移除前确认该行确由本插件管理（`name` 与 id 前缀双条件）。</security>
  <done>目录与 patch 行集合恒等，且幂等。</done>
</task>

<task type="auto">
  <name>T5：预设增删改的生命周期同步</name>
  <files>src/index.ts、src/host/preset-install.ts、src/host/templates.ts、src/runtime/settings-bridge.ts（仅在需要触发同步处）</files>
  <action>把既有 `refreshPresets(ids)` 调用点（写盘、重建、导入、复制、删除、模板落地）接到声明同步：内容变化 → 更新行；目录删除 → 移除行；新建 → 插入行。写入后调用 `reconcileProfilePatches`（或经 `configEditor.edit` 隐含触发）使变更生效。</action>
  <verify>端到端：隔离实例中改一条预设参数 → 不重启即在新会话生效；删除预设目录 → roster 中消失。记录命令与结果。</verify>
  <security>删除动作不删除用户 patch 中的非本插件行；不清理用户目录或其他预设文件。</security>
  <done>增删改三条路径都不需重启 DSH，且 patch 中无残留。</done>
</task>

## Wave 3：回归、端到端验收与文档

<task type="auto">
  <name>T6：契约与回归测试补齐</name>
  <files>test/host/preset-declaration.test.mjs、test/host/preset-default-sync.test.mjs、test/host/write-preset.test.mjs、test/shared/bridge-contract.test.mjs（如契约无变化则不改）</files>
  <action>补齐：注释与用户行保留、幂等、`!!js` 往返、失败回滚、并发写锁、非 profile 降级、默认预设同步（`selectedDefault` 不再指向悬空 id）。</action>
  <verify>`pnpm test` 全绿（基线 1557 项 + 新增）。</verify>
  <security>覆盖写盘授权、上下文白名单、内容版本冲突、读取失败四类行为回归（AGENTS.md 要求）。</security>
  <done>新增用例在修复前为红、修复后为绿（对 T1/T3 的关键断言各留一条反例）。</done>
</task>

<task type="auto">
  <name>T7：真实宿主端到端验收</name>
  <files>仅 _temp 下的隔离环境与临时脚本（不入库）</files>
  <action>按已验证的原型方法搭隔离 DSH_HOME（profile 名 `web`，node_modules 放绝对 junction 指向本仓库），复制现场预设与 `.engine`，启动随机端口实例，断言：`standard`/`pt-standard`/`pt-cordis`/`pt-minimal`/`pt-ptc` 全部在 roster 且工具面与目录形态一致；改参数后热重载生效；删除预设后 roster 移除。**运行中的用户实例只做只读探测，不重启。**</action>
  <verify>记录每个预设的 HTTP 状态与工具数；对用户实例复测 `/tool-surface` 确认修复后不再 `unknown-preset`（需用户重启后生效）。</verify>
  <security>隔离 DSH_HOME 与随机端口；不启动第二个服务占用 3080；不碰用户 profile 以外的文件。</security>
  <done>验收记录含命令、状态码与工具数，全部预设 `IN ROSTER`。</done>
</task>

<task type="auto">
  <name>T8：文档、CHANGELOG 与交付</name>
  <files>docs/architecture-params.md、README.md、CHANGELOG.md、AGENTS.md（如边界表述需更新）</files>
  <action>更新「预设目录与装配」章节：说明预设由 profile patch 的声明行装配、目录为正本、生成侧的绝对化规则与热重载/重启边界。CHANGELOG 记 BREAKING（装配形态变化 + 需重启生效范围）。</action>
  <verify>`git -C $Repo diff --check`；文档中的路径、链接、命令逐条核对。</verify>
  <security>文档不得写入 secrets；不复制指令正文进配置。</security>
  <done>文档与实际行为一致，交付说明列出验证命令、提交 SHA 与推送分支。</done>
</task>

## 回滚与检查点

- **代码侧**：`git revert` 本轮提交即可恢复目录注册形态（`preset-registry.ts` 随 revert 回来）。
- **数据侧**：profile patch 中本插件插入的 `preset-*` 行需手动或经回滚版本移除；回滚前建议备份 `profiles/<name>/cordis.patch.yml`。恢复目录注册后，`pt-*` 会重新按旧路径注册（但旧路径在 0.1.7 下本就不工作，故数据侧回滚只用于保底）。
- **中断检查点**：T1 完成即可独立提交（新增模块 + 单测，不接线）；T2 接线后若 T7 未过，保持 T1 的提交并把接线回退。

## 状态

**已终止（2026-09-23，用户裁定）**：B 方案作废，本 PLAN 不再实施。

- 作废理由：预设经 profile patch 声明后，任何一次预设保存都要改写 profile patch，触发宿主 hmr 的**profile 级重载**（`hmr` 默认 watch `profileContext.patchPath` → `reconcileProfilePatches`），会打断工作台的 UI 实时编辑链路——违反本项目「UI 实时修改预设」准则。
- 已回退：`src/index.ts`、`src/host/preset-registry.ts`、`test/host/preset-registry.test.mjs` 恢复到基线 `4fab913`；新增的 `src/host/preset-declaration.ts`、`test/host/preset-declaration.test.mjs` 已删除；`lib/` 已重建；`pnpm typecheck` 与 `pnpm lint` 通过。
- **「审查结论」章节仍然有效**（0.1.7 预设装配缺陷与证据链），但修复路线改回 **A 方案**（不改写 `baseUrl` + 本地引用绝对化，装配继续走运行时注册，不引入 profile 级重载），待用户另行授权。
- 本 PLAN 未归档：本轮无代码改动、无提交，不满足「随代码改动同一提交归档」的条件，留在 `.scratch/plan/` 备查。

## 验收记录

（待实施后逐条填写：命令、结果、证据）

- 原型验证（2026-09-23，已完成）：隔离 home + 真实 dsh 1.0.0-alpha.2 → `pt-standard` IN ROSTER（25 工具）、`pt-cordis` IN ROSTER（26 工具）、官方 `standard` 25 工具。

## 实施取舍与已知边界

- 采用「首次 insert 由本插件写、后续更新走官方 `configEditor.edit`」的混合路径：patch 中会同时存在 insert 行与顶层覆盖行，这是官方预期形态（见 `standard.patch.yml` 注释），不视为冗余缺陷。
- 目录正本与 patch 行必须恒等，由 T4 对账保证；任一时刻不一致以目录为准。
- 明确的生效边界：插件自身的 bundle 行变化需重启；预设行的新增/变更走热重载。

## 测试现场与清理限制

- 隔离环境：`D:\AI\workspase\_temp\pt-b-home`、原型脚本 `D:\AI\workspase\_temp\pt-b-smoke\make-patch.cjs`（本轮原型用，实施完成后一并清理）。
- 用户实例 `127.0.0.1:3080` 仅做只读探测；未重启、未停止。
- 本轮曾误把诊断脚本写入仓库 `.scratch/`（违反测试 cwd 规则），文件已删；后续所有测试脚本一律落在 `_temp` 下执行。
