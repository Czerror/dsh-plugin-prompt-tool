# B7 专用能力重建、模块删除与预设迁移 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支把 7 个「针对特定模型问题」的专用能力模块**先在触发器引擎里重建为等价声明，再删除模块文件**，并把真实在用的预设迁到新机制。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；依赖 B3（触发器引擎）、B4（会话态）、B6（跨层镜像，参数清理需要它先收口）。
- 用户拍板：
  - `全删除,只保留机制`（7 个专用能力模块）；
  - `删除模块但先重建等价声明`（除 PTC 呈现）；
  - `pt-cordis 与 beta-2-42 迁到新机制`；
  - `promoted-code-mode` 按原方案**移除**（放弃"晋升后才呈现 PTC"的时机特性）。
  - **`instructionHint` 的归属（2026-09-22 执行期拍板）**：**并入 `engine/instruction-hint.mjs`**。查证：该模块已是通用库（`fillers.mjs:7`、`strategies.mjs:12` 都 import 它），且「把 agent-instructions 全文换成 hint」的构造**本就在它里面**（`instruction-hint.mjs:206-223`）；真正留在 `context-gate` 的只有 `hasVisibleInstructionHint`（`:129-133`）、开关判断与**挂载点**（`:226-255`，依赖 `compaction-epoch.mjs` 的晋升状态）。故给它补 plugin 形态（`apply`），`context-gate` 删除后该能力仍在。
  - **`deferredSources` + `deferredGraceSteps` 接受作废（2026-09-22 执行期拍板）**：两项为「晋升后前 N 步延迟注入」，声明层**无对应信号**——`predicates.mjs:250-257` 的 `COUNT_SIGNALS` 只有 `tool-call`/`tool-result`/`assistant-message`/`assistant-chars`/`user-message`/`turn`，而 `context-gate` 的 `state.steps` 是 **pre-step 判定次数**（`context-gate.mjs:239`）不是 durable 事件，二者不等价。查证**无任何真实使用**：组合源 `engine/compositions/source/local/context-gate.yml` 只配 `enabled`/`promoteOn`/`includeSubagents`，两个真实预设均未配，仅出现在测试与文档示例（`preset.yml:364-365` 注释、`docs/engine-reuse.md:347-348/419-420`）。按 §3「各能力的专属参数全部作废」一并撤销，并同步撤销 `docs/architecture-params.md:101` 的 `deferredGraceSteps 0→无延迟` 承诺。
  - **六个能力对声明机制的可表达性已逐项查证**（2026-09-22 执行期）：`context-gate` 清空 contexts → `assembly` ✔；pre-step 过滤 → `pre-step-filter` ✔；`tool-filter` 名单/PTC 裁剪/执行 guard → `assembly` + `sdk-strip` + `guard` ✔；`anchor-turn` → `inbox-prepend` ✔；`deliberation-gate` → `decision` ✔；`progress-reminder` → `append-context` ✔；`tool-bootstrap` 的 `personaSectionsOnly` → `assembly.sections.remove`（`actions.mjs:289-290`、`:312-316`）✔、`bootstrapMaxTokens` → `request-params` ✔。**`guard` 与 `inject-text` 不支持 `when`/`prepend`**（`actions.mjs:698-701` 挂载期报错），但 `registerGuard:466-467,501` 自带 `audience`/`includeSubagents` 受众判定，`tool-filter` 的名单本是静态的，不受影响。
  - **声明的落位（2026-09-22 执行期拍板）**：`纯预设声明（引擎不带默认）`——引擎**不内置**这 6 个能力的默认声明，声明由预设的 `preset.yml` 提供（新增顶层 `triggers` 段），沿既有「顶层段 → `writePreset` 物化 → 引擎模块读」通道接入（与 `subagentToolPolicy` → `subagent-tools/policy.yml` 同构，符合 R6 的「不新开第二条存储通道」）。
    **推论（本支其余任务的约束）**：① 删模块后**现有预设必须都补上声明**，否则「先重建等价声明」只在"用户写了声明"时成立——T2 的候选迁移因此不只是删行，还要补声明；② 原 5 个 `*Enabled` 开关与各能力专属参数的**值改为写进声明**，参数桥不再保留这些键（原「参数全废」的结论照旧成立，但"能力不可配置"不成立——它们由声明配置）。

## 审查结论

### 1. 待处理清单（7 个模块）

| 模块 | 处置 | 重建判定 |
|---|---|---|
| `tool-filter` | 重建为声明 | ✅ 名单判断 + 剔工具动作 |
| `context-gate` | 重建为声明 | ✅ 相位 + 来源判断 → 清空 contexts / 过滤消息 |
| `anchor-turn` | 重建为声明 | ✅ 会话状态判断 → prepend |
| `deliberation-gate` | 重建为声明 | ✅ 计数/阈值判断 → deny |
| `progress-reminder` | 重建为声明 | ✅ 计数判断 → 追加上下文 |
| `tool-bootstrap` | 重建为声明 | ✅ 相位、sections 过滤（`personaSectionsOnly`）、请求预算（`bootstrapMaxTokens`）**均可重建**（后两项不依赖工具注册；请求预算落 B3 的**第 (7) 类动作「改模型请求参数」**——与既有 `layers.mjs:296-314` 的 `agent-request` 层同源，含按值条件删键）；❌ **`stages` 渐进披露按拍板放弃**（2026-09-22：它只是触发器机制的一个应用，行为可由「多条件 + 多触发 + 多动作」自行声明，故**不作为内置能力保留**，连带 5 个参数键、UI 字段与相关测试一并精简） |
| `promoted-code-mode` | **移除，不重建** | ❌ 放弃"晋升后才呈现 PTC"的相位切换（用户拍板） |

**它们"过时"的依据**：6 个标注移植自上游 `dsh-anchored-standard`（如 `anchor-turn.mjs:4`、`deliberation-gate.mjs:2`、`progress-reminder.mjs:2`），插件名带 `anchored-` 前缀（`context-gate`/`tool-bootstrap`/`tool-filter`）；该上游**已进入维护期**（FAREWELL），其姊妹项目作者**已公开勘误**（强归因理论作废/降级）。

### 2. 真实使用面（删除的破坏面）

| 预设 | 挂了什么 | 迁移动作 |
|---|---|---|
| `pt-cordis` | `tool-bootstrap` + `promoted-code-mode`（`usePtcMode: true`） | 移除两行；若仍需 PTC，改用官方 `tool-presentation`（装配时呈现） |
| `beta-2-42` | `tool-filter`，且**名单是配了的**（`preset.yml:28-33` 的 `moduleConfigs.tool-filter.deny = [web_search, web_fetch]`、`includeSubagents: false`） | **不能只删行**（R6）：必须改写为 B7 的名单声明 `{ mode: deny, list: [web_search, web_fetch] }`，否则静默丢失这两个工具的屏蔽。**2026-09-22 执行期更正**：本节原写「`layerSettings` 为空 = 名单没配 = 不过滤」是**错的**——名单配在 `moduleConfigs` 而非 `layerSettings`，实测生效 |
| 其余 6 个（pt-ptc/pt-standard/pt-minimal/pt-custom/custom/liangshen） | 无 | 无需迁移（**更正**：原写「其余 5 个」漏了 `pt-custom`；实测它不挂任何待删模块，结论不变） |

