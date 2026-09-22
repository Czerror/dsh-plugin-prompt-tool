# B2 配置契约统一与能力开关单源 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支把「每个模块自己写白名单、自己写归一化、自己决定缺省语义」收敛为**一份字段声明 + 一个校验运行时**，并把能力启停收敛为**唯一事实源 `config.enabled`**。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；依赖 B1。
- 用户拍板：`enabled` 统一为 **fail loud**；`应该只使用一套事实源`。
- 本支是 B0–B6 中**唯一允许有行为变更**的支线（`enabled` 类型错误从静默变为报错）。

## 审查结论

### 1. 归一化 helper 重复（11 个等价实现）

| helper | 位置 | 返回 | `undefined` | 错误消息 |
|---|---|---|---|---|
| `nameSet` | tool-filter.mjs:37-43 | Set | undefined | `must be an array of non-empty strings` |
| `allowKindList` | context-gate.mjs:103-109 | Set | undefined | 同上（逐字相同） |
| `sourceList` | context-gate.mjs:112-118 | Set | undefined | 同上（逐字相同） |
| `deferredList` | context-gate.mjs:121-127 | Set | `new Set()` | 同上（逐字相同） |
| `stringList` | tool-bootstrap.mjs:140-145 | 去重数组 | 抛 | `must be a non-empty array of non-empty strings` |
| `stringListOrEmpty` | tool-bootstrap.mjs:147-150 | 数组 | `[]` | 委托上者 |
| `stringList` | subagent-tool-policy-core.mjs:21-37 | 去重数组 | `[]` | 收集进 errors，**不抛** |
| `booleanOption` | shared.mjs:21-27 | boolean | fallback | 抛 |
| `booleanOption` | subagent-tool-policy-core.mjs:40-42 | boolean | fallback | **不抛（同名异签名）** |
| `requiredInt` | shared.mjs:33-38 | int | 抛 | 抛 |
| `optionalPositiveInt` | tool-bootstrap.mjs:178-184 | int | undefined | 抛 |
| `requiredText` | shared.mjs:44-49 | string | 抛 | 抛 |
| `requiredStageField` | tool-bootstrap.mjs:190-195 | string | 抛 | 抛 |
| `normalizeEnvKeys` | run-code-env.mjs:43-53 | trim+去重数组 | 抛 | 两条不同消息 |
| `assertString` | subagent-tool-policy.mjs:58-61 | ToolArgsError | 可选静默 | **无插件名前缀** |
| `count` | st-world-book.mjs:28 | `min(v,1000)` | fallback | 静默 |

**`undefined` 的缺省语义有 7 种**（undefined / `new Set()` / `[]` / fallback / 抛错 / …），是「配了没效果」的温床。

### 2. 开关语义不统一

| 写法 | 模块 |
|---|---|
| `if (source.enabled !== true) return` | anchor-turn:44、deliberation-gate:41、tool-filter:63、progress-reminder:35 |
| `booleanOption(...,'enabled',false)` | context-gate:141、run-code-env:163 |
| `usePtcMode` 代替 enabled，**无 enabled 键** | promoted-code-mode:31-38 |
| **完全没有开关** | tool-bootstrap、tool-git-bash、subagent-tool-policy、tool-config-engine、prompt-config-engine、skill-search |

后果：`enabled: "yes"` 在前 4 个模块**静默关闭**，在 context-gate/run-code-env **挂载期抛**；写 `enabled: true` 到 tool-bootstrap / promoted-code-mode / tool-git-bash 会抛「未知键」。

### 3. 能力开关的事实源现状（用户拍板项）

| 机制 | 用在 | 判定 |
|---|---|---|
| `config.enabled` + 参数桥 `*Enabled` | context-gate / tool-filter / anchor-turn / deliberation-gate / progress-reminder（engine-params.ts:268-283） | **目标形态** |
| `config.usePtcMode` | PTC | 保留，语义收窄为「呈现方式」 |
| 「行是否在组合里」 | tool-bootstrap、tool-git-bash、全部工具 | **缺口**：UI 上关不掉 |
| `disabled:` | 平台条件（`!!js process.platform`，11 处）/ 树内子项 / 命名禁用变体（`tool-bash-disabled.yml:9`） | **不是能力开关**，保留 |

