# AGENTS 独立文件源与 pre-step 卡统一设计及修复计划

- 日期：2026-09-14。
- 审查基线：`dev@0779c13`；依赖目标：DSH `0.1.5-rc.2`、Cordis `4.0.2`，不是当前上游 master。
- 状态：已有实现并进入审查修复；实现、确定性回归与真实 UI/会话验收分开记录，以第 8 节为准。
- 授权范围：初始计划阶段仅交付文档；后续实现与本轮 13 项审查问题修复均由用户另行授权。
- 目标：AGENTS 正文、指令卡策略与预设分别拥有独立存储和生命周期，同时复用现有 pre-step 卡组件与执行算法；修复本次审查确认的六项问题。

## 1. 执行入口与范围

接手实现时先检查工作树和 HEAD，再读本节、缺陷清单、对应 Wave；不要将“计划已写入”当作“功能已实现”。

### 1.1 本轮设计包含

1. 修复正文漏读、普通卡正文丢失、未修改文件被回写三个 P1。
2. 分离预设卡与文件卡的读取、草稿、写盘、导出和重建。
3. 提供独立的指令卡策略存储，支持启停、层内顺序、位置、晋升时机、受众和模型范围。
4. 按本地 Agent 会话工作区探测文件，不使用预设构建时 cwd 决定所有会话的文件集合。
5. 复用 pre-step 执行算法，解决文件版本去重、压缩恢复、主/子代理、disposer 和重复装配。
6. 同步 AGENTS.md、领域/架构文档、README、CHANGELOG 与确定性测试。

### 1.2 不包含

- 不修改 DeepSeek Harness 源码、安装包或官方 system 预设。
- 不创建“AGENTS 专用预设”，不复制正文到 preset.yml、settings、生成目录或策略文件。
- 不引入数据库、通用文件管理框架、第二套工作台 store、第二套卡片 UI、全局跨插入点排序。
- 不增加任意文件路径编辑、文件创建/删除/重命名、远程文件系统编辑或持久草稿功能。
- 不新增旧参数/旧内容迁移与双读兼容代码；已有用户数据的升级由明确的切换步骤处理。
- 不停止、重启当前 DSH，也不占用其端口；真实切换由用户安排。

### 1.3 必须保持的仓库契约

- 入口只编排；host 管文件事实，runtime 管宿主装配，shared 管契约，client 管展示与草稿。
- 仅在 pre-step 插入点内比较 order；其他五个插入点及已有预设策略不借本次工作重构。
- YAML 写入使用 Document API，保留注释和未知字段；system 目录保持只读。
- 监听器、注册表条目和临时实例由 effect/disposer 释放；不 monkey-patch 宿主服务。
- 所有测试从 `D:\AI\workspase\_temp` 启动，并使用独立临时 DSH_HOME。

## 2. 审查问题、根因与修复对应

以下为已确认问题，不把后续设计中的风险推演计作新增审查发现。行号以基线为准，后续以符号定位。

| ID | 级别 | 已确认事实与定位 | 根因修复 | 验收 |
|---|---|---|---|---|
| F1 | P1 | `src/runtime/settings-bridge.ts:545` 的 /bootstrap 没有附带文件正文；:870 的 /prompt-configs 才补正文。工作台使用前者，空草稿随后可清空文件 | 两端点共用文件快照读取；读取失败不是空正文；文件保存要求成功读取状态和版本 | T01–T03 |
| F2 | P1 | `src/client/data/prompt-config-content.ts:19` 无条件剥离 text/params.text；persistConfigs 对所有普通卡调用，文本丢失 | 只剥离确实另有文件通道的内容资产；普通卡完整往返 | T04 |
| F3 | P1 | `src/client/data/use-prompt-tool-store.ts:519` 每次保存回写所有文件卡；旧副本覆盖外部新版本 | 分离文件草稿，只写 dirty 文件；服务端乐观版本校验；保存结果按文件返回 | T05–T08 |
| F4 | P2 | `src/host/agents-cards.ts:101` 的 dedupe=session 在 `engine/executor.mjs:160` 提前跳过 resolver；文件变更及压缩后重晋升都不再注入 | 文件来源使用内容版本与可见上下文状态去重，不改变普通预设卡的 session 去重语义 | T15–T21 |
| F5 | P2 | `AGENTS.md:69–70` 仍限定 DSH_HOME 写入及受管块，与直接编辑工作区文件契约冲突 | 删除受管块要求，明确经授权与白名单验证的指令文件编辑例外 | T28 |
| F6 | P2 | `AGENTS.md:63` 禁止提交所有生成目录，但 Git 跟踪 library 25 个文件、yaml vendor 76 个文件；build 只执行 tsdown | 区分 lib 与版本化快照：前者忽略，后两者由对应脚本生成、验证、提交 | T28–T29 |

基线证据：上一轮六个相关测试文件共 114/114 通过，但隔离复现仍确认 F1–F4；主会话和子代理均出现“首次 1 条、文件更新后 0 条、压缩后重晋升仍 0 条”。不能用这些旧绿灯替代新回归。

## 3. 设计决策

### 3.1 选择独立来源，不选择独立预设

| 候选 | 取舍 | 结论 |
|---|---|---|
| 继续在 writePreset 生成文件卡，仅不写入 preset.yml | 改动少，但探测、启停、重建和会话范围仍依赖预设 | 否决 |
| 将 AGENTS 放入专用预设并与其他预设组合 | 又引入预设切换/组合关系，不能满足文件独立 | 否决 |
| 文件源独立，视图合并，写盘分流，同一 pre-step 执行算法 | 能支持完整卡片位置/时机/受众语义；需要显式来源契约与作用域接线 | 采用 |
| 文件卡只做 UI 投影，继续由官方 agent-instructions 注入 | 最小方案，但卡片不能承诺由本插件统一排序及执行策略 | 仅作为缩减范围备选；不能实施中静默降级 |

本计划按“正文与卡片行为均可编辑”设计，所以独立策略文件是实际需求，不是预留框架。若用户改为只编辑正文，可以删除策略存储 Wave，并将行为控件只读化。

### 3.2 三个持久所有者

| 数据 | 唯一来源 | 作用域 | 生命周期 |
|---|---|---|---|
| 预设参数、模块、普通提示词配置、预设正文 | 既有 preset.yml / preset.md 通道 | presetId | 预设切换与重建 |
| 指令正文 | 原始 AGENTS.md / 已支持的指令候选文件 | 实际文件 | 用户文件生命周期 |
| 指令文件卡策略 | 拟定 `$DSH_HOME/.prompt-tool/instructions.yml` | 同一 DSH_HOME 下共享，文件按 fileId 覆盖 | 独立于预设；修改不调用 rebuildPreset |
| 卡片视图、正文草稿、读取版本 | 内存快照 | presetId 或 fileId | 当前工作台挂载期 |
| 注入可见状态、未确认候选 | 会话持久事件及有界内存快路径 | 会话/Agent | 会话与可见上下文生命周期 |

