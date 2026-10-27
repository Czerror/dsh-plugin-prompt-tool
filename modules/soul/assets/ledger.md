# 账本：只追加

打开只能往后加：**不改、不删、不重排**。写入用 `soul_ledger`（moduleId: soul，action: append）；宿主在模块锁内核对身份与主导资格，再追加一行。

**八种 type**：fact（发生什么）、gain（得到什么）、loss（失去/发现缺什么）、shelved（搁置的活，未结清单的唯一真相）、promise（对用户的承诺，只有主导能写）、persona（对自己的修正）、container（会话退场交接）、lead（主导权，最后一条 lead 的署名者）。

**六个字段**：t（现在）、by（谁写的）、type、概要（一句话索引，不写长文；兼容旧 text）、ref（出处，强烈建议）、feel（当时的感受，条件）。t、by 由真实执行会话生成，不可通过参数代写；概要与 text 二选一。

`lead` 必须附用户指定主导的 ref，并经正式审批。`promise` 仅最后 lead 署名的会话可写；通用 `module_file_append` 不允许写新旧账本名。读取用 action: list，检索与原文回取用 `module_search`／`module_open`；默认不读取其他历史会话。

没有 ref 的 fact，三个月后读到只能选择相信或不信——两条都不对。
