# 全引擎审查（engine/ 全部 77 个可审查文件）

- **Status:** needs-triage
- **Type:** task
- **来源报告:** `C:\Users\Cz9nl\Desktop\dsh-plugin-prompt-tool-全引擎审查报告-2026-09-17.md`（235 行，含装配契约核对结果与逐项条款结论）
- **审查范围:** `engine/` 全部 **77 个可审查文件** —— 34 个 `.mjs` + 2 个 `.d.mts` + 19 个 `compositions/source/local/*.yml` + 22 个 `compositions/library/*.yml`
- **审查基线:** HEAD `f93182b`
- **审查日期:** 2026-09-17
- **审查方式:** open-code-review（`ocr` v1.12.4）delegate 委派模式：6 个分片（E1/E2/E4/E5a/E5b/E6）+ 装配契约确定性脚本核对
- **性质:** 只读审查，未修改仓库任何文件。按 `AGENTS.md`「审查发现本身不等于修复授权」，本 issue 需用户指定修复范围。
- **结果:** 🔴 严重 1 · 🔴 高 8 · 🟡 中 16 · 🟢 低 18 · ✅ **装配层 0 缺陷**

## 一、结论摘要

**引擎的装配骨架是健康的**——41 个组合模块与 6 个预设的 `modules` 清单完全对应、46 条参数桥绑定全部命中真实 row、22 个官方模块逐字节等于上游切出、引擎不依赖 `src/`、相对 import 全带扩展名。问题集中在**四处"文档/契约承诺与实现相反"**、**一处会阻断整轮渲染的严重缺陷**，以及**组合层边界形态未被任何测试覆盖**。

## 二、🔴 严重缺陷（1 项）

### C1. 插值层把 `async` provider 的 Promise 当作文本，整轮 system prompt 渲染必抛

- **位置:** `engine/layers.mjs:243-258`（`runtime-context` + `strategy: placeholder` 分支）
- **事实链:** 该分支注册 `text: async (assembly) => {…}`；官方 `SystemPrompt.assemble()`（`node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:350`）为 `text: typeof entry.text === "function" ? entry.text(context) : entry.text` —— **同步取值不 await**。Promise 被当作文本存入 assembly，后续 `renderContextSections` / `renderPrompt` 对其执行文本操作抛 `TypeError`。
- **实测:** 以真实 `SystemPrompt.assemble` 复现：`asm.contexts[0].text instanceof Promise === true`，渲染阶段抛 `TypeError`。
- **可达性:** `engine/schema.mjs:275-277` 明确允许该组合，工作台能力卡也能改出。
- **为何长期未暴露:** 仓库测试直接调用注册的 text 函数断言（`test/engine/prompt-config-engine.test.mjs:953-968`），**从未经过官方 `assemble`**。
- **影响:** 违反引擎自述的"绝不 brick 会话"纪律——唯一会从引擎跑到官方渲染阶段再抛错、且不在任何 `try/catch` 内的路径。
- **建议:** 改为同步 provider（异步部分提前在 pre-step 解析），并补"经真实 `assemble` + 渲染"的端到端回归。

