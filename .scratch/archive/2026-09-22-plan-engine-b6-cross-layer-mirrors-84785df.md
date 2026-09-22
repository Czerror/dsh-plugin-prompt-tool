# B6 跨层镜像归一 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支收敛「同一个事实在引擎、host、runtime、shared、客户端各写一遍」的镜像链，重点是**参数目录**与**两条 prompt-configs 加载路径**。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；依赖 B0（守卫已就位）。
- 用户要求：`对照st的变量参数行为 再讨论方案`（已查证，见审查结论 §3）；`应该只使用一套事实源`。

## 审查结论

### 1. 参数目录镜像链（71 键，平均 5.39/14 个候选文件）

| 位置 | 性质 |
|---|---|
| `src/shared/engine-params.ts:218-290` 定义（71 键、45 带 `module` 绑定） | 权威 |
| `:292-298` 编译期键集合断言、`:310-340` `buildEngineModuleParams`、`:343-352` `moduleParamFallbacks`、`src/shared/param-keys.ts:21` | 派生 |
| 9 个引擎模块的 `ALLOWED_KEYS` | 手抄（B2 后改为字段声明） |
| `engine/compositions/source/local/*.yml` 的 `config:` | 手写默认值（doc 声明为唯一归属地） |
| `src/host/write-preset.ts:201-259` `runtimeOf`（30 键逐键守卫 + `:209` 全键展开） | 手抄（B0 加守卫） |
| `src/index.ts:104-144` 逐键装配（`:113` 全键循环后又 `:114-143` 逐键再赋） | 手抄（B0 加守卫） |
| `src/config.ts:53-98` 首层必填清单 | 手抄（B0 加守卫） |
| `src/host/preset-layer-settings.ts:12-24` `MODEL_SEGMENT_MAP`（10 键） | 手抄 |
| `src/client/locales-params.ts`（`param.<键>` 180 处 ≈ 90 键 × zh/en） | 手抄 |
| `src/client/data/use-prompt-tool-store.ts:70-73`（13 键开关清单） | 手抄 |
| 测试镜像：`test/host/engine-params-bridge.test.mjs:252-261`（4 模块）、`:349-389` `BRIDGE_SAMPLES`（39 键）、`test/shared/engine-param-schema.test.mjs:116` | 手抄 |
| `src/client/data/prompt-tool-fields.ts:74-89` `EMPTY_FIELDS`、`src/client/data/param-overrides.ts` | 派生 |

**最多出现在 10 处**的键：`maxDepth`、`modelProvider`、`modelName`、`subagentModelProvider`、`subagentModelName`。

### 2. 客户端手抄表

| 位置 | 内容 | 事实来源 |
|---|---|---|
| `src/client/data/prompt-tool-fields.ts:56-73` `EMPTY_META` | `layerOrder` + 12 个手写空表 | 抄 `getEngineMeta()` |
| `src/client/prompt-tool-types.ts:100-112` `LayerFieldPolicy` | 11 字段 | 抄 `LAYER_FIELD_POLICIES` |
| `src/client/prompt-tool-types.ts:115-140` `EngineMeta` | meta 全部键名 | 抄 `getEngineMeta()` |
| `src/client/features/prompts/prompt-config-policy.ts:99-111` `EMPTY_POLICY` | 同 11 字段全 false | 再抄一次 |
| 同文件 `:38-79` | 十余个枚举标签映射 | 抄 `schema.mjs` 的 `KNOWN_*`；**引擎已下发 `layerLabels` 但客户端仍自持 `LAYER_LABEL_KEYS`** |
| 同文件 `:6-7` `SOURCE_KINDS`/`SOURCE_FORMS` | 来源枚举 | 引擎不设枚举，客户端自持 |
| 同文件 `:81` `MATCH_LOGICS` | `['any','all','not','notAny']` | 抄 `anchor-match.mjs:20` |
| `src/client/features/tools/CustomToolEditor.tsx:20-24` | 工具枚举 | 抄 `tool-definition.mjs:4/79-80/91-93`（客户端多 `json`/`oneOf`） |

### 3. 两条 prompt-configs 加载路径（ST 变量对照结论）

