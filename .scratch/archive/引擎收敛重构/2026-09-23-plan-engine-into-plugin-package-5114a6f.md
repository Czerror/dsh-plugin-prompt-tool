# PLAN：引擎归位插件包（阶段 2）

## 需求与授权

- **用户指令（2026-09-23）**：「继续执行二阶段」，并澄清此前「不再导出引擎」的含义——**导出预设时不再随包携带引擎**，即引擎不再是预设的组成部分，因此引擎应归插件包提供。
- **起始基线**：`5114a6f`（阶段 1 已交付并推送 `origin/dev`）。
- **上游版本**：`D:\AI\GitHub\deepseek-harness` @ `00102833df` / `dsh-v0.1.7-alpha.2`。
- **与阶段 1 的关系**：阶段 1 修掉「注册锚点被改写导致整份注册被拒」；阶段 2 把引擎从 `<预设根>/.engine/` 物化副本改为**由插件包提供**，使引擎随插件版本更新、预设根回归纯用户数据。

## 审查结论与依据（均已查证，非推断）

**实测（隔离实例，随机端口 51427，`/tool-surface` 探测）**

| 探测 | 组合形态 | 结果 |
|---|---|---|
| 包名子路径解析 | `createRequire(profile/cordis.yml).resolve('dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs')` | **OK** → 指向本仓库 `engine/prompt-config-engine.mjs`（依赖新增的 `"./engine/*"` 导出） |
| `probe-abs` | 引擎行用包名子路径 + `configsDir: file:///…` | **IN ROSTER**（引擎从包内加载成功） |
| `probe-rel` | 同引擎行 + 相对 `configsDir: ../probe-rel/prompt-configs` | **未注册**（整份注册被拒） |

**源码（受管字段解析基准，全部为 `import.meta.url`）**