同一实际文件在多个预设/会话里只有一份正文、一份文件策略；不能按 presetId 创建指令副本。策略文件是本插件自有状态，不是新的正文真相源。

同一 DSH_HOME 下的多个 profile 共享此策略；首版不增加 profile 级覆盖层。若需要 profile 隔离，应在实施前另行确认，不把共享路径描述为 profile 私有。

### 3.3 独立策略格式与默认行为

拟新增文件示例（不存在时使用相同默认值，不因读取自动创建）：

```yaml
schemaVersion: 1
enabled: false
defaults:
  order: 30
  position: after-user
  promotion: none
  audience: null
  modelScope: all
files: {}
```

- `enabled: false` 是新独立注入源的安全缺省，UI 仍可查看和显式编辑文件。部署切换验收后由用户开启一次，不从各预设 agentsHints 自动推导。
- `audience: null` 表示主会话和子代理；`main` / `subagent`、position、promotion、modelScope 使用当前引擎已存在的枚举。
- `files.<fileId>` 只保存该文件相对 defaults 的行为覆盖；删除覆盖恢复默认，不删除正文。
- 允许覆盖：enabled、name（可选显示名）、order、position、promotion、audience、modelScope。字段类型及数值边界复用现有校验，并拒绝非有限 order。
- 固定不可编辑：文件身份/路径、layer=pre-step、role=user、form=instructions、文件内容填充绑定、来源归属、文件版本去重规则。初版不支持文件卡合并消息或任意策略切换。
- 策略变更影响未来满足条件的贡献，不承诺重新排序或撤回已进入会话历史的消息。
- 不存正文、文件读取版本、会话 ID、API 凭据或任意客户端路径。文件身份由服务端解析，fileId 不是写入授权本身。
- 策略文件整体也有内容版本；部分字段保存走 Document API，未知文档字段保留，未知请求字段拒绝。
- 策略文件缺失时 revision=null；首次显式保存可用 expectedRevision=null 创建。解析失败或不支持的 schemaVersion 不能当作空配置覆盖。
- 原 `preset.yml#agentsHints` 不再是运行时开关。旧字段不自动迁移、不自动删除；升级说明明确其不再生效。
- 新独立源开启后，空预设表示“没有预设贡献”，不表示“关闭部署级指令”；真正无指令环境通过独立开关关闭。这是需要记录的行为变化。

### 3.4 来源契约，不复用消息 sourceKind

拟新增 shared 类型；下列是目标契约草图，不是当前已存在接口：

```ts
type CardOrigin =
  | { kind: 'preset'; presetId: string }
  | { kind: 'instruction-file'; fileId: string; contextId: string }

type InstructionContent =
  | { status: 'ready'; text: string; revision: string }
  | { status: 'unreadable' | 'missing' | 'too-large'; message: string }
```

- 复用现有 PromptConfigDraft 的显示/行为字段；origin 与 content 是视图元数据，不写进 preset.yml，也不混入 params。
- origin 用于前端路由；运行时 sourceKind 用于消息来源。服务端不能只信任客户端提供的 origin。
- 使用独立 ID 命名空间，例如 `instruction:<fileId>`；预设不能以同名 ID 覆盖文件来源。取消按 params.file 或字符串前缀猜所有者的逻辑。
- fileId 由规范化的真实文件身份生成，不能继续无条件 toLowerCase 后截成 8 位。大小写敏感平台保留大小写；同一实际文件去重；服务端仍检查 ID 映射唯一性。
- revision 为读取到的原始文件字节的 SHA-256；不能只用 mtime，不能对 trim 后正文计算。
- 读取成功的空文本与读取失败严格区分；读取失败没有可保存的 text/revision。

## 4. 文件来源：范围、读取与安全写入

### 4.1 统一探测与工作区解析

扩展既有 `src/host/agents-cards.ts`，将探测、读取、文件身份、读写校验集中在这一 Module；UI 与运行时使用同一规则，不各写一套转换器。

1. 全局候选保留 `$DSH_HOME/AGENTS.md`。
2. 项目候选保留 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md；按项目根到 cwd 的目录链排列，同目录沿既有候选顺序。
3. 项目根暂沿用 `.git` 标记；无标记以会话 cwd 为根。本轮不扩大到额外上级用户目录。
4. 运行时使用 `agent.session.header.cwd`；缺失不回退为另一会话/进程工作区，只保留可确认的全局范围。
5. UI 提交当前 sessionId，服务端使用已发布的 Agent 能力解析本地会话 cwd，并返回 contextId。不得接受浏览器任意 cwd/path。
6. 当前没有可解析的本地 Agent 时，首版提供全局文件及“项目范围不可用”提示；不拿部署 cwd 冒充当前工作区。远程 Agent/远程 FS 不在本轮支持范围。
7. 只接受普通文件；目录、设备文件跳过并诊断。符号链接/重解析路径先解析真实路径，越出获准文件范围或无法稳定确认身份时，拒绝写入。
8. 首版不加 watcher；打开/刷新工作台、进入符合条件的 pre-step 时重新探测和读取。读性能有实测问题后再加有界缓存。

### 4.2 单次读取形成一致快照

- 一次读取同时得到正文、revision、文件身份和必要编码信息，避免“版本来自 V1、注入正文来自 V2”。
- 只支持可正确解码的 UTF-8 指令文件；现有 BOM 不因无关保存消失。不支持的编码显示错误，不以替换字符后写回。
- 拟定每文件正文上限 64 KiB，与固定版本官方指令行的 maxBytes 基线对齐；读写限制一致，超限显式报错，不能静默截断后覆盖。
- 未编辑的文件字节必须完全不变。编辑框的换行归一仅用于视图/dirty 比较，不能触发后台“格式修复”。
- 文本按原文注入，不继承 preset variables、ST 宏或其他预设插值；文件卡的 UI 正文快照不能成为运行时缓存真相。

### 4.3 保存算法

1. UI 只提交 status=ready 且正文相对已读取基线改变的文件；用户明确清空正文允许保存。
2. 服务端校验 method、loopback、Host/Origin、请求体上限、字段白名单和字段类型。
3. 重新解析 sessionId/contextId 与文件白名单；旧工作区、未知 fileId、越界目标立即拒绝。
4. 在同文件的串行写入段内重新读取文件，比较 expectedRevision；不一致返回 409，不写盘。
5. 在目标同目录排他创建唯一临时文件，写完整 UTF-8 内容；最终替换前重新检查目标身份。保留合理的原文件权限，不让原子替换扩大访问权限。
6. 原子 rename 成功后返回新 revision；失败保留目标原文件并清理本次临时文件，不将失败包装成成功。
7. 不调用 afterPresetImport/rebuildPreset；运行时下一次读取直接看新文件。

