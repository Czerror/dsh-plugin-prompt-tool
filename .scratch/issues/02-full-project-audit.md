# 全项目框架合规审查（HEAD f93182b 全量快照）

- **Status:** needs-triage
- **Type:** task
- **来源报告:** `C:\Users\Cz9nl\Desktop\dsh-plugin-prompt-tool-框架合规审查报告-2026-09-17.md`（432 行，含逐条行号证据、条款逐项结论与误报剔除记录）
- **审查基线:** HEAD `f93182b`（全量快照，非 diff 范围；工作区当时无代码改动）
- **审查日期:** 2026-09-17
- **审查准则:** `AGENTS.md` 硬约束 + `CONTEXT.md` + 4 份权威文档 + 3 份 ADR
- **审查方式:** open-code-review（`ocr` v1.12.4）delegate 委派模式：12 个分片 + 亲审 8 个核心文件
- **性质:** 只读审查，未修改仓库任何文件。按 `AGENTS.md`「审查发现本身不等于修复授权」，本 issue 需用户指定修复范围。
- **覆盖率:** `src/` 137 个文件 100%、`engine/` 自有 32 个 `.mjs` 100%、组合模块 41 个、测试 120 个、文档 14 份
- **验证基线:** `typecheck` / `lint` / `test`（919 通过）/ `build` / `git diff --check` **全部退出码 0**（说明下述缺陷均位于现有 lint/类型/测试的盲区）

> **范围说明:** 本 issue 的 engine 相关条目已在后续的**全引擎审查**（见 `03-engine-audit.md`）中深化与修正，engine 部分以 03 为准；本 issue 保留 host/runtime/client/shared 全貌。

## 一、结论摘要

工程质量基线很高：**919 个测试全绿、类型与 lint 干净、原子写盘与失败回滚贯穿 host 层、文档体系与实现高度吻合**。发现集中在三类：

1. **文档与实现相反**（最高优先，会误导维护与安全判断）；
2. **越界守卫根目录算错一层**（同一根因命中两个引擎模块，安全边界）；
3. **几处"看起来有保护、实际没有"的守卫**（工具在目录外、参数校验缺席、断言不生效）。

分级：🔴 高 14 · 🟡 中 26 · 🟢 低 38 · ⚪ 误报剔除 3（如实记录于报告 §九）。

