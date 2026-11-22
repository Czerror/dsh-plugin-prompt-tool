# 模块数据、账本与知识库

模块私有文件与账本由受控模块拥有。知识库管理按实际会话和用户授权执行，显式导入见[模块私有数据预览与导入](params-migration.md#模块私有数据预览与导入)。

## 账本、授权与动态上下文

以下接口按目标模块复用，不要求模块 ID 为 `soul`。`soul-ledger`、`soul-maintenance`、`soul_ledger`、`soul_state`、`soul-self` 等是现有能力、工具或内容源标识，保留真实名称。模块声明相应能力后，工具仍须显式定位 `moduleId`；示例 ID 不授予读写权限。

### 账本读写与收口

`soul-ledger` 提供 `soul_ledger`，每次显式传 `moduleId`。作者和时间由真实会话与宿主生成，不接受覆盖。工具操作如下：

| action | 输入与权限 | 结果与限制 |
|---|---|---|
| `list` | `type`、`limit`；可选 `view: pending/open/pending-review`、`cursor` | 默认 30 条，最多 100 条、64 KiB；游标绑定内容版本与过滤条件；旧 `text` 投影为概要，不改原行 |
| `append` | `type`，`概要` 或旧 `text` 二选一，可选 `ref`／`feel` | lead 经官方 `tools/pre-execute` 审批；promise 仅最后一条 lead 的署名会话可追加 |
| `close` | `targetId/outcome/reason/ref?`；outcome 为 completed/cancelled，reason 非空 | promise 仅当前 lead 可关闭；shelved 原作者或当前 lead 可关闭；同结果幂等，冲突拒绝 |

条目类型为 lead、promise、fact、shelved、gain、loss、persona、container。收口只追加，不改旧行；暂时搁置仍未结。写入按模块锁串行，账本上限 8 MiB、单字段 8 KiB；坏历史、链接、取消或超限均拒绝，不重置账本。

首次合法写入前，在锁内建立 `data/.soul-ledger-v2.json` 的历史分界与逻辑身份；读取不初始化，历史 promise/shelved 标为待核对。条目 `id` 由模块规范路径、逻辑身份和原行内容链派生，追加及同路径正式导入复制不改变旧引用；inode 不作持久身份。模块改名、部署根迁移不保证旧引用，跨模块复制不是同一账本。

通用 `module_file_append` 拒绝向 `data/02-soul.jsonl` 和旧名 `data/02-墨.jsonl` 追加，包括大小写变体。显式数据导入仍须预览，保留来源并报告目标冲突。

close 数据需要账本 v2 读取器；旧版会忽略收口且仍可写入，兼容标记不能保护旧二进制。回滚先撤账本写能力及旧动态上下文、提醒贡献，再退代码；保留全部 close 行，不自动改用户副本、活变量或私有数据。

### 会话状态与升级

`soul-ledger` 同时挂载 `soul_state`，分别呈现标记、系统活动与快照时刻。操作如下：

| 操作 | 行为与边界 |
|---|---|
| `status` | 读取真实当前会话 |
| `mark` | 写 1–512 字符、最多 2048 字节的短状态；须带 `expectedRevision`，首次为 null；按模块与会话隔离，原子保存，卸载不删除 |
| `check` | 只读报告文件、账本、SELF 候选/投递、索引与维护/恢复证据；unknown/not-observed 不表示通过 |
| `check` + `includeUpgrade: true` | 仅知识库未绑定时可展开完整升级正文；已绑定或授权不可用时拒绝，须走下述真实用户入口 |

受控升级由真实用户执行 `/prompt-tool upgrade {"moduleId":"your_module_id","action":"preview"}`，审阅规则、能力参数和有效正文变化。此入口只处理匹配受支持规则基线的候选，不是任意自定义模块的自动迁移器。确认时改为 `action: "confirm"`，原样带回 `expectedRevision`、`expectedSourceDigest`、`expectedPreviewRevision`。目标、资产或知识库控制状态变化使预览失效；用户修改的正文或不同参数报告冲突，不强覆盖。模型不能代替确认，绑定后的完整升级包也不能经模型工具读取。

确认复用正式安装与重建，保留私有数据、账本、骨架、未知资产，以及知识库授权、项目、记录、学习、持续记忆开关和已消费辅助额度。模块内知识根随受控升级交接目录身份，普通目录替换仍拒绝。状态保存失败恢复原模块与绑定，可重新预览；存储结果或目录恢复无法确认时保留现场及备份，按错误中的路径核对，不重新接入覆盖状态。已持久化但重建失败返回 `publicationPending:true`，修复后重新装配。升级不替代接入、项目选择或持续记忆启用，也不自动更新已有副本或重启 DSH。

mark 的唯一所有者是通用会话键 `soul.mark`，`soul_state` 兼容接口、`module_variables` 与模板共用限长。`recordedAt` 来自该键的宿主更新时间：同值写不刷新，其他键变化不改变 mark 时刻，但会使整表旧 revision 失效。

旧 `data/.soul/state-<hash>.json` 仅由会话变量 owner 在新记录不存在时兼容读取。首次合法会话写将旧 mark 与本次变更一次提交到官方域，保留原件；新记录存在后不再读旧值。旧文件损坏或版本变化则拒绝迁移，不以空表覆盖。运行时与状态工具须接入 owner getter；依赖不可用时拒绝读取，不自行回读旧文件。

### 知识库授权与持续记忆

知识库默认未接入。以下管理操作只由真实用户执行 `/prompt-tool knowledge <JSON>`，每次显式传 `moduleId`；模型不能代替授权或学习确认。首次预览示例：

```text
/prompt-tool knowledge {"moduleId":"your_module_id","action":"preview","read":[],"write":["general","projects"]}
```

| 用户操作 | 请求与版本 | 行为与失败边界 |
|---|---|---|
| 接入预览、确认 | `preview`；保持请求改为 `confirm`，携预览返回的 `expectedRevision` | 默认目标模块的数据根，可用绝对 `root` 选其他目录或已存在父目录下的新根。`read` 显式列旧文件，`write` 只选 general/projects。预览与确认异步枚举最多 2000 项、8 层，并分块核对已选旧资料内容。未选旧资料仅查元数据。若以模块自身目录为根，既有的模块归属校验仍会读取 `module.yml`。已知失效的确认在读取正文前拒绝，校验期间取消不创建目录或绑定。已选内容、模块或根身份变化后须重新预览。仅补缺失目录，保留原有文件。 |
| 查询、选择项目 | `status` / `sources`；`project` 携绝对 `projectDirectory` 与当前绑定 `expectedRevision` | status 区分未接入、已绑定、不可用；sources 返回来源、待归类资料和版本。项目绑定实际会话：Git 按真实 common-dir，同仓 worktree 共享，独立克隆不共享；非 Git 按所选目录。后续 cwd 变化不改归属，已绑定会话不静默换项目 |
| 登记旧资料或历史 | `source-preview` 携 read 内 `path`，或 `sessionId` + 明确 `seqs`；指定 `scope: general/project`。保持请求改为 `source-confirm`，携预览的 `expectedRevision` | 旧材料须手选，不自动纳入；版本或来源变化须重预览 |
| 撤销来源授权 | `revoke` 携 `sourceId`、当前绑定版本 | 立即撤权，保留原文；受影响的摘要和学习停止注入 |
| 启停持续记忆 | 先绑定项目，再以 `enable` / `disable` 携当前绑定版本 | enable 从当前会话及新挂载能力的事件界线开始，只处理之后的新材料；disable 停新处理及新闭环学习、自动整理贡献，保留原文、合法查询与审计；重启用只恢复来源仍有效的贡献 |
| 查询、确认学习 | `learning-list`；`learning-confirm` 携学习条目 id 作为 `sourceId`、当前绑定版本 | 显示来源、范围、变更；仅有效候选可确认，core/locked 始终须用户确认，子任务不能确认或管理用户学习 |
| 撤回、忘记学习 | `learning-withdraw` / `learning-forget`，携条目 `sourceId`、当前绑定版本 | 撤回仅恢复此前仍有效的学习；忘记停用目标及后续依赖。保留原始证据和无关学习，不收回已投递文本 |

绑定由官方持久域按来源模块保存，不随导出、复制或导入转移；不可用时不切其他根。接入不自动启动整理、学习或跨项目授权。根重绑须重新选来源，旧引用不复活；搜索与回取都复核本机根、路径、版本及范围，普通文件工具不能绕过授权。

`module_search` 搜索已授权模块资料和历史，支持 `mode: timeline`；`module_open` 按返回的引用重验并回取原文。检索可做全半角、大小写、千分位归一化及模块声明的有界近义匹配，命中标明方式；会话索引仅含公开正文，排除插件注入、推理、流式片段与本插件工具回执，当前回合自动来源的助手/工具输出不参与即时召回，原日志不改写。

持续记忆中，正式账本写入关联真实来源、项目、根用户 MessageId 和稳定条目，原文成功后登记待整理；重试不重复追加。登记失败单独返回 `persisted:true`、`derived.state:"failed"`，恢复只补登记。`soul_state.recording` 分别报告原始成功、待整理和派生失败。子代理只继承派发时的任务范围与根用户输入，父会话后续材料不自动扩权；工具和自动 followup 不成为新用户根。

### 整理、学习与辅助调用

模型工具使用专用版本，不能拿整理或学习版本代替上述用户授权的绑定版本：

| `soul_state` 操作 | 输入与条件 | 提交边界 |
|---|---|---|
| `consolidate` | `text`、已登记来源或条目的 `refs`，生成前 `knowledge.consolidationRevision` 作为 `expectedRevision` | 至少含一条待整理条目，否则 `no-work`；不额外调用模型。只向授权区域保存不可变正文，关联引用与去重证据根；缺来源、未发布候选、跨项目引用拒绝 |
| `learn` | `text`、`layer: experience/judgment/expression/core/locked`、正式记录 `ref`、当前 `knowledge.learningRevision` 作为 `expectedRevision`；可用 `previous` 替换同层同范围学习 | 工具回执与观察游标不使稳定版本失效，新用户输入、来源、授权或学习变化会失效；短状态不转长期学习 |
| `assist` | 持续记忆已启用且有待整理材料；手动请求立即返回状态，与阶段结束自动请求共用预算；自动请求还要求 `soul-maintenance.enabled: true` | 通过当前会话路由无工具整理，发布仍走版本校验与不可变正文提交；成功与否不阻断普通对话或已授权直接记录 |

整理只在 `published` 后推进 pending。候选已保存而状态提交失败返回 `candidate`，保留原正文和 pending；同正文、引用及预期版本可重验恢复，冲突不覆盖新提交。成功重试不重复写正文或事实。候选不自动检索，也不能借普通来源登记绕过发布；撤权或来源变更立即停用整个受影响正文。

学习用 `basis:"explicit-long-term"` 表达明确长期反馈，宿主核实真实用户、事件版本与长期范围；临时要求、推断或层级不明保留候选，子任务不能冒充用户反馈。推断用 `basis:"inference"`，附 `refs` 与 `assessment:{decision:"adopt"|"candidate",reason,unresolved,counterRefs:[]}`。只有同范围至少两次独立真实用户经历、模型明确采纳且无未解反证才可生效；同源摘要不重复计数，项目经历不晋升通用偏好，core/locked 仍须确认。记录保留引用、证据根与依据，证据撤权或版本变化后停用，审计隐藏失效正文与理由，不自动按时间衰减或删除。

辅助调用保留完整账本结果、原始事件、作者与引用，不混淆用户请求和完成结果。预算参数在 `soul-maintenance.assisted*`，默认限制如下：

| 额度 | 默认与失败行为 |
|---|---|
| 次数 | 每个真实根用户 MessageId，主子合计最多一次；调用前持久预留，失败、取消、重放或恢复不返次数 |
| `assistedInputTarget` / `assistedOutputTokens` | 4096 tokens 是选材目标，不截断完整材料或引用；输入明确标识为估算，预留估算输入与最多 1024 输出 |
| `assistedSessionTokens` / `assistedSessionMs` / `assistedTimeoutMs` | 根会话累计 32768 tokens / 120 秒，单次生成最多 20 秒；可靠 usage 含缓存读写，缺失或失败保留预留，实际超限停后续辅助，估算可能低估 |
| 取消与 `assistedBacklogTurns` | 不占长维护锁；新输入、原生取消、模块释放、授权或来源变化请求取消并拒绝迟到候选，已消费资源不能收回。默认连续三个新用户回合积压集中提示，清空后重置 |

`soul_state` 和用户 `knowledge status` 的 `assistedConsolidation` 分别显示候选/发布、失败原因、预留/实际用量和积压。待整理不代表已生成摘要或已学会。

恢复旧版本前，用户先在绑定项目的会话执行 `disable` 并带当前绑定版本，确认停止新处理；再撤新写能力、SELF 和提醒贡献，等待辅助请求取消后切换版本。保留历史，不静默迁移或回滚新控制格式；账本 v2 的旧二进制风险见前文，不能删除 close 行迁就旧版。

<a id="self-装配与预算"></a>

### 动态上下文装配与预算

SELF 按知识库绑定状态取材。绑定后，旧资料待归类时暂停旧自动 SELF/提醒，保留骨架并显示待归类；账本 list 仅返回当前获授权的新记录。SELF 使用骨架、当前授权有效学习与真实身份；持续记忆启用时再加最多三条本项目有效未结事项及最近交接，已收口不重开，关闭或撤权立即停贡献，旧账本与快照不复活。启用模板求值的 persona 可用 `{{runtime.get::soul.learning}}` 读取同一投影。

绑定后的默认总预算为 12288 UTF-8 字节，骨架、已确认核心/锁定偏好与真实身份优先，其后按剩余预算放普通学习、当前状态、交接，省略说明也计入预算；受保护核心本身超限则明确失败，原文仍可按授权引用回取。

用户骨架为 `data/SELF.src.md`，诊断快照为 `data/.soul/SELF.md`。未绑定时沿用原 SELF：每步读取当前骨架、账本投影、真实会话身份/时钟和索引最近观测，维护关闭或快照缺失、陈旧不阻断读取。内容版本与历史分界最多重验三次，持续变动则报告不可用。

快照只作诊断或降级，降级须标明来源时间与安全原因，不能冒充当前事实；权限、路径或身份拒绝不能借旧快照绕过。派生与快照复用正文实现，屏蔽已识别凭据后按 UTF-8 字节预算输出，默认 12288 字节；骨架与身份不静默截断，事项提供有界摘要、精确总数和未展示数。

快照经 CAS、临时文件和 rename 保存，发布前重验来源，失败保留旧版。`rule-engine` 内置 `strategy: placeholder, fill: soul-self` 异步装配，模块无需策略 JS；候选渲染和真实投递分别观测。

预算取自模块事实，缓存最长 1000 ms，mtime/size 变化提前更新；读取或校验失败沿用最近有效值，无历史值则回默认。缓存不包含骨架或账本事实。定义暂时损坏不阻断安全只读来源，但仍逐次校验路径、文件种类和可读声明 ID，并限制最终输出。维护与注入共用预算校验，详见 [动态账本上下文与维护心跳](engine-context.md#动态账本上下文与维护心跳)。

### 恢复额度与索引

`generation-recovery` 额度保存在插件存储根的 `generation-recovery/<会话ID摘要>.json`，保存已消费 turn/step 身份及累计 used；锁内去重后原子替换，重挂与重启不清零，损坏文件拒绝重置。它不进入模块导出，也不修改会话日志。索引是可重建的派生内存状态，原账本与宿主日志仍为权威来源。

### 实现归属与验证

| 所有者 | 文件 |
|---|---|
| 完整定义/切片 | host/module-slices.ts、module-rules.ts |
| 安装事务 | host/module-install-transaction.ts |
| 模块/全局变量与会话域 | host/module-variables.ts、shared/module-variables.ts；host/session-variables.ts、runtime/module-variable-adapter.ts |
| 模块私有文件 | host/module-files.ts、module-file-path.ts；装配清单 host/module-manifest.ts |
| 导入/导出 | host/import-source.ts、module-package.ts、module-install.ts |
| 装配/人设 | engine/rule-runtime.mjs；runtime/agent-assembly.ts、persona-registration.ts 官方适配 |
| 请求/草稿 | shared/bridge-contract.ts、client/data/、settings-bridge.ts |

验证以公共接口的注入、写盘、bridge 载荷和安全拒绝行为为准；测试准入与交付检查见仓库规则。
