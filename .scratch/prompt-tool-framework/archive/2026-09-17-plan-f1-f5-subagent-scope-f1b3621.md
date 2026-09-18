# 移除 dsh-anchored-standard 预设、保留引擎移植 与 上游引擎核查

- 编写日期：2026-09-17（UTC+8）。
- 状态：方案已编写；用户已批准范围与默认模板选择，本轮直接执行代码、测试与文档改动。
- 固定实现基线：`dev@0af985a`（ST 转译完整性 R7–R14 交付后的提交）。
- 来源：用户指令——「dsh-anchored-standard 预设已经过时不再适用，可以移除；同时查询上游是否有引擎更新，保持只移植引擎，移除预设」。
- 本轮范围：**下线上游预设与其全部引用通道 + 默认模板迁移到 `standard`**；引擎移植（`engine/` 与其本地组合模块）全部保留，不做行为回退。

## 1. 上游引擎核查（只读，已完成）

### 1.1 核查方法

- 克隆上游 `https://github.com/xiaobright/dsh-anchored-standard.git`（`--depth 100`）到 `D:\AI\workspase\dsh-anchored-standard-upstream`（隔离目录，不写仓库）。
- 对照本地内联快照 `upstream/dsh-anchored-standard/REVISION`、本地 `engine/` 移植文件与上游 `shared/` 引擎源码。

### 1.2 核查结论：无待移植的上游引擎更新

| 事实 | 证据 |
|---|---|
| 上游已正式冻结 | `FAREWELL.md` 附记（2026-09-10）：不接受 issue、不接受 PR、无维护动作；HEAD 提交 `dda23ef docs: freeze the project — V4 Pro retires 2026-09-14` |
| 本地快照即上游 HEAD | 工作树 `upstream/dsh-anchored-standard/REVISION` = `dda23ef119e3715f417d73f72eca407732846d1a`（已由既有 `pnpm sync:anchored` 刷新，未提交） |
| 上游最后一批引擎修复已在本地覆盖 | `751fd67`（`session.snapshotEvents()` 兼容）：本地 `engine/shared.mjs#snapshotEvents()` 统一读取正式 API，`test/host-contract.test.mjs` 断言引擎源文件不得出现 `session.events`；`78b4cbd` / `babc933`（Git Bash 路径运行时推断 + Windows workdir 归一）：本地 `engine/tool-git-bash.mjs` 已实现候选探测链与 `normalizeGitBashWorkdir`；`b74543b` / `e3d330b`（instruction-hint 幂等 id 与建议式措辞）：本地 `engine/instruction-hint.mjs` 为独立实现 |
| 本地移植普遍为超集 | `tool-bootstrap.mjs` 24558 B vs 上游 14882 B、`context-gate.mjs` 13424 B vs 9724 B、`compaction-epoch.mjs` 6866 B vs 3535 B；仅 `skill-search.mjs` 与上游逐字一致 |

### 1.3 结论对后续动作的含义

- 不新增引擎移植任务；本轮不动 `engine/`、`engine/compositions/`（除文档措辞外）。
- 上游快照与同步脚本失去引擎比对价值（上游冻结、且快照只复制 `preset/` 而不含 `shared/` 引擎源码），按用户决策一并删除。

## 2. 用户决策与范围

| 决策点 | 用户选择 |
|---|---|
| 移除范围 | **预设 + 上游快照 + 同步脚本全删**：`preset/anchored/`、`upstream/dsh-anchored-standard/`、`scripts/sync-anchored.mjs` 与 `package.json#scripts.sync:anchored` |
| 引擎移植 | 全部保留（`engine/` 与 `engine/compositions/source/local/` 中的 anchor-turn / deliberation-gate / progress-reminder / context-gate / tool-bootstrap / promoted-code-mode / tool-git-bash 等） |
| 默认模板 | `presetTemplate` 默认值由 `anchored` 改为 **`standard`**（官方功能完整基型） |
| 保留项（不属于上游预设语义） | `src/client/ui/anchored-popover*.ts`（弹层锚点定位几何）、`hasAnchoredReasoning` / `matchesAnchorWord`（锚定推理轨迹语义）、`near-anchor` 配置 id——全部保留，不改名 |

## 3. 影响面与迁移设计

### 3.1 删除清单

