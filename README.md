# dsh-plugin-prompt-tool — 提示词注入引擎

通过普通模块声明注入内容、插入点、时机、受众与动作。规则统一走 `compileRules → mountRuleSources`，对接九个独立官方插入点；六层可注入，agent-request、llm-stream、tool-pipeline 分别使用请求、流输出与工具动作。模块与官方会话预设分开，不分发或替换官方预设。

能力来源包括 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT）、[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 与 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)。锚定、晋升、PTC 与模型增强保持可选，不作为默认工作流。

## 安装

通过 DSH 官方插件管理流程安装。新 profile 可从 web 模板初始化；已有 profile 跳过初始化：

```bash
dsh --profile prompt-tool --from-default-profile web
dsh plugin --profile prompt-tool add dsh-plugin-prompt-tool
dsh --profile prompt-tool
```

本地开发可将安装来源换为 `link:<本仓库绝对路径>`。插件只诊断缺失的 Web 能力，不改 profile manifest、包链接或重启服务。版本要求以 [package.json](package.json) 为准：5.x 最低 DSH 为 `0.2.2-rc.2`，Node 为 `24.9.0`，Cordis 为 `4.1.0`。旧宿主由 DSH 兼容检查拒绝或跳过加载；不保留旧宿主兼容层，也不承诺裸 `pnpm install` 必定拒绝。宿主接入以实际安装的公开包验证，不能仅凭 peer 范围推断所有未来版本已验收。

**升级代码、bundle 或 cordis.patch.yml 后，需要用户重启 DSH 服务。** 人设由主插件在会话作用域管理，不改变官方服务的启动依赖：在每个 Agent 自己的 scope 注册同名段，遮蔽部署人设与预设 persona 行，不接管任何官方 fiber。AgentSetup 窗口内注册的同层声明会被撤换（插件人设优先），窗口外的同层声明撤不掉时装配失败并保留旧装配。

## 模块与工作台

```text
$DSH_HOME/.prompt-tool/
├─ config.yml                # 规则模块启用集合与全局层参数
├─ variables.yml             # 全局变量，variables 映射
├─ instructions.yml          # 独立指令策略
└─ modules/<id>/
   ├─ module.yml             # 唯一完整定义
   ├─ rules/                 # 已验证的物化切片
   ├─ memory.md              # 模块私有记忆，按需读取
   └─ data/                  # 模块私有用户数据（账本等）：不导出、覆盖保留
```

module.yml 支持 UI 保存与直接手改。rules/ 从完整定义分解，手改或失配会单向恢复；无效完整定义拒绝加载，不以切片反写。未知用户资产保留，模块关闭只撤回贡献。

工作台由官方悬浮入口（shell.overlay）或左侧栏「提示词工具」入口（sidebar.panellist 行点击直接打开）打开——两个入口打开同一个常驻抽屉，包含主会话、子代理、工具预览和模块四页。模块页统一新建、启停、复制、导出、导入和删除。启用模块将其规则加入运行时装配，停用撤回其运行贡献并保留模块定义与资产。编辑模块通过请求头选择，不切换官方会话预设。

在 dsh-tui 中，`/settings` 的「常规」页有一节「提示词工具」，只含模块运行总开关（settings 文档里唯一的部署轴）；模块参数与规则仍走 `/prompt-tool` 命令或工作台。

删除模块先在同卷隐藏 stage 里 rename，锁外再清理：rename 失败时原目录完整保留；清理失败时模块已移出，提示里会给出残留目录路径（清理未完成，内容可能不完整），刷新失败只影响列表、删除仍按成功处理。内置模块的用户副本删除后，重启会按缺失补建，这不是删除失败。若进程在 rename 后、清理前退出，隐藏残留目录会留在磁盘上，不会自动过期。

每张规则卡编辑完整条件树与动作；then/else 可嵌套，未知事实不当成否定成立。正文、状态分别做 CAS，后台刷新和请求期间的新输入保留。跨模块规则按配置序号排列，同组互斥由显式启用事务决定，排序不替作者选赢家。

人设与其他规则共用规则草稿和保存事务；工具、变量与指令策略保留各自的保存边界。布局、无障碍、locale 和 typed bridge 规范见 [UI 框架](docs/ui-architecture.md)。

