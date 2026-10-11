# dsh-plugin-prompt-tool — 提示词注入引擎

通过普通模块声明注入内容、插入点、时机、受众与动作。规则统一走 `compileRules → mountRuleSources`，对接九个独立官方插入点；八层可注入，tool-pipeline 使用工具裁决动作。模块与官方会话预设分开，不分发或替换官方预设。

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
   └─ memory.md              # 模块私有记忆，按需读取
```

module.yml 支持 UI 保存与直接手改。rules/ 从完整定义分解，手改或失配会单向恢复；无效完整定义拒绝加载，不以切片反写。未知用户资产保留，模块关闭只撤回贡献。

工作台由官方 shell.overlay 悬浮入口打开，包含主会话、子代理、工具预览、技能设置和模块五页。模块页统一新建、启停、复制、导出、导入、并入/移除和删除。编辑模块通过请求头选择，不切换官方会话预设。

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

规则是唯一行为源；共享模型与能力参数保存于 layerSettings，人设、变量、自定义工具和子代理策略各有独立顶层段。根 [module.yml](module.yml) 从权威目录生成九层及14个共享参数参考，示例默认关闭。

- 条件使用 if，动作用 then，另有 else；动作身份在完整规则树中唯一。
- 注入正文策略为 static、placeholder、first-turn-anchor、guide-auto、anchor-notice、context-activation。
- 九个插入点没有跨层全局顺序；order 属于该官方位置，configOrder 管同点跨模块顺序。
- `dedupe: session` 看当前模型可见上下文，旧消息被压缩/替换遮蔽后可再次注入。
- 主/子模型卡各有5个路由/采样参数，在装配时生成受众限定请求规则；也可显式编辑 request-params，不回写宿主全局默认。

字段、空值、保存和安全边界见 [参数框架](docs/architecture-params.md)，通道与生命周期见 [引擎指南](docs/engine-reuse.md) 和 [九层契约](docs/injection-point-contracts.md)。

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
| module-memory-tools | module_memory_read / module_memory_append |
| module-import-tools | module_import |
| tool-config-engine | customTools 中的实际工具 |

完整规则工具先读原始树与版本，再提交合法完整候选；删除整规则需显式 rule:null。变量工具提供 global/module 的 list/get/set/delete，set 必须显式字符串。模块记忆独立 read/append，不自动注入，也不附带在规则 note 中。

工具目录仅注册已声明能力，晚到 provider 与 disposer 按原生命周期处理。模块工具的主语由**这次调用显式声明的 `moduleId`** 决定：不传即没有目标、直接拒绝，不回退装配记录首项或包内默认模块；执行 Agent 已启用的规则模块只作拒绝文案里的候选提示，不是目标（人设来源是独立引用，同样不决定写入目标）。`expectedModuleId` 是桥端对请求头声明的一致性复核，与工具侧的主语选择是两套独立判据。工具只能读写模块存储根下 `module.yml` 所在的既有模块，不访问任意文件。自定义工具继续支持 shell/http/delegate/fs/ask-user，并保留官方批准、拒绝与取消管线。

## SillyTavern 与资产交换

ST JSON 预设、PNG/JSON 角色卡和独立世界书，经统一预览/确认/原子候选安装成为普通模块。默认同名另存，不自动启用。来源变化、目标变化或预览过期须重读，不能重放旧确认。

世界书生成 context-activation，显式 batch/history 扫描、具名副键逻辑、概率、候选组、递归及时间窗；来源字段只在 source.original 记录。ST 变量宏转为原生模板操作，导入期不执行赋值。

outlet/vectorized/triggers 不能等价执行，相关规则禁用并报告；角色过滤、自动化、深度插入、预算、群聊和脚本都有明确限制。完整映射及报告边界见 [SillyTavern 导入](docs/SillyTavern.md)。

模块导出分享完整定义和允许的附件，不分享全局变量或私有 memory.md。旧私有记忆标记必须显式处理，不靠删除标记继续导出。路径、链接、体积、覆盖和备份边界见 [资产交换](docs/asset-transfer.md)。

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
