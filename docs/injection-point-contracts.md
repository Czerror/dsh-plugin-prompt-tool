# 九层配置卡与官方插入点契约

核对基线：DSH 已发布包 `0.1.6-alpha.2`，本地官方源码 `ddefc45fbc`。九层是插件对公开扩展点的组织，不是宿主统一的九阶段管线。层序仅用于 UI；`order` 只在各自入口内解释。

## 配置卡的共同结构

列表只显示真实 `promptConfigs` 实例，不生成空层卡。卡内按「基础信息 → 注入规则 → 作用范围 → 本条规则的行为 → 条件需要的内容 → 本层共享设置 → 可用的高级元数据」组织。

- `layerFieldPolicies` 控制通用字段；`layerContracts` 控制合法策略、匹配对象、内容类型、局部参数类型与枚举。两者都由 `engine/schema.mjs` 下发到 `/meta` 和 `/bootstrap`，保存端调用同一校验。
- 规则参数属于该实例；共享参数属于当前预设的对应层。共享设置放在真实卡内的原生折叠区，同层多卡共用同一份值与草稿。
- 换层只在用户操作时清除新层拒绝的通用字段，并把不适用策略改为固定文本。正文、变量、未知局部参数不因隐藏而删除。
- UI 使用现有 DSH primitive、CSS Modules 和主题 token。分区间距 24px、字段间距 16/24px；窄卡自动单列；错误紧邻控件，键盘焦点可见。未引入新的组件库。

## 官方支持与插件映射

共同实例字段 `id/name/enabled/configKind/order/group/exclusive` 是插件配置与排序规则，不是各官方事件的 payload。`audience/modelScope/promotion/match/dedupe/mergeMode` 同样是插件自己的筛选或注入语义。下表分别列出官方接口与插件实际开放的映射。

| 层 | 官方入口及真实参数 | 当前配置卡 | 约束 |
|---|---|---|---|
| 前置步骤 `pre-step` | `agent/pre-step({agent,messages,turn,step,signal}, next)`；返回 `reject` 或 `enter`，后者含完整 `messages: UserMessage[]`、可选 `startsRequestSeries` | 固定文本、动态填充、首轮锚定、每轮引导、自定义回退、世界书；位置、去重、晋升、受众、模型、合并、用户消息匹配、正文、局部变量与来源元数据 | 出口角色只允许 user；插件保留下游 decision 的其他字段，不伪造 assistant 消息 |
| 系统提示段 `system-section` | `systemPrompt.section({name,order,text,interpolate?,complete?})`；text 为字符串或同步函数；返回 disposer | `sectionName → name`、`complete`、`suppressRuntimeContext → 独立官方方法`；静态正文、局部变量、受众与合并 | 同一作用域只能有一个有效 complete 段；没有位置、去重、晋升和模型过滤。`interpolate` 未开放为本插件参数 |
| 运行上下文 `runtime-context` | `systemPrompt.context({name,order,text})`；text 为字符串或同步函数，物化为持久 user-role 快照；异步准备使用 `system-prompt/assemble(assembly,context,next)` | `contextName → name`；固定文本或动态填充、正文、变量与合并 | 空文本不贡献内容；没有 complete、消息角色或拼接位置。动态策略先注册同步空占位，在 waterfall 内等待填充，不向 text 返回 Promise |
| 代理请求 `agent-request` | `agent/request({agent,turn,step,signal}, next)` 返回新的 `LlmCallConfig`；仅 `provider/model/reasoningEffort/temperature/maxTokens/stop` | 六项结构化请求字段；`params.patch` 浅合并，`params.replace` 整体替换；受众与模型过滤；本层共享模型设置 | 不接收消息正文、system 或 tools；整体替换必须提供 provider/model；`stop` 为字符串数组。patch/replace 是插件配置，并非官方字段 |
| 模型流 `llm-stream` | `llm/stream(GenerateOptions,next)` 返回 `AsyncIterable<StreamChunk>`，允许包装或替代流 | `mode=pass/replace`；仅 replace 显示替代输出文本，支持模型过滤 | 请求深冻结，不在此改写消息或调用配置；当前插件只实现文本流替换，不开放任意 chunk 脚本 |
| 工具链 `tool-pipeline` | `tools/pre-execute(exec,next)`、`tools/execute(exec,next)`、`tools/post-execute(exec,result,next)`；exec 含 `callId/rootCallId/name/arguments/agent?/parent?/signal/token` | 工具名称；前置 allow/deny/ask；deny 原因；后置 accept/replace/block；工具参数或结果匹配；replace/block 才显示文本；内嵌工具共享设置 | 当前插件只接 pre/post，未开放 execute 包装；官方另有 cancel、value、additionalContexts，尚非本插件参数。arguments 不可改写；toolResult 条件仅后置入口具备数据 |
| 轮次停止 `turn-stop` | `agent/turn-stopping({agent,turn,signal})` 为 serial，返回 void；通过 `agent.steer(UserMessage)` 请求继续 | 最后助手文本匹配、模型过滤、续跑文本和局部变量 | 没有 next 或拒绝停止返回值；每轮 1 次、每会话 3 次上限属于插件，不作为可关闭参数 |
| 子代理启动 `subagent-start` | `subagent/start({runId,provider,id,local})` 为只读 emit；插件另调用 `agents.get(id).inject(UserMessage)` | 子代理事件信息匹配、模型过滤、注入子代理文本；卡内共享子代理路由/采样与递归深度 | 事件不提供 prompt/agentOptions/maxDepth。共享模型/深度分别作用于委派模块及请求层；inject 不唤醒 driver，不保证赶上已领取输入的首个请求 |
| 子代理结束 `subagent-end` | `subagent/end({runId,provider,id,local,stopReason,lastAssistantMessage?})` 为只读 emit | `action=observe/inject-main`；默认只记录；inject-main 显示主会话文本与局部变量；事件匹配与模型过滤 | 通过 Agent.inject 独立投递到真实血缘的根主会话，不改写子代理返回值，不唤醒空闲主会话。缺主会话或无法验证血缘时跳过；同一 runId/config 去重 |