## 三、🔴 高优先级（8 项）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| H1 | `preset.yml`（仓库根，自述"复制即自定义预设起点"）`modules` 段 | 仍引用 5 个**已撤销模块名**：`code-presentation`、`persona`、`custom-bash`、`bootstrap-filesystem`、`cot-drip`。实测 `renderComposition` 抛 `composition module code-presentation not found` → **照抄模板得到的预设无法挂载**。附带：模板同时挂 `tool-bash` 与 `persistent-shell` 会触发 **`bash` 重名注册**（官方拒绝） | 更新为现行模块名并补"模板可渲染"回归；一并处理重名对 |
| H2 | `engine/tool-git-bash.mjs:174`、`tool-bootstrap.mjs:457`、`skill-search.mjs:54,92` | `ctx.tools.register` 的 **disposer 被丢弃**（未用 `ctx.effect` 收集），与仓库 `tool-config-engine.mjs:392` 的样板不一致 → 重挂/HMR 时产生第二份同名注册或残留旧注册。违反 `AGENTS.md`「重挂前释放旧实例」 | 统一收集（或确认 cordis 自动绑定后移除另 2 处的冗余包装），消除不一致 |
| H3 | `engine/tool-config-engine.mjs:207-223`（+`:209` 缺 `maxBuffer`） | shell 执行器的超时**只 `kill` 不设标记**，回调返回普通非零退出 → 模型无法区分"超时"与"命令失败"；kill 未杀进程树时调用**悬挂**。且无输出上限，超限时 `error.code` 被当退出码上报、截断不告知（同仓库 `tool-git-bash` 有 `maxOutputBytes`，两套实现） | 区分超时状态、加输出上限，与 `tool-git-bash` 合并为一套实现 |
| H4 | `engine/prompt-config-engine.mjs:47-56` + `executor.mjs:314` | 组合文件读取失败时把"装配未知"报成 `officialInstructions: false`（主动断言"官方行不存在"），函数注释却写"按未知处理"。经三态折叠后，复制协议布局或组合不可读时，同一份 `AGENTS.md` 会被**官方与插件各注入一次** | 恢复三态（`boolean \| null`）或在读取失败时保守阻止注入 |
| H5 | `docs/engine-reuse.md:225-241` | "严格两阶段门控示例"（四个示例中唯一）**缺 `modules:` 字段** → 实测 `rows = []`、**0 行且不报错**，12 行 `moduleConfigs` 全部 silent no-op；示例中 `skill-catalog` 还是 placeholder filler 名而非 `source.kind` | 补 `modules`、修正 `deferredSources` |
| H6 | `engine/layers.mjs:64-69` + `:246-256` | `registerOfficialVariables` 只扫描 `config.texts`，placeholder 配置的正文来自填充器运行期输出 → 已声明变量被出口清洗**静默删除**（实测 `{{tone}}` → 空，静态 text 时为 `FORMAL`） | 把填充器输出纳入变量注册扫描 |
| H7 | `engine/interpolate.mjs:119-121` | `Object.hasOwn(variables, key)` 排在最前，**声明/会话变量可覆盖运行时事实与动态宏**（实测 `{{time}}`/`{{lastusermessage}}`/`{{roll::1d6}}` 均可被覆盖），与 `SillyTavern.md:72`「时间与最后消息宏运行时求值」冲突 | 修正优先级或按文档显式声明覆盖规则 |
| H8 | `engine/tool-bootstrap.mjs:145-148,282` | 显式 `compactionTools: []` 被 **fail loud**，而文档默认值（`engine-reuse.md:163`）、模块自述（`:88` "default none"、`:279-281`）与**根模板示例**都是 `[]`；同批 `bootstrapTools: []` 却正常 → 三方语义错乱，按文档写 `[]` 会让**整个预设挂载失败** | 统一空数组语义，使文档/行默认/显式取值三者一致 |

## 四、🟡 中优先级（16 项）

**组合层边界形态（未被任何测试覆盖，4 项）:**
M1 `applyModuleConfigs`（`host/manifest.ts:798-801`）对 `rows:` **映射形态组合**直接 `return raw` → 参数桥与 `moduleConfigs` 全丢、顶层 persona 契约失效；
M2 参数桥把未声明的 `bootstrapTools` 回填 `[]` 并**顶掉行默认**，使最小组合意外进入零工具首轮（`compactionTools` 同理）；
M3 声明 `stages` 后 `promotion.status()` 分支被绕过 → `promoteGate`/`maxPromoteSteps`/`compactionTools` **静默失效**且无告警；
M4 `engine-reuse.md:160-174` 配置参考表的默认值与组合行/引擎默认不符。

**契约与声明（3 项）:**
M5 `engine/st-world-book.d.mts` 与实现**三处不符**（`diagnostics` 多 `step`、`selectStWorldBook(...args: unknown[])` 丢参数、**漏声明** `stChatMessages`）；
M6 `package.json:136` + `tsconfig.json`：34 个 `engine/*.mjs` 与 2 个 `.d.mts` **完全不在 lint/typecheck 范围**（`lib/*.d.mts` 反而有声明契约测试）；
M7 `architecture-params.md:405` 的 `resolveSubagentToolPolicy` 返回值描述含两个**不存在的字段**。