- 引擎 `engine/schema.mjs:83-122`：**合并** `variables.yml` 进每条配置（`:114-120`，配置自身优先），供**注入**使用。
- host `src/host/prompt-configs.ts:263-289`：`:277` **只跳过、不合并**，供**编辑/列举**使用（TUI `/prompt-tool config`、bridge `/prompt-configs`、bootstrap 聚合）。
- 这是 `CHANGELOG.md:1543-1547` 记录的**刻意设计**：避免预设级变量写回配置文件造成双份；客户端不做 `{{key}}` 插值（全 `src/client` 无插值实现），预设级变量经 `/bootstrap` 的 `variables` 字段单独送达（`src/client/data/bridge-transport.ts:26`）。
- **本项目不是 ST global 变量的等价物**：ST global 存 `extension_settings.variables.global`（跨聊天跨角色、运行时可写）；本项目 `variables.yml` 是静态预设配置（每个预设一份）。差异需写入文档（B0 已列）。
- 真正登记变量的只有 ST 导入期 `src/host/sillytavern.ts:777-788` 与工作台 `/preset-variables`；`world_book_upsert` 只写世界书条目（`src/runtime/world-book-tools.ts:134-151`）。

### 4. host 侧重写引擎逻辑（13 类候选中 10 类重复）

| # | host 位置 | 引擎对应 | 判定 |
|---|---|---|---|
| 1 | `src/host/prompt-configs.ts:263-289` `loadPromptConfigFiles` | `engine/schema.mjs:83-122` | 同名不同契约（见 §3） |
| 2 | `src/host/prompt-configs.ts:279-286` 内联 YAML/JSON 解析 | `engine/schema.mjs:71-77` `parsePromptConfigYaml` | 重写 |
| 3 | `src/host/prompt-configs.ts:15-49` `PromptConfigSpec` 字面量联合 | `engine/schema.mjs:124-185` 的十个 `KNOWN_*` | 重写（第三份在 `src/client/prompt-tool-types.ts:44-90`） |
| 4 | `src/runtime/configs-validate.ts:38-62` `shapeErrors` | `engine/schema.mjs:351-360`/`:366-368` | 重写（`:4-8` 自述为有意两层） |
| 5 | provider+model 配对：`src/client/data/param-overrides.ts:91-93`、`src/host/prompt-configs.ts:100-104`、`src/host/manifest.ts:662/683-696` | 引擎仅 `schema.mjs:340-342`（replace=true 时） | **三处各自实现** |
| 6 | 组合装配/回写 `src/host/manifest.ts:720-962` | 引擎只消费最终 `agent.cordis.yml` | host-only 概念，保留 |
| 7 | 模块名→配置目录 `src/host/preset-install.ts:94-97` | 组合源 yml 同事实两处 | 需单一来源 |
| 8 | 引擎 `.mjs` 清单读取 3 处（`manifest.ts:357`、`write-preset.ts:334`、`preset-install.ts:80-111`） | 无 | 重复读取 |
| 9 | delegation 行重写 `src/host/manifest.ts:650-701` | `engine/subagent-tool-policy.mjs:37-55,180-197` | 两条通道同语义 |
| 10 | 保存期门控一致性 `src/runtime/settings-bridge.ts:1450-1455` | `engine/tool-bootstrap.mjs:212-214` 只报缺必填 | host 额外判定 |
| 11 | `instruction-file` 语义 3 处（`pre-step-coordinator.ts:181-183`、`agents-cards.ts:170`、`prompt-config-tools`） | 无 | 需单一来源 |
| 12 | 晋升判断（`pre-step-coordinator.ts:29-33` 直接 import 引擎） | — | **复用（正例）** |
| 13 | 层枚举校验（`instructions-policy.ts:21` import `KNOWN_*`） | — | **复用（正例）** |

### 5. bridge 契约

- 端点路径真同源：`src/shared/bridge-contract.ts:27-71` 的 43 个常量被 host（`settings-bridge.ts:752-2142` 数组式 41 条 + `:2206`/`:2285` 两条独立注册）与客户端（`bridge-client.ts:20`）共用。
- **载荷形状两端各写一遍**：契约 `bridge-contract.ts:83-161`/`307-384` 只在客户端被引用；host 侧 `settings-bridge.ts:132` 的 `writeBridgeJson(body: unknown)` 完全不引用契约，每个 handler 手写形状。
- meta 键名写三遍：`engine/schema.mjs:238-261` ↔ `src/client/prompt-tool-types.ts:115-140` ↔ `src/client/data/prompt-tool-fields.ts:56-73`。

