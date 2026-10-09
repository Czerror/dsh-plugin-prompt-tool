# 会话历史的两个视图与消费点归属

状态：已采纳，2026-10-10。

## 决策

引擎新增唯一的历史读取入口 `engine/history.mjs`，给出两个**互不替代**的视图，由**消费点按各自语义选择**：

| 视图 | 入口 | 语义 |
|---|---|---|
| 当前可见上下文 | `currentEvents(session)` | 按宿主 surface 的有序节点取事件；被压缩或位置替换**遮蔽**的节点不在其中 |
| 完整历史 | `historyEvents(session)` | 本会话全部 durable 事件，按 log 序 |

- 宿主的 `Session.surface` 是派生模型历史的唯一来源。插件只做**鸭子类型**读取（`session?.surface?.nodes`），不引入依赖或类型声明；`surface.nodes` 存的是 log seq，一次快照加索引即可映射——不折叠、不用已 deprecated 的 `eventAt()`。
- **判据**：一个消费点读的**每种事件类型**是否属于 surface 承载集合（`SURFACE_MESSAGE_TYPES`，真值源是宿主 `packages/core/session/src/surface.ts` 的 `SURFACE_EVENT_TYPES`）。surface 只承载消息事件——`tool/call`、`turn/start`、`step/end`、`compaction/end` **永远不是** surface 节点。
- **降级**：宿主缺 surface（或 `nodes` 非数组、节点越界）时 `currentEvents` 退回完整历史，等价于迁移前的行为。
- **不变量**：缓存与增量路径的**失效条件必须与它读的视图一致**——否则同一会话会出现「一直挂着」与「重启后」两种结论。本轮的三个缺陷（`count` 增量推进轮号、锚定确认的永久记忆、去重 memo 不随压缩失效）全部出自这条不变量被破。

## 消费点归属

| 消费点 | 视图 | 理由 |
|---|---|---|
| 去重（`executor#injectedMessage`、`hasInBatch`） | 当前上下文 | 「这条身份还在模型眼前吗」；被遮蔽后应重新注入 |
| 锚定确认与兜底轮数（`conditions/anchor`） | 当前上下文（轮数按 `seq` 去重） | 看**可见的**首条 assistant 推理；位置替换后同一事件可占多个节点 |
| `count` 的重建 | 按信号：消息类 → 当前上下文；`tool-call` / `turn` → 完整历史 | surface 不承载后两者，一律迁会让它们冷启动重建恒为 0 |
| `session` 谓词的 `present` | 按 `type`：消息类 → 当前上下文；其余 → 完整历史 | 同上；非消息类型若读当前上下文会恒真或恒假 |
| `condition#lastAssistantText`（`turn-stop` 的缺省匹配对象） | 当前上下文 | 模型现在看到的末条 |
| `interpolate#lastMessageOf`（`{{lastusermessage}}` / `{{lastcharmessage}}`） | 当前上下文 | 这两个宏是官方按可见消息求值的运行时事实 |
| `st-world-book#stChatMessages` | 当前上下文（按 `seq` 去重） | 关键词只由模型看得见的对话触发 |
| `st-render#generationKey` | **完整历史** | 帧边界与 `tool/call` 折叠都是 log-only 事件；用当前上下文会让那些分支变成死代码，且与降级路径结论不同 |
| `compaction-epoch#scan`（门控冷启动） | **完整历史** | 「本会话曾经 tool/call 过」是状态性历史事实，压缩遮蔽不该抹掉它 |
| `actions/assembly#fillUnlocked` | **完整历史** | 解锁名单不能因压缩而丢，否则已发现的工具被裁 |

## 取舍

- **不把 seq 去重放进读取层**：只有按条数计数的消费点需要它，三处的过滤条件各不相同（`anchor` 只看 assistant 消息、`st-render` 只看 `tool/call`、`count` 看全部）——抽共享函数要带 predicate，比各自几行更长。
- **不为「统一入口」抽大接口**：判定（`identityHit`）与缓存键（带 `replaceGeneration` 戳）是两种用途，装配侧的告警问的是「声明」而非「实际」，硬拉一个接口会把不同的东西绑在一起。
- **`count` 按信号分视图**而不是整体迁移：这是「surface 只承载消息事件」的直接后果，不是妥协。

## 后续

- 宿主扩大 `SURFACE_EVENT_TYPES` 时需同步 `SURFACE_MESSAGE_TYPES`（`engine/history.mjs` 有 `ponytail:` 升级条件标注）。
- `compaction-epoch` 的「压缩即重置」仍是**事件维近似**：用 surface 代次替换会改语义（非压缩 replace 也会推进代次、且代次只给整数、定不出边界 seq），升级条件写在 `isSuccessfulCompactionEnd` 的 JSDoc 里。
- `engine/actions/content.mjs` 的 anchor-notice 解析器缓存接不到成功压缩的信号，压缩后其 `source.summary` 措辞可能滞后——只影响文案，不影响注入与否。

## 与历史决策的关系

- [ADR-0007](0007-unified-condition-action-rules.md) 规定条件与动作的语义；本 ADR 只补充**这些谓词读哪一份历史**。
- [ADR-0008](0008-module-slices-memory-assembly.md) 的模块切片与内存配装不变：本轮不写任何落盘格式。
