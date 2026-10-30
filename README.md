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

本地开发可将安装来源换为 `link:<本仓库绝对路径>`。插件只诊断缺失的 Web 能力，不改 profile manifest、包链接或重启服务。Node 与官方包版本要求见 [package.json](package.json)；宿主接入以实际安装的公开包验证，不能仅凭 peer 范围推断所有未来版本已验收。

**升级代码、bundle 或 cordis.patch.yml 后，需要用户重启 DSH 服务。** 人设由主插件在会话作用域管理，不改变官方服务的启动依赖：在每个 Agent 自己的 scope 注册同名段，遮蔽部署人设与预设 persona 行，不接管任何官方 fiber。AgentSetup 窗口内注册的同层声明会被撤换（插件人设优先），窗口外的同层声明撤不掉时装配失败并保留旧装配。

## 模块与工作台

```text
$DSH_HOME/.prompt-tool/
├─ config.yml                # 规则模块启用集合与主/子人设来源 ID
├─ variables.yml             # 全局变量，variables 映射
├─ instructions.yml          # 独立指令策略
└─ modules/<id>/
   ├─ module.yml             # 唯一完整定义
   ├─ rules/                 # 已验证的物化切片
   ├─ memory.md              # 模块私有记忆，按需读取
   └─ data/                  # 模块私有用户数据（账本等）：不导出、覆盖保留
```

module.yml 支持 UI 保存与直接手改。rules/ 从完整定义分解，手改或失配会单向恢复；无效完整定义拒绝加载，不以切片反写。未知用户资产保留，模块关闭只撤回贡献。

工作台由官方悬浮入口（shell.overlay）或左侧栏「提示词工具」入口（sidebar.panellist 行点击直接打开）打开——两个入口打开同一个常驻抽屉，包含主会话、子代理、工具预览、技能设置和模块五页。模块页统一新建、启停、复制、导出、导入和删除。编辑模块通过请求头选择，不切换官方会话预设。

在 dsh-tui 中，`/settings` 的「常规」页有一节「提示词工具」，只含模块运行总开关（settings 文档里唯一的部署轴）；模块参数、规则与技能仍走 `/prompt-tool` 命令或工作台。

删除模块先在同卷隐藏 stage 里 rename，锁外再清理：rename 失败时原目录完整保留；清理失败时模块已移出，提示里会给出残留目录路径（清理未完成，内容可能不完整），刷新失败只影响列表、删除仍按成功处理。内置模块的用户副本删除后，重启会按缺失补建，这不是删除失败。若进程在 rename 后、清理前退出，隐藏残留目录会留在磁盘上，不会自动过期。

每张规则卡编辑完整条件树与动作；then/else 可嵌套，未知事实不当成否定成立。正文、状态分别做 CAS，后台刷新和请求期间的新输入保留。跨模块规则按配置序号排列，同组互斥由显式启用事务决定，排序不替作者选赢家。

工具、人设、变量、策略沿用各自的共享草稿与保存边界。布局、无障碍、locale 和 typed bridge 规范见 [UI 框架](docs/ui-architecture.md)。

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

规则是唯一行为源；共享模型与能力参数保存于 layerSettings，人设、变量与自定义工具各有独立顶层段。根 [module.yml](module.yml) 从权威目录生成九层及27个共享参数参考，示例默认关闭。

单个模块装配失败时，首次加载跳过它，更新时恢复它的上次有效贡献；其他正常模块继续加载和更新。晚到服务的初始化失败也按此处理，等待中的新版本不会覆盖最后成功版本。故障仍会报告，修正该模块定义或显式刷新后重试。全局配置和跨模块独占冲突仍明确拒绝，不自动选择赢家；完整边界见[运行时装配](docs/engine-reuse.md)。