**运行时与生命周期（7 项）:**
M8 `write-preset.ts:50-65` 引擎指纹只取"路径:**字节数**"，等长内容修改不触发重刷 → 用户目录长期运行旧引擎；
M9 `st-world-book.mjs:24-27` 会话态放模块级 WeakMap，宿主静态 import 使 `.engine/` 副本写入的记录在诊断端点**读不到**（该链路无端到端测试）；
M10 `promoted-code-mode.mjs:53-102`：`presentAs` 失败在 assemble 路径静默、在事件路径**同步抛出会中断后续所有 `session/event` 监听器**；释放只看成功压缩；
M11 `subagent-tool-policy.mjs:229-241`：`installs` 用 WeakMap **无法遍历**，插件 scope 卸载时不撤销 shadow；
M12 `tool-git-bash.mjs:200-238`：超时计时器在 shell 解析前启动、`abort` 监听注册在 `try` 之外；
M13 `run-code-env.mjs:202-213`：`ctx.systemPrompt.section` 的 disposer **未收集**（同仓库其他注册点一律收集）；
M14 `context-gate.mjs:237-241`：`deferredGraceSteps` 为 0 时计数永不递增 → 声明的 kind 被**无限期过滤**。

**工具与策略语义（2 项）:**
M15 `tool-config-engine.mjs:240-266` delegate 的 `callId` 只由工具名派生（同外层调用内重复 delegate 身份塌缩）；`:226-238` http 的 `method` 允许模板但运行期不插值；
M16 `strategies.mjs:97-111`：锚定确认结果**永久缓存（含 `false`）**且从不按会话生命周期/epoch 清理 → 首次扫描时序不利时该会话永远走不到"已确认"分支。

## 五、🟢 低优先级（18 项，汇总）

- **命名遗留:** `context-gate.mjs` / `tool-bootstrap.mjs` / `tool-filter.mjs` 的 `export const name` 仍是 `anchored-*`（该值用于 **loader 诊断**，与组合行 id、文档、参数桥键都不一致）；
- **注释与实现相反:** `anchor-match.mjs:7-12` 把 `NOT`/`NOT_ANY` 写反（实现与 `SillyTavern.md` 一致）；
- **死代码:** `anchor-match.mjs:35` 的 `isRegexKey` 零引用；`classify-task.mjs:46` 与 `subagent-tool-policy-core.mjs:202` 的 `.sort(...) || 0` 恒不生效；
- **重复实现:** `shared.mjs` 的 `createWarnOnce`/`newMessageId` 被内联复制多份、`parseCounter` 两处字节级相同、`context-gate` 三个同体校验器 + `tool-filter` + `subagent-tool-policy-core` 共 5 份列表校验、三个 `*-tools.mjs` 是同一实现的三副本（且是 engine 内唯一用双引号的文件）；
- **文档漂移:** `engine-reuse.md` 只给计数未枚举 19 个 local 模块名（7 个从未出现）、`interpolate.mjs:189-197` 注释指向错误的重复点；
- **library 层:** `tool-cordis.yml:8-9` 等 4 处**悬空注释引用**（被引用的段未随行切出）、`# local patches: 0` 是生成器硬编码字面量且无断言（注释层改写不会被测试发现）、两组变体模块**共享 row id**（手工编辑可绕过）；
- **自包含性边界:** 文档称"复制即自包含、无外部依赖"，但 `subagent-tool-policy.mjs:21-24` 与 `tool-config-engine.mjs:33` 在模块顶层 `await` 解析官方包（该两行在无这些包的项目中 import 即抛错，文档未限定）；
- **schema 定位:** `schema.mjs` 自述"只管形状"却同步读盘并绑定执行闭包，宿主只为 4 个枚举常量就要拉起整张引擎图；
- **E1 补充:** `skill-search.mjs:31-32` 的 `inject` 多声明未使用的 `agents`（会让该模块在缺 `agents` 的 scope **静默不注册工具**）；三个 `*-tools.yml` 是 **CRLF** 而其余 38 个为 LF（实测产物混行尾）；`filesystem-editor.yml:17` 的 `cwd` 引用已消失的 `DSH_CWD` 并回落进程 cwd；`persistent-shell-posix.yml:11` 使组内 6 项 pwsh 配置**在任何平台都不可达**；两个模块来源头缺路径；`engine-reuse.md` 未登记 4 个本地模块与多个已映射参数键。

