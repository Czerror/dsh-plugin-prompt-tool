# PLAN：引擎默认值下沉到模板/预设

## 需求与授权

- 日期：2026-09-22
- 起始基线：`d8f63ee`（dev）
- 用户原话：检查各引擎能力是否存在默认参数（深度节拍器、we 引导）→ 勾选「移除 we 字面兜底」，补充原则「默认值 应该写在模板 或者预设中,不应该内置引擎中」→ 范围拍板选定「全部下沉 + 开关默认改为关」。
- 本轮范围：把 `engine/*.mjs` 内的一切可配置默认值（引导正文、节奏阈值、机制名与模板、白名单）下沉到组合源（`engine/compositions/source/local/*.yml`，即预设装配来源）；引擎侧只保留「必填校验 + 安全边界常量」；所有模块开关（`enabled`）语义改为「未声明 = 关闭」。

## 审查结论

巡检结论（只读核对：组合源默认 → 引擎内 fallback → UI 草稿默认 → 参数桥隐式装配 → 真实部署现状）：

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 1 | `engine/strategies.mjs:88` | `custom-fallback` 锚定确认词空值兜底 `'we'`（字面量，非配置） | 中 |
| 2 | `src/host/write-preset.ts:503` | 物化 `prompt-injector` 时 `firstTurnWord` 兜底 `'we'`；且 `injectPrompt` 草稿默认 `true` | 中 |
| 3 | `engine/deliberation-gate.mjs:29,32-36,56-57` | `DEFAULT_MIN_CHARS=400`、`GATE_TEXT`（含 `start with "We"`）、`maxGatesPerTurn` 默认 1 全部内置引擎 | 中 |
| 4 | `engine/progress-reminder.mjs:26-28,45-46` | `DRIP_TEXT`（含 `"We …"`）、`every=4`、`maxPerTurn=1` 内置引擎 | 中 |
| 5 | `engine/anchor-turn.mjs:29` | `ANCHOR_TEXT` 内置引擎 | 低 |
| 6 | `engine/compaction-epoch.mjs:65-66` | `maxPromoteSteps` 默认 4 内置引擎 | 低 |
| 7 | `engine/tool-bootstrap.mjs:208-221` | `stagePreUnlock=1`、`stageAdvanceTool='phase_advance'`、`stageAdvanceDescription` 长文本、`stageSectionTemplate` 默认模板内置引擎 | 中 |
| 8 | `engine/run-code-env.mjs:33-66` | `DEFAULT_ENV_KEYS` 白名单内置引擎（`SENSITIVE_ENV_RE` 除外，属安全边界） | 低 |
| 9 | `engine/tool-git-bash.mjs:54-55,127-128` | `DEFAULT_TIMEOUT_MS=120000`、`DEFAULT_MAX_OUTPUT_BYTES=64000` 内置引擎 | 低 |
| 10 | 6 个模块的 `if (source.enabled === false) return` | 「未声明 = 开启」的隐式默认：`anchor-turn` `deliberation-gate` `progress-reminder` `tool-filter` `run-code-env`；`context-gate` 更直接默认 `true`（`context-gate.mjs:140`） | 高 |
| 11 | `engine/tool-bootstrap.mjs` | 无 `enabled` 开关：挂载即窄化工具面 | 中 |

对照事实：真实部署 `D:\AI\DeepSeek harness\.dsh` 的 5 个预设（pt-cordis/pt-standard/pt-minimal/pt-ptc/pt-custom）均未挂载以上任一增强能力，`promptConfigs: []`，`settings.yaml` 无参数覆盖 → 本轮改动不影响正在运行的会话面。

## 影响面、依赖与护栏

- 涉及模块：`engine/`（8 个 .mjs）、`engine/compositions/source/local/`（6 个 .yml，需 `pnpm rebuild:composition` 同步 `library/`）、`src/host/write-preset.ts`、`templates/`、`docs/engine-reuse.md`、`test/engine|host|shared`。
- 调用链：组合源 yml →（`rebuild:composition`）→ `library/` → 预设装配行 → 引擎 `apply(ctx, config)`；参数桥（`ENGINE_PARAM_DEFINITIONS.module` 绑定）在 `moduleConfigs` 之上覆盖。
- 硬约束：
  - 引擎只做「必填 + 形状」校验，缺键 fail loud（`TypeError`），不再静默兜底；
  - 安全边界常量不下沉：`run-code-env.SENSITIVE_ENV_RE`、`tool-config-engine.ENV_ALLOWLIST`、loopback/白名单类校验；
  - 官方扩展点语义缺省不下沉（`layers.mjs` 的 `?? 'pass'` / `?? 'accept'` / `?? 'allow'`，`schema.mjs` 的 `position after-user` / `dedupe none` / `promotion none` / `modelScope all` / `role user` / `mergeMode separate` / `order 0`）——这些是官方层契约而非可配置默认值；
  - `src/shared/engine-params.ts#ENGINE_PARAM_DEFINITIONS.defaultValue` 是 UI 编辑草稿初值（注释已声明「不等于强制写入运行时默认值」），不下沉；
  - 参数桥的 `0` 语义（取消阈值）与 `''`（删键回落）保持既有行为不变。