版本校验是乐观并发控制，不宣称 Node 的“读后 rename”是跨外部编辑器的原子 CAS：不合作的外部进程仍有极短竞争窗口。不得通过自动备份正文到策略/预设目录掩盖该限制；若需要跨进程强事务，应另行设计写入协议。

### 4.4 错误语义

| 情况 | 结果 |
|---|---|
| 非法字段/类型/未知文件 ID | 400，文件不变 |
| 非 loopback、非法 Host/Origin 或越界访问 | 403，文件不变 |
| 原文件已删除或读取对象不可用 | 404/明确不可用错误，不自动重建文件 |
| 文件版本、策略版本或工作区上下文过期 | 409，保留草稿，提供重新读取动作 |
| 请求体或正文超限 | 413，不截断保存 |
| 文件不可读、临时写或替换失败 | 明确错误，不返回空正文成功态 |

## 5. Bridge 与 UI 设计

### 5.1 接口收口

先改 `src/shared/bridge-contract.ts`，再同步 host/client。保留当前成功/失败包装，不借机整体改造 bootstrap 的 descriptor 结构。

| 端点 | 目标行为 |
|---|---|
| /bootstrap | 请求可带 sessionId；既有 promptConfigs 分支只返回预设卡，新增 instructions 分支返回 context、文件卡、正文状态、策略与版本 |
| /prompt-configs | 与 bootstrap 共用读取入口；明确返回预设卡与 instructions 两个分支，不再独立补正文 |
| /agents-file | 调整为单文件写请求 `{ sessionId?, contextId, fileId, expectedRevision, content }`，返回 `{ fileId, revision }`；不传 presetId |
| /instructions-policy（拟新增） | 读取/保存独立策略；写请求带 expectedRevision，只允许白名单策略字段 |
| /param-overrides | 只持久化预设卡；拒绝文件来源及保留身份，不以删正文的方式静默处理错误路由 |
| /import-preset、预设复制/导出/删除 | 只处理预设资产，不携带文件卡、AGENTS 正文或独立策略 |

这是客户端与服务端同步更新的契约变更。旧 UI 载荷应明确失败并提示刷新，不做可能清空文件的兼容猜测。正文通道只保留 /agents-file 一个写入口，清点并移除仍可写 agents 的旧 importPreset 分支。

### 5.2 一套 facade，两个草稿池

- `fields.promptConfigs` 与 savedConfigs 仅承载预设卡，保持现有预设身份保护。
- 在既有 usePromptToolStore 中维护按 fileId 索引的文件草稿：content、savedContent、revision、readStatus、dirty、保存状态。复用既有串行队列 helper，不新建全局 React Context/store 框架。
- 指令策略另有自己的 draft/saved 基线和 policyRevision，不使用 savedSwitches 假装属于 preset params。
- pre-step 展示列表是两类卡的派生视图；排序、筛选、展开可共用，但保存对象绝不能直接使用这个混合数组。
- 来源徽标、文件路径与“直接修改原文件”提示常驻可见；不可编辑的绑定和版本去重规则只读化。
- 单文件提供显式保存；不让 AGENTS 正文继承普通卡的 debounce 自动保存。保存全部也只保存用户已修改且可保存的对象。
- 切换预设只刷新预设草稿，不清空、保存或复制指令草稿；同文件在新预设下继续显示同一份待保存内容。
- 切换会话/工作区使用独立上下文序号，迟到响应不能覆盖当前视图。未存草稿先保留，旧上下文不可继续写；回到原上下文仍需重校验版本。
- 保存期间继续编辑：成功只更新请求快照的 saved 基线，新输入仍 dirty；409/写失败不清草稿，也不自动重载覆盖用户输入。
- 多文件“保存全部”按文件报告成功/失败，成功项更新版本、失败项保留草稿；不宣称文件与预设跨资源原子提交。
- 活动 sessionId 复用 host-api.currentSessionId 与现有官方会话订阅能力；仅会话身份变化时刷新指令上下文，不因每次模型投影更新全量 reload。

### 5.3 卡片编辑与保存分流

- 复用 PromptConfigCard / PromptConfigForm / PromptConfigList，使用 origin 决定允许编辑的字段及保存回调。
- 修复 stripContentText：仅 `isContentAsset` 为真的 preset.md 卡剥离文件通道正文；普通卡的 text、texts、params.text 保持原有合法含义。
- 预设序列化只排除 origin、读取/保存状态等视图元数据；这些字段不是再次删除普通正文的理由。服务端仍独立校验保留身份与写入契约。
- 文件卡正文不再塞入 params.text；移除这一路的 lift/strip 特例，避免编辑态与运行态互相覆盖。
- 文件卡不能被“删除卡片”按钮删除原文件；允许的禁用操作写独立策略。预设保存、模板应用、批量操作必须按 origin 明确分流。
- 显示文件读取失败、过大、冲突和项目范围不可用的实际状态，不能用一个空 textarea 隐藏错误。

## 6. 运行时：两个来源，一次 pre-step 执行

### 6.1 装配平面与最小协调接口

独立文件来源属于跨预设的部署能力；预设卡属于对应 Agent/standing scope。不能把所有会话的预设卡放进“当前 UI 选中预设”的全局变量。

拟新增 `src/runtime/pre-step-coordinator.ts`，作为插件拥有的、作用域感知的薄装配层：

- 在插件侧安装一个 `promptToolPreStep` 协调服务及其唯一 pre-step 监听器。
- 对预设引擎只暴露最小注册操作：`registerPreset(ctx, sourceId, configs) -> disposer`。这是拟新增的本插件接口，不是已有宿主 API。
- 预设来源保留在其注册 ctx 的作用域；独立文件来源根据本次 Agent 实时读取。
- 使用已安装的 `@deepseek-ai/dsh-scope` 的 ScopedLayers / NamedEntries / scopeOf 处理可见性和 effect 归属，不手写一套作用域继承注册表。
- 对当前 Agent 解析有效预设来源，合并本次文件候选，再交给从 `engine/executor.mjs` 提取复用的同一批执行算法。
- 不增加可扩展 provider 框架、订阅总线或存储插件系统；这里只有实际存在的两类来源。

固定版本证据：已安装 dsh-scope 的 README 和类型声明支持未标记监听器观察全局事件、作用域继承、ScopedLayers.merge/effect；dsh-agent 的类型声明提供 agent.ctx、agent.session 和 scoped agent/pre-step waterfall。引用见第 11 节。

