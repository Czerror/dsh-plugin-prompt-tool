# DSH 会话损坏：pre-step 注入 `role: assistant` 写出不可加载的日志

- **Status:** needs-triage
- **Type:** task
- **来源报告:** `C:\Users\Cz9nl\Desktop\DSH会话损坏诊断报告.md`（267 行，含五环故障链与只读自查脚本）
- **报告日期:** 2026-09-16
- **触发报错:** `stored session "session-6ffe4f08-…" is corrupt: failed validation: Error: session event at seq 8 message must have role "user"`
- **性质:** 故障诊断结论。按 `AGENTS.md`「审查发现本身不等于修复授权」，且**历史恢复与防复发是两项独立授权**，本 issue 需用户分别指定范围。
- **数据影响:** 已确认 3 个会话文件损坏、8 条越界事件；另有 3 个预置存在同类"雷"

## 一、结论摘要

**不是磁盘或压缩文件损坏，而是写入端产出了违反会话不变量的数据**：数据一旦落盘，读取校验必然失败，整个会话无法加载。

DSH 的内部约定是「pre-step（步前注入）阶段的消息只能是 `user` 角色」，而 prompt-tool 引擎允许把 pre-step 注入项配成 `role: assistant`。DSH 内核**写入时不校验角色、读取时严格校验**，于是配置里的一个 `role: assistant` 就把会话写成了自杀数据。

## 二、故障链（五环，每环有代码证据）

| 环 | 位置 | 事实 |
|---|---|---|
| 1 | `.dsh\.agent-presets\v2-0\preset.yml:149-162`（`InertiaWaaagh`）、`:614-624`（`JustDoIt`） | 两个 pre-step 条目都配 `role: assistant` + `position: before-all` + `dedupe: none`；两者 `mergeMode: merged` 相同，会合并成同一条消息（命名空间 `merged:before-all`） |
| 2 | `engine/executor.mjs:98`、`engine/schema.mjs:134,139` | 引擎把角色原样写进消息对象；插件层把 `assistant` 列为合法角色且允许 pre-step 层携带 `role`，**无任何拦截** |
| 3 | `deepseek-harness/packages/core/agent-loop/src/agent.ts:375-377` | pre-step 消息一律按 `user/message` 事件落盘，而消息对象里的 `role` 字段被原样带入 |
| 4 | `packages/core/session/src/surface.ts:172-199`、`index.ts:748-749` | 写入路径的 `validateSessionEventData` 只校验 `request/header` 与 `tool/result`，**对 `user/message` 不做检查**，也未调用角色校验函数 |
| 5 | `packages/core/session/src/index.ts:320-325,341-345,166-172` | 读取路径规定角色映射并断言，不符即抛 `message must have role "user"`；回放（`adoptSessionEvent`）同样执行该校验 |

**补充事实:** 投影时 `user/message` 是原样透传（`surface.ts:137-139`），所以"让模型看到自己说过的话"这一注入效果在当次请求中**确实生效**，只是这份历史再也读不回来。DSH 没有注入 assistant 角色的合法通道（`assistant/message` 只由模型流写入），因此 `pre-step + role: assistant` 属于「配置能力超出宿主通道能力」，必然失败。

## 三、影响面

扫描 `.dsh\sessions` 下全部 56 个会话日志：**3 个损坏，共 8 条越界事件**，全部来自 `InertiaWaaagh`：

| 会话 ID | 越界事件位置 |
|---|---|
| `session-6ffe4f08-e870-45b4-ba47-20d6318e2c45` | seq 8、28 |
| `session-2640f447-c480-4e0e-8c63-02ee58a9d966` | seq 8、30 |
| `session-8eac1757-ceaf-4a4b-bacc-10a3a1868237` | seq 16、36、44、54 |

其余 53 个会话通过校验。**潜在风险:** `v5-0`、`v18-8`、`beta-2-42` 三个预置同样存在 `role: assistant` 的 pre-step 条目（分别 3、12、6 处），切过去会重复同样的损坏过程。

## 四、修复方案