## 影响面、依赖与护栏

- 涉及：`src/shared/engine-params.ts`、新增引擎侧参数 schema 导出、`src/host/*`（10 类）、`src/runtime/*`、`src/client/data/*`、`src/client/features/prompts/prompt-config-policy.ts`、`src/client/features/tools/CustomToolEditor.tsx`、`src/shared/bridge-contract.ts`。
- 硬约束：
  - **行为变更必须为零**：host 侧 10 类里唯一会改变行为的是「让 host 改用引擎版 `loadPromptConfigFiles`」（会开始合并 variables.yml）——**本支不做**，改为命名区分 + 共享底层扫描。
  - 不新增端点、不改 bridge 的成功/失败包装与白名单校验。
  - 参数目录的**类型/校验/默认归引擎，UI 呈现（card/label/草稿）归 src**：接受两处，但必须由守卫强制一致（B0 已加）。
- 依赖：B0 的守卫必须先绿，否则本支的收敛无判据。

## Wave 1：参数目录

```xml
<task type="auto">
  <name>T1：引擎侧导出参数 schema，src 侧派生并守卫一致</name>
  <files>engine/*（**仅 B6 时点已存在的** capability 声明；7 个待删模块的声明由 B7 迁移时补齐）；src/shared/engine-params.ts；test/shared/engine-param-schema.test.mjs</files>
  <action>让每个能力模块的字段声明成为**类型/校验/默认值**的权威（B2 的 fields.mjs 已具备）；在 src 侧用一份聚合入口读取这些声明（沿用 src 直接 import engine/*.mjs 的既有先例，如 `src/runtime/pre-step-coordinator.ts:29-33`），并校验**转换规则**是否闭合成引擎的有效配置——**不是要求两侧原值相等**（R9）。UI 元数据（card/label/草稿默认/编辑组）仍留在 src；运行默认仍归组合源。同时收敛 `runtimeOf` / `index.ts` 逐键清单为「按 `ENGINE_PARAM_KEYS` 遍历 + 少量显式特例」。**范围限定（R7）**：本支只对**当时存在**的声明集负责——B2 不迁移 7 个待删模块，它们的字段声明到 B7 才产生，其闭合检查**随 B7 交付**；本支的守卫必须能覆盖它们（同一套断言，不为它们开后门），但不把「它们已闭合」写进本支的完成条件。</action>
  <verify>**校验行为闭合，不要求原值相等**（R9）：`src/shared/engine-params.ts:212` 明说 `defaultValue` 是**编辑草稿**，与引擎运行缺省分工不同——`contextGateEnabled` 草稿 true 而引擎缺省 false、`bootstrapMaxTokens` 草稿 0 经参数桥转换成**删键**（不能直接送正整数校验）。因此断言链是「草稿/保存输入 → 参数桥 → 引擎有效配置」逐段可解释：(a) 每个 module 绑定参数的**转换规则**有断言（含空值/`0`/`false` 的删键与不删键语义）；(b) 运行默认归组合源、UI 元数据归 src，**不把不同表示的刻意转换当作重复事实源**；(c) `runtimeOf` 与 `index.ts` 的逐键清单改为遍历 + 显式特例；(d) B0 的守卫全绿；(e)「新增一个参数」的演示：引擎声明 + src UI 元数据各加一处即通过全部守卫；(f) **范围断言（R7）**：本支只断言「当时存在」声明集的闭合——7 个待删模块缺席时守卫不得误报红，且「声明缺失」与「声明不一致」必须是两类可区分的失败，避免 B7 迁移时被同一盏红灯掩盖。</verify>
  <security>参数目录涉及保存通道与写盘：不得放宽任何类型校验、不得改变空值语义（空字符串/空列表/显式 false 的三种语义必须逐条保持）；不得让 UI 元数据反向覆盖引擎声明。</security>
  <done>类型与校验单一权威在引擎，UI 元数据在 src，二者一致性由守卫强制。</done>
</task>
```

## Wave 2：客户端与契约