- 条件使用 if，动作用 then，另有 else；动作身份在完整规则树中唯一。
- 注入正文策略为 static、placeholder、context-activation；文本与长度分类、确认、工具名和受众由通用条件承担，正文、投递、请求与流控制由动作组合。
- 工具提示通过 tool-catalog 只读引用同规则工具可见面声明，自动列出常驻名单与发现工具；提示正文和投递由模块规则控制。
- 九个插入点没有跨层全局顺序；order 属于该官方位置，configOrder 管同点跨模块顺序。
- `dedupe: session` 看当前模型可见上下文，旧消息被压缩/替换遮蔽后可再次注入。
- 主/子模型卡各有5个路由/采样参数，在装配时生成受众限定请求规则；也可显式编辑 request-params，不回写宿主全局默认。

字段、空值、保存和安全边界见 [参数框架](docs/architecture-params.md)，通道与生命周期见 [引擎指南](docs/engine-reuse.md) 和 [九层契约](docs/injection-point-contracts.md)。

需要“先发锚句、确认后注入正文”时，在同规则中用 `anchor.after.action` 引用锚句动作；确认只读取实际投递后的当前可见输出。默认持续等待、下次正常请求再注入；兜底次数和续跑均须显式声明。示例见 [模板16](templates/16-custom-fallback.yml)，直接匹配本批用户消息见 [模板14](templates/14-first-turn-anchor.yml)。旧专用策略与参数已直接替换，不提供兼容入口，也不自动改写已有用户模块。

## 两级持久变量

模块 variables 覆盖同一 DSH_HOME 的全局变量。空字符串是有效值，删除模块键才回落全局。同模块的主会话与子代理共享，结束会话、压缩、卸载或重挂不清空。变量内容更新不重挂 Agent，下一求值读取新快照。

**普通规则手动建立变量；ST 导入才自动登记缺失裸引用为空占位。** 模板 WHO、stateKeys 等需在变量卡建立；动作 config.variables 已退役。全局值不随模块导出。

需要赋值时显式设置 `params.templateEvaluation: true`，使用 module/global 的 set/get/add/inc/dec。一张模板可读两域但只写一域，所有实际读取域都校验版本。资格、解析和预算检查先于提交；同一次真实执行跨 assembly/pre-step/重挂不重复自增。发布失败只重试发布，不承诺任意跨进程崩溃后的 exactly-once。

## 独立人设

```yaml
persona:
  main:
    prefix: 你是项目助手。
    complete: false
  subagent:
    suffix: 返回可核验的结果。
```

人设卡为主会话和子代理各提供一个来源下拉，默认“官方”，也可分别选择一个模块。正文仍保存在各模块的 persona.main/subagent；config.yml 的 personaSources 只保存两个来源模块 ID，选择人设不自动启用该模块的 rules。

运行时只读取所选模块对应受众的字段，不跨模块逐字段合并。选中字段省略时继承已有声明（同层被接住的声明、祖先的官方 persona 行，最后是根部署人设），显式空文本清空，complete:false 解除人设独占；includeRuntimeContext:false 单独抑制动态上下文。人设不进入 rules 数组或排序，rules/_settings.yml 只保存其校验投影。人设与启用规则的 complete 冲突仍在撤旧之前检查，失败保留上次有效配装。自定义文本读取所选来源模块的变量，继承官方正文不重新执行为模板。

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

完整规则工具先读原始树与版本，再提交合法完整候选；删除整规则需显式 rule:null。变量工具提供 global/module 的 list/get/set/delete，set 必须显式字符串。模块私有文件（memory.md、assets/ 只读、data/ 只追加）由 module_file_read/append 读写，不自动注入；module_manifest 按 assets/manifest.yml 做 next/check/apply，只写 data/、不覆盖。

