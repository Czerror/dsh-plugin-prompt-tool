# B5 层注册表归一 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支只动 `engine/schema.mjs`：把四张按层分组的平行表合成一张层定义表，并把 `createPromptConfigs` 里 15 段同型校验改为声明驱动。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；无前置依赖（可与 B1–B4 并行，但与 B8 的 ③ 有文件冲突，故先于 B8）。
- 全局纪律第 1 条：行为变更必须为零。

## 审查结论

### 1. 四张平行表 + 一处重叠

| 表 | 位置 | 内容 |
|---|---|---|
| `LAYER_ORDER` | `schema.mjs:147-150` | 九层顺序（产品定义） |
| `LAYER_FIELD_POLICIES` | `schema.mjs:188-198` | 9 层 × 11 字段能力矩阵 |
| `LAYER_EDITING` | `schema.mjs:201-217` | 各层 subjects / content / variables / messageMetadata / params 类型表 |
| `LAYER_LABELS` | `schema.mjs:225-235` | 各层显示名与说明 |

派生关系已存在但只覆盖一部分：`KNOWN_LAYERS = new Set(LAYER_ORDER)`（:151）、`CONDITIONAL_LAYERS = new Set(Object.keys(LAYER_DEFAULT_SUBJECT))`（:166）、`LAYER_CONTRACTS = Object.fromEntries(LAYER_ORDER.map(...))`（:219-222）。

重叠：`LAYER_DEFAULT_SUBJECT`（:158-164，5 层）与 `LAYER_EDITING[layer].subjects` 描述同一批事实的两面（缺省值 vs 允许集合），二者分散在两处。

后果：**新增或修改一层要同步 4-5 处**，且没有任何守卫强制一致。

### 2. `createPromptConfigs` 里 15 段同型校验

`schema.mjs:398-459` 是同一个模式重复 15 次：

```js
const X = spec.X ?? DEFAULT
if (!KNOWN_X.has(X)) throw new TypeError(`${name}: ${label} unknown X ${JSON.stringify(X)}`)
```

覆盖：position(398-401)、dedupe(402-405)、promotion(406-409)、audience(410-413)、modelScope(414-417)、role(418-421)、subject(423-428)、mergeMode(456-459)，以及顺序不同的 order(437-440)、group(441-443)、exclusive(444-446)、name(447-449)、variables(450-452)、texts(453-455)、identity(432-436)。

这些字段的枚举与缺省**已经**在 `KNOWN_*` 集合与 `LAYER_FIELD_POLICIES` 中声明过了——校验逻辑只是把它们再手写一遍。

### 3. 其它可归一点

- `getEngineMeta()`（:238-261）里 `[...SET].sort()` 重复 12 次。
- `LAYER_CONTRACTS[layer].params` 的类型表（:204-216）与 `src/shared/bridge-contract.ts:272-275` 的 `LayerParamContract` 是同构手抄（后者归 B6）。

## 影响面、依赖与护栏

- 唯一涉及文件：`engine/schema.mjs`（加 B0 的守卫与 B6 的契约同步点）。
- 硬约束：
  - `getEngineMeta()` 的输出**逐字段不变**（快照对比），包括字段顺序与排序方式。
  - 所有挂载期 fail loud 的错误消息**逐字不变**（现有测试与用户可读性都依赖它）。
  - 不改层的语义（九层顺序、字段策略、subjects 允许集）。
- 不做：不改 `LAYER_ORDER` 的值与顺序；不改 `STRATEGY_LAYER_SUPPORT`（策略层支持矩阵，归 B2 的字段声明体系）。

## Wave 1：层定义表合一