```xml
<task type="auto">
  <name>T2：客户端手抄表改为派生或接收下发</name>
  <files>src/client/data/prompt-tool-fields.ts；src/client/prompt-tool-types.ts；src/client/features/prompts/prompt-config-policy.ts；src/client/features/tools/CustomToolEditor.tsx</files>
  <action>(1) EMPTY_META 的 12 个手写空表改为按 getEngineMeta() 的键派生（保持退化语义：字段缺席时不该崩）；(2) LayerFieldPolicy 与 EMPTY_POLICY 的 11 字段改为从共享契约派生（不引入运行时依赖，用类型 + 单一常量表）；(3) 枚举标签映射：引擎已下发 layerLabels，客户端 LAYER_LABEL_KEYS 改为消费下发值（缺失时退化）；(4) MATCH_LOGICS 改为从 anchor-match 的 MATCH_LOGIC 派生或加守卫断言一致；(5) CustomToolEditor 的枚举加守卫断言与 tool-definition.mjs 一致（客户端多出的 json/oneOf 显式标注为 UI 专有）。</action>
  <verify>客户端测试全绿（含 locale-contract 键集守卫与 engine-module-cards 的层序同源断言）；新增断言：客户端常量与其引擎来源逐项一致；退化路径（meta 缺字段）不抛错。</verify>
  <security>客户端不得因此获得新的写通道；键集守卫（zh/en 一致、非空、不等值）继续生效；不得把引擎内部实现细节泄漏到 UI 文案。</security>
  <done>客户端手抄表要么派生、要么有守卫强制一致，并显式标注 UI 专有项。</done>
</task>
```

```xml
<task type="auto">
  <name>T3：bridge 契约载荷形状单点化</name>
  <files>src/shared/bridge-contract.ts；src/runtime/settings-bridge.ts；test/shared/bridge-contract.test.mjs</files>
  <action>让 host 侧的响应构造引用契约类型：`writeBridgeJson` 泛型化为 `writeBridgeJson&lt;K extends keyof BridgeValueMap&gt;(res, status, body: BridgeResponse&lt;K&gt;)`（或等价的最小约束），使 handler 的成功/失败形状与契约在编译期连接；逐一核对 43 个端点的请求白名单与契约声明，把 host 侧自建的字段白名单（如 `settings-bridge.ts:196`）改为由契约派生或加守卫断言一致。两条独立注册（`:2206`/`:2285`）统一为数组式注册形态。</action>
  <verify>编译期：故意把某端点的响应形状改错，typecheck 必须报错（作为负例验证）；运行期：既有 bridge 契约测试（端点数量 43、bootstrap 聚合、成功/失败包装、toolSurface、persona）全绿；白名单派生后非法载荷仍返回 400。</verify>
  <security>bridge 是写盘与导入的入口：白名单、Host/Origin 校验、请求体上限、成功/失败包装一律不得放宽；派生只能收紧或等价。</security>
  <done>载荷形状有编译期连接，字段白名单与契约同源。</done>
</task>
```

## Wave 3：host 重写收敛

```xml
<task type="auto">
  <name>T4：两条加载路径命名区分与底层共享</name>
  <files>src/host/prompt-configs.ts；engine/schema.mjs；src/runtime/tui.ts；src/runtime/settings-bridge.ts；src/preset-core.ts；docs/architecture-params.md</files>
  <action>**只共享确实等价的步骤**（R12——两条路径的差异**不止**变量合并）：host 的 `src/host/prompt-configs.ts:264/279-284` 还有**空路径短路、对象/id 校验、带文件名的错误**；引擎 `engine/schema.mjs:71-88/108-118` 的 **JSON 形状校验阶段与错误类型**也不同。因此只抽出真正共同的部分（**扫描目录 + 读取文件**），解析与校验**留在各自边界**：引擎侧导出 `loadPromptConfigs(dir)`、host 侧改名 `listPromptConfigSpecs(dir)`，两者各自保留其校验与异常包装。**host 行为保持不变**，只共享代码路径。同步更新调用方（`tui.ts:47`、`settings-bridge.ts:737`、`preset-core.ts:8` 的再导出）与文档表述，并加守卫断言「host 版输出中不含仅存在于 `variables.yml` 的键」。</action>
  <verify>对拍覆盖两侧各自的边界（R12）：以 `{}`、JSON 标量/数组、YAML 非对象、**空路径**、不可读目录五种输入，验证两条路径**各自**的接受/拒绝与错误类型不变；再断言两条路径的输出除 variables 合并差异外逐字段相同；host 版仍不含预设级变量。调用方行为不变（TUI 列表、bridge 端点、bootstrap 聚合的既有测试全绿）。</verify>
  <security>不得让 host 路径开始合并变量（会改变编辑器看到的内容并可能写回配置文件）；不得改变 profiles 目录的读取边界与文件名校验。</security>
  <done>两条路径共享底层实现、命名区分契约、差异有守卫固化。</done>
</task>
```

