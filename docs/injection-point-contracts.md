# 九层配置卡与官方插入点契约

核对基线：DSH 已发布包 `0.2.0-rc.1`，本地官方源码 `4878cdabd8`。九层是插件对公开扩展点的组织，不是宿主统一的九阶段管线。层序仅用于 UI；模块配置序号只在对应插入点、位置内比较，`order` 保留各入口的独立语义。

## 配置卡的共同结构

列表只显示真实 `rules` 实例，不生成空层卡。每卡在同一表面编辑「条件触发 → 执行动作」，支持条件树与多动作；正文是注入动作的字段，共享设置使用平级入口。卡头总开关旁放置上下移动和拖拽控件。

- `layerFieldPolicies` 控制通用字段；`layerContracts` 控制合法策略、匹配对象、内容类型、局部参数类型与枚举。两者都由 `engine/schema.mjs` 下发到 `/meta` 和 `/bootstrap`，保存端调用同一校验。
- 规则参数属于相应条件或动作；共享参数属于当前模块的固定存储层，同层多卡共用一份值与草稿；展示分组不改写磁盘归属。
- 换层只在用户操作时清除新层拒绝的通用字段，并把不适用策略改为固定文本。正文、变量、未知局部参数不因隐藏而删除。
- UI 复用现有控件、CSS Modules 和主题 token，按 Linear 紧凑对齐：桌面控件高28px，单行输入按字符宽度收紧，紧凑下拉按最长选项限宽，数字96px；粗指针目标扩大控件本体。窄卡自动换行，正文与 JSON 保持完整编辑宽度，错误紧邻控件，键盘焦点可见。

## 官方支持与插件映射