| 路径 | 说明 |
|---|---|
| `preset/anchored/` | 内置 Anchored 预设（模板与内容资产） |
| `upstream/dsh-anchored-standard/` | 内联快照（`preset/*` 引擎副本、`LICENSE`、`NOTICE`、`REVISION`） |
| `scripts/sync-anchored.mjs` | 快照刷新脚本 |
| `package.json#scripts["sync:anchored"]` | 脚本入口 |
| `src/preset-core.ts#buildCordis` 与 `ANCHORED_TEMPLATE_DIR` | 硬编码读取 `../preset/anchored/` 的兼容层渲染函数；无生产调用者（`src/` 内零引用），仅测试消费 |

### 3.2 默认模板迁移（`'anchored'` → `'standard'`）

| 文件 | 位置 | 处理 |
|---|---|---|
| `src/config.ts` | 15 行注释、27 行 `Config` 默认、112 行 `PromptSettingsSchema` 默认 | 改 `standard`，注释改为「默认 standard」 |
| `src/index.ts` | 114、116、274、806 行回退字面量；579、789 行运行时默认 | 改 `standard` |
| `src/host/write-preset.ts` | 92 行注释、260 行回退 | 改 `standard` |
| `src/host/manifest.ts` | 10 行注释、177 行 `loadPresetContent` 默认参数 | 改 `standard` |
| `src/runtime/settings-bridge.ts` | 638、1840 行 `basename` / id 回退 | 改 `standard` |
| `src/client/data/prompt-tool-fields.ts` | 98 行默认字段值 | 改 `standard` |
| `src/client/data/prompt-tool-view.ts` | 110 行视图回退 | 改 `standard` |
| `src/client/locales.ts` | 299 行 `settings.writePreset.label` | 文案去 anchored 化（`Materialize prompt-tool injection presets`） |

### 3.3 兼容层导出面收敛

- `src/preset-core.ts` 保留：`loadPresetSpec` / `renderComposition` / `loadPromptConfigFiles` / `mergePromptConfigs` / `renderPromptConfigYaml` / 类型再导出。
- 删除：`buildCordis()`、`ANCHORED_TEMPLATE_DIR`、`assertCompositionArray` 的 anchored 专用校验（仅 `buildCordis` 使用）。
- `tsdown.config.ts` 的 `src/preset-core.ts` 入口保留（其余导出仍被测试与文档消费）。

### 3.4 文档与模板

| 文件 | 处理 |
|---|---|
| `preset.yml`（根模板） | 7、31 行「完整示例见 preset/anchored」改指内置预设（`preset/standard` 与 `preset/custom`）；105 行段标题与注释改为「引擎可选模块（opt-in）」；500–505 行 `upstream:` 段整段删除 |
| `templates/14-first-turn-anchor.yml`、`templates/15-guide-auto.yml` | 注释中的「见 anchored 预设 params」改为「见内置预设 params / 引擎默认」 |
| `README.md` | 5、7、47、59、227、240 行：去掉「内置 anchored 默认预设」「上游策略来源」表述，改为「引擎级锚定/门控能力，预设按需装配」与「引擎移植自 dsh-anchored-standard（MIT）」；删除 `pnpm sync:anchored` 行 |
| `NOTE.md` | 15 行预设清单去掉 `preset/anchored` |
| `docs/engine-reuse.md` | 17 行「如内置 Anchored」改为中性表述（本地 `filesystem-editor` 模块按需装配） |
| `docs/architecture-params.md` | 168 行去 anchored 预设专属表述 |
| `CHANGELOG.md` | 新增本轮条目（历史条目保留，不改写） |

### 3.5 测试迁移（实际执行）

- **夹具方案（替代原计划的「改用 ROOT/preset/standard」）**：实测 `writePreset(options.presetDir)` 的模板解析根是 **`options.presetDir`**（其次包内 `preset/`），不读 `$DSH_HOME/.agent-presets`；而 `resolvePresetDir()` 的默认根才是 `$DSH_HOME/.agent-presets`。因此新增只被 `test/` 引用的夹具模板 `test/fixtures/preset-template/preset.yml`（id=`fixture`：锚定/门控模块装配 + params + 三条 promptConfigs + 顶层 persona 段，**不含任何提示词正文**）与安装器 `test/fixtures/preset-template.mjs`：
  - `installFixturePreset(presetRoot)` → `<presetRoot>/fixture`（writePreset 场景）；
  - `installFixturePresetInHome(dshHome)` → `<dshHome>/.agent-presets/fixture`（resolvePresetDir / rematerialize 场景）。