```xml
<task type="auto">
  <name>T5：host 其余重写项收敛</name>
  <files>src/host/prompt-configs.ts；src/runtime/configs-validate.ts；src/host/preset-install.ts；src/host/manifest.ts；src/runtime/settings-bridge.ts；src/host/agents-cards.ts；src/runtime/pre-step-coordinator.ts</files>
  <action>按审查结论 §4 逐项处理：(2) 内联 YAML/JSON 解析改用引擎 parsePromptConfigYaml；(3) PromptConfigSpec 的枚举联合改为从引擎 KNOWN_* 派生（或加双向守卫）；(4) shapeErrors 与引擎 id 校验的关系显式化（保留两层设计但断言「引擎会拒的 host 也拒」）；(5) provider+model 配对三处收敛为一处共享判定；(7) 模块名→配置目录映射与组合源 yml 单一来源（改由 yml 提供、host 读取，或反之，二选一并加守卫）；(8) 引擎 .mjs 清单读取抽为共享常量/函数；(9) delegation 行重写与 subagent-tool-policy 的同语义显式对齐；(10) 保存期门控一致性校验移至引擎或加守卫；(11) instruction-file 语义抽为单一判定函数。</action>
  <verify>每项独立对拍：处理前后同一组输入的行为相同（宿主接线测试为主）；新守卫能抓到「两处不一致」的构造性反例；全量测试绿。</verify>
  <security>涉及写盘路径（preset-install 的引擎引用改写、manifest 的组合装配）与保存期校验：不得放宽任何路径守卫、不得改变写盘边界；delegation 行重写涉及授权语义，只做「同语义对齐」不做放宽。</security>
  <done>10 类重写中可等价收敛的全部收敛，保留项有明确理由与守卫。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交，按 Wave 回退（T1 参数目录 / T2 客户端 / T3 bridge / T4 加载路径 / T5 其余）。T4 与 T5 相互独立，可分别回退。

## 状态

- [x] T1 引擎侧参数 schema 导出与一致守卫 —— 交付为**闭合守卫**：引擎侧导出 `promptConfigFileNames` 之外，新增「参数桥产出 + 组合源默认值 → 引擎 `configContract` 必须接受」的闭合校验；`(c)` 的「按 kind 统一驱动」查证后**不做**（证据见「T1 执行期修正」）。
- [x] T2 客户端手抄表派生 —— 5 项由子代理完成（2 项派生、3 项守卫 + UI 专有注释），含 3 组变异验证。
- [x] T3 bridge 契约载荷形状单点化 —— **契约内部键覆盖断言已存在**（`bridge-contract.ts:385-391`）；本轮补 **host 字段白名单双向绑定**（含变异验证）；`writeBridgeJson` 泛型化与「两条注册统一」查证后**不做**（见「T3 执行期结论」）。
- [x] T4 两条加载路径命名区分与底层共享 —— 共享**枚举规则**（`promptConfigFileNames`），host 改名 `listPromptConfigSpecs` + 兼容别名；解析/校验**各留边界**（R12）。
- [x] T5 host 其余重写项收敛 —— 10 项里 **4 项做**（(3)(4)(7)(8)）、**6 项查证后不做**（见「T5 执行期结论」）。

## 验收记录

本轮为方案产出，未执行。查证证据：参数镜像链的全部位置与「最多 10 处」的键名、客户端手抄表逐项来源、两条加载路径的调用方与消费者、host 13 类候选的判定表、bridge 端点真同源与载荷形状各写一遍的实证、`CHANGELOG.md:1543-1547` 的刻意设计记录、ST 侧对照结论（ST global 存 `extension_settings.variables.global`，与 `variables.yml` 语义不同）。

### 执行结果（2026-09-22 执行）

**门槛（主线程统一跑，cwd `D:\AI\workspase\_temp`）**：`pnpm typecheck` **0 错误** / `pnpm lint` **0 errors**（2 warnings 属 B3 遗留）/ `pnpm test` **1491 pass / 0 fail**（B5 后 1454 + 本支 37）/ `pnpm build` ✓ / `git diff --check` **CLEAN**。

**改动面**：13 个已跟踪文件（+255/−96）+ 7 个新测试文件；`engine/`、`src/host/`、`src/runtime/`、`src/shared/`（仅测试读过，无净改动）、`src/client/`、`src/preset-core.ts`。

**逐任务证据**：

| 任务 | 交付 | 验证方式 |
|---|---|---|
| T1 | `test/shared/engine-config-closure.test.mjs`（6 例）+ `test/shared/write-runtime-shape.test.mjs`（4 例） | 闭合校验覆盖 2 个 `configContract` 模块 + 5 个手写白名单模块；收窄形态**用 dump 探针实测**后固化（24 收窄 / 48 直透） |
| T2 | `test/client/mirror-guards.test.mjs`（6 例）+ 4 个 client 文件 | 子代理做 3 组变异验证（`EMPTY_META` 漏键 / 枚举改名 / 删项 → 均红） |
| T3 | `src/runtime/settings-bridge.ts` 的 `IMPORT_REQUEST_FIELDS: Record<keyof AssetImportRequest, true>` | **变异验证**：给 `ImportChoices` 加字段 → `TS2741` 命中；撤销后 exit 0 |
| T4 | `test/shared/prompt-config-paths.test.mjs`（10 例） | 5 类输入**各自**固化两条路径的接受/拒绝与错误类型；两路径看到同一批文件 |
| T5 | `prompt-config-spec-enums`(3) + `configs-validate-layering`(5) + `preset-engine-managed-paths`(3) | 枚举逐值双向；分层用消息前缀区分 + 不脱节；受管路径与 yml 逐条一致 |

**执行期发现的、PLAN 未预见的三处**：

1. **`AssetImportRequest extends ImportChoices`**——我一度断言「契约比 host 白名单少 5 个字段」，实际 `ImportChoices:13-19` 恰好是那 5 个，契约一直完整（漏读 `extends` 子句）。
2. **`preset-core.ts` 不在 `package.json#exports` 里**——它是内部兼容层而非公开 API，所以 host 侧改名安全，旧名以别名保留。
3. **从 `src/` import 引擎 `.mjs` 的既有做法是 `// @ts-expect-error`**（`preset-package` / `instructions-policy` / `import-source` 三处先例），不是写 `.d.mts`。我为此多走了三轮弯路（同模块同路径在不同文件表现不同，原因就是这三处的抑制指令）。

