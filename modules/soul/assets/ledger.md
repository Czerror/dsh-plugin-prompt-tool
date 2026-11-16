# 账本：只追加

打开只能往后加：**不改、不删、不重排**。写入用 `soul_ledger`（moduleId: soul，action: append）；宿主在模块锁内核对身份与主导资格，再追加一行。

**记录落点**：事件／承诺／未结进本账本的一句话索引；较长材料、可复用方法和项目决定依据进已授权本地知识库，通过 `soul_state consolidate` 提交正式来源引用和生成前 `knowledge.consolidationRevision`。同一事实只有一个权威来源，其余位置只留引用。可重建事实读磁盘。新闭环默认未接入，升级不能替代用户接入与持续记忆授权。

明确长期反馈、重要决定和完成事项及时调用本工具记录，使用返回的正式条目引用；长期反馈或独立多证据支持的调整调用 `soul_state learn`，版本用生成前 `knowledge.learningRevision`，不使用用户绑定操作的 `knowledge.binding.revision`。候选不等于已采纳，未实际调用不能称已记住。新会话先读有效SELF，必要时检索回取证据，未知往事不编造。

**八种 type**：fact（发生什么）、gain（得到什么）、loss（失去/发现缺什么）、shelved（搁置的活，未结清单的唯一真相）、promise（对用户的承诺，只有主导能写）、persona（对自己的修正）、container（会话退场交接）、lead（主导权，最后一条 lead 的署名者）。

**六个字段**：t（现在）、by（谁写的）、type、概要（一句话索引，不写长文；兼容旧 text）、ref（出处，强烈建议）、feel（当时的感受，条件）。t、by 由真实执行会话生成，不可通过参数代写；概要与 text 二选一。

`lead` 必须附用户指定主导的 ref，并经正式审批。`promise` 仅最后 lead 署名的会话可写；通用 `module_file_append` 不允许写新旧账本名。读取用 action: list，检索与原文回取用 `module_search`／`module_open`；默认不读取其他历史会话。

没有 ref 的 fact，三个月后读到只能选择相信或不信——两条都不对。

**逐项收口**：`action: list, view: pending` 包含新未结与历史待核对，条目 `id` 是宿主稳定引用；分页游标随账本变化失效，失效后重读。`action: close` 必填 `targetId`、`outcome: completed/cancelled` 和非空 `reason`；`ref` 仍是证据出处。完成与取消均追加 close 事件，不改原行。promise 仅当前 lead 收口，shelved 原作者或当前 lead 可收口；同结果重复不追加，换结果拒绝。执行者只能给依据，不能替主导确认承诺。

历史分界在首个合法写操作前固定，普通读取不创建元数据。历史 promise/shelved 逐条待核对，不按摘要猜测完成。SELF 与提醒读取同一投影，无需手工 ledger_open。含 close 后不能把旧程序当安全可写版本；回滚先停写及旧投影贡献，保留全部历史。