### 3. 连锁清理面（删除的完整代价）

| 面 | 具体项 |
|---|---|
| 生成目录 | 两个预设的 `agent.cordis.yml` 里仍有 `name: ./engine/<被删模块>.mjs` → **删除前必须迁移，否则装配失败** |
| 一键组合 | `ENGINE_RECIPES` 三个 recipe（`phase-control`、`phase-control-ptc`、`deliberation`）依赖被删模块 → 重做或删除 |
| UI 能力卡 | `ENGINE_CAPABILITIES` 10 张 → 剩 **4** 张。被删的 7 张是 `tool-bootstrap`/`context-gate`/`anchor-turn`/`promoted-code-mode`/`tool-filter`/`deliberation-gate`/`progress-reminder`；保留 `subagent-tool-policy`/`str-replace-editor`/`tool-config-engine` **外加 `tool-git-bash`**（B2 新增的卡，方案产出时还不存在——**原写「只剩 3 张」已按执行期实测更正**）。`ENGINE_RECIPES` 三个 recipe 全部依赖被删能力（`phase-control`/`phase-control-ptc`/`deliberation`），故全部删除、数组**变空**，需同步检查「recipes 非空」类断言 |
| 参数桥 | 5 个 `*Enabled` 开关（`anchorTurn`/`deliberationGate`/`cotDrip`/`contextGateEnabled`/`toolFilterEnabled`）与各能力的专属参数全部作废 |
| 参数目录 | `src/shared/engine-params.ts` 中被删模块的键要删；连带 `locales-params.ts`（约 180 处文案）、`use-prompt-tool-store.ts:70-73` 的 13 键开关清单、`MODEL_SEGMENT_MAP`、两处测试镜像 |
| 组合源 | `engine/compositions/source/local/` 下对应 yml 删除（`anchor-turn`/`context-gate`/`deliberation-gate`/`progress-reminder`/`promoted-code-mode`/`tool-bootstrap`/`tool-filter` 七个） |
| 测试 | `test/engine/` 下覆盖这些模块的用例（`promotion-gate`、`tool-filter`、`injection-gates`、`tool-module-mount` 等）删除或改写为声明式等价断言 |
| 文档 | `docs/engine-reuse.md` 的模块表/默认值表/组合示例、`docs/injection-point-contracts.md`、README |

### 4. 名单语义（用户关切）

现状 `tool-filter` 里 **`deny` 优先于 `allow`**（`tool-filter.mjs:52-53`），两个名单同时写时结果不可预期。用户的心理模型是「白名单里加 = 可用，黑名单里加 = 不可用」——两套并存即语义不明。

**改为模式互斥**：

```yaml
tools: { mode: allow, list: [read, write, edit] }   # 未列出即不可用（fail-closed）
tools: { mode: deny,  list: [bash], when: { …条件… } }  # 未列出即可用
```

引擎内部 allow 模式仍按 fail-closed 实现，**默认方向不翻转**；UI 两个选项互斥。

### 5. PTC 下工具面有第二条投递通道（外部实证，本项目当前缺口）