## 实施取舍与已知边界

- **不追求「参数只写一处」**：类型/校验/默认的权威在引擎，UI 元数据在 src——二者职责不同，强行合并会让 UI 概念污染引擎。目标是「两处必须一致且漂移即红」。
- **host 不合并 variables.yml 是刻意设计**：本支只共享代码路径，不改行为；若将来要改，需先有 ST 变量对照的行为决策。
- **保留 host-only 概念**：`ModuleSourceMode`、`rowIds`、`editable` 等引擎无对应物，不强行下沉。
- **`PERSONAL` 类小项**：`MODEL_SEGMENT_MAP`（10 键，有「正好 10」断言）与 `use-prompt-tool-store` 的 13 键开关清单作为手抄项保留，但加守卫与来源注释。

## T1 执行期修正：(c) 不按 kind 统一驱动，改为特性固化

**原计划**：把 `runtimeOf`（`src/host/write-preset.ts`）与 `reloadPresetParams`（`src/index.ts`）的逐键清单收敛为「按 `ENGINE_PARAM_KEYS` 遍历 + 少量显式特例」。

**查证后不采用「按 kind 统一驱动」**，三条同向证据：

1. **两处规则本来就不同**：`firstTurnAnchor` 在写盘侧是 `providedBoolean`（`typeof === 'boolean' ? value : undefined`，**保留调用方显式的 `false`**），在读回侧是 `params.firstTurnAnchor === true`（把 `undefined` 也布尔化成 `false`）。同一批键、两套有意的策略；按 kind 驱动必然改变其中一侧。
2. **kind 描述值语义，不等于入参形态**：`modelTemperature` / `modelMaxTokens` / `subagentTemperature` / `subagentMaxTokens` 的 kind 是 `number`，但写盘侧规则是 `typeof === 'string'`——因为 UI/YAML 以**字符串**回读这些值（`engine-param-schema.test.mjs:28` 断言 `modelTemperature: 0.5` → `'0.5'`）。按 kind 归一化会把合法输入判成非法。
3. **逐键清单存在的理由不是「类型声明」**，而是「**哪些键需要在写盘前收窄形态**」：实测 24 个键需要收窄、48 个键直透。这是行为事实，不是类型信息的拷贝，因此不构成「第二套事实源」。