### 4. 四个插件行完全没有白名单

`prompt-config-engine.mjs:65-72`、`tool-config-engine.mjs:371-375`、`subagent-tool-policy.mjs:37-39,54-55`、`skill-search.mjs`（`apply(ctx)` 单参忽略 config）——未知键**静默忽略**，拼错键名不报错。

## 影响面、依赖与护栏

- 涉及：新增 `engine/fields.mjs`；迁移 9 个有白名单模块；补 3 个模块的 `enabled`；补 4 个模块的校验；`engine/compositions/source/local/*.yml`；`src/shared/engine-params.ts`（补参数桥 enabled 键）。
- 硬约束：字段声明的**校验结果与现状逐字段相同**（除 `enabled` fail loud）；错误消息格式统一为 `${plugin}: ${field} must be ...`；`subagent-tool-policy-core.mjs` 的「收集 errors 不抛」是**纯模块的刻意设计**（供 UI 预校验），保留但其函数改名以消除同名冲突（如 `collectBoolean`）。
- 冲突：本支只改 `engine/fields.mjs`、两个保留模块（`run-code-env`、`tool-git-bash`）与四个无白名单模块；**待删的 7 个模块不碰**（由 B7 先重建声明再删除，因此不存在「迁移完又被删」的白工）。

## Wave 1：字段声明运行时

```xml
<task type="auto">
  <name>T1：新增 engine/fields.mjs 字段类型系统</name>
  <files>engine/fields.mjs（新增）；engine/shared.mjs</files>
  <action>实现最小字段 DSL：bool({default}) / int({min,default}) / text({required,default}) / stringList({default, dedupe, allowEmpty}) / enumOf(values,{default})，每个字段提供 { parse(value, plugin, field) → 归一化值或抛 TypeError, key, default, optional }。配套 defineConfig(fields) 返回 { allowedKeys, parse(config, plugin) }：由声明派生白名单（替代手写 ALLOWED_KEYS）并逐字段归一化。错误消息统一 `${plugin}: ${field} must be ...`；缺省语义由每个字段显式声明（消除 7 种隐式缺省）。保留 shared.mjs 现有 helper 作为 fields.mjs 的底层实现，不复制逻辑。</action>
  <verify>单元断言：每个字段类型在 undefined / 正确值 / 错类型 / 空数组 / 空串 五种输入下的归一化结果与错误消息；defineConfig 对未知键抛错且消息含允许键清单（与 shared.mjs:52-64 现状一致）。</verify>
  <security>纯校验层，不接触 IO；不得把「错类型」降级为静默默认（这正是本支要消除的）；不得放宽任何现有校验。</security>
  <done>fields.mjs 可用，且其行为能表达现有 11 个 helper 的全部语义。</done>
</task>
```

## Wave 2：迁移与开关统一

```xml
<task type="auto">
  <name>T2：迁移保留模块到字段声明（待删模块不迁移）</name>
  <files>engine/run-code-env.mjs；engine/tool-git-bash.mjs（其余 7 个有白名单模块由 B7 先重建等价声明再删除，本支**不迁移**它们，避免做白工）</files>
  <action>把**保留的**两个模块（`run-code-env`、`tool-git-bash`）的 ALLOWED_KEYS + 手写归一化 helper 换成 fields.mjs 声明；config 键、类型、缺省、错误消息保持与迁移前逐字段一致（`enabled` 例外见 T3）。`run-code-env` 的 `normalizeEnvKeys` 若被测试直接 import（`test/engine/preset-engine-modules.test.mjs:181-186`）则保留导出但内部改用声明；`tool-git-bash` 的两处 `requiredInt`（timeoutMs / maxOutputBytes）改为字段声明。**待删的 7 个模块不动**——它们的等价声明由 B7 直接用 fields.mjs 书写，其现存 helper（`context-gate` 的三个孪生、`tool-filter` 的 `nameSet`、`tool-bootstrap` 的 `stringList`/`optionalPositiveInt`/`requiredStageField`）随模块一并删除，本支不迁移以免做白工。</action>
  <verify>逐模块对拍：同一组 config 输入下，迁移前后 (a) 归一化后的对象逐字段相等，(b) 抛错时消息相等，(c) 未知键行为相等。用既有测试 + 新增参数化对拍用例覆盖；全量测试绿。</verify>
  <security>迁移不得放宽校验：错类型必须仍抛错；空列表/空串的语义必须显式保留（如 allowKinds 空数组 = 只留 claimed 批，与 messageSources 不启用不同）。</security>
  <done>保留的两个模块（`run-code-env`、`tool-git-bash`）用字段声明；待删的 7 个模块不迁移；迁移面内的 helper 归零（必要的对外导出保留）。</done>
</task>
```