- 依赖顺序：Wave 1（we 兜底）与 Wave 2（文本/阈值）改同一批 .mjs，串行；Wave 3 改 `enabled` 语义并补组合源，须在 Wave 2 之后（同文件）。

## Wave 1：移除 we 字面兜底

<task type="auto">
  <name>T1：custom-fallback 确认词去掉 'we' 兜底</name>
  <files>engine/strategies.mjs</files>
  <action>删除 `firstTurnWord` 的 `: 'we'` 兜底，改为空字符串；`anchorWords` 仅在显式提供时使用，缺省为空数组。</action>
  <verify>`node --test test/engine/prompt-config-engine.test.mjs`；空确认词时 `createAnchorMatcher({keys: [], mode:'prefix'})` 恒 `active:false`（engine/anchor-match.mjs:113），配置走「未命中兜底注入」分支。</verify>
  <security>不涉及，原因：纯文本匹配默认值，无外部输入与写盘。</security>
  <done>引擎内不再出现字面 'we'；空值行为有测试断言。</done>
</task>

<task type="auto">
  <name>T2：prompt-injector 物化不再造 'we'</name>
  <files>src/host/write-preset.ts, templates/16-custom-fallback.yml, preset.yml</files>
  <action>把 `firstTurnWord: explicitWord.length > 0 ? explicitWord : (anchorWords[0] ?? 'we')` 改为无兜底（派生为空则不写该键）；同步模板注释。</action>
  <verify>`node --test test/host/write-preset.test.mjs test/host/preset-prompt-configs.test.mjs`。</verify>
  <security>不涉及，原因：只改生成目录内 YAML 取值，不触授权与路径。</security>
  <done>未提供确认词时生成的 `prompt-injector` 不含 `we`。</done>
</task>

## Wave 2：引导正文与阈值下沉到组合源

<task type="auto">
  <name>T3：三段引导正文下沉</name>
  <files>engine/anchor-turn.mjs, engine/deliberation-gate.mjs, engine/progress-reminder.mjs, engine/compositions/source/local/{anchor-turn,deliberation-gate,progress-reminder}.yml</files>
  <action>`ANCHOR_TEXT`/`GATE_TEXT`/`DRIP_TEXT` 正文搬进对应组合源 yml 的 `config.text` / `config.gateText`；引擎删除导出常量，`text`/`gateText` 缺失即 `TypeError`。</action>
  <verify>`node --test test/engine/injection-gates.test.mjs`（断言改为读组合源取值）。</verify>
  <security>不涉及，原因：注入文本仍走既有 pre-step / tools 通道，无新增输入面。</security>
  <done>引擎文件内不再含引导措辞；组合源持有正文。</done>
</task>

<task type="auto">
  <name>T4：阈值与机制名下沉</name>
  <files>engine/deliberation-gate.mjs, engine/progress-reminder.mjs, engine/compaction-epoch.mjs, engine/tool-bootstrap.mjs, engine/run-code-env.mjs, engine/tool-git-bash.mjs, 对应组合源 yml</files>
  <action>`minChars`/`maxGatesPerTurn`/`every`/`maxPerTurn`/`maxPromoteSteps`/`stagePreUnlock`/`stageAdvanceTool`/`stageAdvanceDescription`/`stageSectionTemplate`/`envKeys`/`timeoutMs`/`maxOutputBytes` 全部改为组合源提供、引擎必填校验；`turn-stop` 之外不再有静默兜底。</action>
  <verify>`node --test test/engine/promotion-gate.test.mjs test/host/engine-params-bridge.test.mjs test/shared/engine-param-schema.test.mjs`。</verify>
  <security>`run-code-env` 的 `SENSITIVE_ENV_RE` 与 `tool-config-engine` 的 `ENV_ALLOWLIST` 保持引擎内硬约束不下沉。</security>
  <done>引擎内无可配置默认值；缺键 fail loud 有测试覆盖。</done>
</task>

## Wave 3：开关语义改为「未声明 = 关闭」

