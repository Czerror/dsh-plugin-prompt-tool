export const ACTION_DEGRADE = Object.freeze({
  keep: 'keep',
  exposeAll: 'expose-all',
  empty: 'empty',
  silent: 'silent',
})

/**
 * 九类动作的声明：**合法事件通道** + **降级语义** + 触发时机。
 * `events` 是动作允许注册的官方事件（注册到声明外的事件在挂载期 fail loud）；
 * `services` 是它允许触碰的宿主服务方法（同一纪律的文档面）。
 */
export const ACTION_KINDS = Object.freeze({
  'inject-text': {
    title: '注入文本',
    events: ['agent/pre-step', 'session/event', 'system-prompt/assemble', 'agent/request', 'llm/stream', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'subagent/start', 'subagent/end'],
    services: ['systemPrompt.section', 'systemPrompt.context', 'systemPrompt.variable'],
    degrade: ACTION_DEGRADE.keep,
    timing: '按配置声明的 layer 落到该层官方通道；pre-step 在 agent/pre-step，system-section/runtime-context 在注册期 + 官方 assembly。',
    note: '复用九层注册通道，不新开通道；显式空正文 = 不注册（empty 情形）。`options` 原样交给该层的既有接线（pre-step 执行器的 `prepend` = 声明的位置策略）；`session/event` 是 pre-step 执行器自带的会话态旁听，不是第二条注入通道。',
  },
  assembly: {
    title: '改装配',
    events: ['system-prompt/assemble'],
    services: [],
    degrade: ACTION_DEGRADE.exposeAll,
    timing: 'system-prompt/assemble 的下游结算之后（`await next()` 之后改，装配事实已就绪）。',
    note: '失败时返回未改动的装配 = 对 tools 即暴露完整目录；不改 global，只作用于本次 assembly。',
  },
  decision: {
    title: '裁决',
    events: ['tools/pre-execute', 'tools/post-execute'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'pre 相在工具执行之前返回 allow|deny|ask；post 相在结果结算之后返回 accept|replace|block。',
    note: '异常与条件未命中一律 `next()`（放行/接受），绝不让裁决 bug 卡死调用。',
  },
  'append-context': {
    title: '追加上下文与续跑',
    events: ['tools/post-execute', 'agent/turn-stopping'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'mode=context 在 post-execute 追加 durable user 通知；mode=continue 在 agent/turn-stopping steer 一步。',
    note: '续跑共用引擎的续跑预算（每轮 1 次 / 每会话 3 次），无正文时不追加（empty 情形）；绝不伪造 assistant 角色。',
  },
  guard: {
    title: '执行层 guard',
    events: ['system-prompt/assemble'],
    services: ['tools.guard', 'tools.restrict'],
    degrade: ACTION_DEGRADE.silent,
    timing: '首次 assembly 时按 agent scope 惰性注册一次（预设切换/重绑后按新的 agent.ctx 重注册）。',
    note: '最终拒绝层：注册在 agent.ctx 上（工具本层与晚到工具也被裁决），命中返回拒绝原因；不注册全局 guard。guard 自身不吞异常——异常即失败，绝不退化成"放行"。',
  },
  'sdk-strip': {
    title: '裁 SDK 声明文本',
    events: ['system-prompt/assemble'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'system-prompt/assemble 下游结算之后，改写名为 tools:sdk 的段文本。',
    note: '只删不增、保守失败：形态异常/自校验失败一律原样返回；空名单零开销。仅是呈现补救，执行边界在 guard。',
  },
  'request-params': {
    title: '改模型请求参数',
    events: ['agent/request'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'agent/request 的下游结算之后（`await next()` 拿到已冻结的 LlmCallConfig 再改写）。',
    note: '与既有 promptConfigs 的 agent-request 层共用 applyAgentRequestParams；只改命中 scope/agent 的请求，删键仅删"本声明注入的那个值"。',
  },
  'inbox-prepend': {
    title: '前置收件箱消息',
    events: ['agent/inbox/inserted'],
    services: ['agent.inbox.prepend'],
    degrade: ACTION_DEGRADE.silent,
    timing: 'emit 通道（**无 next**）：命中即前置一条消息，不命中什么都不做。',
    note: '只前置不追加；插件来源消息（含本动作自己插入的那条）永不再次前置，防自触发插队。'
      + '收件箱的持久化归宿主（`agent/inbox/spliced`），本动作不自己落盘。',
  },
  'pre-step-filter': {
    title: '过滤 pre-step 注入消息',
    events: ['agent/pre-step'],
    services: [],
    degrade: ACTION_DEGRADE.exposeAll,
    timing: 'agent/pre-step 的下游结算之后（`await next()` 拿到 decision 再过滤 messages）。',
    note: '两种白名单模式**互斥**：`sources` = 严格白名单（只放行这些 `source.kind`，含 claimed 批）；'
      + '`keepKinds` = 保留 claimed 基线（按对象身份或 id）+ 这些 kind。未声明任一 = 不过滤（零开销）。'
      + '`blockPlugins` 是与二者**正交**的另一维度、可共存：仅当来源 kind 为 plugin 时按 `source.plugin` '
      + '做大小写不敏感的**精确等值**匹配并剔除命中项，不做子串/正则/glob；空名单 = 关闭'
      + '（与白名单「空 = 全拦」不同），未声明 = 不过滤。'
      + '**永不吞上下文**：异常一律返回未过滤的 decision（`expose-all`）。',
  },
})