`id/name/enabled/group/exclusive` 属于规则，`when` 统一判断，`do` 持有动作。`configKind/order/dedupe/mergeMode` 属于注入动作配置，不是各官方事件的 payload；下表描述注入动作复用的层适配能力，通用判断与其他动作见 [引擎指南](engine-reuse.md#声明的条件与动作边界)。组内显式启用目标卡会关闭其余卡，不按排序选择赢家。

| 层 | 官方入口及真实参数 | 当前配置卡 | 约束 |
|---|---|---|---|
| 前置步骤 `pre-step` | `agent/pre-step({agent,messages,turn,step,signal}, next)`；返回 `reject` 或 `enter`，后者含完整 `messages: UserMessage[]`、可选 `startsRequestSeries` | 固定文本、动态填充、首轮锚定、每轮引导、自定义回退、世界书；位置、去重、晋升、受众、模型、合并、用户消息匹配、正文、局部变量与来源元数据 | 出口角色只允许 user；插件保留下游 decision 的其他字段，不伪造 assistant 消息。按 `source.plugin` 的显式屏蔽（`pre-step-filter` 动作的 `blockPlugins`）是**可选逃生阀**：默认不启用，未声明时不注册监听（零开销），只做大小写不敏感的**精确等值**匹配（不做子串/正则/glob） |
| 系统提示段 `system-section` | `systemPrompt.section({name,order,text,interpolate?,complete?})`；text 为字符串或同步函数；返回 disposer | `sectionName → name`、`complete`、`suppressRuntimeContext → 独立官方方法`；静态正文、局部变量、受众与合并 | 同一作用域只能有一个有效 complete 段；没有位置、去重、晋升和模型过滤。`interpolate` 未开放为本插件参数。**注册顺序**：本层经 `systemPrompt.section` 普通注册；同一通道内的否决型动作若要落在普通注册之外，须用 `triggers` 声明的 `waterfallPosition: outermost`（见 `docs/engine-reuse.md` 的「同 scope 内的注册顺序」） |
| 运行上下文 `runtime-context` | `systemPrompt.context({name,order,text})`；text 为字符串或同步函数，物化为持久 user-role 快照；异步准备使用 `system-prompt/assemble(assembly,context,next)` | `contextName → name`；固定文本或动态填充、正文、变量与合并 | 空文本不贡献内容；没有 complete、消息角色或拼接位置。动态策略先注册同步空占位，在 waterfall 内等待填充，不向 text 返回 Promise。**注册顺序**：本层是协作式填充，保持**普通注册**、不抢最外层；同通道内需要否决权的动作另由 `waterfallPosition: outermost` 声明（见 `docs/engine-reuse.md` 的「同 scope 内的注册顺序」） |
| 代理请求 `agent-request` | `agent/request({agent,turn,step,signal}, next)` 返回新的 `LlmCallConfig`；仅 `provider/model/reasoningEffort/temperature/maxTokens/stop` | 六项结构化请求字段；`params.patch` 浅合并，`params.replace` 整体替换；受众与模型过滤；本层共享模型设置 | 不接收消息正文、system 或 tools；整体替换必须提供 provider/model；`stop` 为字符串数组。patch/replace 是插件配置，并非官方字段 |
| 模型流 `llm-stream` | `llm/stream(GenerateOptions,next)` 返回 `AsyncIterable<StreamChunk>`，允许包装或替代流 | `mode=pass/replace`；仅 replace 显示替代输出文本，支持模型过滤 | 请求深冻结，不在此改写消息或调用配置；当前插件只实现文本流替换，不开放任意 chunk 脚本 |
| 工具链 `tool-pipeline` | `tools/pre-execute(exec,next)`、`tools/execute(exec,next)`、`tools/post-execute(exec,result,next)`；exec 含 `callId/rootCallId/name/arguments/agent?/parent?/signal/token` | 工具名称；前置 allow/deny/ask；deny 原因；后置 accept/replace/block；工具参数或结果匹配；replace/block 才显示文本；内嵌工具共享设置 | 当前插件只接 pre/post，未开放 execute 包装；官方另有 cancel、value、additionalContexts，尚非本插件参数。arguments 不可改写；toolResult 条件仅后置入口具备数据 |
| 轮次停止 `turn-stop` | `agent/turn-stopping({agent,turn,signal})` 为 serial，返回 void；通过 `agent.steer(UserMessage)` 请求继续 | 最后助手文本匹配、模型过滤、续跑文本和局部变量 | 没有 next 或拒绝停止返回值；每轮 1 次、每会话 3 次上限属于插件，不作为可关闭参数 |
| 子代理启动 `subagent-start` | `subagent/start({runId,provider,id,local})` 为只读 emit；插件另调用 `agents.get(id).inject(UserMessage)` | 子代理事件信息匹配、模型过滤、注入子代理文本；卡内共享子代理路由/采样与递归深度 | 事件不提供 prompt/agentOptions/maxDepth。共享模型/深度分别作用于委派模块及请求层；inject 不唤醒 driver，不保证赶上已领取输入的首个请求 |
| 子代理结束 `subagent-end` | `subagent/end({runId,provider,id,local,stopReason,lastAssistantMessage?})` 为只读 emit | `action=observe/inject-main`；默认只记录；inject-main 显示主会话文本与局部变量；事件匹配与模型过滤 | 通过 Agent.inject 独立投递到真实血缘的根主会话，不改写子代理返回值，不唤醒空闲主会话。缺主会话或无法验证血缘时跳过；同一 runId/config 去重 |

子代理结束行为示例：

```yaml
rules:
  - id: subagent-completed
    name: 子代理完成后检查结果
    layer: subagent-end
    do:
      - id: notify-main
        kind: inject-text
        config:
          layer: subagent-end
          strategy: static
          params:
            action: inject-main
          text: 子代理已结束。请检查其结果，完成验证后再回复用户。
```

## order 的作用面与刻度来源

模块配置序号与官方定位 `order` 分属不同作用面：

- **模块配置次序**：`module.yml.configOrder` 以配置 ID 保存序号，装配时带上模块来源，跨模块按序号排列。文件名前缀与读回的 `sequence` 是投影，不是新的可写正文。启用表成员顺序不参与配置次序裁决。
- **官方定位**：`system-section` 与 `runtime-context` 仍把 `order` 交给官方注册接口。默认注册名包含配置序号，使同一官方 `order` 下的模块配置可按该序号打破平局；显式 `sectionName` / `contextName` 保留其名字，继续遵循官方同 `order` 按名称比较的规则。
- **独立消费**：没有模块来源的独立引擎与触发器保留原有 `order` 行为；ST 世界书使用的候选预算／优先级语义也不因拖拽改写。配置序号不建立跨插入点的全局生命周期。

主会话与子代理的配置列表在“当前模块”和“跨模块排序”范围共用 `/module-config-order`；前者只交换自身原槽位，后者在同插入点、位置与官方档位内交换当前受众可见的槽位，均只提交完整身份列表与版本。排序不会改写正文、官方定位 `order` 或世界书语义。详见 [ADR-0006](adr/0006-module-config-order.md)。

**刻度来源**：区段边界由 `/meta` 与 `/bootstrap` 运行时下发，数值取官方 `getSectionOrder(name)` / `getContextOrder(name)`。任一档位无法求值即整表降级。`src/shared/official-orders.ts` 的名字分组对应 `0.2.0-rc.1`（section 32 项 / context 3 项，不含已移除的 TOOL_CORDIS）；数值不硬编码。快捷入口使用 `from - 1` 插入区段之前，避免同 order 时按名称排序落到官方段之后；末项使用 `max(to) + 1`。

## 参数所有权与存储

```yaml
layerSettings:
  subagent-start:
    maxDepth: 2
  tool-pipeline:
    customToolRequireApproval: [shell]
rules:
  - id: subagent-temperature
    layer: agent-request
    when:
      scope: { audience: subagent }
    do:
      - id: temperature
        kind: request-params
        patch: { temperature: 0.9 }
  - id: example-subagent-start
    name: 子代理通用守则
    layer: subagent-start
    do:
      - id: inject
        kind: inject-text
        config:
          layer: subagent-start
          strategy: static
          text: 先核实调用链，再开始修改。
```

共享参数位置由参数目录的 `storageLayer` 固定，`card` 与编辑组 `displayLayer` 只决定 UI 展示；当前公开共享键为4个。旧模型键与15个规则快捷键只进入离线迁移。`maxDepth` 只在插件子代理工具策略启用时生效；子模型路由通过 `request-params` 动作和受众条件作用于实际请求，不改普通官方 spawn 预检。persona、variables、customTools、subagentToolPolicy、moduleConfigs 保留独立所有者，不复制到每条规则。详情见 [参数框架](architecture-params.md)。

## 官方依据

以下链接固定到核对过的源码提交；安装包类型同时核对通过。

- [Agent 核心：pre-step、request、turn-stopping](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/core.md)
- [System prompt：section/context 与 complete](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/system-prompt.md)
- [LLM streaming：请求冻结与流包装](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/llm-streaming.md)
- [Tools：各工具阶段及不可修改的参数](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/tools.md)
- [Subagent：只读生命周期与投递接口](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/subagent.md)

运行时动态上下文在官方异步 waterfall 内完成填充，随后继续 `next()`，保留作用域遮蔽、顺序、上下文抑制与晋升门控。同步占位由私有空变量承载；空值、异常、取消或卸载不会复用旧正文。
