/**
 * 从官方 `@deepseek-ai/dsh-agent-instructions` 注入的消息里按文件切出正文段落。
 *
 * 官方负责探测与读取（单文件上限、工具触碰驱动的嵌套发现、总量预算、provider 通道），
 * 插件负责决定每个文件的位置、顺序、时机、受众与形态。做法是：官方照常注入 → 本模块
 * 把内容按文件切出来 → 协调器摘掉官方那条消息，按卡片策略重新注入。
 *
 * **保守原则**：任何无法精确判定的情况都返回 undefined，调用方据此保留官方原消息——
 * 宁可少管一次，也不能让用户磁盘上的指令悄悄消失。
 */

/** 官方段落头；正文段以 `Instructions from: <displayPath>` 开头。 */
const HEADER = 'Instructions from: '

/** 官方预算裁剪时的告知片段：命中即放弃切分，避免吞掉「有内容被省略」这个事实。 */
const TRUNCATION_NOTICE = 'omitted or truncated'

/**
 * 官方包裹闭合标记。官方会把正文里出现的同一个串转义成 `<\/system-reminder>`
 * （`escapeInstructionFrameBody`），因此正文里未转义的那个一定是包裹本身，剥离安全。
 */
const FRAME_CLOSE = '</system-reminder>'

interface OfficialChange {
  action?: unknown
  path?: unknown
}

export interface InstructionSegment {
  /** 模型可见路径（官方 `changes[].path`），与插件 displayPath 同口径。 */
  path: string
  /** 该文件正文；已去掉段落头与前导空行。 */
  text: string
}

/** 取单个 text 块的正文；块形状不确定时返回 undefined（不猜）。 */
function bodyOf(message: { content?: unknown }): string | undefined {
  const blocks = message.content
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined
  const block = blocks[0] as { type?: unknown; text?: unknown } | null
  if (block === null || typeof block !== 'object') return undefined
  if (block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block.text
}

/** 在行首定位 `Instructions from: <path>`，找不到或成串出现返回 undefined。 */
function markerIndex(body: string, marker: string, from: number): number | undefined {
  let at = body.indexOf(marker, from)
  while (at >= 0) {
    if (at === 0 || body[at - 1] === '\n') return at
    at = body.indexOf(marker, at + 1)
  }
  return undefined
}

/**
 * 按 `changes[].path` 切出各文件正文。
 * @returns 段落（按正文出现顺序）；任何不确定的情况返回 undefined。
 */
export function extractInstructionSegments(message: unknown): InstructionSegment[] | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return undefined
  const { kind, changes } = source as { kind?: unknown; changes?: unknown }
  if (kind !== 'agent-instructions' || !Array.isArray(changes)) return undefined
  const body = bodyOf(message as { content?: unknown })
  if (body === undefined) return undefined
  if (body.includes(TRUNCATION_NOTICE)) return undefined
  // `remove` 条目没有正文（文件被移出上下文）：交给官方原消息表达。
  const paths: string[] = []
  for (const raw of changes) {
    if (raw === null || typeof raw !== 'object') return undefined
    const { action, path } = raw as OfficialChange
    if (action === 'remove') continue
    if (typeof path !== 'string' || path.length === 0) return undefined
    if (paths.includes(path)) return undefined
    paths.push(path)
  }
  if (paths.length === 0) return undefined
  const marks: Array<{ path: string; start: number }> = []
  for (const path of paths) {
    const start = markerIndex(body, `${HEADER}${path}`, 0)
    if (start === undefined) return undefined
    marks.push({ path, start })
  }
  marks.sort((left, right) => left.start - right.start)
  return marks.map((mark, index) => {
    const textStart = mark.start + HEADER.length + mark.path.length
    const raw = body.slice(textStart, index + 1 < marks.length ? marks[index + 1]!.start : body.length)
    const frame = raw.indexOf(FRAME_CLOSE)
    return { path: mark.path, text: (frame < 0 ? raw : raw.slice(0, frame)).replace(/^\n+/, '').replace(/\s+$/, '') }
  })
}
