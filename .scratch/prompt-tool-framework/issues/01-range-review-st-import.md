# 范围评审：ST 导入预览 + 世界书诊断（ec5b8e3..f93182b）

- **Status:** needs-triage
- **Type:** task
- **来源报告:** `C:\Users\Cz9nl\Desktop\dsh-plugin-prompt-tool-代码评审报告-2026-09-17.md`（204 行，含逐条代码引用）
- **评审范围:** `ec5b8e3..f93182b` —— 最近 3 个功能提交
  - `177f128` fix(st): 读取世界书 extensions 蛇形别名并锁定 false/0 语义
  - `203da1e` feat(st): 提供同源导入预览、结构化转换报告与世界书只读诊断
  - `f93182b` feat(ui): 导入先预览后写入并展示只读世界书诊断
- **评审日期:** 2026-09-17
- **评审方式:** open-code-review（`ocr` v1.12.4）delegate 委派模式
- **性质:** 只读评审，未修改任何项目文件。按 `AGENTS.md`「审查发现本身不等于修复授权」，本 issue 需用户指定修复范围后才进入实施。
- **覆盖率:** 可评审文件 17/17 全部评审，0 跳过

## 一、结论摘要

架构方向成熟：**同源转换**（预览/提交共用同一纯函数）、**摘要防重放**（`sourceDigest` 校验）、**只读诊断零扰动**（旁路观测不改求值）都是正确姿势，测试质量高于平均水平。

核心风险集中在**「顺序组选择」这条新链路的三处接线断点**（H1 / H2 / M1）：它们使"多 `prompt_order` 组由用户明确选择"这一 `PLAN.md` 明确要求的功能在现实路径上**静默失效**。建议作为一批修复并补测试。其余为维护性与风格项，不阻塞。

## 二、发现明细

### 🔴 高

#### H1. 服务端：显式组选择被 `record.character_id` 短路，静默失效

- **位置:** `src/host/sillytavern.ts:138-140`
- **问题:** `??` 是空值短路，不是"找不到时的逐级回退"。只要卡内 `character_id` 存在（ST 卡导出常态），`options.characterId`（用户在下拉里的显式选择）**永远不会参与求值**。
- **复现:** 卡片 `character_id=100001`、`prompt_order` 含组 [100001, 200002] → 预览成功并出现组下拉 → 用户选 200002 → 服务端仍按 **100001** 组转换，无错误无提示，导入结果与用户选择不符。
- **与文档冲突:** `PLAN.md:176`「多个 prompt_order 组允许用户明确选择」、`PLAN.md:180`「所选顺序组发生变化，应重新校验/重新预览」。
- **测试盲区:** `test/host/st-preview-report.test.mjs:362` 只覆盖"无 character_id"场景。
- **修复建议:** 交换优先级为 `String(options.characterId ?? record.character_id ?? 100001)`；补用例：卡带 `character_id=111`、组 [111,222]、调用 `{ characterId: '222' }` 应选中 222。
- **置信度:** 高（静态语义确认 + 全调用链核对）

#### H2. 前端：`CharactersPage` 的组选择参数从未传出

- **位置:** `src/client/features/characters/CharactersPage.tsx:85`（提交）、`:160`（唯一写入点）
- **问题:** `groupCharacterId` 仅由 `onGroupChange` 写进预览 state，提交时不带 `promptOrderCharacterId`；且 `settlePreview(true)` 会先清空该 state。全项目检索证实 `promptOrderCharacterId` 只出现在 contract / settings-bridge / PresetSwitcher / 测试中 —— **该页的组下拉是纯装饰**。
- **正确示范:** `PresetSwitcher.tsx:48-52` 提交时带上 `promptOrderCharacterId`。
- **修复建议:** 让 `askPreview` 挂接最新选择（resolve `{ confirmed, groupCharacterId }`，或用独立 ref 不随 `settlePreview` 清除），提交时按 PresetSwitcher 模式传参。
- **置信度:** 高

### 🟡 中

#### M1. 歧义预览失败是死路：错误文案引导 UI 不存在的操作

- **位置:** `src/host/sillytavern.ts:140`（throw）+ 两个导入入口的错误展示
- **问题:** 卡内 `character_id` 与所有组都不匹配且组数 >1 时，预览抛错 → 提示「请提供 character_id 或导出全局预设」→ 但组选择下拉只在预览成功后渲染 → 用户卡死，只能手改 JSON。
- **修复建议（二选一）:**
  1. **推荐**：throw 改为结构化 4xx（`code: 'st-prompt-order-ambiguous'` + `groups: [...]`），UI 收到该 code 直接渲染组选择、选择后重发预览 —— 可与 H1/H2 一起收口；
  2. 轻量：文案改为可执行指引（明确要求重新导出文件）。