### 6.2 保持原有引擎可独立复用

- `engine/prompt-config-engine.mjs` 在协调服务可用时，把 pre-step 配置注册到所属 scope，不再安装第二个本地 pre-step 执行监听器。
- 其余五个层级继续由原 wireLayers 接线，不能因本次拆分重复注册或跨层排序。
- 未安装宿主 prompt-tool 插件的独立引擎使用场景保留原来的本地执行路径，只执行自身预设配置；不强制依赖新的 host 源文件、host node_modules 或独立指令设置。
- 协调服务迟到、卸载、HMR 的接管/释放必须先撤销旧 pre-step 接线，再启用新路径；一个实例在任何时刻只选择一种执行路径。
- engine 不能静态 import `src/host`。文件快照由宿主协调层注入；作用域依赖留在宿主层，保持 engine 的自包含复制协议。
- `src/index.ts` 只负责安装协调层及既有 bridge；不得把注册表、文件 IO 或会话状态实现塞进入口。

### 6.3 生命周期接线必须先证明

实现前在 W0 使用固定版本真实 Cordis/scope 类型与隔离 harness 证明：

1. 全局协调器能收到不同本地 Agent 的 pre-step，读取其实际 scope 与 session，而不是最后一次 UI 选择。
2. 两个 standing scope、父/子 Agent 的来源继承和遮蔽符合宿主规则；同名不同 scope 不串配置。
3. 管理模式、独立模式、迟到服务与 disposer 切换都只有一个执行器；在途旧回调不能重注入。
4. 使用真实 `PreStepDecision` 的 `kind: 'enter' | 'reject'`，保留 startsRequestSeries 和其他 decision 字段；不只用旧测试中的 kind=ok 假对象证明接线。
5. 与 context-gate/压缩插件共同挂载时，没有因监听顺序变化让原预设消息绕过门控，也没有吞掉下游拒绝或消息。

这五项是实现前置门槛，不是当前已完成的 smoke。如果固定版本无法安全完成，不得以“分别挂两个监听器但共用 order 名称”冒充统一执行；停止运行时 Wave，报告证据，并由用户决定调整挂载方案或采用第 3.1 节的 UI-only 备选。

### 6.4 文件卡编译与候选合并

- 文件源将同一次读取的正文/身份/版本/策略编译成执行器可消费的卡；沿用现有位置、晋升、受众及模型过滤算法。
- 内部文件卡可使用 `dedupe: none` 进入公共算法，但其候选资格必须先经过专用“文件版本可见状态”判断；UI 显示“文件变化后更新”，不是一个可误改成 session 的通用下拉框。
- 普通预设卡的 session/batch/none 不在本轮改变语义；不要为修 F4 全局重写去重规则。
- 预设卡与文件卡的身份空间不互相覆盖。按 order 排序；相同 order 使用确定性 tie-break：保留预设来源顺序，再按文件的全局→项目根→cwd 探测顺序排列。
- 不将文件卡与其他来源拼为一个 merged 消息，保留每文件独立身份、版本与定位。
- 文件正文走 literal 内容路径，不经过 interpolateVariables。不能因共用执行器重新引入预设变量依赖。
- 找不到 after-user 锚点时延后，不擅自改成 before-all；延后不能标记已经注入。
- 独立存储不等于绕过已部署的会话门控。文件策略只能限定自身资格，不得借协调器绕过既有拒绝、安全限制或受众限制；作用域接线测试必须覆盖这些组合。

### 6.5 文件版本与可见上下文去重

最小身份为 `(sessionId, fileId, contentRevision, surfaceEpoch)`。会话事件是真相，内存只作有界快路径。

| 条件 | 行为 |
|---|---|
| 文件可读、满足策略、该版本尚未可见 | 加入本次候选 |
| 相同文件相同版本在当前 surface 已可见 | 不重复注入 |
| 文件内容变更 | 下一次满足插入条件时发出该文件新版本，明确是更新，不改写旧持久日志 |
| 成功压缩使原文退出可见上下文 | 新 epoch 重新具备注入资格；若有晋升条件，等待该 epoch 的晋升 |
| 失败压缩 | 不推进 epoch，不重放同版本 |
| pre-step 拒绝、缺少锚点、后续 prepare/admission 取消 | 不确认注入；下次仍可重试 |
| 插件重挂或进程恢复 | 从当前可见 epoch 的持久消息重建；不能扫描到旧 epoch 的同 kind 消息就永久跳过 |
| 文件不可读/超限 | 保留错误状态，不把错误当空文件；不将未知版本标记为已投递 |

实现要求：

- 文件消息使用稳定的文件来源身份；不同文件不能仅因同为 sourceKind=instruction-file 而互相去重。
- 可通过本插件命名的合法 message.id 编码 fileId/revision/epoch/attempt，source.plugin 标识文件身份，避免凭空依赖宿主未声明的元数据字段。
- 仅在本次消息真正形成持久准入事实后确认可见；“resolver 返回正文”或“插进临时数组”不等于已经注入。
- 压缩后的可见性与 `compaction/end` 成功边界、现有 compaction-epoch helper 对齐；replay 不把已被压缩替换的旧全文当成仍可见。
- 同会话主/子代理按各自实际 session/scope 处理，不共享一个全局 injected Set。缓存有界，Agent/插件 disposer 清理未确认状态和临时引用。
- 清空/删除已注入文件不能抹掉历史：停止后续全文注入，并对已可见版本提供一次带文件身份的失效/更新通知。若用户要求完全撤回历史正文，必须使用宿主正式的 surface replacement 能力或开启新会话，不声称“清空文件就删除历史”。
- 关闭独立来源/禁用卡影响后续贡献，不能撤销已经发给模型的内容；UI 说明这一点。

### 6.6 官方注入唯一负责人

当前 standard/ptc/creative 显式引用 official-agent-instructions。不能只因为文件卡使用另一个 sourceKind 就认为没有重复。

- 目标部署采用本插件统一执行文件卡；必须在受控装配中确认同一 Agent 没有并行官方指令加载器。
- 仓库自有模板的模块调整作为单独、可审查的变更；官方 library 快照本身保留原样，不能删改官方切块伪造来源。
- 已有用户预设不自动批量修改。列出受影响预设，由用户通过既有预设编辑/复制路径去掉重复装配后再启用独立来源。
- 对非本插件预设或无法确认的装配，显示负责人冲突/未知状态并拒绝启用插件文件注入，不同时执行、不靠同文案去重；普通预设功能仍可运行。
- 装配事实必须针对实际 Agent scope，而非仅查看当前工作台 presetTemplate。W0 必须验证固定版本可取得的事实来源；不能以未验证的 loader 内部接口作为发布条件已满足的依据。
- 无论由哪个负责人注入，UI 文件编辑都仍是原文件编辑；只有插件负责人激活时，才宣称独立卡策略会由本插件执行。