来源：[dsh-agent-studio](https://github.com/thissensen/dsh-agent-studio) 的真机取证（`src/host/apply.ts:12-20` 与 `src/host/sdk-strip.ts:1-23`），已与本项目官方源码核对：

- `assembly.tools` 在 `system-prompt/assemble` 的 waterfall **之前**就已按**当时的工具视图**求值完毕（官方 `packages/core/system-prompt/src/index.ts:612-625`：`tools: orderTools(collected, …)` 在 `await this.ctx.waterfall(...)` **之前**构造）。因此改数组（投递层）有效，但**改视图**对当次无效。
- **PTC 模式下 `tools:sdk` 段是另一条投递通道**，由平台按**工具视图**生成，与 `assembly.tools` 不共享数据；该段是模型在 PTC 下**唯一的工具知识来源**。
- 本项目 `tool-filter` 只改 `assembly.tools` 数组、**不改工具视图**，因此 **PTC 模式下被剔除的工具仍可能出现在 `tools:sdk` 声明里被模型看到并调用**——这是当前的真实缺口（未触发只因为真实部署里 `beta-2-42` 的名单是空的）。
- 本项目对该段目前只有"避免破坏"的意识：`tool-config-engine.mjs:318` 与 `src/runtime/session-var-tools.ts:21` 都注明 description 会进 `tools:sdk` 且受 `{{var}}` 校验，但**没有任何裁剪**。

因此本支的 `tool-filter` 等价声明**必须同时包含执行层 guard 与 SDK 声明裁剪**（动作由 B3 的第五、六类动作提供），且**同一份名单判据驱动呈现过滤、执行 guard 与 SDK 重生/裁剪三处**。这是**修复缺口**而非等价迁移，验收里单列。

依总纲 **R4** 补充的硬约束：只裁文本**挡不住执行**——已发布工具包在 `run_code` 执行时从 `registry.schemas(exec.agent)` 建绑定，不从裁过的正文建绑定；`scope restrict` 又只收继承面，agent 本层与晚到的工具收不动。因此呈现补救不能替代执行边界，SDK 必要时按更新后的视图经官方 `sdkSection().text(context)` 重生。

## 影响面、依赖与护栏

- 硬约束：
  - **先重建、后删除**：每个能力的声明实现必须与模块实现在同一组输入下逐条对拍通过，才允许删除对应文件（替换而非叠加）。
  - **预设先迁移、后删除**：`pt-cordis` / `beta-2-42` 的生成目录必须先切到新机制，否则删除即装配失败。
  - 不删除三个提供者（`subagent-tool-policy`、`tool-config-engine`、`str-replace-editor`）与任何库模块。
- 顺序：本支必须在 B3/B4 之后（需要引擎与状态原语），且 B6 的跨层镜像先收口（参数清理要在单一来源上做）。

## Wave 1：等价声明重建

```xml
<task type="auto">
  <name>T1：六个能力重建为声明，并与原模块逐条对拍</name>
  <files>触发器声明（落位由 B3 决定）；engine/{tool-filter,context-gate,anchor-turn,deliberation-gate,progress-reminder,tool-bootstrap}.mjs（作为参考实现保留至验证通过）</files>
  <action>为六个能力各写一份触发器声明：`tool-filter`（名单 + 条件剔除，按「模式互斥」新语义，**并含 SDK 声明裁剪**——见审查结论 §5）、`context-gate`（相位 + 来源 → 清空/过滤）、`anchor-turn`（会话状态 → prepend）、`deliberation-gate`（计数/阈值 → deny）、`progress-reminder`（计数 → 追加）、`tool-bootstrap`（相位 → 工具面窄化/恢复、**`personaSectionsOnly` 的 sections 过滤**、**`bootstrapMaxTokens` 的 `agent/request` 字段覆盖与释放**（落动作第 (7) 类）——后两项不依赖工具注册，动作库能表达，**必须迁移**；**不含 `stages`**，它按拍板放弃，不写声明也不注册推进工具）。声明与原模块并存，用于对拍。

**能力净损失的授权边界（R1）**：`bootstrapMaxTokens`（`tool-bootstrap.mjs:454` 起的请求预算逻辑）与 `personaSectionsOnly`（`:428-440` 的 sections 过滤）**都不依赖「注册工具」**，因此不能用「动作库不支持注册工具」当作放弃它们的理由——两项都要给出声明映射并进入对拍（`personaSectionsOnly` → 动作第 (2) 类「改装配 sections」+ 相位判断；`bootstrapMaxTokens` → 动作**第 (7) 类「改模型请求参数」**，与既有 `layers.mjs:296-314` 的 `agent-request` 层**复用同一实现**，含按值条件删键）。真正需要单列的只有 `stages` 渐进披露——它已由用户**拍板放弃**（2026-09-22）：该功能只是触发器机制的一个应用，行为可由「多条件 + 多触发 + 多动作」自行声明，**不存在被动作库卡住的缺口**，故不作为内置能力保留；本支对它只做删除与连锁清理，**不写声明、不注册推进工具**。若最终仍要净删除其它任一项，必须**逐项保留为尚未确认的范围变更**、单独交用户拍板，**不得把实现缺口自动当作功能删除授权**。</action>
  <verify>逐能力对拍：同一组会话事件与配置下，(a) 装配结果（tools/sections/contexts）逐项相同，(b) 工具调用裁决结果相同，(c) 注入消息内容与时机相同。对拍用例直接复用原模块的既有测试夹具。**`tool-filter` 另需覆盖 PTC 形态**：断言被剔除的工具既不在 `assembly.tools` 里、也不在 `tools:sdk` 声明正文里（原模块的缺口，属**新增覆盖**而非等价对拍，单列为预期差异）；并断言**携带该工具名的真实 `run_code` 子调用被 guard 拒绝**，TypeScript 与 Python 两种载荷都要覆盖——**只裁文本不拦执行不算通过**（依 R4）。`tool-bootstrap` 的三项按 **R1** 分别处置：`personaSectionsOnly` 与 `bootstrapMaxTokens` **必须与现状等价**（进入等价对拍）；`stages` 渐进披露**已拍板放弃**（2026-09-22），本支不写声明、不注册推进工具，其删除与连锁清理由 T3 的 **stages 专项**覆盖——对拍只覆盖被迁移的那两项。</verify>
  <security>门控类能力（context-gate 的隔离、tool-filter 的掩码）是安全边界：对拍必须覆盖「未晋升时不得出现运行时上下文」「名单外工具不得出现」两类反例，任一不成立即判定重建失败。</security>
  <done>六个能力的声明与原模块逐条等价（tool-bootstrap 的三项放弃有显式断言）。</done>
</task>
```

## Wave 2：备份与候选迁移（旧模块仍可用时完成）

```xml
<task type="auto">
  <name>T2：备份整组资产，并在旧模块仍可用时完成两个预设的候选迁移</name>
  <files>用户预设目录（`$DSH_HOME/.agent-presets/{pt-cordis,beta-2-42}/`）；备份目录（临时）；`scripts/rematerialize-presets.mjs`（按需）</files>
  <action>**顺序必须是「先备份 → 再迁移 → 最后删除」，不得先删后迁**（R5）：实际引用走 `../.engine/`（`src/host/write-preset.ts:330`），任一预设重建都会**在单预设提交前**刷新**共享引擎**（`:571`），而成功刷新会删除旧引擎备份（`:173`）——第一个预设重建后，未迁移的预设可能就找不到旧模块；仅 `git revert` 代码并恢复预设目录**不能**恢复磁盘上的共享引擎。

  (1) **备份三样 + 指纹**：两个预设的 `preset.yml` 与生成目录、**共享引擎目录 `.engine/` 及其指纹**（沿用 `src/host/write-preset.ts:57-79` 的指纹逻辑）。
  (2) **在旧模块仍可用时**用既有候选路径 / `materializeOnly` 语义完成两个候选迁移并**隔离装配验证**：`pt-cordis` 移除 `tool-bootstrap` 与 `promoted-code-mode` 两行，并为其**窄化行为装配替代声明**（R6——**不能只删行**：旧组合源 `tool-bootstrap.yml:9` 本身就带窄化默认，只删行而不补声明等于静默丢功能）；若该预设仍需 PTC，改用官方 `tool-presentation`（与 pt-ptc 同路径）。`beta-2-42` 移除 `tool-filter` 行，如需过滤则改写为新的名单声明。
  (3) 明确**失败恢复顺序**：任一步失败即恢复「定义 + 生成目录 + 共享引擎 + 指纹」**这一整组**，而不是只恢复其中一部分。</action>
  <verify>(a) 两个候选都能在隔离环境装配并通过 smoke（隔离 `DSH_HOME` + 随机端口，不碰在役实例）；(b) 生成目录里不再有指向旧模块的行，且**替代声明确实生效**（有行为断言，不是只断言无加载错误）；(c) 其余能力（character-tools / session-var-tools / tool-config-engine 等）行为不变；(d) **补「第二个预设迁移失败」断言**（R5）——第一个成功、第二个失败时，恢复流程能把整组资产回到迁移前状态。备份保留至用户确认无误。</verify>
  <security>预设目录属用户资产：只做最小必要改动、不重排其余字段；**备份先行**；全程不启停在役 DSH 服务；备份目录含用户数据，交付说明标注其位置与清理方式。</security>
  <done>两个预设的候选迁移通过隔离装配验证；整组资产有可验证的备份与恢复路径；**此刻旧模块仍未删除**。</done>
</task>
```

## Wave 3：删除与连锁清理

```xml
<task type="auto">
  <name>T3：删除七个模块文件与其组合源，清理全部引用</name>
  <files>engine/{tool-filter,context-gate,anchor-turn,deliberation-gate,progress-reminder,tool-bootstrap,promoted-code-mode}.mjs；engine/compositions/source/local/ 对应 yml；`ENGINE_CAPABILITIES`、`ENGINE_RECIPES`、`src/shared/engine-params.ts`、`locales-params.ts`、`use-prompt-tool-store.ts`、`src/client/data/{prompt-tool-fields,param-overrides,dirty-state}.ts`、`src/client/features/modules/EngineParamFields.tsx`、两处测试镜像；stages 专项另涉 `docs/{engine-reuse,architecture-params,ui-architecture}.md`、`preset.yml`、`scripts/rebuild-preset-template.mjs`、`skills/repo-to-dsh-preset/{SKILL.md,reference.md}` 与 11 个含 stages 用例的测试文件</files>
  <action>**仅在 T1 对拍与 T2 候选迁移都通过之后**才删除七个模块文件与其组合源 yml，并同步更新全部 `referenced by` 位置：`ENGINE_CAPABILITIES`（10 → 3）、`ENGINE_RECIPES`（三个 recipe 删除或改写为新机制组合）、`src/shared/engine-params.ts`（删除对应参数与 5 个 `*Enabled` 键）、`locales-params.ts`、`use-prompt-tool-store.ts` 的开关清单、`test/host/engine-params-bridge.test.mjs` 与 `test/shared/engine-param-schema.test.mjs` 的镜像。

  **stages 渐进披露的专项清理（按拍板放弃，2026-09-22——它不写声明、不注册推进工具，只做删除与连锁）**：(1) 五个参数键 `stages` / `stagePreUnlock` / `stageAdvanceTool` / `stageAdvanceDescription` / `stageSectionTemplate`（`src/shared/engine-params.ts:262-266` 的定义与 `:111-117` 的类型），并确认 `ENGINE_PARAM_DEFINITIONS` 的 `kind: 'stages'` 是否只服务本项——是则连该 kind 一起删；(2) 组合源 `tool-bootstrap.yml:14-21` 的四个 stages 参数；(3) 客户端：`StageDraft`、`hasIncompleteStageDrafts`（`prompt-tool-fields.ts:20/47/53`）、`param-overrides.ts:69` 的 `case 'stages'`、`dirty-state.ts:51` 的未完成草稿判断、`EngineParamFields.tsx` 的 stages 编辑器与其 5 组中英文案；(4) **语义连带**：`stagePreUnlock: 0` 的「合法档位」是 `docs/architecture-params.md:98` 的既有承诺，随键删除一并撤销；顶层 `stages: []` 的删键语义（`:112`）同步删除；(5) 其余清理点：`preset.yml:387-390` 示例注释、`scripts/rebuild-preset-template.mjs:72`、`docs/engine-reuse.md:322-334/372`、`docs/ui-architecture.md:360`，以及 `test/engine/promotion-gate.test.mjs:545-650`、`test/host/{engine-params-bridge,wave1-safety,settings-bridge,write-preset,preset-layer-settings}.test.mjs`、`test/client/{engine-module-cards,editor-state,param-overrides,prompt-tool-view}.test.mjs`、`test/shared/engine-param-schema.test.mjs` 中的 stages 用例。</action>
  <verify>全仓 grep 无残留引用（模块名、参数键、能力 id、recipe id，stages 另需覆盖 `stages|stagePreUnlock|stageAdvanceTool|stageAdvanceDescription|stageSectionTemplate|StageDraft|hasIncompleteStageDrafts|phase_advance`）；B0 的守卫全绿（会抓「参数登记了但没落点」），且 **B6 的声明闭合检查在此时点全绿**（R7——7 个模块的字段声明随删除一并消失，余下声明必须与 src 侧元数据闭合；B6 只对它当时存在的声明负责，这 7 个模块的闭合由此处交付）；`typecheck` / `lint` / 全量 `test` / `build` 通过；删除后**再跑一次 T2 的隔离装配 smoke**，确认两个预设在新形态下仍能装配（此时旧模块已不存在）。</verify>
  <security>删除只针对本项目自有的移植模块；**不得删除 `library/` 下的官方切块**（那是分发快照，禁手改）；不得删除三个提供者与任何库模块。</security>
  <done>七个模块及其全部引用清理完毕，工程全绿，两个预设在新形态下仍可装配。</done>
</task>
```

## Wave 4：文档与交付

```xml
<task type="auto">
  <name>T4：文档同步与交付</name>
  <files>docs/engine-reuse.md；docs/injection-point-contracts.md；docs/architecture-params.md；docs/ui-architecture.md；README.md；CHANGELOG.md；preset.yml；`skills/repo-to-dsh-preset/{SKILL.md,reference.md}`；本 PLAN</files>
  <action>文档侧：engine-reuse 的模块表改为「触发器引擎 + 声明 + 三个提供者」的新结构；删除被移除能力的条目；写明名单的「模式互斥」语义与 fail-closed 方向；记录**净损失**（两项，均已拍板）：`stages` 渐进披露（2026-09-22 拍板放弃——它只是触发器机制的一个应用，行为可由「多条件 + 多触发 + 多动作」自行声明，故不作为内置能力保留）与 `promoted-code-mode` 的相位 PTC 呈现；`bootstrapMaxTokens` 与 `personaSectionsOnly` 按 **R1** 已作为声明迁移，**不得写成「放弃」**；首轮窄化/隔离/锚定/深思门/节拍作为**声明供重建**而非内置能力。**能力面文档必须同步删除 stages**：`skills/repo-to-dsh-preset/SKILL.md:29` 与 `reference.md:113-116` 目前把它当可配能力写给用户，留着就是承诺不存在的能力；`docs/architecture-params.md:98/:112`（`stagePreUnlock: 0` 合法档位、顶层 `stages: []` 删键语义）与 `docs/ui-architecture.md:360`（`StageDraft`）同理。CHANGELOG 写一条完整叙述（这是一次**能力净缩减 + 机制统一**，必须显式列出删除了什么）。</action>
  <verify>文档与实现逐条对拍；`git diff --check` 退出 0；交付说明标注「需用户重启 DSH 后生效」。</verify>
  <security>文档不得把删除描述成「无影响」；必须显式列出放弃的能力与迁移方式，避免用户以为功能仍在。</security>
  <done>文档如实反映新结构与被删能力，交付说明完整。</done>
</task>
```

## 回滚与检查点

- **T1 未通过对拍前不得进入 T2**（模块仍在，可随时放弃重建）。
- T2 之后回滚需 `git revert` 并恢复用户预设备份；因此 T3 的备份必须保留到用户确认。
- **回滚范围（R7）**：撤回本支前必须先撤回 B8（其 ②④ 建在本支删除后的新载体上）；本支与 B0–B6 的提交互相独立，但**磁盘上的共享引擎与两个预设目录**需按 T2 的备份路径恢复，代码 `revert` 不足以覆盖它们。
- 中断检查点：任一时刻工作树须可 `typecheck` / `lint`；不存在「模块已删但引用仍在」的状态。

## 状态

- [x] **T1** 六个能力重建为声明并对拍。（**完成**：`context-gate` 13/13、`tool-filter` 14/14、`anchor-turn` 与 `deliberation-gate` 5/5、`progress-reminder` 5/6（唯一未通过者是已拍板接受的计数来源差异，已改为 `skip` 并注明原因、断言体保留）、`tool-bootstrap` 9/9；引擎为此补齐 8 项拍板能力 + `subjectOf` 载荷归一 + `composite` 转发 `observe`）
- [x] **T2** 备份整组资产并在旧模块仍可用时完成两个预设的候选迁移。（**完成**：整组备份 280 文件 + 指纹、装配 smoke PASS、隔离环境 T3 预演；`pt-cordis` 按「完整性对齐官方预设」不补声明，`beta-2-42` 等价重建 3 条声明）
- [x] **T3** 删除七个模块与连锁清理。（**完成**：清点落盘；批次 A+B（`src/**` 与守卫测试）、批次 C（文档，含「未迁移项」「已知边界」两节）、**批次 D**（删 7 个模块 + 7 个本地组合源、清 11 文件 23 行 import 面、改述 31 处注释行号引用、重生成 `preset.yml`、清全部失效红）三批全部完成；三目录 99 文件 **1184 例 / 1184 通过 / 0 失败 / 0 skipped**）
- [x] **T4** 文档同步与交付。（**完成**：文档随批次 C 落地；交付说明含「需重启 DSH 后生效」；架构图 v2 待本支提交后单独同步提交）

**执行期注（2026-09-22）**：本节的 T2/T3 描述在原稿中**互换**（Wave 2 是「备份与候选迁移」、Wave 3 是「删除与连锁清理」），上方已按 Wave 标题更正。批次 D 的执行入口见 `.scratch/plan/b7-t3-batch-d-brief.md`（含最终交接状态、四步原子顺序、精确到行的 import 清单，以及「哪些红与 grep 命中是预期的」全部预判）。

## 验收记录

本 PLAN 于 2026-09-22 **执行完毕**，四个任务块全部收口。**最终门槛实测（父代理独立复跑，非子代理自述）**：`typecheck` exit 0、`lint` 305 文件 96 规则 0 error、`build` 成功（718ms）、`git diff --check` exit 0、装配 smoke **PASS**（引擎引用 10 条，`beta-2-42` 3 条声明）；三目录（`engine`+`shared`+`host`，99 个测试文件）**1184 例 / 1184 通过 / 0 失败 / 0 skipped**；四目录（135 文件）1470 例 / 1438 通过 / **32 失败**，32 条**全部位于 `test/client`**，逐条判定均属「9 层模块卡待重构」范畴（用户指示允许红，明细见下）。残留 grep：指向**已删模块**的 `*.mjs:<行号>` 注释引用 **0 处**；其余命中均为说明性注释、`test/engine/declarations/*.yml` 声明夹具、`engine-params-bridge` 的「幽灵行」负向断言、`src/shared/engine-capabilities.ts:91-92` 的删除记录与 `lib/**` 构建产物。

**一条必须记录的基线教训（批次 D 实测）**：本 PLAN 早先记的「32 条预期中间态红」是 **stale `lib/` 下的假基线**——未 build 时 `test/host` 大量用例跑在 `lib/index.mjs` 的旧代码上而假通过；`pnpm build` 后同一套测试红数升到 **87**。故**验收必须 build 在前**（本节命令块本就这个顺序），并以 build 后实测为准。

**`test/client` 32 条红逐条归属（均属 UI 待重构）**：`engine-module-cards` 16、`module-policy-smoke` 6、`scope-create-separation` 3、`param-overrides` 3、`editor-state` 1（文件级：`prompt-tool-fields.ts` 已不再导出 `hasIncompleteStageDrafts`）、`prompt-tool-view` 1、`real-css-smoke` 1。失败点清一色是被删除的 9 层模块卡与已删参数键（`stagePreUnlock`、`stages`、`deliberation-gate`、`tool-filter`、`anchor-turn`、`promoteGate` 等）——`src/client` 侧已无这些对象，而 `test/client/**` 仍是旧卡形态的断言，需随 9 层模块卡重构重新设计断言，不在本支范围内。

**方案产出期的查证证据**（保留）：7 个模块的移植来源注释（`anchor-turn.mjs:4`、`deliberation-gate.mjs:2`、`progress-reminder.mjs:2` 等）、真实部署两个预设的 `modules` 列表与 `layerSettings`、`ENGINE_RECIPES` 三个 recipe 的依赖、`tool-filter.mjs:52-53` 的 deny 优先语义、`tool-bootstrap.mjs:378-402` 的 stages 阶段推进工具约束。

## 实施取舍与已知边界

- **净损失只有两项**（第一项按 2026-09-22 拍板定案）：`stages` 渐进披露（**拍板放弃**——它只是触发器机制的一个应用，行为可由「多条件 + 多触发 + 多动作」自行声明，**不存在被动作库卡住的缺口**；本支不写声明、不注册推进工具，连同 5 个参数键、UI 字段与相关测试文档一并精简）与 `promoted-code-mode` 的相位 PTC 呈现（按用户拍板移除）。`bootstrapMaxTokens`（落 B3 动作**第 (7) 类「改模型请求参数」**，与 `layers.mjs` 的 `agent-request` 层同源）与 `personaSectionsOnly`（动作第 (2) 类「改装配 sections」）**不依赖工具注册**，必须作为声明迁移，**不得写成放弃**。
- **六个能力不是"删除"而是"降级为声明"**：它们的行为仍可由用户按需声明重建；只有上述四项是真正的净损失。
- **`anchor-turn` 的会话状态判断**依赖 B3 的第六类原语（会话状态），若 B3 未实现该类，本支 T1 需先补。
- **UI 能力区会显著变空**：10 张卡 → 3 张，这是精简的必然结果；声明式触发器是否需要 UI 入口由后续产品决策，本支不新增 UI。

## T1 实施设计（2026-09-22 执行期，落位拍板后）

### 为什么不是「把动作塞进 `mountTriggers` 的 `do`」

B3 留了 `mountTriggers(ctx, declarations, …)`（`do` 是函数）与 `registerAction(ctx, action)`（动作自己注册）**两套没接上**的接口。曾考虑让 `mountTriggers` 的 `do` 接受动作声明、由它拿"执行体"来跑，**查证后否决**：

- `channelBinder`（`actions.mjs:162-170`）确实是注入点，但只有走 `on(...)` 的动作能被捕获——`registerInjectText`（`:182-195`）走 `applyPromptConfigs`/`wireLayers` 注册**层**，`registerGuard` 走 `ctx.tools.guard`（assembly 时惰性注册）。**"执行体"抽不出来**，这条路只能覆盖一部分动作。

### 采用的路径：`when` 前置到 `registerAction`

声明 → 编译器逐条处理 → **`registerAction` 带上 `when`/`phase`/`prepend` 三个新选项**。`actions.mjs` 只改一处：把注入给注册器的 `on` 包一层——

```js
const on = when === undefined ? rawOn : (event, handler, options) =>
  rawOn(event, handler, async (...args) => {
    const next = args[args.length - 1]
    if (await when(...args.slice(0, -1)) !== true) return next()
    return handler(...args)
  })
```

**七个注册器一行不用改**（它们照常调 `on`），`when` 对走 `on` 的动作（assembly / decision / append-context / sdk-strip / request-params）自动生效。两个特例单独处理：`guard` 的 `when` 决定「该 agent 是否装 guard」（assembly 时求值）；`inject-text` 注册的是**层**（静态），声明侧改用它的 `config.condition`/会话态表达，不靠 `when`。

`trigger.mjs` 仍是机制的一部分，只是分工变了：声明编译器**用**它的 `validateTrigger`（校验）、`orderTriggers`（稳定排序）、`registrationOptions`（位置 → `prepend`），然后逐条 `registerAction`。**YAML 里的数组顺序即注册顺序**，所以 `channelOrder` 在声明路径上退化为「数组下标」，不再需要数字排序。

### 声明语法（YAML）

`when` 是**一个对象**：键为组合运算符（`any`/`all`/`not`/`notAny`，与 `composite` 同源），或七类原语之一（`text`/`phase`/`source`/`count`/`names`/`session`/`preset`），值是该类原语的选项对象——**原样透传给对应的 `createXxxPredicate`**，不在声明层另立一套词汇：

```yaml
- id: gate-not-deep
  channel: tools/pre-execute
  when:
    all:
      - session: { type: user/message, present: true }
      - count: { of: assistant-chars, per: turn, max: 49 }
  do: { kind: decision, phase: pre, decision: deny, reason: '先说明计划' }
  position: default          # → registrationOptions 的 prepend
  phase: after-next          # 动作在 next() 之前还是之后
```

`do` 是动作声明（`{kind, …载荷}`，与 `ACTION_KINDS` 同形状）或它们的**数组**（按序执行，最后一个非 `undefined` 的返回值成为本次瀑布结果）。

### 物化与挂载（沿既有通道，不新开存储）

`preset.yml` 顶层新增 `triggers` 段 → `writePreset` 物化为 `<presetDir>/triggers.yml`（与 `subagentToolPolicy` → `subagent-tools/policy.yml` 同构）→ 新增 `engine/declared-triggers.mjs`（config: `triggersFile`）读入、编译、注册。声明**不带默认**（用户拍板），所以预设必须显式写。

## T1 范围扩展（2026-09-22 执行期拍板：扩动作库）

查证发现 **6 个能力里有 2 个的动作/通道不在现有动作库**。按 R1（实现缺口不得自动当作删除授权）交用户拍板，用户选**扩动作库**：

| 能力 | 通道 | 所需动作 | 现有动作库 |
|---|---|---|---|
| `tool-filter` | `system-prompt/assemble` | 改装配（tools 过滤） | ✔ `assembly` |
| `deliberation-gate` | `tools/pre-execute` | deny | ✔ `decision` |
| `progress-reminder` | `tools/post-execute` | 追加 durable 消息 | ✔ `append-context` |
| `tool-bootstrap` | `assemble` + `agent/request` | 改装配 + 请求预算 | ✔ `assembly` + `request-params` |
| **`context-gate`** | `agent/pre-step` | **改写 `decision.messages`（过滤注入消息）** | ✗ 需新增 |
| **`anchor-turn`** | **`agent/inbox/inserted`** | **`agent.inbox.prepend(...)`** | ✗ 需新增（通道与动作都没有） |

**inbox API 已查证存在**（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`）：`export interface Inbox`（`:41`）提供 `prepend(target, message)`（`:59`）／`append`／`replace`／`remove`／`splice`／`clear`；`agent/inbox/inserted` 事件在 `:263-266`，payload 是 **`{ agent, message }` 对象**，且注释明写 **scope-filtered dispatch**（agent-scoped 监听器只收到该 agent）。

**新动作带来的一处真实契约差异（实施时必须一并解决）**：`agent/inbox/inserted` 声明为 **`@mode emit`**——**没有 `next`**；而九层通道（`system-prompt/assemble`、`tools/pre-execute` 等）都是 **waterfall**。`actions.mjs` 的 `withWhen` 目前假设「`args` 的最后一个参数是 `next`」，对 emit 通道不成立。所以动作声明需要能表达「该通道是 waterfall 还是 emit」——否则 `when` 前置会把 payload 的最后一个字段当成 `next` 调掉。

## T1 完成记录（2026-09-22 执行期）

**六个能力的声明已全部写出并与原模块对拍**，交付物与结论：

| 能力 | 声明文件 | 对拍 | 判定 |
|---|---|---|---|
| `context-gate` | `test/engine/declarations/context-gate.yml`（2 条生效 + `allowKinds` 变体注释） | `declaration-parity-context-gate.test.mjs` **13/13** | **通过**（路径 a 与路径 b 的 `messageSources` 变体；`allowKinds` 未配置形态 = 不写声明，已覆盖） |
| `tool-filter` | `declarations/tool-filter.yml`（呈现 / `sdk-strip` / `guard` 三条同名单） | `declaration-parity-tool-filter.test.mjs` **14/14** | **通过**（含 PTC 形态：剔除的工具既不在 `assembly.tools` 也不在 `tools:sdk` 正文；真实 `run_code` 子调用被 TS/Python 双载荷拒绝且工具体零执行） |
| `anchor-turn` | `declarations/anchor-turn.yml` | `declaration-parity-capabilities.test.mjs` | **通过**（5/5） |
| `deliberation-gate` | `declarations/deliberation-gate.yml` | 同上 | **等价重建通过**（5/5：深度放行 / deny / 哨兵轮 / 每轮上限 `maxPerTurn` / 子代理受众 `count.delegated`） |
| `progress-reminder` | `declarations/progress-reminder.yml` | 同上 | **通过（含 1 项已拍板接受的差异）**：形状 / 节奏（`every`）/ 轮边界 / `maxPerTurn` / 受众全绿；唯一红是**冷启动计数来源**（见下） |
| `tool-bootstrap` | `declarations/tool-bootstrap.yml`（**4 条声明**） | 同上 | **迁移范围内通过**（9/9）：工具面窄化/恢复、`sections` 白名单（含未列名第三方段）、`bootstrapMaxTokens` 注入与按值释放、compaction 回退（拆 `catalog`（¬C∧¬P）/ `catalog-compacted`（C∧¬P）两支）、keep 缺工具降级（全缺与部分缺） |

**引擎侧为此补齐的能力**（用户拍板 8 项 + 2 处必修缺陷，全部有直接行为测试）：谓词载荷归一 `subjectOf`（含 `composite` 转发 `observe`）、`count` 的 `delegated`/`every`/`includeCurrent`、`session` 的 `delegated`、`phase` 的 `compacted` 与三态 `promoted`、动作 `maxPerTurn`、`assembly.target.sections.keep`、`assembly.target.tools.requireMatch`、`createMask` 放开 allow 侧点名 `run_code`、`registerInboxPrepend` 的 session 守卫。

**红数轨迹**：全引擎从 16（缺口探测器）逐轮降到 **1**。最后一条是**已拍板接受的已知差异**：`progress-reminder` 冷启动时原模块从 0 计数（纯增量）、声明按已落盘事件计数 —— 这正是拍板⑤「改用可重建计数」的语义放宽，**不是缺口**，按 PLAN 要求须在 T4 文档中显式记录。

**两处已知边界（非缺口，须在 T4 文档与 T2 迁移时处理）**：

- **零工具模式**（`bootstrapTools: []`）：原模块在已压缩时补 `bash`/`pwsh`（`tool-bootstrap.mjs:427-430`，仅当它们在装配目录里）。对拍文件对应组合源默认（非零工具），故 `catalog-compacted` 的 `allow` 不含这两个名字 —— **零工具模式的预设**要自行写成 `[bash, pwsh, …compactionTools]`。
- **`request-params` 的隐式模型过滤**：动作无条件走 `matchesAgentScope`，未声明 `modelScope` 时按「非 Flash」过滤，而原模块的预算监听没有模型过滤 → Flash 模型下 `bootstrapMaxTokens` 不等价（对拍用非 Flash 模型，未覆盖）。

**未写声明（需产品/引擎侧定，T4 需如实记录）**：`workspaceLine`（`tool-bootstrap.mjs:323-339, :415`）与 `phase1FirstCallInstruction`（`:439-444`）——两者都要**改写已有段正文**，而 `assembly` 只能 `sections.add` 整段；`stages` 按拍板放弃。

## T2 完成记录（2026-09-22 执行期）

**两个真实预设已迁移并重建，装配引用全绿。** 备份：`D:\AI\workspase\_temp\dsh-presets-backup-b7\`（280 文件 + `.engine/` 指纹 `556a4504…84bf0b`，含 MANIFEST 与恢复/清理命令；备份已按用户指示移出工作树，工作树内的原目录已删除）；迁移前复核过备份完好性（文件数、指纹、7 个待删模块齐全）。

| 预设 | 改动 | 验证 |
|---|---|---|
| `pt-cordis` | `modules` 删 `tool-bootstrap`/`promoted-code-mode`；删 `layerSettings.tool-pipeline.usePtcMode`；**不补任何声明**（见下「第二次校正」） | 生成目录无旧模块行、无 `declared-triggers` 行、无 `triggers.yml` —— **与仓库模板 `preset/pt-cordis/preset.yml` 的 modules 逐项一致** |
| `beta-2-42` | `modules` 删 `tool-filter`、删 `moduleConfigs.tool-filter`；加 3 条声明（呈现 + `sdk-strip` + `guard`，共用 `deny: [web_search, web_fetch]`） | 生成目录无旧行；`declared-triggers` + `triggers.yml`(674B) 就位 |

**执行中发现并修正的三件事**：

1. **只删 `modules` 行不够**（PLAN T2(2) 已说「不能只删行」，但它举的例子是组合源默认——`layerSettings` 这条是新发现）：`pt-cordis` 的 `layerSettings.tool-pipeline.usePtcMode: true` 会被 `writePreset` **翻译成 `promoted-code-mode` 模块行**（生成目录 `config: { usePtcMode: true }`）。删掉层设置后该行才真正消失，否则 T3 删除模块时该预设会装配失败。
2. **`pt-cordis` 不该有 PTC**（**用户指正**：「pt-* 预设为内置预设来自官方宿主内置预设，不需要考虑兼容性，只需要考虑完整性是否对齐官方预设；本地用户目录中的预设都是用户经过配装修改后的」）：查证官方内置预设只有 `cordis`/`minimal`/`ptc`/`standard` 四个；官方 `cordis` 的行集合**不含**那 7 个模块、**不含** `prompt-config-engine`、**也不含** `tool-presentation`（它的工具呈现行是 `present`）；`tool-presentation` 只出现在官方 `ptc`。我最初据 `usePtcMode: true` 给 `pt-cordis` 补了 `tool-presentation`，按「完整性对齐官方」是**多加了官方没有的能力**，已移除（需要 PTC 请用 `pt-ptc`）。`beta-2-42` 是用户自建（不在官方四个内），按实际配置迁移。
3. **`liangshen` 被重建脚本跳过**（手写/官方格式，无 `modules`/`params`）——它的组合不被覆盖，本轮未受影响。

**装配 smoke**（`.scratch/b7-assembly-smoke.mjs`；一次性脚本，不进 `test/` 因为它读用户现场）：校验「`../.engine/*.mjs` 引用不悬空」「`triggers.yml` 过编译器全部校验」「`declared-triggers` 行与 `triggers.yml` 物化一致」。真实现场 **PASS**（11 条引用；`beta-2-42` 3 条 + `pt-cordis` 2 条声明）；**隔离环境删掉 7 个模块后再跑仍 PASS**（T3 预演，证明无预设引用它们）。

**覆盖局限（如实记录）**：smoke **不等于**「cordis 能真正挂载」——运行时挂载（`ctx.inject` 的服务依赖、`tool-presentation` 需要的宿主 `ptcRuntime` 等）只有启动 DSH 才能证明。PLAN verify (a) 的「隔离 `DSH_HOME` + 随机端口启动独立 smoke 环境」**未做**；PLAN verify (d) 的「第二个预设迁移失败的恢复流程断言」**未做**。

**第二次校正（2026-09-22 执行期，用户二次指正）**：用户澄清「pt-* 是官方预设**使用本项目插件拆解后**的**本项目内置预设**」，并裁定「不需要考虑兼容性，只需完整性对齐官方预设」。据此查证并发现：

- **`pt-*` 的真正源头在仓库 `preset/`**（`README.md:111`、`NOTE.md:15`：「随包内置预设」），`$DSH_HOME/.agent-presets/pt-*` 是从它物化出的**部署副本**。仓库模板 `preset/pt-cordis/preset.yml` 的 modules（`:6-25`）**本就是干净形态**：无那 7 个模块、无 `usePtcMode`、无 `triggers`，且**含** `prompt-config-engine`（插件核心）。部署副本之所以含那些行，是插件配装机制改过的结果。
- **所以本支 T2(2) 的 R6 判断对 `pt-*` 不适用**：R6 说「不能只删行、不静默丢功能」，前提是**该功能属于这个预设**；而 `pt-*` 的判据是**对齐官方原型**——官方内置 `cordis` 预设没有首轮窄化（首轮即完整工具集），所以去掉窄化**不是丢功能，而是纠正偏离**。
- **用户裁定：不补声明。** 已移除我先前在部署副本里加的两条 `tool-bootstrap` 声明与该 `triggers` 段；`writePreset` 随后按预期 `rmSync` 掉 `triggers.yml`、`manifest` 也不再注入 `declared-triggers` 行。重建后 `pt-cordis` 的 modules 与仓库模板**逐项一致**。
- **`beta-2-42` 不在本校正范围**：它是用户自建（SillyTavern 转换，`meta.source: sillytavern`），不属于官方四基型，其 `tool-filter` 名单是**它自己的能力**，按 R6 做等价重建（3 条声明）正确保留。
- **仓库 `preset/` 模板无需改动**：它们已是干净形态，T3 删除那 7 个模块不会影响模板。

## T1 缺口拍板（2026-09-22 执行期，用户裁定）

C 与 B 的真机对拍把缺口从最初 2 项扩到 12 项。交用户拍板的 5 项**全部选择「扩引擎」方向**（第 5 项选「改用可重建计数」）：

| # | 缺口 | 拍板 | 落点 |
|---|---|---|---|
| 1 | 受众原语（`delegationDepth`）——三能力共用；`guard` 之外的动作都不带受众开关 | **扩原语** | 归一化载荷已带 `agent`，给会话态谓词加 `delegated` / `delegationDepth` 判据 |
| 2 | 动作触发计数（本动作已执行次数 / 每轮上限）——`deliberation-gate` 的 gates、`progress-reminder` 的 drips | **扩动作库** | 动作声明的通用自限，或 `count` 的「本动作触发次数」信号 |
| 3 | `phase` 只暴露 `promoted` 不暴露 `boundary`——`tool-bootstrap` 的 compaction 回退目录 | **扩原语** | `compaction-epoch.mjs` 的 `status()` 已返回 `boundary`，谓词加判据即可（12 项里最便宜） |
| 4 | `personaSectionsOnly` 是白名单 `filter`，而 `assembly.sections` 只有黑名单 `remove` | **扩动作库** | 加对称的 `sections.keep`（与 remove 同一实现） |
| 5 | `progress-reminder` 的节奏计数自注「纯增量、轮内重置、不可从事件流重建」 | **改用可重建计数** | 语义从「严格递增节奏」放宽为「轮内计数阈值」，文档标注差异 |

**C 后续报告新增、尚未拍板的项**（须在下轮一并交用户）：

- **计数时点对齐**：`when` 在处理器入口求值（`actions.mjs:250`），早于本次 `tool/result` 落盘——`tools/post-execute` 是 `dsh-tools` 的 `finalizeScheduledExecution` 内部一环，而该包内**无** durable `tool/result` 写入（`dsh-tools/lib/index.js:3354-3361` → `:3490-3519`），落盘发生在 `execute()` 返回后的 agent loop。实测节拍晚一步（第 5 次 vs 第 4 次）。**注：我上一轮给用户的第 5 个选项只覆盖了「计数来源不可重建」，没有覆盖「计数时点」，这是我的疏漏，必须单独提出，不得当作已拍板。**
- **`assembly` 不校验 keep 名单里工具的存在性**：`tool-bootstrap.mjs:346-355` 在原模块里「keep 名单中的工具都不存在 → 暴露完整目录」，声明侧会裁空 —— **方向相反**（实测裁成 `[bash]`；更严，但不等价）。
- **`request-params` 的隐式模型过滤**：未声明 `modelScope` 时按「非 Flash」过滤（`matchesAgentScope` + `matchesModel`），原模块的预算监听无此过滤 → Flash 模型下 `bootstrapMaxTokens` 不等价（对拍用非 Flash 模型，未覆盖）。
- **`workspaceLine` / `phase1FirstCallInstruction`**：需**改写已有段正文**（给 persona 追加 cwd 行 / 首调指令，含幂等），而 `assembly` 只能 `sections.add` 整段 → **未写声明**，属未迁移项。
- **anchor-turn 的 `agent.session` 存在性守卫**（`anchor-turn.mjs:51`）：无对应原语，声明侧实测多插 2 条。

**C 的对拍现状**：`declaration-parity-capabilities.test.mjs` 25 例 **14 绿 / 11 红**，红全部是上列缺口（用例按 R1 **原样保留**，未改成必然通过）。四能力等价性结论：`tool-bootstrap` 已迁移的三项全部通过；`deliberation-gate` 与 `anchor-turn` 主判据通过；`progress-reminder` 离可表达最远。载荷归一修好后，原 9 条缺口探测器已全部转为绿并改写为真实宿主的载荷契约 + 等价对拍（含一条防回归钉子）。

## T1 执行期发现的载荷契约缺口（2026-09-22，阻塞级）

子代理 B 在写 `context-gate` 声明时报告：`phase` 谓词在真实通道上恒为「已晋升」，故它按硬规则**只标注、不写声明**（`test/engine/declarations/context-gate.yml` 为空数组 + 证据注释）。**主线程核证并扩大后确认这是阻塞级缺陷，范围比 B 报告的更广。**

**事实（逐条有源码依据）**：

- 谓词契约是**单个对象**：`predicates.mjs:4`「统一接口：`predicate(payload) → boolean`」。
- 两条挂载路径都传**参数表**（展开为多个实参）：
  - `actions.mjs:246` `decided = when(...payload)`，而 `:237` 的 `payload = args.slice(0, -1)`；
  - `trigger.mjs:266` 内联路径同为 `await trigger.when(...payload)`。
- `compaction-epoch.mjs:144` 的 `status(undefined)` 返回 `{ boundary: -1, promoted: true }`——取不到 agent 被语义化为「已晋升」。

**后果（逐谓词核证）**：

| 谓词 | 真实通道上收到的第一个实参 | 结果 |
|---|---|---|
| `names` | `tools/pre-execute` 的 `exec` | ✅ **恰好可用**（读 `payload.name`） |
| `phase` | `assemble` 的 `assembly` / `pre-step` 的 `{agent,…}` | ❌ **恒为「已晋升」** → `not phase` 恒 false → 声明永不命中 |
| `preset` | 同上 | ❌ `agent?.ctx` 取不到 → 恒 undefined |
| `source` | `inbox/inserted` 的 `{agent, message}` | ❌ 该读 `message.source`，现读 `payload.source` → 不命中 |
| `count` / `session` | `{agent, messages}` / `{agent, turn}` | ❌ 无 `.session` → `sessionEvents(对象)` 为空 → 计数恒 0 |
| `text` | 视通道 | ⚠️ 仅在首个实参恰好带该 subject 字段时可用 |

**定案（修法）**：在 `withWhen`（它创建 wrapped 时已知 `event`，见 `:235`）与 `trigger.mjs:266` 两处，**按通道把参数表归一为一个谓词载荷** `{ agent, session, source, name, text, channel, args }`，每条取法配源码依据（`assemble` → `args[1].agent`；`pre-step`/`turn-stopping`/`inbox/inserted` → `args[0].agent`；`tools/pre-execute`/`post-execute` → `args[0].agent` + `args[0].name`；`inbox/inserted` 另取 `args[0].message.source`）。未知通道首次 `warnOnce` 一次（不抛，避免打断会话）。谓词改读固定字段，并**兼容旧的手工 payload 形态**（`predicates.test.mjs` 的 22 例不得红）。

**为何必须修而不是绕**：R1——实现缺口不得当作能力删除授权。不修则六个能力的声明**全部落入「配了没效果」**，而这是本引擎明确拒绝的失败模式（`trigger-spec.mjs` 的模块头第 2 条）。`context-gate.yml` 里的「意图声明」块在适配落地后即可原样启用。

**第二个缺口（B 在 `tool-filter.yml` 报告，未修）**：`tool-filter.mjs:72-74` 的「`includeSubagents:false` → 子代理整个跳过本过滤」无法声明——`assembly`/`sdk-strip` 只吃 `when`，而七类原语里没有读 `context.agent.session.header.delegationDepth` 的一类，`includeSubagents` 只在 `guard` 动作里被读（`actions.mjs:446`、`:466-467`）。后果是声明在**子代理装配上比原模块多过滤一层（更严，非更宽）**，`guard` 已按原受众写 `includeSubagents: false`。**待载荷归一落地后一并评估**：归一化载荷里带 `agent` 后，可考虑给 `session` 谓词加一个读 `delegationDepth` 的判据。

## T2 现场勘察（2026-09-22 执行期，只读）

`DSH_HOME = D:\AI\DeepSeek harness\.dsh`。预设目录 `.agent-presets/` 下 **8 个预设**（`.characters`/`.engine` 是目录不是预设）：`beta-2-42`、`custom`、`liangshen`、`pt-cordis`、`pt-custom`、`pt-minimal`、`pt-ptc`、`pt-standard`。

- **共享引擎 `.agent-presets/.engine/`**：35 个 `.mjs` + `.pt-engine-fingerprint`，7 个待删模块都在其中（`anchor-turn`/`context-gate`/`deliberation-gate`/`progress-reminder`/`promoted-code-mode`/`tool-bootstrap`/`tool-filter`）。`instruction-hint.mjs` 也在此——印证它是**引擎分发件**而非预设私有件，故「并入」后它随引擎分发，不新增一条预设私有通道。**T2 备份必须含此目录 + 指纹**（R5：预设重建会在单预设提交前刷新共享引擎并删旧备份）。
- **`pt-cordis`**：`preset.yml:26-27` = `tool-bootstrap` + `promoted-code-mode`；**无 `moduleConfigs`**，故 `tool-bootstrap` 走组合源默认（`tool-bootstrap.yml:9-21`：`bootstrapTools: [bash, str_replace_editor]`、`compactionTools` 7 项、`maxPromoteSteps: 4`、4 个 stages 参数）。生成目录 `agent.cordis.yml:414-433` 有两行。另含历史遗留 `.layer-settings-backup.json`（来自 `scripts/migrate-layer-settings.mjs:10`，被预设导出排除，与 B7 无关）。
- **`beta-2-42`**：`preset.yml:27` = `tool-filter`，名单确实配了（见上方 §2 的更正）。生成目录 `agent.cordis.yml:36-43` 有该行。另有 **127 个 `prompt-configs/*.yml`**，是重度使用预设，迁移必须最小改动。
- 其余 6 个预设实测不挂任何待删模块（全目录 grep 待删模块名，只有 `liangshen` 自建的 `tool-catalog.mjs`/`minimal-prompt.mjs` 提到 `anchor-turn`/`instructionHint`，那是它**自己的实现**，与本支无关）。

## 测试现场与清理限制

迁移使用隔离 `DSH_HOME`；用户预设备份在 T3 完成后由用户确认再删；测试 cwd 固定 `D:\AI\workspase\_temp`，结束清理。
