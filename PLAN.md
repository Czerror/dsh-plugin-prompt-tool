# 内置预设保留名表与安全 id 收口（补 `pt-cordis`）

## 授权与基线

- 用户指令（2026-09-18）：「用户预设目录下缺少 `pt-cordis`，使用 `creative` 会和官方冲突」；并确认默认预设切到 `pt-standard`。
  **随后明确「这样才正确对齐官方」：插件包内模板应对齐官方命名（`creative` → `cordis`），数据侧产出 `pt-cordis`。**
- 事实纠正（读源码得到）：官方 shipped 预设里并没有 `creative`——官方那个「创造模式」是 `cordis` 预设
  （`deepseek-harness/packages/preset/agent-presets/presets/cordis/preset.yml` 的 `name: 创造模式`）。
  因此 `creative` 目前**不被遮蔽**；但插件包内模板 `creative`（persona 通篇是 Cordis 组合创作指导）与官方 `cordis` 同源，
  属官方语义上的保留名，且用户要求统一 `pt-` 命名——故纳入保留名表，用户目录改用 `pt-cordis`；
  **插件包内模板目录同步对齐官方命名为 `preset/cordis`（`id: cordis`），「新建 → 创造模式」从此产出 `pt-cordis`。**
- 代码基线：dev@`c21cc97`（工作树干净）。旧 PLAN 原文归档
  [plan-preset-id-safety-c21cc97-20260918.md](.scratch/prompt-tool-framework/archive/plan-preset-id-safety-c21cc97-20260918.md)
  （SHA-256 `78EF5A37C4C633E579BD0D2DED0C47B39B7DB7366C8CF66C2BC6639829B43B45`，与归档前 `PLAN.md` 逐字节一致）。
- 本轮范围：`src/host/preset-id-safety.ts`、`src/host/manifest.ts`、`src/index.ts`、`test/host/**`、
  `docs/architecture-params.md`、`CHANGELOG.md`、`README.md`、`PLAN.md`；
  仓库内模板改名 `preset/creative` → `preset/cordis`（含 `preset.yml` 的 id 与 `scripts/rebuild-composition.mjs` 的目标映射）、
  `AGENTS.md`/`NOTE.md` 的模板路径引用；
  用户数据侧：`.agent-presets/creative` → `pt-cordis`、三个 `pt-*` 目录的 `preset.yml` id 收口、
  `settings.yaml` 的 `agent-presets.default` 与 `prompt-tool.presetTemplate` → `pt-standard`。
- **不在本轮范围**：工作台遮蔽标记；其他用户预设（`custom`/`liangshen`）的命名；宿主内置预设本身。

## 事实依据（读源码与真实目录得到，作为不变量）

1. 官方 presets（安装包 `0.1.6-alpha.2` 与本地 master 一致）只有 `cordis`/`minimal`/`ptc`/`standard`，其中 `cordis` 的
   显示名是「创造模式」；插件包内模板 `creative` 的 `name` 与 persona 文本与之同源。
2. 本机 `.agent-presets` 现有：`creative`、`custom`、`liangshen`、`pt-minimal`、`pt-ptc`、`pt-standard`；
   `standard-copy`/`ptc-copy`/`minimal-copy` 与旧的被遮蔽目录已被清理，而 `settings.yaml` 的默认预设仍写着 `standard-copy`
   （**指向不存在的目录，新会话会报找不到预设**）。
3. `ensurePresetSeed` 只改目标目录名、不写 `preset.yml` 的 `id` ⇒ `pt-standard/preset.yml` 至今写着 `id: standard`；
   插件内 `findPresetDir` 的「目录名优先、id 兜底」匹配会把 `standard` 解析到 `pt-standard` 目录，是真实歧义。
4. `ensurePresetSeed` 在 `apply` 开头运行，此时占用集合只有磁盘探测结果；服务就绪后的 `refreshOccupiedFromHost`
   只更新集合与归一化激活预设、**不补建** ⇒ 探测漏掉的 id 不会生成安全副本（本机缺 `pt-cordis` 即此形态）。

## 目标语义

| 场景 | 行为 |
|---|---|
| 包内模板名命中保留名表（`cordis`/`minimal`/`ptc`/`standard`/`creative`）或探测/服务给出的占用 | 种子化与「新建」落 `pt-<模板名>` |
| 插件包内模板名 | 与官方 id 对齐（`creative` 模板改名为 `cordis`），「新建 → 创造模式」因此产出 `pt-cordis` |
| 生成或克隆出的安全目录 | `preset.yml` 的 `id` 同步写成目标目录名（消除 id 与目录名不一致） |
| 宿主服务就绪后拿到更全的占用集合 | 除归一化激活预设外，**补建缺失的安全副本** |
| 已存在的用户预设（`custom`/`liangshen` 等非保留名） | 原样不动 |

## Wave 1：保留名表与占用集合合并

