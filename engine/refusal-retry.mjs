/**
 * 有界拒绝识别与单次请求重放（`request-retry` 动作的运行时）。
 *
 * 已批边界（spec 15）：缓冲开头约 400 个文本字符后决策，匹配范围最多前 600 个字符；
 * 遇到推理增量、工具调用或 finish 提前决定。块级正文与增量级 `text-delta` 用同一份累积，
 * 同一 index 已有增量时不再并入块正文，避免重复计数。
 *
 * 一次原始请求最多两次实际调用：首请求 options 与重放 options 都进入同一 claim 集合，
 * 多来源命中时只有最先声明的来源重放（同值共存、异值由调用方告警并保旧）。
 */
export const RETRY_DECISION_CHARS = 400
export const RETRY_MATCH_CHARS = 600

/** 命中即视为「模型在推脱」。中文软拒绝开场比「我不能」更常见，因此单列几条。 */
const REFUSAL_PATTERNS = [
  /I (?:can(?:'|’)?t|cannot|won(?:'|’)?t|am unable to|must decline)/i,
  /I(?:'|’)?m sorry,? but/i,
  /(?:can(?:'|’)?t|cannot|unable to) (?:help|assist|provide|comply) with (?:that|this|your|the)/i,
  /我不能|我无法|无法(?:协助|帮助|提供|满足|完成)|抱歉[，,]?\s*我/,
  /(?:这|此举|此事)(?:超出了|超出)(?:我的)?(?:能力|范围)/,
  /(?:作为|身为)(?:一个)?(?:AI|人工智能|语言模型)/i,
  /我(?:不参与|不帮你|不会帮|不能参与|不方便参与)/,
]

/** 讨论拒绝机制（而非拒绝本身）：长正文出现这些词按技术讨论处理。 */
const META_DISCUSSION = /提示词注入|越狱|指令注入|拒绝机制|prompt[ _-]?injection|jailbreak|refusal/i
/** 命中位置之前出现引用标记：引号、块引用、或明确的「它说／原文／例如」。 */
const QUOTE_MARKER = /["'“”‘’「」『』>][^\n]{0,80}$/
const QUOTE_WORD = /(?:said|says|wrote|quote|example|引用|原文|写道|说)[^\n]{0,80}$/i

/** 返回命中规则的下标（-1 = 不命中）。`head` 取自开头累积文本，内部再按匹配上限截断。 */
export function refusalMatchIndex(head = '') {
  const text = String(head).slice(0, RETRY_MATCH_CHARS)
  if (text.trim().length === 0) return -1
  // 长正文里讨论注入/越狱/拒绝机制不是拒绝（参考实现同判据；阈值与匹配上限同量级）。
  if (text.trim().length > 280 && META_DISCUSSION.test(text)) return -1
  for (let index = 0; index < REFUSAL_PATTERNS.length; index++) {
    const found = REFUSAL_PATTERNS[index].exec(text)
    if (found === null) continue
    const before = text.slice(Math.max(0, found.index - 80), found.index)
    if (QUOTE_MARKER.test(before) || QUOTE_WORD.test(before)) continue
    return index
  }
  return -1
}

export const looksLikeRefusal = head => refusalMatchIndex(head) >= 0

/**
 * 一次原始请求的重放claim：键是官方请求 options 对象本身。
 * 跨来源共享（模块级），因此第二个命中来源只会看到已被认领的 options 并直接透传。
 */
const claimed = new WeakSet()

/** 认领（或查询）本次请求的重放额度；`true` = 由调用方处理。 */
export function claimRequest(options) {
  if (options === null || typeof options !== 'object') return false
  if (claimed.has(options)) return false
  claimed.add(options)
  return true
}

const textOf = parts => [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('')

/** 同一份累积同时接受增量与完整块；已有增量的 index 不再并入块正文。 */
function accumulate(chunk, parts) {
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
    parts.set(chunk.index, (parts.get(chunk.index) ?? '') + chunk.text)
    return
  }
  if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string' && !parts.has(chunk.index)) {
    parts.set(chunk.index, chunk.block.text)
  }
}

/** 推理、工具调用与完成信号都在此提前决出「不是可重放的开头拒绝」。 */
const decidesEarly = chunk => chunk?.type === 'finish' || chunk?.type === 'reasoning-delta'
  || chunk?.type === 'tool-call-delta'
  || (chunk?.type === 'block-start' && (chunk.blockType === 'tool-call' || chunk.blockType === 'reasoning'))

/**
 * 包一层官方流：先缓冲有限前缀判定，未命中按原顺序透传；命中则结束上游、按重放正文发起
 * 第二次真实请求，并只采用第二次的输出块。第二次自身失败直接冒泡（不再叠加本能力）。
 */
export async function* refusalRetryStream({ options, first, retryStream, warnOnce = () => {} }) {
  const iterator = first[Symbol.asyncIterator]()
  const buffered = []
  const parts = new Map()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await iterator.return?.() } catch { /* 上游结束失败不改变已决定的结果 */ }
  }
  try {
    let finish
    while (true) {
      const step = await iterator.next()
      if (step.done) break
      const chunk = step.value
      buffered.push(chunk)
      accumulate(chunk, parts)
      if (chunk?.type === 'finish') { finish = chunk; break }
      if (decidesEarly(chunk)) break
      if (textOf(parts).length >= RETRY_DECISION_CHARS) break
    }
    const head = textOf(parts)
    // 整段就一句拒绝也算命中；只有正常 stop 收尾才重放，error / aborted / 截断沿官方链返回。
    const hit = (finish === undefined || finish.reason?.kind === 'stop') && looksLikeRefusal(head)
    if (!hit) {
      for (const chunk of buffered) yield chunk
      while (true) {
        const step = await iterator.next()
        if (step.done) return
        yield step.value
      }
    }
    // 命中：只保留首尝试已到手的用量；正文块与 finish 属被丢弃的尝试，不上交。
    for (const chunk of buffered) if (chunk?.type === 'usage') yield chunk
    await close()
    // 取消可能正好落在「已判定命中、尚未发起第二次」的窗口，运行时不会替包装拦截。
    options.signal?.throwIfAborted()
    warnOnce('request-retry: refusal matched in the opening window, replaying once')
    yield* retryStream()
  } finally {
    await close()
  }
}