<task type="auto">
  <name>T5：enabled 语义反转 + 组合源补齐</name>
  <files>engine/{anchor-turn,deliberation-gate,progress-reminder,tool-filter,run-code-env,context-gate,tool-bootstrap}.mjs, engine/compositions/source/local/*.yml（对应 6 个）</files>
  <action>`if (source.enabled === false) return` 改为 `if (source.enabled !== true) return`；`context-gate` 去掉 `fallback=true`；`tool-bootstrap` 新增 `enabled` 开关。组合源为需要保持既有行为的模块显式写 `enabled: true`（`context-gate`、`tool-bootstrap`、`run-code-env`），关闭类保持 `false`。</action>
  <verify>`node --test test/engine/`；装配集成断言：声明 context-gate / tool-bootstrap 的预设行为与改动前一致。</verify>
  <security>不涉及，原因：开关只控制模块是否注册监听器，不触权限与写盘。</security>
  <done>未声明 enabled 的模块一律不生效；既有组合行为无回归。</done>
</task>

## Wave 4：同步与验证

<task type="auto">
  <name>T6：测试、文档、快照同步</name>
  <files>test/**, docs/engine-reuse.md, engine/compositions/library/**</files>
  <action>更新受影响的断言；`docs/engine-reuse.md` 的默认值表改为「组合源提供」；`pnpm rebuild:composition` 重新生成分发快照。</action>
  <verify>`pnpm typecheck && pnpm lint && pnpm test && pnpm build && git diff --check`。</verify>
  <security>不涉及，原因：仅文档与生成物同步。</security>
  <done>全量门禁通过，快照与源一致。</done>
</task>

## 回滚与检查点

- 代码侧回滚：`git revert <本轮提交>`。
- 数据侧：本轮不改用户预设与 `DSH_HOME` 状态；生成目录由 `pnpm rematerialize:presets` 重建。
- 中断检查点：Wave 边界即检查点，每个 Wave 结束跑一次对应测试文件，未通过不进下一 Wave。

## 状态

- [✔] Wave 1（T1、T2）
- [✔] Wave 2（T3、T4）
- [✔] Wave 3（T5）
- [✔] Wave 4（T6）
- [✔] 归档与推送

## 验收记录

- `node scripts/run-tests.mjs`（隔离 cwd，含构建）：**1286 tests / 1286 pass / 0 fail**。
- `pnpm typecheck`：通过（`tsconfig.json` + `tsconfig.client.json`，无输出即成功）。
- `pnpm lint`：`Found 0 warnings and 0 errors`（279 files）。
- `pnpm build`：`Build complete`（10 files，907.63 kB）。
- `pnpm rebuild:preset-template`：`preset.yml: 71 个共享参数，9 层，15 条默认关闭的规则示例`；模板契约测试由红转绿。
- `git diff --check`：无空白错误。
- `engine/compositions/library/` 无需重建：脚本注释明确「本地模块以 `source/local/*.yml` 为唯一源，不复制到 `library/`」，组合库测试保持绿。
- 新增回归保护：`test/fixtures/composition-defaults.mjs` 让测试按组合源取默认（把默认值搬回引擎会让这些测试立刻变红）；`injection-gates.test.mjs` 新增「未声明 `enabled` 即关闭 / 缺必填键 fail loud / 显式空文本不注册」三组断言；`preset-engine-modules.test.mjs` 的 `normalizeEnvKeys` 断言改为「缺省/空数组 fail loud」。

## 实施取舍与已知边界

- 组合源 `engine/compositions/source/local/*.yml` 视为「模板/预设」下的默认值归属地（它是预设装配行的来源；`library/` 只放官方切出的行与官方变体）。
- **T5 撤销了 tool-bootstrap 的 `enabled` 新增**：参数桥契约要求引擎公开键可被 UI 覆盖（`test/shared/engine-param-schema.test.mjs`、`test/host/engine-params-bridge.test.mjs` 的 `ALLOWED_KEYS ⊆ 参数绑定` 断言），而 tool-bootstrap 原本就没有三态开关（它唯一的关闭方式是从 `modules` 移除），新增属于本轮扩大范围。它保持「挂载即生效」，与官方模块同类。
- 官方扩展点语义缺省、UI 编辑草稿初值（`ENGINE_PARAM_DEFINITIONS.defaultValue`）、安全边界常量三类不下沉，理由见「影响面、依赖与护栏」。
- 安全护栏保留在引擎内：`run-code-env.SENSITIVE_ENV_RE`、`tool-config-engine.ENV_ALLOWLIST` 与 http 执行器 `timeoutMs ?? 15000`（防挂死）。
- placeholder 只下沉 `envKeys` 与 `emptyText`；`limit` / `fields` / `emptyBehavior` 保留为策略形状缺省（模板已给真实值）。`instruction-hint.scope` 属内部选项，不下沉。
- 行为变化需重启 DSH 服务后生效（引擎与组合属装配期读取）；本轮未改动任何用户预设与 `DSH_HOME` 状态。