## 7. 逐文件修改清单

“新增”是计划路径，当前不存在；其余为已有文件。实现时按 Wave 细化补丁，不先创建空壳。

| 文件/路径 | 动作 | 主要内容 |
|---|---|---|
| `src/shared/bridge-contract.ts` | 修改 | 两类快照、session/context 身份、文件版本、单文件保存、独立策略端点、统一错误 |
| `src/shared/instructions.ts` | 新增 | 仅放真实跨 host/client 共享的 origin、内容状态、策略和响应类型/白名单；不复制引擎枚举算法 |
| `src/host/agents-cards.ts` | 修改 | 身份、统一探测/快照、读取错误状态、白名单与版本写入；删除 preset 生成专属假设 |
| `src/host/instructions-policy.ts` | 新增 | 插件自有策略文件的 Document API 读写、默认值、校验与 revision |
| `src/host/paths.ts` | 修改 | 独立策略路径，仅一个权威定义 |
| `src/runtime/settings-bridge.ts` | 修改 | bootstrap 与单读共用快照；正文与策略单独端点；去除文件写入触发重建的回调 |
| `src/client/data/prompt-config-content.ts` | 修改 | 修 F2；按 origin 路由；去掉文件正文借用 params.text 的协议 |
| `src/client/data/use-prompt-tool-store.ts` | 修改 | 两类草稿、独立版本/dirty/保存、上下文切换、冲突与部分失败回执 |
| `src/client/data/instruction-drafts.ts` | 新增 | 仅提取可独立测试的文件草稿/请求快照纯逻辑，避免 facade 继续堆积 |
| `src/client/data/{prompt-tool-fields,prompt-tool-view,dirty-state,bridge-client,host-api}.ts` | 按消费点修改 | 响应映射、窄订阅、来源类型与当前会话身份；复用 save-queue helper |
| `src/client/prompt-tool-types.ts` | 修改 | 视图卡 origin 与允许编辑能力，不把所有类型改造成通用文档框架 |
| `src/client/features/prompts/{PromptConfigCard,PromptConfigForm,PromptConfigList,PromptConfigsEditor}.tsx` | 修改 | 来源徽标、正文显式保存、只读绑定、操作分流、文件卡错误态 |
| `src/client/features/prompts/{prompt-config-policy,prompt-config-order}.ts` | 修改 | 按来源字段权限与确定性层内展示顺序 |
| `src/client/app/workspace/PromptWorkspace.tsx`、`src/client/app/workspace/pages/ConfigListWithTemplates.tsx` | 按接线需要修改 | 当前会话/工作区变化刷新及派生混合视图，不增加全局 Context |
| `src/client/locales-prompts.ts`、相关本地 CSS | 按实际呈现修改 | 来源、直接写文件、冲突、未启用、负责人状态及只读策略文案 |
| `src/runtime/pre-step-coordinator.ts` | 新增 | 发布本插件协调能力、作用域注册、独立文件来源、单监听器与 disposer |
| `src/index.ts` | 小改 | 安装协调层，接 bridge；移除过期 AGENTS 受管块注释/已无消费者的相关适配 |
| `engine/executor.mjs` | 修改 | 提取复用批执行路径，保留普通卡语义；支持文件内容 literal 及准入确认接线 |
| `engine/prompt-config-engine.mjs` | 修改 | 管理/独立模式 pre-step 接管；其他层级原样接线 |
| `engine/instruction-hint.mjs` | 小改 | 与独立文件快照/消息身份契约对齐，保留无 file 时的建议式提示用途 |
| `engine/compaction-epoch.mjs`、`engine/shared.mjs` | 按回归证据修改 | 优先复用；仅为确实缺少的 epoch/准入读取能力补窄改动 |
| `src/host/write-preset.ts` | 修改 | 删除 agentsFiles 参数及自动文件卡合成；不再探测/拷贝正文；保持普通预设物化 |
| `src/host/manifest.ts` 及其实际存储子模块 | 按引用复核修改 | 停止消费 agentsHints；预设导出/复制/删除只处理自身资产，保留未知 YAML 字段 |
| `preset/{standard,ptc,creative,custom}/preset.yml`、根 `preset.yml` | 按确切字段修改 | 处理独立源切换说明与重复官方模块；不强制改变无关门控/模型增强 |
| `package.json`、`tsdown.config.ts`、`cordis.patch.yml` | 仅实际需要时修改 | 核对公共运行时依赖、构建及 bundle 装配；不为新文件默认增加 patch 行 |
| `AGENTS.md` | 修改 | 修 F5/F6，补两类数据所有者与测试边界，不复制完整设计正文 |
| `CONTEXT.md`、`docs/adr/0003-instruction-files-independent.md` | 更新/新增 ADR | 明确“预设卡”“指令文件卡”及 ADR-0001 的适用范围 |
| `README.md`、`CHANGELOG.md`、`docs/{ui-architecture,architecture-params,engine-reuse}.md` | 修改 | 写稳定行为、破坏性切换说明、独立生命周期及新验收 |

测试文件：优先扩展现有 agents-cards、write-preset、prompt-configs、bridge-contract、prompt-config-engine、dirty-state、prompt-tool-view 等；只在缺少对应公共入口测试时新增 `test/host/instructions-policy.test.mjs`、`test/client/instruction-drafts.test.mjs`、`test/engine/instruction-lifecycle.test.mjs`、`test/host/pre-step-coordinator.test.mjs`。

不得手改 lib、library 或 yaml vendor。除明确改变组合源/依赖版本外，不刷新对应快照。

## 8. 分阶段实施与完成条件

阶段按依赖顺序执行。执行状态（2026-09-14）：

- W0–W4 已有实现，原阶段提交已压缩为 `11a9e73`；审查发现的来源、保存与生命周期缺陷按下表补充修复和行为回归，不以原完成标记替代验收。
- 下列勾选表示已有代码或对应确定性测试，不表示真实 UI、模型会话或用户运行中的 DSH 已验收。
- W5 尚未完成：完整门禁与审查反例回归之外，真实浏览器交互及本地主/子会话 smoke 仍需单独执行；不操作当前运行中的 DSH。

本轮审查修复证据入口（只覆盖对应反例，不等价于完整端到端验收）：