破限／无限制／红队三个内容模块已移出本插件（存档在本地知识库 `03_Knowledge/archived-modules/prompt-tool-20261114`），本仓库只保留注入引擎：规则、条件、动作、插入点、组合、模块写盘与导入导出。内容改由外部内容插件提供，口径固定：模块目录 id 必须是 `redteam`（`ROLE_MODULE_ID`），角色规则 id 为 `role-<role>`（`plan`／`recon`／`assess`／`vuln-scan`／`exploit`／`internal`），协议用 `protocol-redteam`／`protocol-official` 占 `capability-protocol` 互斥组，自动派工总开关用 `auto-delegation`。缺这些内容时自动派工报 `AUTO_DELEGATION_DISABLED`，角色正文不投递并给出一次可见告警，不把「启动成功」当成「角色已生效」。**升级提示**：播种只补缺失、不删多余，已安装的旧副本会继续装配投递，需要收紧时自行删除 `$DSH_HOME/modules` 下的 `limit-breaker`、`redteam`、`unrestricted` 三个目录。



团队角色委派沿官方 Team 与官方 subagent 完成。启动前登记一次性 intent 与唯一 token，子会话在 `agent/created`（宿主 await，早于首个 assemble）消费并写入会话级角色事实；角色正文仍由外部内容模块的 `role-*` 规则与 `assets/` 提供，名称、描述与任务文本不授予角色。五个执行角色默认叶子（恒显式 `maxDepth: 1`，缺 `depthLimit` 即明确不可用而不启动），`plan` 只作用于真实根 Agent，派给子代理报 `ROLE_NOT_EXECUTABLE`。任务、依赖与版本由官方 Team 拥有，结果只在真实运行 `stopReason: completed`、有输出且归属匹配时标完成，一轮结束不等于任务完成；取消的启动不留可复用资格。关闭派工只撤回后续派工，不删官方任务、不中断其他来源。自动派工默认关闭、需显式开启，开启时选择红队协议，关闭时不自动切回普通协议。

官方指令预算通过普通人设动作的 `instructionsMaxBytes` 编辑，沿既有数字草稿、规则保存与发布。启动时在官方入口前加载 `node --import dsh-plugin-prompt-tool/early <官方入口>`；指令字节预算只验证官方 `@deepseek-ai/dsh-agent-instructions@0.2.2-rc.2` 的指定发行指纹，瞬时请求额度另验证同版本agent-loop的指定指纹。缺早期入口、已缓存或产物失配时，对应预算及同分支依赖正文暂停，无关规则继续；官方原预算透传。代码及早期入口变更需用户重启DSH服务生效，不自动重启。

## 原生模块格式

```yaml
id: project-rules
name: 项目规则
modules: [rule-engine]
variables: {}
rules:
  - id: project-context
    enabled: false
    then:
      - id: inject
        kind: inject-text
        config:
          layer: pre-step
          strategy: static
          position: after-user
          dedupe: session
          text: 请依据用户确认的项目约束执行。
```

规则是唯一行为源；人设使用 persona 动作，共享模型与能力参数保存于 layerSettings，变量与自定义工具各有独立顶层段。根 [module.yml](module.yml) 从权威目录生成九层及27个共享参数参考，示例默认关闭。

单个模块装配失败时，首次加载跳过它，更新时恢复它的上次有效贡献；其他正常模块继续加载和更新。晚到服务的初始化失败也按此处理，等待中的新版本不会覆盖最后成功版本。故障仍会报告，修正该模块定义或显式刷新后重试。全局配置和跨模块独占冲突仍明确拒绝，不自动选择赢家；完整边界见[运行时装配](docs/engine-reuse.md)。

- 条件使用 if，动作用 then，另有 else；动作身份在完整规则树中唯一。
- 注入正文策略为 static、placeholder、context-activation；文本与长度分类、确认、工具名和受众由通用条件承担，正文、投递、请求与流控制由动作组合。
- 工具提示通过 tool-catalog 只读引用同规则工具可见面声明，自动列出常驻名单与发现工具；提示正文和投递由模块规则控制。
- 九个插入点没有跨层全局顺序；order 属于该官方位置，configOrder 管同点跨模块顺序。
- `dedupe: session` 看当前模型可见上下文，旧消息被压缩/替换遮蔽后可再次注入。
- 主/子模型卡各有5个路由/采样参数，在装配时生成受众限定请求规则；也可显式编辑 request-params，不回写宿主全局默认。