#### M2. `sourceDigest` 计算三处重复 —— 一致性风险

- **位置:** `src/runtime/settings-bridge.ts:1544`、`src/runtime/settings-bridge.ts:1845`、`src/host/characters.ts:174-175`
- **问题:** 三处为同构的 `sha256(path\0content)` 实现，**必须永远保持一致**（客户端提交与服务端重算逐字节比对），否则所有预览提交都会 409。
- **修复建议:** 抽公共 `computeSourceDigest(entries)` 到 host 层，`characters.ts` 与 bridge 共用，删除三处手写哈希。

#### M3. 上限常量 200/500 散落至少 5 处，UI 文案硬编码同值

- **位置与值:**

  | 位置 | 值 |
  |---|---|
  | `engine/st-world-book.mjs:31` `DIAGNOSTIC_LIMIT` | 200 |
  | `src/runtime/settings-bridge.ts:2287` `slice(0, 200)` | 200（硬编码，与引擎常量无关联） |
  | `src/host/sillytavern.ts:32-33` `REPORT_ENTRY_LIMIT` / `REPORT_DIAGNOSTIC_LIMIT` | 500 / 200 |
  | `src/client/locales-cards.ts:196,387`「前 500 条 / 200 条诊断」 | 文案写死 |
  | `src/client/locales-prompts.ts:31,351`「前 200 条」 | 文案写死 |

- **风险:** 改引擎上限时至少 4 处漂移，bridge 的 `slice` 不报错只提前截断。
- **修复建议:** 公共常量 + 文案用 `{limit}` 插值（`t()` 已支持参数）。

### 🟢 低

1. **`note` / `noteInfo` 逐行同构**（`sillytavern.ts:163-171` vs `177-185`，仅 `severity` 不同）→ 抽 `pushDiagnostic(severity)` 工厂；`mergeStConversionReports`（580-586）对 `flatMap` 结果重复计算 4 次，可先算一次复用。
2. **诊断载荷防御不完整**（`WorldBookDiagnosticsCard.tsx:27`）：注释称"防御畸形载荷"但只校验 `Array.isArray`；`record.id / stage / reason` 未验类型就渲染，非字符串对象会让 React 崩页。
3. **嵌套三元**（内置规则禁止）：`engine/st-world-book.mjs:84`、`sillytavern.ts:377-378`。
4. **快照更新条件可能显示过期诊断**（`engine/st-world-book.mjs:55,167`）：仅 `records.length > 0` 时刷新，删空世界书后卡片仍显示旧记录。
5. **不可达错误分支**（`PresetSwitcher.tsx:37`）：预览请求不带 digest，服务端不可能返回 `preset-preview-stale`。
6. **琐项**：`ImportPreviewCard.tsx:49` 的 `slice(0, 20)` 硬编码；`MainSessionPage` 诊断卡在 `hidden` 容器常驻挂载（开页即发一次 bridge 请求）；诊断卡刷新按钮无 loading 反馈。

## 三、设计亮点（值得保留）

1. **同源转换**：预览与提交共用 `convertStToPresetWithReport`；预览不落盘、不执行宏（测试用 `existsSync === false` 断言）；摘要防重放、预览身份不作写入凭证。
2. **诊断零扰动**：诊断由求值路径旁路产生；`st-world-book.test.mjs` 用 `Math.random` 打桩计数验证"读取诊断不改变抽样次数/时间窗/入选集合"。
3. **单一事实来源**：`stWarnings` 由结构化诊断派生（同一来源、消息去重）。
4. **测试质量**：蛇形/驼峰别名等价、`false/0` 语义锁定、200 上限截断、会话隔离、loopback 403 / 方法 405。
5. **契约纪律**：`bridge-contract.ts` 的端点覆盖断言同步更新（37 → 38）。

## 四、建议修复顺序

| # | 项 | 类型 | 工作量 |
|---|---|---|---|
| 1 | **H1** 服务端组选择优先级交换 + 补测试 | 1 行 + 1 用例 | 小 |
| 2 | **H2** CharactersPage 提交携带组选择 | 前端小重构 | 小 |
| 3 | **M1** 歧义错误结构化（code + groups）+ UI 选择重试 | 后端 + UI | 中 |
| 4 | **M2** digest 计算抽共享函数 | 重构 | 小 |
| 5 | **M3** 上限常量收敛 + 文案插值 | 小重构 | 小 |
| 6 | 低项 1-6 | 清理 | 按需 |

## 五、验收要点

- H1/H2/M1 必须用**行为断言**（注入组 → 提交 → 断言落盘配置来自所选组），不用静态源码字符串匹配；
- 补测试需覆盖"卡内 character_id 与显式选择冲突"这一场景（现有用例只覆盖无 character_id）。

## Comments

（暂无）