**替代交付（已做）**：`runtimeOf` 加 `export`（沿用仓库既有「Exported for tests」先例），新增 `test/shared/write-runtime-shape.test.mjs` 把**实测划分**特性固化——24/48 两个清单内联、收窄语义（合法值原样 / 异物值丢弃为 undefined）、「未提供 = 不覆盖」（空输入时只有 `promptText` 有值）、输出键集 = 全部 72 个引擎参数 + `promptText`。任何改动（包括按 kind 重写）只要挪动某个键的归属或改变收窄结果，都会红在测试里。

**未做**：`reloadPresetParams` 侧未加同类特性测试——它在 `src/index.ts` 的插件闭包内、未导出；必要时可与 `runtimeOf` 一样导出后固化。

## T3 执行期结论：三项里一项已存在、一项前提不成立、一项代价过高

查证（`src/shared/bridge-contract.ts`、`src/runtime/settings-bridge.ts`）后逐项处置：

1. **「契约内部载荷形状单一来源」已经存在**：`bridge-contract.ts:385-391` 早有编译期断言
   `AssertCoverage<keyof typeof BRIDGE_ENDPOINTS, BridgeRequestMap>` 与 `…, BridgeValueMap>`，
   注释写明「漏改任一侧 typecheck 失败」。**不需要新增**。

2. **「host 侧自建字段白名单改为由契约派生或加守卫」——本轮实施，改为双向类型绑定**：
   `settings-bridge.ts` 的导入请求白名单原先是手写字面量数组（10 键），只靠人眼与契约保持一致。
   现改为 `const IMPORT_REQUEST_FIELDS: Record<keyof AssetImportRequest, true> = {…}`，
   再用 `new Set(Object.keys(…)` 供 `has` 检查 —— **运行时语义完全不变**（顺序无关），
   但两个方向都进了编译期：白名单多键、或契约（含其继承的 `ImportChoices`）改键都会 `typecheck` 失败。
   **变异验证**：临时给 `ImportChoices` 加 `zzzProbe?: string` → 立刻报
   `TS2741: Property 'zzzProbe' is missing … required in type 'Record<keyof AssetImportRequest, true>'`；撤销后 exit 0。

3. **`writeBridgeJson` 泛型化——不做**。查证：定义在 `settings-bridge.ts:132`（`body: unknown`），
   而调用点有 **190 处**；要让成功分支真正连上 `BridgeValueMap[K]`，每个成功调用都得显式给出端点名
   类型参数（约 50 处），失败分支则无需改动。收益是编译期防漂移，但**契约内部漂移已有断言（第 1 项）**、
   客户端本就在消费 `BridgeResponse<K>` 类型，而代价是 190 处里的大规模类型改动——在「行为变更必须为零」
   的分支里，这个代价应优先给 T4/T5 的真实重复（如 host 侧第 4 份 match logic 联合、两条加载路径）。

4. **「两条独立注册统一为数组式形态」——前提不成立**。`:2200` 与 `:2287` 两处**已经**是同一套
   `register(endpoint, handler)` + `disposers.push` 形态（`:2203-2204`）；它们分成两个块是因为
   `ctx.inject([...])` 声明了**不同的服务依赖**（`:2200` 是 `['agents','tools','webServer']`），
   这是 Cordis 的注入语义要求，不是形态不统一。**不该合并**。

## T5 执行期结论：10 项里 4 项做、6 项查证后不做

### 做了的四项

- **(3) host 枚举与引擎 `KNOWN_*` 双向绑定**：`PromptConfigSpec` 原先把 9 个枚举联合手抄一遍
  （引擎 `KNOWN_*` + 客户端 + host = 第 3 份）。因引擎是无 `.d.mts` 的纯 `.mjs`（`src/` 侧靠
  `@ts-expect-error`），其 `KNOWN_*` 在 TS 眼里是 `any`，**派生不出字面量联合**；改为运行期值清单
  `PROMPT_CONFIG_SPEC_ENUMS`（`as const`）——类型由它派生（`SpecEnum<'position'>`）、守卫读同一份。
  新增 `test/shared/prompt-config-spec-enums.test.mjs`（3 例，逐值双向 + 键集对应 + 集合非空自证）。
