/**
 * near-anchor — prompt-tool 近距离首句锚定（替代独立锚定轮）。
 *
 * 依据 dsh-router-standard P13/P14/P15/P22 与作者勘误：
 *   - 行为引导放 system（远距离）会衰减甚至反向；放在真实用户消息之后
 *     （近距离）零衰减；
 *   - 只要求首句一次：模型自回归续写会维持语域，越锚越牢；
 *   - 强制“每个 reasoning 块都以某句开头/回顾开头”是负效果；
 *   - 日常任务锚 We（官方后训练压出的高效路径），复杂规划放行 Let
 *     （未收敛旧路径携带更深规划能力），不做唯一解。
 *
 * 实现：在首条真实用户消息之后追加一条锚点消息，不拆轮、不挪任务；
 * 幂等性来自持久事件（source.plugin === 'near-anchor'）+ 进程内 memo。
 * 自定义开关：config.useCustom 为 true 时固定使用 config.anchorText；
 * false（默认）时忽略 anchorText，按任务与模型自动选择文本。
 */

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'near-anchor'

/** 无服务依赖，只监听 pre-step 消息组装。 */
export const inject = []

/** 开发/生成类任务关键词。 */
const BUILD_RE = /(开发|创建|写一个|生成|从零|做一个|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/i
/** 复杂规划/修复类任务关键词：放行 Let 深度路径。 */
const COMPLEX_RE = /(架构|重构|设计|系统|全面|深度|迁移|兼容|审查|architecture|refactor|comprehensive|design|system|migrate|review)/i

/** 开发类：we 直接产出并验证。 */
const ANCHOR_BUILD = "Start your reasoning with the exact sentence: 'We need to build it directly and verify it.'"
/** 检查/日常类：we 先看代码。 */
const ANCHOR_INSPECT = "Start your reasoning with the exact sentence: 'We need to inspect the code first.'"
/** 复杂规划类：放行 Let 深度规划路径。 */
const ANCHOR_DEEP = "Start your reasoning with the exact sentence: 'Let me think through the design before changing anything.'"

/** Flash 模型附加三锚（回顾已完成 + 信息足够就产出 + 禁止环境检查/穷举）。 */
const FLASH_ANCHORS = ' Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. When you have gathered enough information, stop exploring and produce the deliverable. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.'

/** 生成消息 id：优先加密随机 id，旧运行时回退到随机串。 */
function newMessageId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `near-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 从 user/message 的 data 中提取纯文本；兼容 data.message 嵌套形状。 */
function extractText(data) {
  if (!data) return ''
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join(' ').trim()
}

/** 按开关与任务选择锚点：useCustom=true 固定用自定义；false 自动选择。 */
function chooseAnchor(text, modelId, customText, useCustom) {
  if (useCustom === true) {
    return typeof customText === 'string' ? customText.trim() : ''
  }
  let anchor
  if (COMPLEX_RE.test(text)) anchor = ANCHOR_DEEP
  else if (BUILD_RE.test(text)) anchor = ANCHOR_BUILD
  else anchor = ANCHOR_INSPECT
  if (typeof modelId === 'string' && /flash/i.test(modelId)) return anchor + FLASH_ANCHORS
  return anchor
}

export function apply(ctx, config) {
  const customText = typeof config.anchorText === 'string' ? config.anchorText : ''
  const useCustom = config.useCustom === true

  /** 本进程已处理过的会话（真相在持久事件流）。 */
  const handled = new Set()

  /** 持久事件里是否已有本插件的锚点消息。 */
  const seenAnchor = (session) => session.events.some((event) => {
    const payload = event.data && typeof event.data.message === 'object' && event.data.message !== null
      ? event.data.message
      : event.data
    return payload?.source?.plugin === 'near-anchor'
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (agent === undefined) return decision
    const session = agent.session
    if (session === undefined || handled.has(session.id) || seenAnchor(session)) return decision
    // 子代理不注入锚点：让 dsh-mnemon 等结构化 worker 按自己的提示词工作。
    if ((session.header?.delegationDepth ?? 0) > 0) return decision

    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 只锚真实用户消息；插件消息原样保留。
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return decision
    const taskText = extractText(messages[userIndex])
    if (taskText.length === 0) return decision

    const anchorText = chooseAnchor(taskText, agent.options?.model, customText, useCustom)
    if (anchorText.length === 0) return decision
    handled.add(session.id)

    const anchor = {
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: anchorText }],
      source: {
        kind: 'near-anchor',
        plugin: 'near-anchor',
        form: 'notice',
        summary: 'near-anchor 近距离首句锚点',
      },
    }
    const nextMessages = [...messages]
    nextMessages.splice(userIndex + 1, 0, anchor)
    return { ...decision, messages: nextMessages }
  })
}