<task type="auto">
  <name>T1：保留名表常量与并集纯函数</name>
  <files>src/host/preset-id-safety.ts</files>
  <action>新增 `SHIPPED_PRESET_ID_RESERVATIONS`（`cordis`/`minimal`/`ptc`/`standard`/`creative`，附「官方语义保留名」注释）
  与 `mergeOccupiedPresetIds(...sources)` 纯函数（并集，忽略空值）。探测与服务结果统一经它合并，调用方不再各自拼 Set。</action>
  <verify>纯函数单测：并集去重、空源不影响、保留名始终在结果里。</verify>
  <security>仍只借用 id 名，不读其他根的预设内容。</security>
  <done>「哪些名字属于官方」只有一处定义。</done>
</task>

## Wave 2：生成物 id 收口

<task type="auto">
  <name>T2：种子化与新建同步写 preset.yml 的 id</name>
  <files>src/host/manifest.ts</files>
  <action>新增 `retargetPresetId(dir, id)`：用 yaml Document API 把 `preset.yml` 的 `id` 改写为目标目录名（保留注释与未知字段，
  内容无变化不落盘）；`ensurePresetSeed` 与 `cloneBuiltinPreset` 在复制后调用，失败只经 warn 暴露、不阻断复制。
  同时把包内模板目录 `preset/creative` 改名为 `preset/cordis`（`id: cordis`，`skills/` 随目录移动），
  `rebuild-composition.mjs` 的 `TARGET_PRESET_OVERRIDES` 随之取消（官方 `cordis` → 本地 `cordis`，同名不再需要覆盖）。</action>
  <verify>种子化出 `pt-standard` 后其 `preset.yml` 的 `id` 为 `pt-standard`；`custom`/`creative` 等未撞名模板的 id 不变；
  写入失败（目录只读）时复制仍成功并告警。</verify>
  <security>只改该预设自己的 `preset.yml` 的 `id` 键，其余字节保留；写盘沿用同目录暂存 + rename。</security>
  <done>目录名与 id 不再漂移。</done>
</task>

## Wave 3：服务就绪后补建

<task type="auto">
  <name>T3：占用集合更新后补建缺失模板</name>
  <files>src/index.ts</files>
  <action>把 apply 开头的「补建缺失模板」抽成 `seedMissingPresets()`，在 `refreshOccupiedFromHost` 更新集合后再次调用
  （服务给出的集合比磁盘探测更全时，把新识别的保留名补成安全副本）。</action>
  <verify>服务返回含 `creative` 的 system 集合时，用户目录出现 `pt-cordis`；集合未变化时不重复复制（幂等）。</verify>
  <security>只写预设根，不触碰其他根与包内模板。</security>
  <done>探测漏项不再是永久缺口。</done>
</task>

## Wave 4：回归测试

<task type="auto">
  <name>T4：保留名、id 收口与补建的行为回归</name>
  <files>test/host/preset-id-safety.test.mjs、test/host/user-presets.test.mjs</files>
  <action>补用例：保留名表含 `creative` 且并入探测结果；种子化在保留名集合下落 `pt-cordis` 且 `preset.yml` 的 `id`
  等于目录名；未撞名模板 id 不变；`cloneBuiltinPreset('creative')` 落 `pt-cordis`。</action>
  <verify>把保留名表清空时「creative 落 pt-cordis」用例必红；把 `retargetPresetId` 调用去掉时 id 收口用例必红。</verify>
  <security>临时目录 + 临时 DSH_HOME，结束清理。</security>
  <done>新语义有可失败的确定性回归。</done>
</task>

## Wave 5：数据侧切换、文档与交付

<task type="auto">
  <name>T5：用户目录切换到 pt-cordis 与默认预设收口</name>
  <files>用户数据（不入库）：`.agent-presets/creative` → `pt-cordis`、三个 `pt-*` 的 preset.yml id、`settings.yaml`</files>
  <action>目录改名 + 同步 `id` 与 `configsDir`；`pt-standard`/`pt-ptc`/`pt-minimal` 的 `preset.yml` id 收口为目录名；
  `agent-presets.default` 与 `prompt-tool.presetTemplate` 改为 `pt-standard`（当前指向已删除的 `standard-copy`）。</action>
  <verify>插件 `listPresets()` 列出 6 项且 id 与目录名一致；settings 指向存在的预设；宿主不再有「找不到预设」的条件。</verify>
  <security>只改本插件拥有的预设目录与两个 settings 键；不改宿主内置预设。</security>
  <done>用户目录与设置一致，且不再依赖会被遮蔽的命名。</done>
</task>

<task type="auto">
  <name>T6：文档、门禁、变异与提交</name>
  <files>docs/architecture-params.md、CHANGELOG.md、README.md、PLAN.md、.ai-memory/</files>
  <action>文档补保留名表与 id 收口；门禁 typecheck / lint / test / build / `git diff --check`；一组反向变异
  （清空保留名表应红掉 `pt-cordis` 用例）；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志。</action>
  <verify>门禁全绿；变异精确红；暂存只含本轮文件。</verify>
  <security>不停止运行中的 DSH；`.ai-memory` 与 `.scratch` 不入库。</security>
  <done>本轮交付完成。</done>