```xml
<task type="auto">
  <name>T1：四张平行表合成一张 LAYER_DEFINITIONS</name>
  <files>engine/schema.mjs</files>
  <action>定义单一 LAYER_DEFINITIONS（有序数组或 Map：layer → { order, label:{title,detail}, fields:{11 项策略}, editing:{subjects,content,variables,messageMetadata,params}, defaultSubject })；由它派生 LAYER_ORDER / KNOWN_LAYERS / LAYER_FIELD_POLICIES / LAYER_EDITING / LAYER_LABELS / LAYER_DEFAULT_SUBJECT / CONDITIONAL_LAYERS / LAYER_CONTRACTS（全部保持现有导出名与形状，外部消费方不受影响）。defaultSubject 与 editing.subjects 的一致性在定义处就近声明，并加一条断言「defaultSubject ∈ editing.subjects」。</action>
  <verify>快照对比：改动前后 getEngineMeta() 的输出 deepEqual（含 layerOrder/layers/layerFieldPolicies/layerLabels/layerContracts/layerDefaultSubjects 等全部字段）；新增断言「每层的 defaultSubject 属于该层 subjects」；test/engine/prompt-config-engine.test.mjs、test/shared/bridge-contract.test.mjs、test/client/engine-module-cards.test.mjs 全绿。</verify>
  <security>层契约是客户端表单与校验的共同事实源：派生结果必须与现状逐字段相同，不得在迁移中「顺手修正」任何一层的策略或说明文案。</security>
  <done>四表合一，派生结果与现状逐字段相同。</done>
</task>
```

## Wave 2：字段校验声明化