子代理结束行为示例：

```yaml
promptConfigs:
  - id: subagent-completed
    name: 子代理完成后检查结果
    layer: subagent-end
    strategy: static
    params:
      action: inject-main
    text: 子代理已结束。请检查其结果，完成验证后再回复用户。
```

## 参数所有权与存储

```yaml
layerSettings:
  agent-request:
    modelTemperature: 0.7
  subagent-start:
    subagentTemperature: 0.9
    maxDepth: 2
  tool-pipeline:
    deliberationMinChars: 400
promptConfigs:
  - id: example-subagent-start
    name: 子代理通用守则
    layer: subagent-start
    strategy: static
    text: 先核实调用链，再开始修改。
```

共享参数位置由既有参数目录的 `card` 与编辑组 `displayLayer` 派生，不再另写九份键清单。内部运行时与 bridge 仍使用 EngineParams 平铺值，避免把存储重排变成接口及各模块的重复改造。persona、variables、customTools、subagentToolPolicy、moduleConfigs 保留独立所有者，不复制到每条规则。详情见 [参数框架](architecture-params.md)。

## 官方依据

以下链接固定到核对过的源码提交；安装包类型同时核对通过。

- [Agent 核心：pre-step、request、turn-stopping](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/core.md)
- [System prompt：section/context 与 complete](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/system-prompt.md)
- [LLM streaming：请求冻结与流包装](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/llm-streaming.md)
- [Tools：各工具阶段及不可修改的参数](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/tools.md)
- [Subagent：只读生命周期与投递接口](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc/docs/subsystems/subagent.md)

运行时动态上下文在官方异步 waterfall 内完成填充，随后继续 `next()`，保留作用域遮蔽、顺序、上下文抑制与晋升门控。同步占位由私有空变量承载；空值、异常、取消或卸载不会复用旧正文。真实官方装配回归见 `test/engine/official-variable-regression.test.mjs`。