| 审查项 | 修复行为 | 回归入口 |
|---|---|---|
| S1–S2 | 明确文件来源身份，保留普通文件参数卡；链接根与候选统一真实路径，仍拒绝越界 | `test/host/instruction-source-review.test.mjs` |
| S3–S6 | 策略原始字节版本、严格解码、YAML 转换错误态、null 覆盖更新、用例隔离 | `test/host/instructions-policy.test.mjs`、`test/host/instructions-policy-endpoint.test.mjs` |
| R1–R3 | 迟到门控、resolver 来源 ctx、服务实例 HMR 重登记及空来源生命周期 | `test/host/pre-step-wiring.test.mjs` |
| R4–R7 | 迟到响应隔离、独立来源总开关、工作区往返保留基线、保存全部汇总失败 | `test/client/instruction-save-flow.test.mjs`、`test/client/instruction-drafts.test.mjs` |

### W0：契约冻结与规范冲突处理

- [x] 复核工作树、用户已有改动、目标版本与第 2 节定位。
- [x] 修正 AGENTS.md 的受管块/写盘例外与生成快照提交规则；建立指令来源独立 ADR，说明对 ADR-0001 的限定，不悄悄改写既有决策。
- [x] 运行第 6.3 节的固定版本作用域接线验证，确认负责人检测与 context-gate 顺序。
- [x] 确认本计划的默认禁用、独立策略、直接写文件、只支持本地 Agent 与历史不可撤回语义。

完成条件：作用域/单执行器关键机制有确定性验证，所有拟用宿主能力能对应已发布契约；否则仅推进安全修复，不宣称运行时设计已验证。

### W1：先止住数据丢失（F1–F3）

- [x] 先添加 bootstrap→草稿→真实临时文件保存的失败回归，不只测单独 /prompt-configs。
- [x] 收口正文读取；失败状态禁写，空文件仍可正常编辑。
- [x] 修 stripContentText，只对内容资产剥离，普通卡正文保留。
- [x] 改为 dirty 文件显式提交，加入文件 revision/context 校验；移除文件写后 rebuild 回调。
- [x] 初步建立独立文件草稿池，保存期间继续编辑和冲突时不丢稿。

完成条件：T01–T08、T11–T14 通过，原 F1–F3 反例转绿；这一阶段可以独立交付，不等待运行时重构。

### W2：独立策略与统一卡片 UI

- [x] 实现策略文件及 shared 合同，使用 Document API 与独立版本。
- [x] bootstrap/单读分开两类来源；不依赖生成目录才能显示文件卡。
- [x] origin 驱动 UI 字段、操作和保存分流；文件绑定只读，正文显式保存。
- [x] 预设切换保留文件草稿，工作区切换建立独立上下文保护。

完成条件：T09–T14 通过；卡片所有可编辑字段都有唯一持久化位置与读回证明，没有无效开关。

### W3：统一 pre-step 接线与文件可见状态（F4）

- [x] 提取并复用批执行算法，添加作用域协调服务与管理/独立模式接管。
- [x] 指令来源按会话探测，合并后统一层内执行；正文 literal，预设卡其余语义不变。
- [x] 根据持久准入和当前 epoch 确认文件版本；处理变更、空/删除、失败压缩、重挂与 disposer。
- [x] 验证所有公共门控、主/子代理、不同预设并发及 HMR。

完成条件：T15–T24 通过；没有第二套 pre-step 执行器、跨会话来源泄漏或新的外部 engine 依赖。

### W4：从预设生命周期中移除文件来源

- [x] 删除 writePreset 的文件探测/文件卡生成与 agentsHints 运行时依赖。
- [x] 预设保存/复制/导出/删除不含文件卡；普通卡完整 round-trip。
- [x] 处理仓库自有模板的官方指令重复装配，核对用户预设升级清单，不能静默修改 system/用户未知文件。
- [x] 生成目录通过现有物化流程更新；只重建插件拥有的目录，不清理全局指令文件或用户原文。

完成条件：T25–T27 通过；启用独立源后，各预设使用同一文件来源且只有一个注入负责人。

### W5：全量验收、文档与交付

- [x] 执行完整 typecheck/lint/test/build、diff 检查及本轮审查反例回归。
- [ ] 完成第 9 节对应的真实 UI 和本地主/子会话端到端验收：使用隔离 profile/随机端口，不操作正在运行的服务。
      （此前已验证：隔离 DSH_HOME + 独立 profile + OS 随机端口真机插件加载、/bootstrap、/agents-file 写入与 409、/instructions-policy；
      未完成：浏览器内真实 UI 点击路径与本地主/子会话提示词注入观察——冷实例没有存活会话，需用户环境或后续 smoke。）
- [x] 同步 README、CHANGELOG、权威文档、CONTEXT 和 ADR，核对路径与命令。
- [x] 只暂存本 Wave 文件，创建中文 Conventional Commit，推送 origin/dev；报告 SHA、验证和用户切换步骤。

完成条件：全部必需验收有证据，未验证项明确列出；真实服务尚未切换时不得写“已在用户运行环境生效”。

## 9. 验收矩阵与验证命令

### 9.1 确定性验收

测试以公共读取/保存/执行入口为主；复用现有 Node test runner 和 helper。不用静态源码字符串匹配替代行为断言，不用模型回答措辞作为注入验收。

