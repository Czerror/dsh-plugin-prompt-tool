# soul 工具速查

工具可能被工具面裁剪：先用 `tool_search({"toolNames":[...]})` 解锁，下一轮生效。

- `soul_ledger`（moduleId: soul）：`action: list` 读账本（limit 1–100）；`action: append` 追加，必填 `type` 与 `概要`（一句话索引，不写长文），建议带 `ref`。type 八种：fact / gain / loss / shelved / promise / persona / container / lead。`promise` 仅最后 lead 署名会话可写，`lead` 需用户指定并审批；t/by 由宿主生成，不能改历史。
- `module_search`（moduleId: soul）→ 用命中的 `reference` 调 `module_open`（moduleId: soul）回取原文；引用会重新校验授权与版本，不是访问凭据。
- `soul_ledger` 收口：先 `action: list, view: pending` 取稳定 `id`（有 `nextCursor` 则继续）；再 `action: close, targetId: id, outcome: completed/cancelled, reason: 非空依据`，可附 `ref`。promise 仅当前 lead 确认，shelved 原作者或当前 lead 可确认；暂时搁置仍未结。历史项标待核对，不自动视为已完成。
- `soul_state`（moduleId: soul）：`status` 看当前时钟、会话状态和来源；`mark` 用 `text`＋`expectedRevision` 显式记短状态（首次 null）；`check` 只读核对文件、SELF实际投递、索引及运行观测。标记时间与实际活动时间分开，不能指定其他会话。
- `module_search` 的 `mode: timeline` 按可信时间查已授权账本/会话，可用带时区的 `since/until` 和 `cursor`；未知时间明确标记。普通查询标注精确/归一/近义，原文不改。
- 旧副本升级由真实用户 `/prompt-tool upgrade` 预览并确认，模型不能代替用户确认或读取已绑定模块的完整升级包；有冲突先处理。升级不等于知识库接入或持续记忆授权。
- `module_file_read` / `module_file_append`（moduleId: soul）：读取允许 `memory.md`、`assets/`、`data/`；追写只允许 `memory.md` 与 `data/`，一次一行。账本 `data/02-soul.jsonl` 只能走 `soul_ledger`，通用文件接口会被拒。
- `module_manifest`（moduleId: soul）：`action: next` 看第一条缺失，`check` 看全部检查结果，`apply` 只建缺失文件、不覆盖不删除。
- `module_variables`（moduleId: soul，scope: module）：`action: list` 读全部并返回 revisions；`get` 读单键；`set` 必须 `key` + `value` + 读取时的 `expectedRevisions`；`delete` 只删本模块键，删除后回落全局。
- 变量是状态不是流水：计划变化或完成时覆盖 plan_step/plan_at（两者清空后，下个会话首轮会重新提醒写计划），装配完成后 scaffold_done 置 true；清单检查走 manifest 条件，不用手写状态变量。
- 会话短状态可用 `module_variables` 的 `scope: session` 操作 `soul.mark`，或继续用 `soul_state mark`；两者共用版本、限长和宿主时间戳。session 按真实当前会话隔离，需要官方 storageDomain；不能指定别人的会话。旧 mark 首次合法写自动迁入，旧文件保留。
- SELF骨架支持只读模板占位（plan_step、session.get::soul.mark、runtime.get::soul.open 这类写成双花括号）；缺运行事实不冒充零。session赋值仅由规则动作或工具执行，SELF不执行赋值。
- 记录落点：事件/承诺/未结→Soul账本索引；较长材料、可复用方法和项目决定依据→用户已选择并授权的本地知识库。同一事实只保留一个权威来源，其他位置只留引用；可重建事实读磁盘。
- 账本写入时机：完成跨回合任务、做出重要且难以回头的决定、踩坑后，及时用 `soul_ledger` 记录可核实的事件、决策依据或坑的形状与检测法，选择合适的 `fact` / `gain` / `loss`；不必等用户专门要求。退场前集中写一次 `container`，交接做了什么、产物在哪、下一步由谁接手。
- 写前先判断唯一归属并核对已有记录；已有事项不再追加一份，状态变化走既有收口流程。只留一句话索引与可回取的 `ref`；过程流水、可重建事实、无出处断言不入账。自主记录不授予 `lead` 或 `promise` 的额外权限。

## 持续记忆的实际操作

新会话先读有效SELF，按话题用 `module_search` 与 `module_open` 回取已授权证据。资料不足就明确未知，不能编造共同经历。`soul_state action: status` 区分未接入、来源不可用、原始记录、pending、candidate、adopted、inactive、取消、失败和辅助预算；记录成功不等于学习采纳。未接入时请用户走 `/prompt-tool knowledge`，不能自称已完成闭环。

明确长期反馈、重要决定和完成事项及时调用 `soul_ledger action: append`，保存一句话索引并使用返回的正式条目引用。明确长期反馈或多次独立经历支持的调整，再调用 `soul_state action: learn`：传 `text`、`layer`、正式条目 `ref`，必要时 `refs`；明确长期反馈用 `basis: explicit-long-term`，推断用 `basis: inference`。`assessment` 包含 `decision: adopt/candidate`、`reason`、`unresolved`、`counterRefs`；解释反证与替换依据，同源摘要不重复计数。核心与锁定偏好只能成为待用户确认的候选，不自报确认。

阶段收尾有新增材料时调用 `soul_state action: consolidate`，提交有来源的较长正文 `text` 和正式 `refs`；仅 `published` 表示已发布，候选、取消或失败保留待整理。正常会话优先；必要时 `assist` 请求受预算限制的辅助整理，新输入优先，不能把排队当成功。

版本分别使用：学习 `learn.expectedRevision` 取生成前 `knowledge.learningRevision`；整理 `consolidate.expectedRevision` 取生成前 `knowledge.consolidationRevision`；用户绑定/授权操作使用 `knowledge.binding.revision`。版本冲突先重读来源和状态，不盲目重试旧正文。
