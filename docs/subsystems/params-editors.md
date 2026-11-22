# 人设、指令文件与自定义工具

这三个编辑入口各自持有正文与版本边界。普通人设规则复用规则版本；指令正文由用户文件持有；工具模板由完整模块定义中的独立字段持有。

## 动态人设规则与继承

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

persona 动作复用规则 if/then/else、嵌套分支、enabled、configOrder 与稳定动作 id；可声明 audience:main/subagent，省略覆盖两类。所有启用模块按既有规则顺序和动作声明顺序参与，主子按真实 Agent 分别判定。prefix/suffix 各自拼接非空片段，以两个换行分隔；空片段不增加分隔符，但仍是显式声明。

某字段全省略才继承官方，显式空串阻止该字段继承而不清除其他规则正文。complete/includeRuntimeContext 的显式值须一致，同值幂等、省略继承；冲突拒绝整组，不部分替换。complete:false 解除人设 prefix 独占。includeRuntimeContext:false 增加本插件抑制，true 只撤本插件抑制，祖先 scope 的抑制仍生效。

规则是唯一正文所有者；人设卡编辑具体规则动作，读写共用 `/rules` 的逐规则 CAS、保存队列、草稿保留与发布重试。没有独立正文端点、来源下拉或 settings 正文投影。旧顶层 persona（含 main/subagent）及 config.yml.personaSources 在读取根明确拒绝，用户手工重建规则并移除旧键；插件不双读、不迁移、不自动改用户文件。

统一 ruleRuntime 在原官方 assemble 之前求值、聚合、预检并事务化替换本 Agent 的完整人设贡献；同时预检同受众普通 complete 与 sections.append。全部失配或必要事实不可用撤回插件贡献并恢复官方；配置、解析、注册错误报告并保留最后有效组。自定义正文按来源模块读取会话→模块→全局变量和只读 runtime，继承官方正文原样保留，不重新求模板。同步人设出口拒绝 session setter。

同一 Agent 的准备与原 assemble 串行，每次固定候选；不同 Agent 可并发，全局刷新事务等待各 Agent 锁。AgentSetup 捕获的同层官方声明只暂撤，失配或卸载恢复；原 owner 已释放时不复活其声明。边界见 [引擎接线](engine-assembly.md#执行状态与接入)。代码更新仍须用户重启 DSH。

`persona.stripDefaultIdentity` 可选 `preset` 或 `harness`，选择要移除的默认身份来源；它是普通动作字段，沿完整定义、切片、保存版本及模块包往返保留，非法目标在候选校验阶段拒绝。

## 自定义模型工具

工具模板继续由tools-editor整组草稿、既有customTools保存与原发布链持有；此通道沿现有契约不增加逐工具CAS。工具说明的显式依赖使用普通tool条件，工具编辑与规则正文仍各自保存，不扫描正文自动登记依赖。

customTools 独立于规则/变量。`compileCustomTool` 使用官方 DSL 转换再交 `tool-definition.mjs` 校验；身份、Schema、执行器和输出都在保存/装配前检查。保存保留作者 DSL，运行内联编译工具，不另写工具产物目录。

`customTools` 是模块自定义工具模板行：模块总开关关闭时整组贡献撤回；模块开启后仍须把工具行显式设为 `true` 才注册，关闭工具行撤回注册并保留定义。自定义 HTTP 工具返回原始响应时，不等价于官方 `web_fetch` 的网页提取、来源引用或 provider 能力；工具行不隐式打开 `fetch` 来源开关，该开关默认关闭。

支持 shell/http/delegate/fs/ask-user；delegate 通过官方工具调度保留批准与拒绝。customToolRequireApproval 只接受实际执行器名称。大文本、秘密与 token 不放 settings；shell 环境沿白名单处理，超时与输出上限有可诊断原因；fs 执行器按 realpath containment 限定 cwd，symlink/junction 不得越界。工具卡的参数行编辑不得丢嵌套 properties/items/oneOf/enum。

已存在工具的说明不通过同名delegate或复制完整schema接管；普通规则的 `assembly.target.toolDescriptions` 只保存实际工具名、可选顶层参数名、精确匹配与替文。它沿原规则编辑、CAS、YAML Document、切片、导入导出和运行发布链保存，非法类型/空匹配在写盘前拒绝，空替文仍是有效删除意图；无独立工具说明文件或版本owner。工作台沿原装配卡编辑这些字段，工具执行与约束仍由原定义拥有。

技能摘要配置同样归普通规则的 `assembly.target.skillDescriptions`，只保存技能名、精确原文与替文；不复制技能正文、不改身份或调用定义，也没有独立保存/版本owner。工作台沿原装配卡、原文和正文编辑链保存，匹配必填、替文可空，不提供工具参数字段。规则诊断只读取当前保存版本的观测，旧版本或编辑中的草稿不显示成功。

## 指令文件与逐文件过滤策略

AGENTS.md/CLAUDE.md 及 local 变体属于用户文件。正文就地保存；显示名和后续注入开关属于独立 `$DSH_HOME/.prompt-tool/instructions.yml`。两者不写入 module.yml、settings、生成目录或模板变量。

- 文件卡探测 `$DSH_HOME/AGENTS.md` 与当前会话 cwd 到项目根链的候选。真实路径命中授权范围且为普通文件才可编辑；部署 cwd 回退只是范围提示，不等于会话写授权。
- 保存要求 fileId/contextId 白名单及 expectedRevision 字节版本。不存在、越界、过期、超限或读取失败明确拒绝；临时文件+rename 替换目标本身并保留权限。
- 同一 DSH_HOME 的插件写入按规范真实路径（大小写不敏感平台归一）在插件存储根持跨进程锁，覆盖读取、版本检查、暂存、最终复核和 rename；锁忙立即返回 409 `agents-file-conflict`，不自动重试正文，未知或活进程锁不强夺。此协调不跨 DSH_HOME；外部编辑器仍由最终版本与身份复核保护，但复核到 rename 间存在窗口，不承诺任意写入者的原子 CAS。
- 正文保存不重建模块。策略局部写保留注释、未知字段及另一端最新状态；共享 alias 可能改变未编辑内容时拒绝。
- 过滤只作用于可识别的未来官方消息。关闭不撤回历史，不阻止官方读取，不补预算删掉的正文；未知身份/不可分段保留并诊断。
- instructionHint 在过滤后且有有效模板时转换；空模板保持原文。owner 只报告已观察事实，未观察不捏造“未装配”。

细节与理由见 [ADR-0003](../adr/0003-instruction-files-independent.md)、[ADR-0004](../adr/0004-official-instruction-filter.md)、[引擎过滤](engine-rules.md#pre-step-协调器与官方指令过滤)。