## 二、🔴 高优先级（14 项）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| H1 | `host/instructions-policy.ts:59-61,186-188`；`shared/instructions.ts:70`；`client/data/instruction-policy.ts:23` | **指令策略缺省 `enabled` 实现为 `true`，而 3 份文档 + 契约注释 + 客户端回退值都是 `false`**（已行为实测 `exists=false, enabled=true`）。提交 `dfdac10` 只同步了 6 处中的 3 处（README、ui-architecture 两处），漏掉 ui-architecture 第 12 条、两份 docs、代码注释与 CHANGELOG | 先定夺方向（改文档还是改实现），再一次性同步 5 处 + CHANGELOG |
| H2 | `shared/bridge-contract.ts:301-307` | 「编译期断言」是**死类型别名**：键集不匹配时求值为 `false` 而 TS 不报错（探针实测 `tsc` 退出码 0）。漏改端点映射不会被 typecheck 拦住 | 改为 `const _x: AssertCoverage<...> = true`（对照 `engine-params.ts:273` 的正确写法） |
| H3 | `engine/schema.mjs:27`、`engine/tool-config-engine.mjs:351` | 越界守卫用 `new URL('../..')`，但引擎物化后位于 `<预设根>/.engine/` → 守卫根实际是 `$DSH_HOME` 而非预设根。`templateFile` 可读兄弟预设乃至 `$DSH_HOME` 任意文件进模型上下文；`configsDir` 可加载预设根外 YAML 并**注册 shell/http 执行器**（导入第三方预设包即可触发） | `'../..'` → `'..'`，补"预设根外一级必须拒绝"用例（现有用例只测更外层，故全绿） |
| H4 | `engine/prompt-config-engine.mjs:74`、`engine/executor.mjs:310,374` | 引擎行固定 `prepend: true`，而组合中 `context-gate` 恒排在它之前；`prepend` 为后注册者在外层 → **独立路径下引擎注入逃过 `allowKinds` 门控**（测试用"补偿性挂载顺序"规避，未覆盖生产顺序） | 调整 prepend 策略或组合行序，并补**生产顺序**回归 |
| H5 | `engine/tool-bootstrap.mjs:352-358,334,457` | `stages` 模式的 `keep` 集合不含 `phase_advance`（它在 apply 期注册），被 `filter` 剔除，而第 369 行仍把它写进给模型的提示文案 → `stagePreUnlock: 0` 时**阶段永久停在 0** | 把推进工具加入 keep；补 `stagePreUnlock: 0` 用例 |
| H6 | `runtime/world-book-tools.ts:136,147,149`；`host/worldbook.ts:67-68` | `world_book_upsert` 的模型可控 id 未过 `assertSafeConfigId`：含 `:` 或 `/` 的 id 会写入 `preset.yml`，物化时抛错被 `index.ts` 只 `warn` 吞掉 → 预设**每次物化都失败**，工具却返回"已保存、已重建" | 写入前调 `assertSafeConfigId`，或生成安全 id 并说明改名 |
| H7 | `runtime/tui.ts:308-311,213`；`shared/engine-params.ts:205` | `guideEnabled` 的目录默认是 `undefined` 且 6 个内置 `preset.yml` 均未声明 → `toggle/on guideEnabled` 一律返回"不是布尔开关"，而 usage 与 `architecture-params.md:189` 仍宣称可用 | `undefined` 时按当前生效值推导，或在 usage 标注需先声明 |
| H8 | `host/skills-import.ts:20,60-67,89-97` | `normalizeImportPath` 不拒点前缀段，提交时逐顶层条目覆盖并**删除旧备份** → 载荷含 `.system/` 会**不可恢复地删除** `skills/.system/prompt-tool/config.yml` 与 `.prompt-tool-manifest.json` | 拒绝点前缀段 |
| H9 | `host/skills-import.ts:38,41,58` | `content` 非字符串时静默按空串写 **0 字节文件**且返回 `ok: true` → 既有 `SKILL.md` 被清空、技能消失，界面仍提示成功 | 加类型校验 + "空内容即失败" |
| H10 | `host/characters.ts:398,418-421,482-487` | `chara-<id>-` 前缀用 `startsWith` 判归属 → `foo` 与 `foo-bar` 互为前缀的两张卡**互相串扰**（应用/移除 `foo` 会误删 `foo-bar` 的条目） | 改为最长匹配已知卡 id，或改用不可歧义分隔符 |
| H11 | `host/characters.ts:204-208,211-214,223` | `persistCharacterCard` 整目录替换，临时目录只写三文件 → 重新导入同一张卡会**永久删除 `memory.md`**（累积的角色记忆） | 保留 `memory.md` |
| H12 | `host/prompt-configs.ts:104,168` | 手写 `|-` 块标量且每行等量缩进 → 正文首行缩进更深时产物**不是合法 YAML**，一条正文让整个预设的提示词配置加载失败（同文件 128 行自称"不手写规则"） | 改用 `yaml` 适配器序列化 |
| H13 | `host/manifest.ts:464-472` | `openPresetLocation` 的 `spawn` 无 `error` 监听 → 无桌面环境时以**未捕获异常终止宿主进程**；且无条件返回 `ok: true` | 挂 `child.on('error', ...)` 并据实返回 |
| H14 | `client/data/use-prompt-tool-store.ts:432,690-692,715-719` | 保存校验用 `pool.seq`，而每次 `load()` 无条件递增 seq → 已成功写盘的应答被判"迟到"丢弃，基线不确认 → 下次保存发旧 `expectedRevision` 触发**伪 409**，用户"重新读取"会覆盖期间的新输入 | 改为只认 `contextId` 变化，或保留已成功批次的结果 |

## 三、🟡 中优先级（26 项，按主题）

**契约不自洽（5）:** `WRITER_PARAM_KEYS` 别名同数组致 §5.2 断言恒真（M1）；`InstructionPolicySnapshot` 在 bridge 内联重抄（M2）；`subagentToolPolicy.defaultProfile` 契约死字段（M3）；`configsValidate.strategyDir` host 忽略（M4）；`presetContent`/`importPreset` 请求形状与 host 不一致（M5）。

**导入与转换（6）:** `applyModuleConfigs` 遇 delegation 组行 id 时整段跳过嵌套合并（M6）；ST 别名优先级在字段间方向相反（M7）；缺省 `injection_position` 的 position 与 stSource.position 互相矛盾且不标降级（M8）；PNG 流式导入用卡片名而非文件名做 slug（M9）；`appendCharacterMemory` 未校验 `cardId`（M10）；技能导入非整树原子（M11）。

**工具语义与自述不符（4）:** `world_book_upsert` 的 `enabled` 缺省语义与描述相反，静默翻转用户停用状态（M12）；`upsertWorldBookEntry` 未限定 `strategy==='world-book'`，可覆盖普通配置（M13）；`tool-config-engine` 无会话时 `?? process.cwd()` 兜底（M14）；`withinCwd` 不解析符号链接/junction（M15）。

**门控与状态机（4）:** `context-gate` 在 `try` 外读 `decision.kind`（M16）；`skills-watcher` 自我关闭后不再重挂（M17）；`prompt-config-engine` 组合不可读时返回"官方行不存在"而非未知（M18）；`instruction-hint` 的 `params.file` 无边界与大小上限（M19）。