## 六、✅ 符合的条款（正面结论，值得保留）

| 条款 | 结论与证据 |
|---|---|
| `library/` 跟随核验过的官方 master、原样切出 22 个模块 | **完全符合**：逐字节比对 **22/22** 等于"生成头 + 官方切片"；GitHub 核验上游 master HEAD 与 `PROVENANCE.md`、每个模块 `# commit:` 一致；无本地补丁、无自定义 `disabled`、无额外 config |
| 装配显式按需语义（`modules: []` 合法空组合） | 符合：`custom` 预设实测 0 行；未列入的 `moduleConfigs` 为 dormant |
| 参数桥 `module.row` ↔ 组合库 row（含四种 mode） | 符合：**46 条绑定全部命中**；`nonempty-list`/`positive`/`editor-default`/`optional-cap` 逐一实跑无错配 |
| 六个插入点彼此独立、无跨层全局顺序 | 符合 |
| 协调器位于 `context-gate` 门控内侧 | 符合：按 cordis 4.0.2 `prepend` 语义精确复刻仿真验证 |
| persona 契约（不读模块库、不补 modules、不是可引用模块名） | 符合：`modules: ['persona']` 实测抛 `not found`；组合库无 persona 行 |
| `compaction-epoch` 被多模块共用、口径一致 | 符合：三个模块走同一状态机与同一成功压缩边界 |
| 纯模块 seam（`subagent-tool-policy-core`、`classify-task`） | 符合：无 I/O、无宿主服务访问、无模块级可变状态 |
| 引擎不依赖宿主源码、相对 import 带扩展名 | 符合：72 条 import 中 `src/` **0** 处、相对 import 全带 `.mjs`/`.js` |
| 有界性（诊断 200、宏 1 MiB/32 层、插值预算、`count` clamp） | 符合：逐项在位 |
| 世界书语义表（ST 通道） | 符合：`selectiveLogic` 0-3、`scan_depth`、`probability` 抽样保持、`group`、`recursive`、`insertion_order` 逐条对齐文档 |
| 装配契约确定性核对 | **0 问题**：41 模块 ↔ 6 预设 modules 完全对应、无同名冲突、17 个 `name:` 引用全部命中、无重复 row id、已撤销名仅出现在"负向断言"与"历史记录"中 |

## 七、建议修复顺序

1. **阻断级:** C1（async provider + 补真实 `assemble` 回归）、H1（模板旧名 + bash 重名）；
2. **纪律与语义:** H2（disposer 统一）、H3（超时/输出上限）、H4（负责人三态）、H6/H7（变量剥离与插值优先级）、H8（`compactionTools` 空数组语义）；
3. **组合层边界（补测试）:** M1/M2/M3 与 H5/M4 的文档修正；
4. **门禁与清理:** M5/M6（把 engine 纳入 lint/typecheck 或补声明一致性测试）、M7 与文档漂移、低优先级项收敛。

## 八、验收要点

- **C1 必须补"经真实官方 `assemble` + 渲染"的端到端回归**——本题正是因测试绕过官方装配而长期未暴露；
- 组合层修复需补**组合级回归**：`rows:` 映射形态、`stages` 与门控并存、参数桥回填 vs 行默认；
- 资源类修复（H2/M11/M12/M13）的验收需覆盖 **disposer 释放**（`AGENTS.md` 要求"共享门控、提示词引擎或组合的验收覆盖主会话、子代理、压缩后重晋升和 disposer"）；
- 引擎声明修复（M5）后建议补一条与 `test/declaration-bundle.test.mjs` 同形的**引擎声明契约测试**。

## Comments

（暂无）