### A. 恢复历史（3 个文件）——**需单独授权**

- **做法:** 把越界事件的 `role` 从 `assistant` 归一化为 `user`，其余内容一字不改。
- **操作要点:**
  1. 先备份原文件（`session.v3.jsonl.zstd` → 带时间戳的 `.bak`）；
  2. 日志是标准 zstd 多帧拼接，须**逐帧解压、按原帧划分重新压缩并带校验和**；
  3. **绝对不要删除事件或改动 `seq`**：`surfaceOp.sourceEventSeqs`、压缩边界、表面节点都依赖事件序号，删事件会引发更深的结构错乱；改角色不改序号，风险最低。
- **代价（需知情）:** 模型回看这段历史时，文本角色由 assistant 口吻变为 user 口吻。

### B. 防复发（可选其一或组合）——**需单独授权**

| 方案 | 做法 | 取舍 |
|---|---|---|
| **B1 引擎侧根治（推荐）** | 在 `engine/executor.mjs` 的 `buildMessage`（`:90-109`）对 `layer === 'pre-step'` 强制 `role: 'user'`；或在 `engine/schema.mjs` 的校验中拒绝 pre-step 使用 `assistant` 并告警 | 从源头堵住，任何预置都不会再写出坏数据；代价是放弃"assistant 口吻注入"这一表达能力（该能力在 DSH 中本就无合法通道） |
| **B2 数据侧快速止血** | 把 `v2-0/preset.yml:160,622` 的 `role: assistant` 改为 `user` 或删除该行；`v5-0`、`v18-8`、`beta-2-42` 同理 | 改动小、立即生效；但重新生成预置会还原 |
| **B3 改走系统提示层** | 把这两个条目移到 `system-section` 层（该层不允许 `role` 字段） | 内容保留，但角色语义从"模型说过的话"变为"系统设定" |

### C. 上游改进建议（DSH 内核，本仓库不实施）

当前「写入宽松、读取严格」的不对称会把任何插件的小缺陷升级为**整会话不可加载**。建议二选一：
1. `append` 路径补 `assertMessageEventShape`（或至少做角色归一化并告警），让非法数据在产生点被拒绝；
2. 收紧 pre-step 通道契约：`decision.messages` 类型是 `UserMessage[]` 但运行时无校验，建议在 `agent.ts:375` 对 `role` 做断言。

## 五、验收要点

- **A 的验收必须经官方完整回放验证**：三个文件能被 DSH 正常加载并回放，事件、`seq` 与引用保持不变（不得凭魔数拆帧或忽略解析失败判定成功）；
- **B1 的验收需覆盖**：pre-step 配 `role: assistant` 时被拒绝或有明确降级告警，且 `pnpm test` 全绿；同时补一条"注入层与角色契约"的行为回归；
- 报告附录 5.1 提供了只读自查脚本 `scan-sessions.mjs`，可用于修复前后复核与后续巡检。

## 六、关键位置索引

| 位置 | 作用 |
|---|---|
| `.dsh\.agent-presets\v2-0\preset.yml:149-162,614-624` | 两颗雷：`role: assistant` 的 pre-step 条目 |
| `engine/executor.mjs:90-109` | 消息构造，角色由此透传 |
| `engine/schema.mjs:134,139` | 插件层允许 assistant 角色 |
| `src/host/sillytavern.ts:271-272,276-283` | 酒馆转换：世界书 `sourceRole === 2` 与开场白均映射为 `role: 'assistant'` |
| `packages/core/agent-loop/src/agent.ts:375-377` | pre-step 消息一律按 `user/message` 落盘 |
| `packages/core/session/src/surface.ts:137-139` | 投影时原样透传 |
| `packages/core/session/src/surface.ts:172-199` | 写入校验：不含角色检查 |
| `packages/core/session/src/index.ts:320-345` | 读取校验：角色不变量与报错文案 |
| `packages/session/session-persistence-jsonl/src/zstd.ts:48,111-113` | zstd 分帧扫描与带校验和压缩 |

## Comments

（暂无）