- 内置预设集合断言：`['anchored','creative','custom','minimal','ptc','standard']` → `['creative','custom','minimal','ptc','standard']`（`builtin-presets-parity`、`writepreset-off`、`user-presets`）。
- 夹具承载：`write-preset`（`makeOptions` 缺失时安装夹具、`presetTemplate: fixture`，含 4 处 `cpSync(FIXTURE_PRESET_SRC, …)` 改写场景）、`prompt-configs`、`module-configs`（新增 `fixtureComposition()` 等价替代已删除的 `buildCordis`）、`rematerialize-presets`、`module-facts`、`instructions-e2e`（夹具不含官方 `agent-instructions` 行，等价原 anchored 的装配事实；负责人冲突用例保持 `standard`）。
- 官方基型承载：`wave1-safety` 的两处路径断言改用缺省模板 `standard`；`composition-modules` 改为遍历全部内置预设校验模块存在性（并用 `standard` 承接 `command-goal`/ST 工具断言）。
- `buildCordis` 专属测试（`test/host/preset-core.test.mjs`、`test/presets/anchored/preset-core.test.mjs`）删除；`test/presets/anchored/anchored-presets.test.mjs` 实为引擎行为测试（tool-git-bash / persona 层 / run-code-env），迁移为 `test/engine/preset-engine-modules.test.mjs` 并修正相对导入，不删除覆盖。
- `test/engine/yaml-vendor-parity.test.mjs` 的语料清单 `preset/anchored/preset.yml` → `preset/standard/preset.yml`。
- 与预设无关的 anchored 字样（`anchored-popover*`、`hasAnchoredReasoning`、引擎插件名 `anchored-*`、上游来源注释）保持不变。

## 4. 任务拆解与执行

### Wave 1：上游通道下线

- [ ] R1：删除 `preset/anchored/`、`upstream/`、`scripts/sync-anchored.mjs`，移除 `package.json` 的 `sync:anchored`。
- [ ] R2：`preset.yml` 根模板去 anchored 引用与 `upstream:` 段。

### Wave 2：默认模板与代码迁移

- [ ] R3：`src` 层默认值迁移到 `standard`（3.2 表全部位置）。
- [ ] R4：`src/preset-core.ts` 收敛导出面（删 `buildCordis` 与 anchored 模板常量）。
- [ ] R5：`templates/` 注释引用更新。

### Wave 3：测试迁移

- [ ] R6：内置预设集合与夹具迁移（3.5 前三项）。
- [ ] R7：`buildCordis` 相关测试下线与改写。

### Wave 4：文档与交付

- [ ] R8：README / NOTE / docs / CHANGELOG 更新。
- [ ] R9：完整门禁 `pnpm typecheck` + `pnpm lint` + `pnpm test` + `pnpm build` + `git diff --check`。
- [ ] R10：提交并推送 `origin/dev`；交付说明标注真实 `DSH_HOME` 中已种子化 `anchored` 目录的处理方式（本插件不主动删除用户目录内容）。

## 5. 验证与证据

- 门禁：`pnpm --dir $Repo typecheck`、`lint`、`test`、`build` 全绿；`git -C $Repo diff --check` 无输出。
- 行为证据：
  - `grep -rn "preset/anchored"` 无结果；`grep -rn "sync:anchored"` 无结果。
  - `listBuiltinTemplates()` 返回 5 个内置模板（不含 anchored）——由 `test/host/builtin-presets-parity.test.mjs` 断言。
  - 未传 `presetTemplate` 时运行时默认 `standard`——由 settings 默认值与 `preset-default-sync` 测试断言。
  - 引擎移植未回退：`test/engine/*`（anchor-turn、deliberation-gate、promotion-gate、meta）与 `test/host-contract.test.mjs` 全绿。
- 反例证据：`git status` 只含本轮文件；`lib/` 未提交；`.ai-memory/` 不入库。

## 6. 回滚与停止条件