字段、空值、保存和安全边界见 [参数框架](docs/architecture-params.md)，通道与生命周期见 [引擎指南](docs/engine-reuse.md) 和 [九层契约](docs/injection-point-contracts.md)。

需要“先发锚句、确认后注入正文”时，在同规则中用 `anchor.after.action` 引用锚句动作；确认只读取实际投递后的当前可见输出。默认持续等待、下次正常请求再注入；兜底次数和续跑均须显式声明。示例见 [模板16](templates/16-custom-fallback.yml)，直接匹配本批用户消息见 [模板14](templates/14-first-turn-anchor.yml)。旧专用策略与参数已直接替换，不提供兼容入口，也不自动改写已有用户模块。

## 持久变量与运行事实

模块 variables 覆盖同一 DSH_HOME 的全局变量。空字符串是有效值，删除模块键才回落全局。同模块的主会话与子代理共享，结束会话、压缩、卸载或重挂不清空。变量内容更新不重挂 Agent，下一求值读取新快照。

会话变量按来源模块＋真实当前会话隔离，裸引用优先级为会话→模块→全局。它们使用官方 `storageDomain` 持久化，需宿主提供该能力及后端；插件不另建存储引擎或修改 profile。会话数据不随 fork 或会话日志导出，工作台仍只编辑模块/全局。

**普通规则手动建立变量；ST 导入才自动登记缺失裸引用为空占位。** 模板 WHO、stateKeys 等需在变量卡建立；动作 config.variables 已退役。全局值不随模块导出。

需要赋值时显式设置 `params.templateEvaluation: true`，使用 module/global/session 的 set/get/add/inc/dec。一张模板可读多域但只写一域，实际读取的持久域都校验版本。session 赋值仅在异步规则和模型工具中提交，人设同步出口可读取但不能赋值 session。资格、解析和预算检查先于提交；同一次真实执行跨 assembly/pre-step/重挂不重复自增。发布失败只重试发布，不承诺任意跨进程崩溃后的 exactly-once。