工具目录仅注册已声明能力，晚到 provider 与 disposer 按原生命周期处理。模块工具的主语由**这次调用显式声明的 `moduleId`** 决定：不传即没有目标、直接拒绝，不回退装配记录首项或包内默认模块；执行 Agent 已启用的规则模块只作拒绝文案里的候选提示，不是目标（人设来源是独立引用，同样不决定写入目标）。`expectedModuleId` 是桥端对请求头声明的一致性复核，与工具侧的主语选择是两套独立判据。工具只能读写模块存储根下 `module.yml` 所在的既有模块；模块内文件限定 memory.md、assets/（只读）、data/（只追加），不访问任意路径。自定义工具继续支持 shell/http/delegate/fs/ask-user，并保留官方批准、拒绝与取消管线。

## SillyTavern 与资产交换

ST JSON 预设、PNG/JSON 角色卡和独立世界书，经统一预览/确认/原子候选安装成为普通模块。默认同名另存，不自动启用。来源变化、目标变化或预览过期须重读，不能重放旧确认。

世界书生成 context-activation，显式 batch/history 扫描、具名副键逻辑、概率、候选组、递归及时间窗；来源字段只在 source.original 记录。ST 变量宏转为原生模板操作，导入期不执行赋值。

outlet/vectorized/triggers 不能等价执行，相关规则禁用并报告；角色过滤、自动化、深度插入、预算、群聊和脚本都有明确限制。完整映射及报告边界见 [SillyTavern 导入](docs/SillyTavern.md)。

模块导出分享完整定义和允许的附件，不分享全局变量、私有 memory.md 或 data/。旧私有记忆标记必须显式处理，不靠删除标记继续导出。路径、链接、体积、覆盖和备份边界见 [资产交换](docs/asset-transfer.md)。

