export const ACTION_DEGRADE = Object.freeze({
  keep: 'keep',
  exposeAll: 'expose-all',
  empty: 'empty',
  silent: 'silent',
})

/**
 * 十类动作的声明：**合法事件通道** + **降级语义** + 触发时机 + **声明字段**。
 * `events` 是动作允许注册的官方事件：经 `on(...)` 注册的动作（`channelBinder`）注册到声明外的
 * 事件在挂载期 fail loud；`inject-text` 不经 `channelBinder`，它的真实通道由
 * `actionExecutionPoint`（派生自 `schema.mjs` 每层的 `channel`）决定——下面那行 `events`
 * 对它只是**文档面**（零校验、零消费），判断层是否可注入不要以它为准；
 * `services` 是它允许触碰的宿主服务方法（同一纪律的文档面）；
 * `fields` 是该类动作自己的声明键（白名单写在这里**一份**，`rule-spec.mjs` 的未知键
 * 检查从这里派生）。通用键 `id/kind/channelOrder/waterfallPosition/maxPerTurn` 由
 * {@link ACTION_FIELDS} 统一补上；`if`/`then`/`else` 刻意不在名单里——带 `kind`
 * 的动作写分支键会被编译期点名拒绝（`expandActions` 只认无 `kind` 的分支节点）。
 */
export const ACTION_KINDS = Object.freeze({
  'inject-text': {
    title: '注入文本',
    fields: ['config', 'options'],
    events: ['agent/pre-step', 'session/event', 'system-prompt/assemble', 'agent/turn-stopping', 'subagent/start', 'subagent/end'],
    services: ['systemPrompt.section', 'systemPrompt.context', 'systemPrompt.variable'],
    degrade: ACTION_DEGRADE.keep,
    timing: '按配置声明的 layer 落到该层官方通道；pre-step 在 agent/pre-step，system-section/runtime-context 在注册期 + 官方 assembly。',
    note: '复用既有注入通道（见 schema 的 `injectionLayers`），不新开通道；工具链的裁决与追加上下文走 `tool-gate` / `tool-result` / `append-context`，请求参数走 `request-params`，模型流走 `stream-output`。显式空正文不注册；`session/event` 是 pre-step 执行器自带的会话态旁听，不是第二条注入通道。',
  },
  assembly: {
    title: '改装配',
    fields: ['target', 'match'],
    events: ['system-prompt/assemble'],
    services: [],
    degrade: ACTION_DEGRADE.exposeAll,
    timing: 'system-prompt/assemble 的下游结算之后（`await next()` 之后改，装配事实已就绪）。',
    note: '失败时返回未改动的装配 = 对 tools 即暴露完整目录；不改 global，只作用于本次 assembly。',
  },
  'tool-gate': {
    title: '工具裁决',
    fields: ['decision', 'reason'],
    events: ['tools/pre-execute'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'pre 相在工具执行之前返回 allow|deny|ask。',
    note: '异常与条件未命中一律 `next()`（放行），绝不让裁决 bug 卡死调用；判据只看本相真正读的字段。',
  },
  'tool-result': {
    title: '工具结果处理',
    fields: ['action', 'text'],
    events: ['tools/post-execute'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'post 相在结果结算之后返回 accept|replace|block。',
    note: '异常一律 `next()`（接受）；`text` 仅 replace / block 使用，accept 时被忽略。',
  },
  'append-context': {
    title: '追加上下文',
    fields: ['text', 'match'],
    events: ['tools/post-execute'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: '在 post-execute 追加 durable user 通知。',
    note: '无正文时不追加；绝不伪造 assistant 角色。',
  },

  'tool-visibility': {
    title: '工具可见面',
    fields: ['allow', 'deny', 'requireMatch', 'discovery'],
    events: ['system-prompt/assemble'],
    services: ['tools.schemas', 'tools.restrict', 'tools.guard', 'tools.register'],
    degrade: ACTION_DEGRADE.keep,
    timing: 'system-prompt/assemble 的下游结算之后：按当前条件重算目录、SDK 正文与执行闸；条件翻转时撤销上一轮注册的闸。',
    note: '一份声明拥有工具的可见面：allow/deny 名单、requireMatch、发现工具。名单语义对齐官方 '
      + 'ToolRestriction 的 and/or（同时给时先按 allow 保留、再按 deny 剔除）。deny 走 guard（本层与晚到工具）'
      + '与 restrict（继承的全局工具）；allow 只有 restrict 能覆盖全局工具，本层注册无法在执行层「只保留」——'
      + '这是官方 restrict 的边界，不是本动作的取舍。',
  },
  'request-params': {
    title: '改模型请求参数',
    fields: ['patch', 'unset', 'replace'],
    events: ['agent/request'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'agent/request 的下游结算之后（`await next()` 拿到已冻结的 LlmCallConfig 再改写）。',
    note: '请求改写的唯一入口；删键仅删本声明指定的那个值。',
  },
  'stream-output': {
    title: '控制模型输出流',
    fields: ['mode', 'text'],
    events: ['llm/stream'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'llm/stream 下游调用前决定透传或替换。',
    note: '替换输出为合法文本 chunk，不改冻结的请求；空正文透传。',
  },
  'inbox-prepend': {
    title: '前置收件箱消息',
    fields: ['target', 'text', 'match'],
    events: ['agent/inbox/inserted'],
    services: ['agent.inbox.prepend'],
    degrade: ACTION_DEGRADE.silent,
    timing: 'emit 通道（**无 next**）：命中即前置一条消息，不命中什么都不做。',
    note: '只前置不追加；插件来源消息（含本动作自己插入的那条）永不再次前置，防自触发插队。'
      + '收件箱的持久化归宿主（`agent/inbox/spliced`），本动作不自己落盘。',
  },
  'pre-step-filter': {
    title: '过滤 pre-step 注入消息',
    fields: ['sources', 'keepKinds', 'blockPlugins'],
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

/** 十类动作共用键：身份、同点定位与每轮预算。 */
const COMMON_ACTION_FIELDS = ['id', 'kind', 'channelOrder', 'waterfallPosition', 'maxPerTurn']

/** 每类动作的允许键集合（通用键 + `ACTION_KINDS[kind].fields`）。 */
export const ACTION_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_KINDS).map(([kind, meta]) => [kind, new Set([...COMMON_ACTION_FIELDS, ...meta.fields])]),
))