</task>

## 回滚

- 代码：`git revert` 本轮提交。
- 数据：目录名改回 `creative`、三个 `pt-*` 的 `preset.yml` id 与 `settings.yaml` 的默认预设改回原值即可；不涉及删除。

## Task Summary 与状态

- 当前：T1–T6 执行中（执行记录与门禁结果在本节回填）。

### 执行记录

- **T1（保留名表与并集）**：`src/host/preset-id-safety.ts` 新增 `SHIPPED_PRESET_ID_RESERVATIONS`
  （`cordis`/`minimal`/`ptc`/`standard`/`creative`）与 `mergeOccupiedPresetIds(...sources)`；
  占用集合统一为「保留名表 ∪ 磁盘探测 ∪ 宿主服务」，探测与服务都拿不到时仍按保留名表避让。
- **T2（模板对齐官方 + id 收口）**：包内模板 `preset/creative` → `preset/cordis`（`id: cordis`，`skills/` 随目录移动）；
  `rebuild-composition.mjs` 的 `TARGET_PRESET_OVERRIDES` 清空（官方 `cordis` 不再需要目标覆盖），
  新增库模块 `tool-plugin-manager`（cordis 启用态）与 `tool-plugin-manager-disabled`（standard/ptc 的 `disabled: true` 版），
  `standard`/`ptc` 模板 modules 相应加行；`manifest.ts` 新增 `retargetPresetId`，`ensurePresetSeed` 与 `cloneBuiltinPreset`
  复制后把 `preset.yml` 的 `id` 收口为目标目录名。
- **T3（服务后补建 + 补建保护）**：`src/index.ts` 把种子化抽成 `seedMissingPresets()`，启动与 `refreshOccupiedFromHost`
  更新集合后各跑一次；补建循环遇到目录名属于保留名的旧目录时跳过并告警（避免一次白写中断其它预设的重建）。
- **T4（回归）**：`preset-id-safety.test.mjs` 新增保留名表与并集用例；`user-presets.test.mjs` 新增
  「保留名表下创造模式模板落 `pt-cordis` 且 id 收口」「克隆落 `pt-cordis`」两组；受影响的三处既有期望值随官方行结构更新。
- **T5（用户数据，不入库）**：`.agent-presets/creative` → `pt-cordis`；四个 `pt-*` 预设用**包内新模板**重建
  （`rematerialize` 会以用户目录自身为模板，旧副本挡住包内新版，故先按模板重铺再渲染），id 与目录名收口；
  `settings.yaml` 的 `agent-presets.default` 与 `prompt-tool.presetTemplate` → `pt-standard`；
  **发现卡库 `.characters` 已在早前的清理中被删除**，按本会话早期读到的原文重建 `.characters/ponytail/converted.yml`
  并重新应用到 `pt-standard`（`apply` 返回 `count: 4`，`importedCharacters: [ponytail]`）。
- **T6（官方漂移同步）**：随官方 `dsh-0.1.6-alpha.2`（`ddefc45f`）：`cordis` persona 补 5 段
  （plugin_manager / Creator 模式 UI 插件 / `cordis_inspect_*` / MCP / installed bundles）、`standard`·`ptc`·`cordis` 新增
  `tool-plugin-manager` 行、`cordis` 两个技能同步为官方新正文；`engine/compositions/library/` 重建（22 处仅为来源提交号刷新，
  另新增 2 个模块），`test/fixtures/dsh/current` 快照与 `PROVENANCE.md`（来源提交 + 10 个文件指纹）同批更新。

### 反向变异验证

| 变异 | 期望失败 | 实测结果 |
|---|---|---|
| `SHIPPED_PRESET_ID_RESERVATIONS` 清空 | 保留名表相关用例 | **恰好 3 条红**（保留名表、种子化 `pt-cordis`、克隆 `pt-cordis`），其余 20 条绿 |

变异已回退；回退后全量 1058/1058 通过。

### 门禁结果

- `typecheck` ✓、`lint` 0 warning 0 error ✓、`build` ✓、`test` **1058/1058** ✓、`git diff --check` ✓。
- 未做（明确不在本轮范围）：工作台遮蔽标记；`custom`/`liangshen` 的命名；宿主内置预设本身。

[✔] Wave 1 / T1：保留名表常量与并集纯函数
[✔] Wave 2 / T2：种子化与新建同步写 preset.yml 的 id、包内模板对齐官方命名（`creative` → `cordis`）
[✔] Wave 3 / T3：占用集合更新后补建缺失模板
[✔] Wave 4 / T4：保留名、id 收口与补建的行为回归
[✔] Wave 5 / T5：用户目录切换到 pt-cordis 与默认预设收口
[✔] Wave 5 / T6：文档、门禁、变异与提交