| ID | 场景 | 必须断言 |
|---|---|---|
| T01 | bootstrap 与单独读取同一文件 | 正文、文件身份、revision、读取状态一致；UI 能显示真实正文 |
| T02 | 读取失败、无权限、非法编码 | 不生成 ready 空正文；客户端不可保存，其他卡正常工作 |
| T03 | 原文件本就为空、用户主动清空 | 可读空文件仍 ready；明确清空成功，未编辑卡不写盘 |
| T04 | 普通 static/placeholder 卡保存往返 | text、合法 texts、params.text 各自含义保留；仅 preset.md 内容资产剥离其文件正文 |
| T05 | 修改普通卡/排序其他卡 | 所有未修改指令文件字节和时间信息不变，/agents-file 调用次数为 0 |
| T06 | 外部编辑后旧草稿保存 | 409，外部版本字节不变；即使 mtime 相同也由字节 revision 检出 |
| T07 | 保存中继续编辑、响应迟到 | 成功只更新请求快照的基线；新草稿保留 dirty，不被 reload 覆盖 |
| T08 | 保存全部中一个文件失败 | 每文件独立结果；成功项更新 revision，失败项保留草稿；不报告全量成功 |
| T09 | 文件策略读写/并发/恢复默认 | 只改独立策略文件，正文与所有 preset.yml 不变；注释/未知文档字段保留，旧 revision 被拒 |
| T10 | 带未存文件草稿切换预设 | 文件内容、草稿、revision 不变；切换预设不隐式触发文件保存 |
| T11 | 工作区 A→B、A 的迟到响应/保存 | B 不显示/写入 A 文件；旧 contextId 被拒；不使用进程 cwd 兜底 |
| T12 | 两个本地 Agent、父/子代理、无本地会话 | 各取真实 scope/cwd；不存在项目范围时明确不可用；无跨会话文件/配置泄漏 |
| T13 | 未知 ID、伪造 origin、目录、重解析越界、超限 | 拒绝且无文件变化；UTF-8 字节大小正确；Host/Origin/loopback 原防护未退化 |
| T14 | 原子写失败/文件被删除/身份替换 | 原有效文件不被部分截断，不自动创建消失的文件；临时文件有确定清理与错误回执 |
| T15 | 主会话与子代理首次满足文件策略 | 每文件注入一次，位置/角色/正文/身份正确；不依赖预设的 agentsHints |
| T16 | 文件 V1→V2、内容保持不变 | V2 在下一合适 pre-step 更新一次；不变版本不按每轮重复；预设变量不改写正文 |
| T17 | 成功压缩后重晋升、失败压缩 | 成功边界后当前版本恢复一次；失败压缩不推进 epoch、不重复注入 |
| T18 | reject、无 after-user 锚点、prepare 取消 | 未形成持久准入不记已注入；条件恢复后仍可注入一次 |
| T19 | 恢复会话/HMR 后读取历史 | 当前 epoch 已可见的版本不重复；旧 epoch 的同 kind 不能挡住恢复 |
| T20 | 两个文件、一文件稍后出现/恢复可读 | 两个独立身份不互相去重；后出现文件能注入；同一真实路径不重复成两卡 |
| T21 | 已注入文件清空/删除/禁用 | 无新全文；必要失效通知仅一次；旧持久日志不被篡改，不谎称历史已撤回 |
| T22 | coordinator 迟到、独立模式、接管、释放 | 任一时刻每 scope 只有一个 pre-step 执行路径；disposer 后监听/来源/未确认状态归零 |
| T23 | 与 context-gate、晋升、压缩共同装配 | 普通预设原门控语义不变；受众/拒绝不被绕过；保留 enter/reject、startsRequestSeries 与下游消息 |
| T24 | engine 复制到无 host 源码的目录 | 普通预设可按原协议运行，不依赖 src/host 或协调服务强制存在；无隐式文件源 |
| T25 | writePreset 与空预设 | 不探测/复制指令正文，不生成文件卡；空预设配置仍为空，文件来源由独立开关决定 |
| T26 | 预设保存/复制/导出/删除 | 无文件身份/正文/策略混入；使用独特正文 sentinel 验证；不得简单禁止所有含 AGENTS 字样的普通文本 |
| T27 | official-agent-instructions 与插件来源 | 已受控切换时正文只有一份；冲突/未知时独立源不偷跑，UI 明确负责人状态 |
| T28 | 文档、术语、ADR、路径 | 无受管块旧契约、无统一禁止提交快照的规则；ADR-0001 的限定明确，链接和命令有效 |
| T29 | 完整门禁及必要快照重建 | typecheck/lint/test/build/diff 检查通过；重建输入固定版本，生成物与来源对应 |

建议落位：T01–T03/T05–T06/T13–T14 扩展 host agents-cards 与 shared bridge 测试；T04/T07–T11 扩展 client 纯逻辑及真实保存入口测试；T09 增加策略文件测试；T12/T22–T24/T27 在真实 Cordis scope harness 中验证；T15–T21 扩展引擎文件卡生命周期测试；T25–T26 扩展 writer/预设导出测试。

### 9.2 实施时的命令

以下用于实现阶段，不代表编写本计划时已经执行。PowerShell 7 路径固定为 `D:\App\PowerShell\7\pwsh.exe`；在该 shell 内运行：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
$env:TEMP = 'D:\AI\workspase\_temp'
$env:TMP = 'D:\AI\workspase\_temp'
$env:DSH_HOME = Join-Path $env:TEMP ('instructions-verify-' + [guid]::NewGuid().ToString('N'))