```xml
<task type="auto">
  <name>T2：15 段同型校验改为字段声明驱动</name>
  <files>engine/schema.mjs</files>
  <action>为 promptConfig 的枚举/布尔/文本字段建立一份字段表（field → { known: Set|null, default, validate, allowNull }），把 :398-459 的 15 段手写校验替换为一次遍历。特殊项保持独立：identity（:432-436，结构校验）、variables（:450-452，对象校验）、texts（:453-455，字符串数组校验）、params（走 normalizeLayerParams）、match（走 normalizeMatch）。subject 需保留两条语义（KNOWN_SUBJECTS 全局集合 + LAYER_CONTRACTS[layer].subjects 层内允许集）与 :429 的缺省回退。</action>
  <verify>逐字段对拍：同一组非法输入下，抛出的 TypeError 消息与现状逐字相同（含 `${label} unknown X ${JSON.stringify(X)}` 形态与 KNOWN 集合的排序拼接）；合法输入的归一化结果相同；新增「字段表新增一个枚举字段即自动获得校验」的演示断言。</verify>
  <security>校验只允许收紧不允许放宽：迁移后任何一个现状会抛错的输入必须仍抛错；不得因为声明化而把某种非法值静默降级为默认值。</security>
  <done>15 段同型校验收敛为一份字段表，错误消息逐字不变。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交（单文件改动，回滚风险低）。中断检查点：T1 与 T2 各自独立可回退（T1 只改数据结构、T2 只改校验实现）。

## 状态

- [x] T1 LAYER_DEFINITIONS 四表合一 —— 五处事实（`LAYER_ORDER` / `LAYER_FIELD_POLICIES` / `LAYER_EDITING` / `LAYER_LABELS` / `LAYER_DEFAULT_SUBJECT`）合并为一张 `LAYER_DEFINITIONS`，其余全部派生。
- [x] T2 字段校验声明化 —— 15 段同型校验收敛为 `CONFIG_FIELDS` 表 + 一次遍历。

## 验收记录

本轮为方案产出，未执行。查证证据：`engine/schema.mjs:147-150/158-164/188-198/201-217/219-222/225-235/238-261` 的表结构、`:398-459` 的 15 段校验逐段行号、`:219-222` 已存在的派生关系。

### 执行结果（2026-09-22 执行）

**门槛（主线程统一跑，cwd `D:\AI\workspase\_temp`）**：`pnpm typecheck` ✓ / `pnpm lint` **0 errors**（2 warnings 属 B3 遗留）/ `pnpm test` **1454 pass / 0 fail**（B4 后 1445 + 本支新增 9）/ `pnpm build` ✓ / `git diff --check` **CLEAN**。

**T1 的等价性证明用「HEAD 版当 oracle 直接对拍」**（比"跑测试看绿"更强）：把 `git show HEAD:engine/schema.mjs` 写到 `engine/.tmp-schema-old.mjs`，两个版本同时 import 后断言——`getEngineMeta()` 整体 `deepEqual`、**顶层键顺序**、**JSON 序列化逐字相同**（客户端渲染对键顺序敏感）、四个嵌套表各自的层顺序与每层键顺序、以及 `LAYER_ORDER` / `LAYER_FIELD_POLICIES` / `LAYER_CONTRACTS` / `LAYER_LABELS` / `LAYER_DEFAULT_SUBJECT` / `KNOWN_LAYERS` / `CONDITIONAL_LAYERS` / `KNOWN_SUBJECTS` 逐个 deepEqual。**全部通过**，临时对照文件与探针已删除。另新增「`defaultSubject ∈ editing.subjects`」的**加载期断言**（定义处就近声明）。

**T2 的等价性同样用对拍**：66 组输入（枚举合法/非法/`null`/缺省、subject 两条语义与层缺省、identity 五种形态、order/group/exclusive/name 的边界与 `null`、variables/texts、多字段同时非法、层内受限字段、非法 layer/strategy/configKind、重复 id、完整合法配置），断言**是否抛错、错误消息逐字、错误类型**一致；合法输入再断言**归一化 config 逐字段相同**（剔除函数字段后 JSON 比对）。结果：37 组抛错消息逐字一致、29 组合法结果逐字段一致。临时探针已删除。

**对拍当场抓到 1 个真 bug（已修）**：`resolveConfigFields(spec, \`${name}: ${label}\`, layer)` 把**已含前缀**的 label 又传给会自行补前缀的函数，产出 `prompt-config-engine: prompt-config-engine: configs[0] …` 的双前缀。改为传裸 `label`。

**B0 守卫的必要同步**：`test/shared/mirror-guards.test.mjs` 的「第一组(b)」原本用正则解析 `const LAYER_EDITING = { … }` 的**源码字面量**，派生后解析为空 → 全量测试转红。已改为从**运行时导出** `LAYER_CONTRACTS` 取 content 取值。这是**增强而非削弱**：守卫的意图是「bridge 契约与引擎**实际取值**同域」，运行时读才是实际取值，且不再被格式调整误伤（该文件仍不 import `src` 的 TS 模块）。

**新增回归 `test/engine/schema-fields.test.mjs`（9 例）**：字段表驱动（表里**每个**枚举/形态字段自动获得校验，新增字段无需再写测试）、**表顺序 = 报错顺序**（5 组多字段非法用例，且反向确认第二个字段的非法值本身会抛错）、表结构自洽（字段名唯一 / known 是 Set / keepNull 需 known / validate 必带 problem 文案 / 枚举与形态不共存）、九层顺序与三张派生表同序覆盖、每层能力矩阵恰好 11 项与标签契约完整、`defaultSubject ∈ subjects` 不变量、subject 两条语义与层缺省回退、`getEngineMeta()` 各层字段与派生物同源。

**此轮自查到的两处测试错误**（都由运行结果暴露，非猜测）：把 `name` 的非法值写成 `'__bad__'`（合法非空字符串，导致"先报 name"的断言假红）；以及上文的双前缀 bug。

## 实施取舍与已知边界

- **不动的部分**：`STRATEGY_LAYER_SUPPORT`（策略层支持矩阵）与 `normalizeMatch`（匹配归一化）保持独立——它们是各自领域的权威，塞进层表反而降低可读性。
- **导出名不变**：所有现有导出（`LAYER_ORDER`、`KNOWN_LAYERS`、`LAYER_FIELD_POLICIES`、`LAYER_CONTRACTS`、`LAYER_LABELS`、`LAYER_DEFAULT_SUBJECT`、`CONDITIONAL_LAYERS`）保持名字与形状，避免连锁改动 host/客户端。
- **客户端侧的层字段类型手抄（`LayerFieldPolicy` / `EMPTY_POLICY`）归 B6**，本支不含。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。