| 字段 | 位置 | 盘符绝对路径 | `file://` URL |
|---|---|---|---|
| `prompt-config-engine.configsDir` | [prompt-config-engine.mjs:78](engine/prompt-config-engine.mjs#L78) | ✗ 被当 scheme（实测） | ✓（实测） |
| `prompt-config-engine.strategyDir` | [prompt-config-engine.mjs:83](engine/prompt-config-engine.mjs#L83) | ✗ | ✓ |
| `tool-config-engine.configsDir` | [tool-config-engine.mjs:369-372](engine/tool-config-engine.mjs#L369-L372) | ✓（`isAbsolute` 分支） | ✓ |
| `subagent-tool-policy.policyFile` | [subagent-tool-policy.mjs:97](engine/subagent-tool-policy.mjs#L97) | ✗ | ✓ |
| `declared-triggers.triggersFile` | [declared-triggers.mjs:50-51](engine/declared-triggers.mjs#L50-L51) | ✓（`isAbsolute` 分支） | ✓ |

⇒ **`file://` URL 是唯一对全部 5 个字段一致有效的形态**，装配期换算统一采用它。

**引擎对 `.engine/` 布局的耦合（全局仅 2 处）**

1. [schema.mjs:27-30](engine/schema.mjs#L27-L30)：`loadTemplate` 以 `new URL('../..', baseUrl)` 推导 `presetRoot`，并强制 `templateFile` 落在预设根内。引擎移入包内后基准会变成包目录 ⇒ **必须显式注入预设根**。
2. [tool-config-engine.mjs:377](engine/tool-config-engine.mjs#L377)：同类推导，但有 `isAbsolute` 分支，绝对 `configsDir` 会跳过校验。

**关键设计（本 PLAN 的技术核心）**：引擎接受可选配置 `presetRoot`（绝对 `file://` URL，指向预设根），装配期由插件注入；缺省时回退历史推导（`../..` from `import.meta.url`），因此引擎放在包内或 `.engine/` 两种布局都成立。

## 影响面、依赖与护栏

| 层 | 变更 |
|---|---|
| `engine/*.mjs` | 2 处基准解耦（`presetRoot` 注入 + 缺省回退） |
| `engine/compositions/source/local/*.yml`、`write-preset.ts` | 引擎行改包名说明符；不再生成 `../.engine/` 引用 |
| `src/host/preset-registry.ts` | 装配期换算扩展：受管字段 → `file://`；注入 `presetRoot`；旧 `../.engine/x.mjs` 引用重定向到包内引擎 |
| `src/host/write-preset.ts`、`preset-install.ts`、`manifest.ts`、`preset-package.ts` | 退场 `.engine` 物化/指纹/备份与相关特判；迁移改写规则改为「任何 `engine/<模块>.mjs` 引用 → 包名说明符」 |
| `package.json` | 新增 `"./engine/*": "./engine/*"` 导出（已加） |
| 测试 | 7 个依赖 `.engine` 布局的用例改造 + 新增守卫 |
| 文档 | `architecture-params.md`、`engine-reuse.md`、`asset-transfer.md`、`README.md`、`CHANGELOG.md`、`AGENTS.md` |

**硬约束**

- 换算仍在**内存注册定义**内完成，正本 `agent.cordis.yml` 保持相对/包名形态，可移植性不退化（改 `DSH_HOME`、复制预设根后按新位置重算）。
- `file://` URL 只用于受管字段与本地模块说明符；`!!js` 节点、包名说明符、非受管字段一律不动。
- 旧预设（含 `../.engine/*.mjs`）必须在**不改盘**的前提下继续可用：装配期把受管引擎引用重定向到包内引擎。
- 引擎侧只做基准解耦，不改提示词语义、不改参数契约、不改注入点行为。
- 不触碰用户 profile；运行中的 DSH 只做只读探测。

## Wave 1：引擎基准解耦

<task type="auto">
  <name>T1：引擎接受显式 presetRoot</name>
  <files>engine/prompt-config-engine.mjs、engine/schema.mjs、engine/tool-config-engine.mjs、engine/declared-triggers.mjs（如需）</files>
  <action>`prompt-config-engine` 的 config 增加可选 `presetRoot`；命中时以它为 `templateFile` 越界校验与 `loadTemplate` 的基准（构造 baseUrl 传入 `createPromptConfigs`），缺省回退现有 `import.meta.url` 推导。`tool-config-engine` 的 presetRoot 同源处理。</action>
  <verify>新增/扩展引擎单测：给定 `presetRoot` 时 `templateFile` 在预设根内通过、越界被拒；缺省时保持现有行为（历史布局用例不变）。</verify>
  <security>越界校验只能放宽到显式注入的 presetRoot；未注入时行为与现在完全一致，不得出现「无基准即放行」的路径。</security>
  <done>引擎在包内与 `.engine/` 两种布局下，`templateFile` 校验结果一致。</done>
</task>

## Wave 2：生成侧与装配期

<task type="auto">
  <name>T2：引擎行改包名说明符</name>
  <files>engine/compositions/source/local/*.yml、engine/compositions/library/*.yml、src/host/write-preset.ts、scripts/rebuild-composition.mjs</files>
  <action>组合源与快照里的引擎行 `name` 由 `./engine/x.mjs` 改为 `dsh-plugin-prompt-tool/engine/x.mjs`；`writePreset` 不再做 `./engine/ → ../.engine/` 重写。</action>
  <verify>`pnpm --dir $Repo rebuild:composition` 产出与预期一致；生成目录的 `agent.cordis.yml` 中引擎行为包名说明符。</verify>
  <security>组合快照仍由脚本生成、不手工编辑；不引入绝对路径。</security>
  <done>新建/重建的预设不再引用 `.engine/`。</done>
</task>

<task type="auto">
  <name>T3：装配期换算扩展与 presetRoot 注入</name>
  <files>src/host/preset-registry.ts</files>
  <action>在既有 `absolutizeLocalModules` 基础上：受管 config 字段（`configsDir`/`strategyDir`/`policyFile`/`triggersFile`）以 `<预设根>/.engine/` 为基准解析为 `file://`；受管引擎模块说明符（`./engine/*.mjs`、`../.engine/*.mjs`）重定向为包名说明符；引擎行 config 注入 `presetRoot: file:///<预设根>/`。</action>
  <verify>单测覆盖：旧形态引用被重定向、受管字段变 `file://`、非受管字段与 `!!js` 不动、正本不回写绝对路径。</verify>
  <security>只改内存注册定义；换算基准固定为预设根，拒绝越界值原样透传（由引擎侧校验兜底）。</security>
  <done>旧预设不改盘即可用包内引擎装配。</done>
</task>

## Wave 3：退场物化与迁移

<task type="auto">
  <name>T4：退场 `.engine` 物化、指纹与备份</name>
  <files>src/host/write-preset.ts、src/host/preset-install.ts、src/host/manifest.ts、src/host/preset-package.ts、scripts/rematerialize-presets.mjs</files>
  <action>删除 `syncPresetEngine`、`ENGINE_FINGERPRINT_MARKER`、`engineFingerprint` 及其调用点与备份/回滚分支；`rewritePresetEngineReferences` 改为一律重写为包名说明符；`preset-package` 的 `.engine` 特判与 `candidateTemplate` 基准适配；已有 `.engine/` 目录不再生成、不被引用（保留不清理）。</action>
  <verify>相关单测改写后通过；`pnpm --dir $Repo rematerialize:presets` 不再产生 `.engine/`。</verify>
  <security>不删除用户既有 `.engine/` 与任何用户文件；写盘边界不变。</security>
  <done>插件不再物化引擎，`.engine/` 对装配不再必要。</done>
</task>

## Wave 4：验收与文档

<task type="auto">
  <name>T5：测试适配与端到端验收</name>
  <files>test/host/{write-preset,preset-boundaries,rematerialize-presets,pre-step-wiring,pre-step-injection,trigger-save-validation}.test.mjs、test/engine/declared-triggers.test.mjs</file>
  <action>改写依赖 `.engine` 布局的断言与夹具；隔离实例（隔离 `DSH_HOME` + 随机端口，复制现场预设与 `.engine` 以覆盖两种来源）验证 `standard`/`pt-standard`/`pt-cordis`/`pt-minimal`/`pt-ptc` 全部在册。</action>
  <verify>全量 `pnpm test` 通过；端到端工具数与官方同预设一致。</verify>
  <security>隔离环境与随机端口；用户实例只读探测。</security>
  <done>两种布局（有/无 `.engine/`）下预设均正常装配。</done>
</task>

<task type="auto">
  <name>T6：文档、CHANGELOG 与交付</name>
  <files>docs/{architecture-params,engine-reuse,asset-transfer}.md、README.md、CHANGELOG.md、AGENTS.md</files>
  <action>更新「引擎由插件包提供、不再物化」的口径与 `file://`/`presetRoot` 约定；CHANGELOG 记 BREAKING 与生效条件；`asset-transfer.md` 的「共享引擎由目标安装的插件生成」改为与包内引擎一致的表述。</action>
  <verify>`git diff --check`；文档路径与命令核对。</verify>
  <security>不写入 secrets。</security>
  <done>文档与实际行为一致，交付说明含验证命令、SHA 与分支。</done>
</task>

## 回滚与检查点

- 代码侧：`git revert` 本轮提交回到 `5114a6f`（阶段 1 形态，引擎仍从 `.engine/` 加载）。
- 数据侧：本轮**不删**任何 `.engine/` 目录、不改用户预设；回滚后旧形态仍可用。
- 中断检查点：Wave 1 独立可提交（引擎基准解耦自身向后兼容）；Wave 2+3 必须同批，否则出现"引用包内引擎但仍在物化"或"不物化但仍引用 `.engine/`"的中间态。

## 状态

- [✔] Wave 1：引擎基准解耦（T1）—— 已提交 `0091797` 并推送 `origin/dev`
- [✔] Wave 2：生成侧与装配期（T2 / T3）—— 重写目标改包名说明符、`sourceDir` 退场、装配期换算扩展（受管字段 → `file://`、`presetRoot` 注入，不兼容旧布局）
- [✔] Wave 3：退场物化与迁移（T4）—— 删除 `syncPresetEngine`/`engineFingerprint`/指纹常量与调用点、`preset-package` 的 `.engine` 豁免退场、`rematerialize-presets.mjs` 的指纹校验改为旧布局引用校验。期间修掉两处自查未发现的**捕获索引缺陷**（正则首组改为非捕获组后仍读 `match[2]`，导致重写与受管字段重写恒不触发；已由子代理实测暴露并修为 `match[1]`）
- [✔] Wave 4：验收与文档（T5 / T6）—— 三组测试适配全部完成（write-preset 40/40、rematerialize+boundaries 16/16、pre-step+transfer 68/68），全量 **1560/1560**；端到端验收通过；文档已更新 architecture-params / asset-transfer / engine-reuse / README / CHANGELOG，`scripts/rematerialize-presets.mjs` 的失效指纹校验已改写。收尾时另修一处**复制路径缺口**：`rewritePresetEngineReferences` 的改写门只认本地形态，产物已是包名说明符 → 门永不命中、副本 `configsDir` 仍指向原预设；现按 `PRESET_ENGINE_PREFIX` 同时识别两种形态，并在 `preset-transfer` 补断言守住。

## 验收记录

**前提实测（隔离实例，随机端口，`/tool-surface` 探测）**

| 探测 | 结果 |
|---|---|
| `createRequire(profile/cordis.yml).resolve('dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs')` | OK（需新增 `"./engine/*"` 导出） |
| 引擎行用包名子路径 + `configsDir: file:///…` | IN ROSTER |
| 同引擎行 + 相对 `configsDir` | 未注册（整份注册被拒）→ 证明受管字段必须换算 |

**端到端（新装用户场景：隔离 `DSH_HOME` + 随机端口 49559，预设由插件自行种子化与物化）**

| 预设 | 状态 | 工具数 |
|---|---|---|
| `standard`（官方） | IN ROSTER | 25 |
| `pt-standard` | IN ROSTER | 25 |
| `pt-cordis` | IN ROSTER | 26 |
| `pt-ptc` | IN ROSTER | 25 |
| `pt-minimal` | IN ROSTER | 1（=官方 minimal） |

产物形态：预设根下**只有预设目录**（无 `.engine/`、无指纹文件）；`pt-standard/agent.cordis.yml` 的引擎行为
`name: dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs`，`configsDir: ../pt-standard/prompt-configs`
（历史形态，注册期换算为绝对 `file://`）。

**测试**

- **全量 `pnpm test` → 1560/1560 通过**；`pnpm typecheck`、`pnpm lint`（0 warnings / 0 errors）、`pnpm build`、`git diff --check` 全部通过。
- 适配明细：`write-preset.test.mjs` 40/40（6 项原失败改写为「不物化 + 包名说明符 + 产物幂等」断言）；`rematerialize-presets.test.mjs` 10/10 与 `preset-boundaries.test.mjs` 6/6（16/16）；`pre-step-injection.test.mjs` 22/22、`pre-step-wiring.test.mjs` 34/34、`preset-transfer.test.mjs` 12/12（68/68）。
- 期间修复三处缺陷，全部由验证暴露、非推断：
  1. `rewritePresetEngineReferences` 正则首组改为非捕获组后仍读 `match[2]` → 引擎引用重写**恒不触发**（现 `match[1]`）；
  2. 同函数受管字段查表同样读错索引 → 字段重写**恒不触发**（现 `match[1]`）；
  3. 改写门只认本地形态 → 复制预设时产物行（包名说明符）不参与改写，**副本 `configsDir` 仍指向原预设**（现按 `PRESET_ENGINE_PREFIX` 同时识别两种形态，并在 `preset-transfer` 补断言守住）。
- 已知环境依赖：`rematerialize-presets.test.mjs` 通过脚本调用 `lib/index.mjs`，因此对 `lib/` 新鲜度敏感——`lib/` 陈旧时会出现假红，`pnpm test`（内部先 build）不受影响。

## 实施取舍与已知边界

- 采用「显式 `presetRoot` 注入 + 缺省回退」而非把预设根写进正本：正本保持可移植，注入只发生在内存注册定义。
- 受管字段统一换算为 `file://` URL（而非普通绝对路径），因为 `policyFile`/`configsDir`/`strategyDir` 无 `isAbsolute` 分支（源码已核）。
- 旧 `.engine/` 目录不主动清理：避免删除用户文件；它不再被引用，仅占磁盘。
- 上游已把「目录形态用户预设」判为遗留（`editing-cordis-compositions` SKILL.md:70），本项目保留目录正本 + UI 实时编辑属自主取舍，本轮不改变该定位。

## 测试现场与清理限制

- 隔离环境与临时脚本一律位于 `D:\AI\workspase\_temp\`，验证后清理。
- 用户实例 `127.0.0.1:3080` 只读探测。