pnpm --dir $Repo typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
pnpm --dir $Repo lint
if ($LASTEXITCODE -ne 0) { throw 'lint failed' }
pnpm --dir $Repo test
if ($LASTEXITCODE -ne 0) { throw 'test failed' }
pnpm --dir $Repo build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
git -C $Repo diff --check
if ($LASTEXITCODE -ne 0) { throw 'diff check failed' }
```

- `pnpm --dir` 本身不能保证测试 cwd 隔离；当前 scripts/run-tests.mjs 会用临时 cwd 启动测试，TEMP/TMP 指向上述隔离根。验证时检查真实子进程 cwd，不只检查父 shell。
- 临时环境变量只留在验证进程，不写系统环境；文件系统测试各自建立、清理独立目录。任何递归清理先验证绝对目标仍在本次临时目录内。
- 定向测试也从隔离 cwd 运行，以绝对测试路径调用 node --test；依赖 lib 的用例先用既有 build 生成输入，不能拿旧 bundle 冒充新源码验证。
- 组合源确实改变时，用固定输入：`pnpm --dir $Repo rebuild:composition -- "$Repo/test/fixtures/dsh/0.1.5-rc.2"`。不使用重建脚本默认的同级开发仓库作为发布输入。
- yaml 依赖确实改变时才执行 `pnpm --dir $Repo sync:yaml`，并跑 vendor parity 测试；本设计不要求升级 yaml。
- 实现交付时保存每条命令的退出码、测试总数及关键断言；临时审查复现脚本不是正式回归测试的依赖。

### 9.3 真实 smoke

使用隔离 DSH_HOME、独立 profile 与随机端口，至少验证：

1. 打开工作台，查看真实全局/项目文件正文与来源标记；读取错误可见。
2. 编辑并保存 AGENTS；磁盘变化而 preset.yml、预设生成文件指纹不变。
3. 改普通卡、切换预设、导出预设；AGENTS 原文件不变，导出中没有正文 sentinel。
4. 外部编辑制造 409，继续编辑期间保存，部分文件失败；草稿均按预期保留。
5. 两个本地会话与一个子代理使用不同工作区；日志证明文件身份、位置、受众、版本和 epoch 正确。
6. 压缩恢复、组件卸载/重挂、独立源开关与官方负责人冲突；无重复注入或残留监听。

证据使用截图/操作步骤、实际桥响应与持久消息日志。没有实际 smoke 就明确写未验证，不能以构建成功替代。

## 10. 规范同步、切换与回滚

### 10.1 规范变更

- AGENTS.md：预设定义只拥有“预设行为”；指令文件与独立策略为独立所有者。明确只有用户授权编辑、当前上下文白名单及版本校验通过时才能写工作区文件。
- 删除已移除的“常驻受管块”指令，仍保留不覆盖用户未知改动、不修改官方文件的保护。
- `lib/` 继续忽略、不提交；`engine/compositions/library/` 与 `engine/vendor/yaml/` 是版本化分发快照，由脚本生成后按任务范围提交。不要顺手将它们 git rm 或加入 ignore。
- ADR-0001 保持预设自身单一来源的原则，新增 ADR 明确指令文件不属于预设配置；ADR-0002 的插入点独立性不改变。
- architecture-params 的 AGENTS 文件卡节迁为“独立指令来源”，ui-architecture 记录双草稿池与来源分流，engine-reuse 记录协调/独立模式和文件可见状态。
- README/CHANGELOG 明确直接改原文件、默认禁用后的显式启用、旧 agentsHints 不再生效、旧 UI 需刷新、官方负责人切换和远程文件范围限制。

### 10.2 用户环境切换

1. 发布前先交付 W1，避免用户在旧读写链路继续丢失正文；如果单独回移 W1，必须同时包含读取状态和保存保护，不只修一个端点。
2. 在隔离环境完成 W0–W5。列出用户预设中的官方指令模块与旧生成文件卡，不自动批量修改用户定义。
3. 用户通过既有预设编辑/复制通道处理重复负责人；system 预设只读，必要时复制后使用。
4. 更新插件并通过现有脚本重新生成插件拥有的预设产物；不重新创建或覆盖任何 AGENTS.md。
5. 新 UI 刷新、独立策略正常读取、负责人事实确认后，用户显式启用独立源。所有预设共享这一设置，不按旧 agentsHints 建立例外表。
6. 若 bundle、profile 或装配代码变化需要重载，交付注明“需要用户重启 DSH 服务后生效”；执行者不得自行重启当前服务。
7. 对未切换的第三方/用户 scope 保持可诊断的冲突/未启用状态；不要为了发布完成度隐藏这些状态。

### 10.3 回滚边界

- 正文是用户文件，不随代码回滚、预设回滚或策略回滚恢复旧副本。用户在新 UI 中合法编辑的内容必须保留。
- 回滚可先关闭独立注入源，再撤销本插件的协调/策略接线；必须确保官方与插件负责人不会同时恢复。
- 需要回退到旧装配时，通过既有版本化来源重建插件拥有的生成目录；不清理其他 profile、system 目录或用户文件。
- 独立策略文件保留原地，不导入 preset.yml；旧版本不识别时不启动迁移。
- 不应回滚到重新引入 F1–F3 的版本。至少保留 W1 修复；否则禁用工作台文件保存并明确风险。
- Git 回退采用新的可审查提交，不 reset --hard、clean、强推或覆盖已有历史；任何用户环境恢复需单独授权。

### 10.4 已知限制与停止条件

| 限制/风险 | 处理与停止条件 |
|---|---|
| 固定版本单执行器接管、门控顺序或负责人事实无法证明 | 停止 W3/W4；保留 W1 安全修复，不静默降级为双执行器 |
| 外部编辑器不参与跨进程锁 | 仅承诺乐观冲突检测与完整文件替换，明确剩余竞争窗口 |
| 远程/冷态会话无本地可验证工作区 | 显示范围不可用，不用部署 cwd 或用户输入裸路径兜底 |
| 历史已包含旧指令 | 不篡改历史；更新/失效通知或新会话，不承诺物理撤回 |
| 用户旧预设仍有官方指令模块 | 发布清单列明；负责人冲突解决前不激活插件文件注入 |
| 独立策略文件损坏/版本未知 | 提示错误、禁止破坏性保存；不以默认空配置覆盖 |

## 11. 资料来源与本计划验证

### 11.1 仓库依据

- [AGENTS.md](AGENTS.md)：修改、测试、交付及记忆规则；其 F5/F6 冲突是待修内容，不是本计划已完成的修改。
- [CONTEXT.md](CONTEXT.md)、[ADR-0001](docs/adr/0001-preset-definition-is-authoritative.md)、[ADR-0002](docs/adr/0002-insertion-points-remain-independent.md)：领域词汇和稳定架构约束。
- [UI 架构](docs/ui-architecture.md)、[参数架构](docs/architecture-params.md)、[引擎复用](docs/engine-reuse.md)、[组合编辑规范](preset/creative/skills/editing-cordis-compositions/SKILL.md)：状态、存储、作用域和物化约束。
- [文件卡实现](src/host/agents-cards.ts)、[writer](src/host/write-preset.ts)、[bridge](src/runtime/settings-bridge.ts)、[shared 合同](src/shared/bridge-contract.ts)：当前来源及读写链。
- [内容映射](src/client/data/prompt-config-content.ts)、[工作台 store](src/client/data/use-prompt-tool-store.ts)、[宿主能力接口](src/client/data/host-api.ts)：客户端保存和当前会话能力。
- [执行器](engine/executor.mjs)、[指令填充](engine/instruction-hint.mjs)、[epoch](engine/compaction-epoch.mjs)：当前注入与去重行为。
- [package.json](package.json)、[构建配置](tsdown.config.ts)、[测试入口](scripts/run-tests.mjs)、[组合重建](scripts/rebuild-composition.mjs)、[yaml 同步](scripts/sync-yaml-vendor.mjs)：实际命令与生成链。

### 11.2 固定版本宿主依据

本机于 2026-09-14 核对的已安装官方包（由 package.json 锁定版本），不是猜测新 API：

- `node_modules/@deepseek-ai/dsh-scope/README.md` 与 `lib/types/{index,store}.d.ts`：scopeOf、ScopedLayers、NamedEntries、effect/disposer、未标记全局监听与作用域继承。
- `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:92–99,139–149,306–319`：PreStepDecision、Agent ctx/session、agent/pre-step waterfall。
- `D:\AI\GitHub\deepseek-harness\docs\agent-lifecycle.zh.md`：生命周期说明仅作对照；若与安装版本不同，以固定包类型和隔离验证为准。
- [固定输入出处](test/fixtures/dsh/0.1.5-rc.2/PROVENANCE.md)、[官方指令组合快照](engine/compositions/library/official-agent-instructions.yml)：版本来源及 maxBytes=65536 基线。

### 11.3 原始计划提交的验收边界（历史记录）

- 原始计划提交 `4887019` 只交付 PLAN.md：检查 Markdown 结构、现有引用路径、拟新增路径标记、命令对应的 scripts、F1–F6 到验收项/Wave 的对应关系，以及 git diff --check。
- 当时 W0–W5、T01–T29 均待实施/待验证；文档校验不能代替实施证据，后续状态以第 8 节为准。
- 项目修改记忆仅追加到被忽略的 `.ai-memory/{YYYYMMDD}/daily.md`；不放知识图谱或 handoff，也不纳入提交。
- 原始计划仅提交文档；后续实施和修复仍只提交本轮任务文件并推送 origin/dev，报告 SHA，不创建 PR、不切换 main。