- 回滚：本轮为单次结构性删除，反向 `git revert` 本轮提交即可恢复预设、快照与同步脚本；不改写历史、不 reset、不 clean。
- 不动运行中的 DSH：不停止/重启当前 dsh 与 dsh web，不抢占端口；生成目录由用户重启后按新默认模板物化。
- 停止条件：门禁全绿并推送成功后停止；不扩展 scope 到引擎模块重构、不处理用户 `DSH_HOME` 内既有 `anchored` 目录（只在交付说明中提示）。

## 7. Wave 与任务完成状态

`[✔]` = 已完成且对应验证通过；`[ ]` = 未完成。

- [✔] **Wave 0：上游引擎核查（只读）**
  - [✔] U1：上游已冻结于 `dda23ef`，本地快照即该提交，最后一批引擎修复已在本地覆盖 → 无待移植引擎更新（证据见 1.2）。
- [✔] **Wave 1：上游通道下线**
  - [✔] R1：删除预设、快照与同步脚本（`preset/anchored`、`upstream/`、`scripts/sync-anchored.mjs`、`package.json#scripts.sync:anchored`）。
  - [✔] R2：根模板去 anchored 引用与 `upstream:` 段。
- [✔] **Wave 2：默认模板与代码迁移**
  - [✔] R3：`src` 默认值迁移到 `standard`（config / index / write-preset / manifest / settings-bridge / client fields+view+locales）。
  - [✔] R4：`src/preset-core.ts` 导出面收敛（删 `buildCordis` 与 `ANCHORED_TEMPLATE_DIR`，`BuildCordisOptions` 一并删除）。
  - [✔] R5：`templates/` 注释更新。
- [✔] **Wave 3：测试迁移**
  - [✔] R6：内置预设集合与夹具迁移（新增 `test/fixtures/preset-template{,.mjs}`；`write-preset` / `prompt-configs` / `module-configs` / `rematerialize-presets` / `module-facts` / `instructions-e2e` / `wave1-safety` / `composition-modules` / `user-presets` / `writepreset-off` / `builtin-presets-parity` 全部通过）。
  - [✔] R7：`buildCordis` 测试下线与改写；`preset-engine-modules.test.mjs` 承接原 anchored-presets 的引擎覆盖。
- [✔] **Wave 4：文档与交付**
  - [✔] R8：文档更新（README / NOTE / docs×2 / CHANGELOG / preset.yml / templates）。
  - [✔] R9：完整门禁——`typecheck` ✓、`lint` 0 warning/0 error ✓、`test` 930/930 ✓、`build` ✓、`git diff --check` 干净 ✓。
  - [✔] R10：提交 `a406136`（`refactor(preset)!: 移除上游 anchored 预设，只保留引擎移植`）已推送 `origin/dev`（`0af985a..a406136`）。

## 8. 交付与 OCR 委托审查记录

- 提交：`a406136`，普通快进推送 `origin/dev`（`0af985a..a406136`）；未切 `main`、未建 PR、未提交本地记忆（`.ai-memory/` 被忽略）。
- 审查入口：`ocr delegate preview --format json`（workspace 模式）判定 60 个变更文件中 **34 个可审查**（26 个被排除：md 文档、删除文件、`.scratch` 归档，以及 `test/fixtures/preset-template*` 两个夹具文件）；`ocr delegate rule --format json` 返回 3 组规则（YAML 键拼写 / package.json 依赖 / TS-JS 质量与安全）。
- 覆盖：34/34 可审查文件逐文件审阅（`git diff` + 规则）；被规则排除的 `test/fixtures/preset-template/preset.yml` 与 `preset-template.mjs` 由本轮作者手工审阅（内容为测试夹具，不含提示词正文）。
- 审查确认并修复 2 处漏改：①`src/client/locales.ts` 中文文案仍为「生成锚定注入预设」（EN 已改为 prompt-tool 口径）；②`src/config.ts` 的 `writePreset` 注释仍写「锚定注入 preset」。另同步清理 `src/host/write-preset.ts` 中仍引用已删除 `buildCordis` 的注释。
- 审查确认的非缺陷取舍（记录备查）：原 anchored 测试中的 `tool-web.fetch: true` 本地保留差异断言随预设下线失去载体（`delegation` 的 `modelSelectionSettings` / `backgroundMode` 两条仍由 `composition-modules` 的库断言覆盖）；引擎侧 `anchored-*` 插件名、`hasAnchoredReasoning`、`anchored-popover*` 属「锚点/锚定推理」语义或上游来源注释，按计划保留不改名。
