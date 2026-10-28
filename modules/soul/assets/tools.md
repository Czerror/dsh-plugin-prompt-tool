# soul 工具速查

工具可能被工具面裁剪：先用 `tool_search({"toolNames":[...]})` 解锁，下一轮生效。

- `soul_ledger`（moduleId: soul）：`action: list` 读账本（limit 1–100）；`action: append` 追加，必填 `type` 与 `概要`（一句话索引，不写长文），建议带 `ref`。type 八种：fact / gain / loss / shelved / promise / persona / container / lead。`promise` 仅最后 lead 署名会话可写，`lead` 需用户指定并审批；t/by 由宿主生成，不能改历史。
- `module_search`（moduleId: soul）→ 用命中的 `reference` 调 `module_open`（moduleId: soul）回取原文；引用会重新校验授权与版本，不是访问凭据。
- `module_file_read` / `module_file_append`（moduleId: soul）：读取允许 `memory.md`、`assets/`、`data/`；追写只允许 `memory.md` 与 `data/`，一次一行。账本 `data/02-soul.jsonl` 只能走 `soul_ledger`，通用文件接口会被拒。
- `module_manifest`（moduleId: soul）：`action: next` 看第一条缺失，`check` 看全部检查结果，`apply` 只建缺失文件、不覆盖不删除。
- `module_variables`（moduleId: soul，scope: module）：`action: list` 读全部并返回 revisions；`get` 读单键；`set` 必须 `key` + `value` + 读取时的 `expectedRevisions`；`delete` 只删本模块键，删除后回落全局。
- 记录落点：事件/承诺/未结→账本；可复用判据→mnemon；项目变更为什么→工作区 `.ai-memory`（只留指针）；可重建事实→读磁盘。同一件事只写一处。