```xml
<task type="auto">
  <name>T3：enabled 统一为 fail loud，并补 tool-git-bash 的开关</name>
  <files>engine/fields.mjs（enabled 语义）；engine/tool-git-bash.mjs；engine/compositions/source/local/*.yml；src/shared/engine-params.ts；CHANGELOG.md</files>
  <action>(1) `enabled` 一律走 `bool({ default: false })` 的 fail loud 语义：`enabled: "yes"` 在**所有保留模块**挂载期抛错（行为变更，须在 CHANGELOG 标注）；待删的 7 个模块不迁移、不改——其能力开关语义随 B7 的等价声明自然继承。(2) 给 `tool-git-bash` 补 `enabled` 键；其平台条件 `disabled: !!js process.platform !== 'win32'` 保留不动（它是装配条件，不是能力开关）。(3) 参数桥补对应 `*Enabled` 键（仅 tool-git-bash）。(4) 在 docs 写明 `disabled:` 只用于平台条件 / 树内子项 / 命名禁用变体，**不是能力开关**。(5) `promoted-code-mode` 的 `usePtcMode` 随该模块在 B7 删除，本支不处理。</action>
  <verify>新增断言：`enabled: "yes"` 在全部 9+3 个模块一致抛 `enabled must be a boolean`；`enabled` 未声明 = 关闭（与现状一致）；参数桥 `*Enabled` 键与模块 enabled 双向可达（沿用 test/shared/engine-param-schema.test.mjs:113-130 的双向闭合机制）；tool-git-bash 的平台条件仍生效。既有组合源装配行为不变（各 yml 已显式写 enabled 的保持原值，未写的补 false 并同步测试夹具）。</verify>
  <security>开关只影响「是否注册监听器」，不得顺带改变已启用模块的任何过滤/注入行为；组合源补 enabled 时必须与既有装配结果一致（原「未声明即关闭」的模块补 false，原「靠行存在即启用」的模块补 true 并说明）。</security>
  <done>能力启停唯一事实源为 config.enabled，UI 可管理全部能力，`disabled:` 的适用范围写入文档。</done>
</task>
```