SELF骨架支持普通变量和 `{{runtime.get::soul.open}}` 等只读事实；runtime 不可被同名用户值覆盖，失败保持不可用。会话键 `soul.mark` 与旧 `soul_state mark` 共用限长、版本和宿主时间戳；旧 mark 首读零写、首次合法写自动迁入且保留原件。详见 [变量事务](docs/architecture-params.md#持久变量事务) 和 [SELF](docs/engine-reuse.md#self动态内容与维护心跳)。

## 动态人设规则

```yaml
rules:
  - id: project-persona
    if: { variable: { key: mode, value: coding } }
    then:
      - id: identity
        kind: persona
        audience: main
        prefix: 你是项目助手。
        complete: false
```

所有启用模块的命中人设按既有规则排序、动作声明顺序分别拼接 prefix 与 suffix，非空片段以两个换行连接。动作 audience 可为 main/subagent，省略作用于两者；主子按真实 Agent 分别判定条件。人设卡是普通规则中 persona 动作的编辑视图，正文、条件、启停和排序共用规则草稿与 `/rules` 事务。

某字段所有命中动作都省略时才继承官方；显式空串阻止该字段继承，但不清空其他动作已提供的正文。complete/includeRuntimeContext 的显式布尔值必须一致，冲突拒绝候选并保留旧贡献。includeRuntimeContext:false 增加本插件抑制；true 只撤回本插件抑制，不能强开祖先 scope 的上下文。

原官方 assemble 前准备并提交完整候选，同一次装配固定该候选。全部失配或事实不可用撤回本插件人设并回官方；配置、解析或注册错误保留最后有效贡献并报告。自定义正文按所属规则模块读取变量与 runtime，继承官方正文不重新求模板；session setter 仍拒绝。旧顶层 persona 和 personaSources 已退役，读取根明确拒绝，用户须手工重建规则并移除旧字段，插件不自动迁移。

## 按需工具

| 能力 | 工具 |
|---|---|
| module-rule-tools | module_rules_read / module_rules_edit |
| module-variable-tools | module_variables |
| module-file-tools | module_file_read / module_file_append |
| module-manifest-tools | module_manifest |
| module-import-tools | module_import |
| soul-ledger | soul_ledger / soul_state |
| retrieval | module_search / module_open |
| tool-config-engine | customTools 中的实际工具 |

完整规则工具先读原始树与版本，再提交合法完整候选；删除整规则需显式 rule:null。变量工具提供 global/module/session 的 list/get/set/delete，set 必须显式字符串；session 只能访问真实当前会话，写入携带 revisions.session。模块私有文件（memory.md、assets/ 只读、data/ 只追加）由 module_file_read/append 读写，不自动注入；module_manifest 按 assets/manifest.yml 做 next/check/apply，只写 data/、不覆盖。

内置模块首次补建或同 ID 新建只复制 `module.yml`，`rules/` 照常派生；`assets/` 留在插件包内。资产逐文件按完整 `moduleId` 查找：用户目录优先，缺失才读包内同名模块；空文件是有效覆盖，读取错误或链接不回退。注入模板、工具读取、初始化清单/模板与检索共用此规则，`memory.md`、`data/` 不回退。改名复制/另存会补齐包内资产并保留用户覆盖，成为独立用户模块；不从 `-copy` 名称推断来源。已有资产不自动清理，移除本地覆盖后才使用包内版本。

工具目录仅注册已声明能力，晚到 provider 与 disposer 按原生命周期处理。模块工具的主语由**这次调用显式声明的 `moduleId`** 决定：不传即没有目标、直接拒绝，不回退装配记录首项或包内默认模块；执行 Agent 已启用的规则模块只作拒绝文案里的候选提示，不是目标。`expectedModuleId` 是桥端对请求头声明的一致性复核，与工具侧的主语选择是两套独立判据。工具只能读写模块存储根下 `module.yml` 所在的既有模块；模块内文件限定 memory.md、assets/（只读）、data/（只追加），不访问任意路径。自定义工具继续支持 shell/http/delegate/fs/ask-user，并保留官方批准、拒绝与取消管线。

## SillyTavern 与资产交换

ST JSON 预设、PNG/JSON 角色卡和独立世界书，经统一预览/确认/原子候选安装成为普通模块。默认同名另存，不自动启用。来源变化、目标变化或预览过期须重读，不能重放旧确认。

世界书生成 context-activation，显式 batch/history 扫描、具名副键逻辑、概率、候选组、递归及时间窗；来源字段只在 source.original 记录。ST 变量宏转为原生模板操作，导入期不执行赋值。

outlet/vectorized/triggers 不能等价执行，相关规则禁用并报告；角色过滤、自动化、深度插入、预算、群聊和脚本都有明确限制。完整映射及报告边界见 [SillyTavern 导入](docs/SillyTavern.md)。

模块导出分享完整定义和允许的附件，不分享全局变量、私有 memory.md 或 data/。旧私有记忆标记必须显式处理，不靠删除标记继续导出。路径、链接、体积、覆盖和备份边界见 [资产交换](docs/asset-transfer.md)。

书房数据通过 `/prompt-tool data-import <JSON>` 显式导入。先指定 `moduleId`、来源书房根 `sourceDirectory` 和相对文件列表 `paths`，预览创建、跳过与冲突项；确认后在相同 JSON 中加上返回的 `expectedRevision`（值取预览的 `revision`）应用。只补缺失文件，冲突项保留目标，源文件不动；旧 `02-墨.jsonl` 映射到 `data/02-soul.jsonl`。新建书房用 `{"moduleId":"soul","initialize":true}` 预览模块自己的清单，也须带预览版本应用。完整例子与限制见 [数据导入](docs/architecture-params.md#书房数据预览与导入)。

Soul 模块包含结构化账本、授权文件／历史检索、每步动态 SELF、上下文压缩与裁剪溯源、生成恢复和维护心跳。SELF 由 `rule-engine` 的内置动态内容源提供（`strategy: placeholder`、`fill: soul-self`），无需模块附带策略 JS。先用上述初始化预览补齐 `SELF.src.md` 骨架；已有模块副本须显式更新，包升级不会覆盖用户定义或私有数据，旧副本仍可使用自身保留的自定义策略。

`soul_ledger` 自动署名真实会话；`lead` 需宿主审批，`promise` 仅当前主导会话追加/收口，`shelved` 可由原作者或当前主导收口。`close` 通过稳定 `targetId` 追加完成/取消及依据，保留历史原行；`list` 的 `pending/open/pending-review` 视图提供版本分页。升级前历史事项标为待核对，不猜测已完成。

常驻 Soul 工具速查要求在完成重要任务、重要定案、踩坑和退场时主动判断是否记账，周期自检每 12 轮核对遗漏；不等用户专门提醒。只记有依据的一句话索引，排除过程流水、可重建事实与无出处断言，遵守唯一记录归属和现有写入权限。这是模型指令，不是后台自动写账本。

SELF 每步读取当前骨架、账本投影和身份，业务事实不变时正文保持稳定；自动正文不携带采样时钟、活动/投递时间或精确 token 水位，避免每个工具步骤重复追加整份上下文。维护关闭或诊断快照陈旧仍能呈现当前事实；索引只报告最近成功观测，不逐步扫描历史。`soul_state status/mark/check` 提供当前会话状态、带版本的短标记及精确时间/水位诊断。未结提醒默认仅主会话，在集合变化或成功压缩后实际投递一次；候选装配不消费提醒。Soul 显式开启 45/60/80% 水位提示，自动正文只随级别更新行动提示，不自动压缩。用户模板显式引用时钟或精确水位仍逐次求值；升级不清理旧会话已累积的快照。

`module_search` 支持全半角/大小写/千分位归一化、Soul 声明的有界近义表及 `mode: timeline` 时间线；命中标注方式，引用交给 `module_open` 重验授权与原文。历史会话仍只读白名单。维护默认每分钟更新索引与诊断快照，等待可取消，`wake` 独立且默认关闭。

`generation-recovery` 的通用默认只截断；Soul 显式启用空回合检测和有界恢复，主会话额度 3、子代理 1，每会话独立且重挂不清零。维护压缩和扩大范围默认关闭。配置与边界见 [引擎运行时](docs/engine-reuse.md#重复输出安全截断)、[账本与SELF](docs/architecture-params.md#soul账本与派生快照)。

这些运行能力由本插件实现，不需要源项目 `dsh-agent-soul` 的仓库、插件或后台服务；上下文治理仍要求宿主提供[官方能力包](docs/engine-reuse.md#上下文运行时与溯源)。未提供向量库、规模持久索引、压缩帧直取、附属面板、源安装体系或恢复补额/惩罚。`assets/reference/` 保留源背景文档，其 CLI 不代表本插件接口。

已有 Soul 定义通过 `soul_state check` 显式传 `includeUpgrade: true` 查看定向升级候选及冲突；完整 `files` 含必要配置、近义词表和现有可交换资产，再交 `module_import` 模型工具预览确认及重建，该入口保留私有数据、记忆和技能资产。包内种子不覆盖用户副本。包含 `close` 的账本要求支持账本 v2 的程序：旧版会忽略收口且仍能写入，回滚前必须撤写能力及旧 SELF/提醒贡献，不能删除 close 行迁就旧版。

上下文能力按包名白名单从 DSH 自带包解析，不增加插件依赖，运行期不校验版本；仅包缺失或未登记时拒绝该能力装配。包代码更新需要用户重启 DSH 加载；加载后修改模块启停／参数沿运行时刷新，不改官方 preset 或 profile patch。

## 升级与旧格式

原生格式是破坏性切换：旧 world-book/ST 运行字段、动作局部变量、旧工具能力以及全部顶层 persona 和 config.yml.personaSources 明确拒绝。重新导入原始标准来源，或使用内置 [dsh-module 技能](skills/dsh-module/SKILL.md) 在用户授权下显式转换。插件不扫描改写用户目录、不恢复历史ST会话变量；旧Soul mark仅按上述首次合法写契约迁移。其它历史参数的白名单边界见 [旧格式与显式转换](docs/architecture-params.md#旧格式与显式转换)。

## 指令文件

AGENTS.md/CLAUDE.md 及 local 变体正文属于用户文件。编辑需上下文白名单、用户授权和字节版本一致；读取失败不能当空文件覆盖。显示名和后续注入开关归独立策略，关闭只拦未来可识别官方消息，不撤历史、不补官方预算，不复制正文到模块。

## 开发与验证

开发与 CI 唯一目标为官方 `dsh-v0.2.2-rc.2`，SHA `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`，使用 Windows x64 源码构建包。首次安装前准备该源码的完整干净 checkout，以 Node 26.13.0、pnpm 11.28.5 执行：

```powershell
$Source = '<固定官方源码 checkout 的绝对路径>'
pnpm --dir $Source install --frozen-lockfile
pnpm --dir $Source run package:desktop:win:x64:unsigned
node scripts/sync-harness-deps.mjs --source-root $Source
pnpm install --frozen-lockfile
```

源码构建采用官方 unsigned/local 流程；不安装或启动生成的桌面程序。`sync:harness` 先核验固定源码 SHA、tag 与已跟踪文件无改动，再暂存构建 tarball 与官方 PI 1.3.0 patch，生成 ignored `.scratch/harness/` 下的安装 hook 与本机来源路径，不修改 manifest、不安装。冷 checkout 尚无 node_modules 时，脚本从已安装完成的官方 `packages/settings/settings` 取得其声明的 YAML 依赖，不需要先用旧宿主包引导。根 `pnpm-workspace.yaml` 自动启用该 hook，普通安装、验证与构建均复用固定源图；冷 checkout 必须先完成上述暂存步骤再执行根 pnpm 命令。

根锁保留相对 tarball 路径、integrity 与第三方锁定输入，tarball、源码路径和机器路径不提交。CI 按固定 SHA、平台、工具链与本仓库锁哈希缓存官方 packed 产物；缓存缺失时重新构建并执行相同 frozen 安装。相同 SHA 的独立构建尚不承诺 tarball 字节相同：完整性不匹配必须失败，由维护者确认构建输入后更新锁，不删除 integrity 或回退 registry。更换目标属于显式基线升级。

在本仓库按 AGENTS.md 从隔离目录启动命令：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
$env:TEMP = 'D:\AI\workspase\_temp'; $env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

涉及分发或宿主接入另执行 `verify:host`、`verify:harness`、`verify:pack`。`verify:host` 校验固定源 SHA、包名版本、tarball/安装入口完整性、根 node_modules 真实解析、锁与 peer 图、导入约束及官方档位。`verify:harness` 等同于 `sync:harness --check`，从 ignored `.scratch/harness/local.json` 读取首次显式指定的本地源码路径，只读复验源码、tag、已跟踪文件无改动、构建包与官方 PI patch，不查询 registry。`verify:pack` 使用当前 pnpm 在临时项目安装真实 tarball，复用同一源码包与 PI patch 图；临时绝对路径配置不进入发布包。自建包不是 npm 已发布版本；失败阻断交付，不自动追新或降级。

参考模板用 `rebuild:module-template`，追加 `-- --check` 检查漂移。test 脚本先 build，再以独立 cwd/TEMP/TMP/DSH_HOME 运行 Node 测试。类型、单测和包检查通过不代表真实发布宿主与桌面 UI 已验收；隔离发布 CLI 的 headless/web 验证和用户桌面验收分别记录。

源文件通过 package scripts 生成 lib 和 YAML vendor 快照，不手改构建产物。永久测试仅保留注入行为、写盘语义、bridge 载荷、安全拒绝、UI slot / 入口注册五条 seam 的公共接口回归，期望来自独立真值；临时探针及纯旧名消失检查不进入测试套件。

## 排障

随包委托模板只影响后续插入，不覆盖已保存到用户 `customTools` 的副本。旧规则读取/变量读取工具需要在 parameters 声明必填字符串 `moduleId`，并在 execute.args 传入 `'{{args.moduleId}}'`；旧规则编辑工具应将 execute.args 的 `expectedModuleId` 键改为 `moduleId`，保留 `expectedRevisions` 和 `edits`。可在自定义工具编辑器显式修改后保存，或保留自定义内容后删除旧条目并重新插入对应模板；读取规则取得新版本再编辑。不要同时给模型工具传两个主语键，bridge 的 `expectedModuleId` 不受此修正影响。

`skipping profile bundle` 表示插件未加载，补建和工作台也不会运行。先检查官方插件清单与依赖解析；`pnpm --dir $Repo repair:profile -- --profile <name> --dry-run` 只做体检，修复走官方插件管理器。插件不会自行改 manifest、包链接、停止或重启服务。

## 许可

插件本体 MIT（Czerror）。移植能力的上游版权和许可保存在 [engine/THIRD_PARTY_LICENSES](engine/THIRD_PARTY_LICENSES)，随包发布。上游预设本体不随本包分发。