- **(4) 两层分工从注释变成断言**：`configs-validate.ts:4-8` 自述「形状层（host 收集全部错误）
  + 语义层（引擎逐条、带 `prompt-config-engine:` 前缀）」是有意设计。新增
  `test/shared/configs-validate-layering.test.mjs`（5 例），用**消息前缀**区分两层，并钉住
  「引擎在形状上会拒的输入，host 绝不返回 valid」（否则会把引擎必然拒绝的配置渲染成预览文件）。
- **(7) 受管路径映射提为导出常量 + yml 一致性守卫**：`preset-install.ts` 原先用 if-else 内联
  「模块名 → 配置目录」（3 个模块），与组合源 yml 的 `configsDir`/`policyFile` 是同一事实的两处。
  提为 `ENGINE_MANAGED_PATHS`（导出）并查表，新增 `test/host/preset-engine-managed-paths.test.mjs`
  （3 例）。**两处都要保留**：yml 声明装配时的值，本表声明迁移时的改写目标——迁移面对的是用户预设里
  可能已过时的值，靠读它无法判断该改成什么，所以是「加守卫」而非「二选一」。
- **(8) 引擎 `.mjs` 清单读取抽共享**：`manifest.ts:357` 与 `write-preset.ts:343` 曾各写一遍
  `new Set(readdirSync(dir).filter(name => name.endsWith('.mjs')))`，且都作为
  `rewritePresetEngineReferences` 的第三参。抽为 `preset-install.ts` 的 `engineModuleFileNames(dir)`
  ——与消费函数同文件，**不设 `dir` 默认值**（`packageEngineDir()` 在 `manifest.ts`，反向 import 会成环）。
  第 3 处 `preset-install.ts:88` 的正则不是清单读取，未动。

### 查证后不做的六项

- **(2) 内联解析改用引擎 `parsePromptConfigYaml`——不做**：与 **T4 的 R12 修正**直接冲突
  （R12 明令「解析与校验留在各自边界」）。实测差异真实存在：host 用 `parseYaml(raw, {logLevel:'silent'})`、
  引擎用 `parseYaml(raw)`，**警告行为不同**；单对象校验的消息形态也不同。照做即行为变更。
- **(5) provider+model 配对三处——不做**：三处判定**已经一致**（「两者都非空才算有效路由」），
  只是重复了同一个 2 条件字面判断，而**动作不同**（client 是"配套提交避免半路由"、host 是"两者都有才写
  `agentOptions`"）。跨 client/host/引擎三层抽一个 2 条件谓词，收益小于依赖成本。
- **(9) delegation 行重写与 subagent-tool-policy 对齐——不做**：查证后发现它与 (5) 是**同一条极简规则**
  的又两处表达（host `manifest.ts:662/683` 写 `agentOptions`、引擎 `subagent-tool-policy.mjs:188`
  预检路由时要求两者有效），而各处的「空」定义随数据源而异（client 判空串、host 判长度、引擎判
  `undefined`）。判定一致、语境不同，抽共享谓词收益极小。
- **(10) 保存期门控一致性——不做**：`settings-bridge.ts:1449-1461` 查的是「顶层人设独占 vs 提示词
  配置独占互斥」，涉及 `spec.persona`——这是 **host-only 业务规则**，引擎无对应物。PLAN 的
  「移至引擎」在此不成立（引擎不管 persona）。
- **(11) `instruction-file` 语义单一来源——不做**：三处判定**语义各不相同**——
  host `pre-step-coordinator.ts:182` 判「是否被独立来源接管」（含 `config.id.startsWith('agents-file-')`
  的额外条件）、client `prompt-config-content.ts:19` 判「是否指令文件卡并取 `fileId`」、
  client `PresetSwitcher.tsx:43-44` 是在保存预设时**过滤**掉这类卡。唯一真正共享的是字面量
  `'instruction-file'`，漂移风险极低（改它要同时改引擎、host、client 与类型定义），
  强行抽「单一判定」反而会掩盖三者判的不是同一件事。
- **(7) 的另一半（映射改由 yml 提供）——不做**：见上，两处分工不同，保留 + 守卫是正解。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。