```xml
<task type="auto">
  <name>T4：四个无白名单插件行补校验</name>
  <files>engine/prompt-config-engine.mjs；engine/tool-config-engine.mjs；engine/subagent-tool-policy.mjs；engine/skill-search.mjs；engine/subagent-tool-policy-core.mjs</files>
  <action>为 prompt-config-engine（configsDir/strategyDir）、tool-config-engine（configsDir/requireApproval）、subagent-tool-policy（policyFile/spawnProvider/forkProvider/maxDepth/agentOptions）、skill-search 补**字段声明与白名单**（未知键挂载期报错）。

**但「默认值下沉组合源」不得连带走「缺键 fail loud」**（R10 修正——原方案只承诺了 `enabled` 一处行为差异，这里会引入第二处）：现状 `subagent-tool-policy.mjs:37/53` 有内置默认路径与 provider 名，`tool-config-engine.mjs:370` 的降级也**允许缺目录**；这些默认值被**复制引擎、手写组合与旧生成目录**依赖。因此二选一：

- **（推荐）保留兼容**：声明里给出与现状**同值**的 default，缺键时行为不变，只新增「未知键报错」与类型校验；
- 若确要改成缺键 fail loud，必须**单列为行为变更**：写明严格化的迁移范围、旧输入→新输入的映射、装配失败时的恢复路径，并覆盖「复制引擎 / 手写组合 / 旧生成目录」三类输入。

同时把 `subagent-tool-policy-core.mjs` 的 `booleanOption`/`stringList` 改为不与 `shared.mjs` 同名的名字（如 `collectBoolean` / `collectStringList`），保留其「收集 errors 不抛」语义。</action>
  <verify>四个模块对未知键抛错；组合源补上原本内置的默认值后，既有装配与行为不变（逐模块对拍）；同名冲突消除（grep 两处 booleanOption 定义不再同名）；test/host/engine-params-bridge.test.mjs:250-292 的镜像断言随新键同步。</verify>
  <security>补校验不得改变既有默认行为（默认值搬到组合源而非删除）；skill-search 的 `apply(ctx)` 单参形态若需接收 config，须确认其调用方与组合行已传 config，否则保留现状并记录。</security>
  <done>四个插件行有白名单与字段校验；**缺键行为与现状一致**（默认值保留在引擎或同值下沉，未连带引入 fail loud）；同名冲突消除。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交。`enabled` fail loud 是唯一行为变更，若发生后向兼容问题，可单独回退 T3 而不动 T1/T2/T4。中断检查点：同一模块的声明与消费点必须同进同退，不留半迁移模块。

## 状态

- [x] T1 engine/fields.mjs 字段类型系统（bool / int / text / stringList / enumOf / passthrough + defineConfig）。
- [x] T2 迁移**保留模块**到字段声明（2 个；待删的 7 个不迁移）。
- [x] T3 enabled 统一 fail loud + 补 `tool-git-bash` 开关（含参数桥 `toolGitBashEnabled` 键）。
- [x] T4 四个无白名单模块补校验（默认值**保留兼容**，不连带 fail loud）。

## 验收记录

执行日期 2026-09-22；分支 `dev`，起点 `ebb0d1e`（B1 已提交推送）。唯一行为变更是 **`enabled` fail loud**。

**T1 `engine/fields.mjs`（新增，主线程）**：字段类型 `bool / int / text / stringList / enumOf / passthrough` + `defineConfig(fields) → { allowedKeys, parse }`。
- 与既有 helper **逐字对拍**：`bool`↔`booleanOption`、`int({required})`↔`requiredInt`、`text({required})`↔`requiredText`（含「空串 → undefined」契约）；无消息覆盖时**整分支委托**原 helper，故默认消息自动逐字一致（第一版只在部分分支委托，被测试打红后修正）。
- `default` 支持**工厂函数**：`deferredList` 的 `new Set()` 若被多次 parse 共享，会被 mutate 串味到别的会话。
- 空数组走**形状消息**、`trim` 后为空才走 `emptyMessage`：`normalizeEnvKeys` 对 `[]` 与 `['  ']` 给的是两条不同消息（第一版把两者混为一条，被测试打红后修正）。
- **`passthrough` 是本支的关键补充**：旧代码普遍存在「非法值即静默取默认」（非字符串/空串/非数组），换成严格字段类型会把静默降级变成挂载期报错——那是未授权的行为变更。
- 断言 `test/engine/fields.test.mjs` **9/9**。**YAGNI 自审**删掉了多写的 `int({max})`（engine 里 11 处 `requiredInt` 调用全部只传最小值，上限语义零需求）。

**T2 迁移两个保留模块**（委派代理执行，主线程逐条复核 diff + 亲自复跑其断言）
- `run-code-env`：白名单由 `configContract` 派生；`normalizeEnvKeys` **保留导出**（`preset-engine-modules.test.mjs` 直接 import）并内部委托声明；两条消息逐字保留；**非字符串项宽容语义**（`[1,'PATH']` → `['PATH']`）用包装层保住。
- `tool-git-bash`：`int({min:1,required:true})` 对齐 `requiredInt` 消息；`bashPath` 的**「非字符串静默忽略」**用 `passthrough` 保住；`if (!source.enabled) return` 位于**校验之后**（关闭时未知键/缺必填仍响亮）。
- 对拍断言 `test/engine/fields-migration.test.mjs` **10/10**（把迁移前实现逐字复制为基准，对拍抛/不抛、消息、归一化对象、未知键四个维度，并证明声明确实被 apply 消费）。

**T3 `enabled` 统一 fail loud**
- `tool-git-bash` 补 `enabled` 键；组合源 `tool-git-bash.yml` 补 `enabled: true`（原「行在组合里即启用」），**平台条件 `disabled: !!js process.platform !== 'win32'` 原样保留**，并在 yml 与 CHANGELOG 写明 `disabled:` 不是能力开关。
- **影响面查证**：用户预设里**零引用** `tool-git-bash`（三个预设引用的是**官方** `tool-bash`），仓库内仅 `tool-git-bash.yml` 自身声明 → 补 `enabled: true` 覆盖唯一使用点，无静默关闭风险。
- 参数桥 `toolGitBashEnabled` 连带四处：`src/shared/engine-params.ts`（类型 + 定义）、`src/shared/engine-capabilities.ts`（新能力卡，否则 `impliedModulesForParams` 查不到 card、「参数在⇒装配在」静默失效）、`src/client/locales-params.ts`（中英文案，`locale-contract` 强制）、**`preset.yml` 模板示例**——最后这处是被 `full-preset-template.test.mjs` 的「不能漏登记参数或混入旧别名」断言抓出来的，属守卫起作用的实证。
- CHANGELOG 明确标注这是**本轮唯一行为变更**。

**T4 四个无白名单模块补校验**（主线程执行）
- `prompt-config-engine`（configsDir / strategyDir）、`tool-config-engine`（configsDir / requireApproval）、`subagent-tool-policy`（policyFile / spawnProvider / forkProvider / maxDepth / agentOptions）补 `defineConfig` 声明，**全部用 `passthrough`**（迁移前对非法值一律静默取默认、`requireApproval` 只过滤非字符串项），只新增「未知键报错」。
- `skill-search` 按 PLAN 的例外处理：它 `apply(ctx)` 单参、**不读任何 config**，故保留现状并加注释说明「若将来需要 config，先确认组合行与调用方都在传」。
- 断言 `test/engine/config-whitelist.test.mjs` **5/5**（含「宽容语义不变」的边界证据）。

**顺带修掉 B0 守卫的一处空转**（由代理实测暴露，属 B0 遗留缺陷）：`test/host/engine-params-bridge.test.mjs` 的 `ownKeysOf` 只认 `ALLOWED_KEYS` 字面量，模块迁移到 `defineConfig` 后它返回空集 → 落进 `pendingWhitelist` 分支被静默跳过（测试仍绿、实际不再检查）。已改为**优先解析 `defineConfig` 声明、`ALLOWED_KEYS` 作待删模块的回退**，并用一次性探针分别验证两种形态都能解析出键集。

**门禁（全部通过）**：`typecheck` exit 0；`lint` 0 warnings / 0 errors（285 files）；全量 `test` **1347 tests / 1347 pass / 0 fail**（B1 后为 1323，本支新增 24 条）；`build` 由 `scripts/run-tests.mjs` 内含执行且成功；`git diff --check` exit 0。

**未验证项**：①未做真宿主挂载（未起 dsh、未动真实预设目录）：`enabled` 门控是 stub ctx 的行为断言，真装配由全量测试与交付后重启验证。②`lint` 的检查范围是 `src test tsdown.config.ts`，**不含 `engine/`**，故引擎侧 5 个改动文件的静态质量由全量测试与人工 diff 复核保证。③`bashPath` 非字符串静默忽略、`envKeys` 非字符串项降级丢弃这两处**刻意的宽容**与 fields.mjs「错类型不降级」的取向相左，为满足逐字段一致而保留，源码注释已标注升级路径。

**交付凭据**：提交 SHA 与推送结果在归档后补记（随下一支的提交带入）。

## 实施取舍与已知边界

- `subagent-tool-policy-core.mjs` 的「收集 errors 不抛」**保留**：它是纯模块，供 UI 预校验使用，与配置挂载期的 fail loud 是两种场景；只改名消除冲突。
- `usePtcMode` **不与 enabled 合并**：前者选呈现方式、后者管是否注册，是两个维度。
- 内置默认值下沉会让组合源变长：这是与既有约定一致的方向，代价是 yml 更显式。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。