书房数据通过 `/prompt-tool data-import <JSON>` 显式导入。先指定 `moduleId`、来源书房根 `sourceDirectory` 和相对文件列表 `paths`，预览创建、跳过与冲突项；确认后在相同 JSON 中加上返回的 `expectedRevision`（值取预览的 `revision`）应用。只补缺失文件，冲突项保留目标，源文件不动；旧 `02-墨.jsonl` 映射到 `data/02-soul.jsonl`。新建书房用 `{"moduleId":"soul","initialize":true}` 预览模块自己的清单，也须带预览版本应用。完整例子与限制见 [数据导入](docs/architecture-params.md#书房数据预览与导入)。

Soul 模块包含结构化账本、授权文件／历史检索、每步动态 SELF、上下文压缩与裁剪溯源、生成恢复和维护心跳。SELF 由 `rule-engine` 的内置动态内容源提供（`strategy: placeholder`、`fill: soul-self`），无需模块附带策略 JS。先用上述初始化预览补齐 `SELF.src.md` 骨架；已有模块副本须显式更新，包升级不会覆盖用户定义或私有数据，旧副本仍可使用自身保留的自定义策略。

`soul_ledger` 自动署名真实会话；`lead` 需宿主审批，`promise` 仅当前主导会话追加/收口，`shelved` 可由原作者或当前主导收口。`close` 通过稳定 `targetId` 追加完成/取消及依据，保留历史原行；`list` 的 `pending/open/pending-review` 视图提供版本分页。升级前历史事项标为待核对，不猜测已完成。

SELF 每步读取当前骨架、账本投影和身份/时钟，维护关闭或诊断快照陈旧也能呈现；索引只报告最近成功观测，不逐步扫描历史。`soul_state status/mark/check` 提供当前会话状态、带版本的短标记及只读运行诊断。未结提醒默认仅主会话，在集合变化或成功压缩后实际投递一次；候选装配不消费提醒。Soul 显式开启 45/60/80% 水位提示，只提示，不自动压缩。

`module_search` 支持全半角/大小写/千分位归一化、Soul 声明的有界近义表及 `mode: timeline` 时间线；命中标注方式，引用交给 `module_open` 重验授权与原文。历史会话仍只读白名单。维护默认每分钟更新索引与诊断快照，等待可取消，`wake` 独立且默认关闭。

`generation-recovery` 的通用默认只截断；Soul 显式启用空回合检测和有界恢复，主会话额度 3、子代理 1，每会话独立且重挂不清零。维护压缩和扩大范围默认关闭。配置与边界见 [引擎运行时](docs/engine-reuse.md#重复输出安全截断)、[账本与SELF](docs/architecture-params.md#soul账本与派生快照)。

这些运行能力由本插件实现，不需要源项目 `dsh-agent-soul` 的仓库、插件或后台服务；上下文治理仍要求宿主提供[官方能力包](docs/engine-reuse.md#上下文运行时与溯源)。未提供向量库、规模持久索引、压缩帧直取、附属面板、源安装体系或恢复补额/惩罚。`assets/reference/` 保留源背景文档，其 CLI 不代表本插件接口。

已有 Soul 定义通过 `soul_state check` 显式传 `includeUpgrade: true` 查看定向升级候选及冲突；完整 `files` 含必要配置、近义词表和现有可交换资产，再交 `module_import` 模型工具预览确认及重建，该入口保留私有数据、记忆和技能资产。包内种子不覆盖用户副本。包含 `close` 的账本要求支持账本 v2 的程序：旧版会忽略收口且仍能写入，回滚前必须撤写能力及旧 SELF/提醒贡献，不能删除 close 行迁就旧版。

上下文能力按包名白名单从 DSH 自带包解析，不增加插件依赖，运行期不校验版本；仅包缺失或未登记时拒绝该能力装配。包代码更新需要用户重启 DSH 加载；加载后修改模块启停／参数沿运行时刷新，不改官方 preset 或 profile patch。

## 升级与旧格式

原生格式是破坏性切换：旧 world-book/ST 运行字段、动作局部变量、旧工具能力和扁平 persona 明确拒绝。重新导入原始标准来源，或使用内置 [dsh-module 技能](skills/dsh-module/SKILL.md) 在用户授权下显式转换。插件不扫描改写用户目录、不恢复旧会话变量、不提供自动迁移器。其它历史参数的白名单边界见 [旧格式与显式转换](docs/architecture-params.md#旧格式与显式转换)。

## 技能与指令文件

技能保留在实际官方/用户来源目录。管理页复用官方发现与监听，按会话快照显示生效、遮蔽和未确认状态；开关写官方 frontmatter 调用策略，单端修改保留另一端和未知字段。创建、引用、导入及可恢复删除见 [技能管理](docs/skills-management.md)。

AGENTS.md/CLAUDE.md 及 local 变体正文属于用户文件。编辑需上下文白名单、用户授权和字节版本一致；读取失败不能当空文件覆盖。显示名和后续注入开关归独立策略，关闭只拦未来可识别官方消息，不撤历史、不补官方预算，不复制正文到模块。

## 开发与验证

在本仓库按 AGENTS.md 从隔离目录启动命令：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

涉及分发或宿主接入另执行 verify:host、verify:pack；参考模板用 rebuild:module-template，追加 `-- --check` 检查漂移。test 脚本先 build，再以独立 cwd/TEMP/TMP/DSH_HOME 运行 Node 测试。

源文件通过 package scripts 生成 lib 和 YAML vendor 快照，不手改构建产物。永久测试仅保留注入行为、写盘语义、bridge 载荷、安全拒绝的公共接口回归，期望来自独立真值；临时探针及纯旧名消失检查不进入测试套件。

## 排障

`skipping profile bundle` 表示插件未加载，补建和工作台也不会运行。先检查官方插件清单与依赖解析；`pnpm --dir $Repo repair:profile -- --profile <name> --dry-run` 只做体检，修复走官方插件管理器。插件不会自行改 manifest、包链接、停止或重启服务。

## 许可

插件本体 MIT（Czerror）。移植能力的上游版权和许可保存在 [engine/THIRD_PARTY_LICENSES](engine/THIRD_PARTY_LICENSES)，随包发布。上游预设本体不随本包分发。