**客户端边界（5）:** `data` 反向依赖 `features/models`（M20）；`SubagentToolPolicyCard` 缺只读预设守卫（M21，服务端有 403 兜底）；store 对象每次渲染新建致 memo 短路失效（M22）；`PromptConfigFields` 条件调用 `useId`（M23）；`CustomToolsCard` effect 依赖不完整（M24）。

**清理与残留（2）:** `profile-skills` 暂存 `cpSync` 在 `try` 之外，抛错时 `.skills-sync-*` 永久残留（M25）；`skills-config` 同值写入仍丢被 patch 键的行内注释（M26）。

## 四、🟢 低优先级（38 项，汇总）

- **死代码（12）:** `bridge-contract` 死断言形态、`engine-params` 重复空串判断、`engine-capabilities` 死兜底、`executor.mjs` 的 `config.prepend` 与不可达告警、`interpolate.mjs` 的 `items.length === 0`、`shared.mjs` 的 `sessionMapGet` 死导出、`subagent-tool-policy-core` 死选项与 `|| 0`、`skills-import` 不可达穿越校验、`characters.ts` 恒空的 params 循环、`workspace-controller.open()`、`DialogSurface` 非锚定分支；
- **注释与实现不符（8）:** 指令策略文件头、`preset-core` 的 `__TOKEN__`、`agents-cards` 的 `fill=instruction-file`、右侧栏残留注释（2 处）、`DEFAULT_TRIGGER` 位置描述、`parseListParam` 空格分隔、`tui.ts` 悬空 JSDoc、`run-code-env` 死条件；
- **重复实现（6）:** 参数映射 4 份手写（`index.ts` ×2 / `preset-core` / `write-preset`）、`bootstrapMaxTokens` 归一 4 处、`createWarnOnce` 重复、过滤谓词两遍、`prompt-tool-view` 默认值重复、**预设 id 校验规则 4 份不同实现**；
- **样式文案性能（5）:** 唯一内联 style、`WorldBookDiagnosticsCard` 单值 `as` 断言、`bridge-transport` 英文文案、`controls.module.css` 的 `.configEnable` 双写（**注**：分片称 `gap` 失效，经复核为误——CSS 逐属性覆盖）、`anchored-popover` 每次渲染强制测量；
- **文档漂移（3）:** `ui-architecture.md §3` 目录树缺 **15/99** 个 client 文件；CHANGELOG 缺 `dfdac10` 条目；源码遗留 `// ponytail:` 标记 3 处；
- **其它（4）:** `writePluginState` 非原子、占位变量默认与客户端回退不一致、`st-world-book` 空结果不覆盖旧快照、sticky 候选与 delay 排除同时记录。

## 五、复核记录（误报剔除，如实保留）

1. **自定义工具 `array` 类型导致 400** —— 误报：`test/client/custom-tool-editor.test.mjs:72` 已用 `assert.doesNotThrow(compileCustomTool(...))` 锁定，`{type:'json'}` 会被官方 DSL 转换器正常物化；
2. **`HintTooltip` 隐藏时 `aria-describedby` 悬空** —— 不成立：两者在同一渲染批次内同步增删；
3. **`.configEnable` 双写致 `gap: 10px` 失效** —— 因果有误：CSS 逐属性覆盖，`gap` 仍生效（双写本身属实，降级为低）；
4. **`PARAM_KEYS` 白名单与校验器键集不一致** —— 由中降为低：客户端只遍历 `ENGINE_PARAM_KEYS`，那 7 个内容键当前无写入路径。

## 六、建议修复顺序

1. **零风险对齐:** H1（定夺并同步 5 处 + CHANGELOG）、H2（断言形态）、文档漂移与目录树；
2. **一行改动 + 补用例:** H3（越界守卫）、H6（id 校验）、H8/H9（技能导入）、H11（保留 memory.md）、H10（前缀判定）；
3. **功能回归:** H4（prepend 与门控层次）、H5（`phase_advance`）、H13（spawn error）、H14（seq 判定）、H7（TUI 开关）；
4. **语义与清理:** selectiveLogic 两 seam 统一、`applyModuleConfigs` 组行分支、watcher 重挂、`data → features` 反向依赖、死代码与重复映射收敛。

## 七、验收要点

- 每条修复都必须有**行为断言**（注入层/位置/时机/次数/受众/epoch），不用静态源码字符串匹配；
- 安全边界与写盘类修复需补**独立临时目录 + 临时 `DSH_HOME`** 的确定性回归，结束后清理；
- 文档类修复后运行 `git diff --check`，并核对文档中的路径、链接与命令。

## Comments

（暂无）
