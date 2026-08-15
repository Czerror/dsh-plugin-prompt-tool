/**
 * prompt-tool preset 生成核心：与 dsh 插件上下文无关的纯函数，
 * 独立成文件以便单元测试与复用。失败一律抛出（fail loud）。
 */
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 子模块直引（唯一源）：插件加载时读 vendor 最新版，子模块更新后无需任何
// 同步步骤、重启即生效。vendor 缺失或上游结构变化 → fail loud。
const VENDOR_CORDIS = fileURLToPath(new URL('../vendor/dsh-anchored-standard/preset/agent.cordis.yml', import.meta.url))

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
}

const LOCAL_INJECTOR_BLOCK = `# prompt-tool 附加件：锚定确认后注入 prompt.md。注册在 tool-bootstrap 之后，
# 不参与首轮剥离顺序；tools / 上下文剥离全部由原版 tool-bootstrap 负责
# （首轮 = Minimal 真实 schema：持久 bash + str_replace_editor，无输出 cap），
# 此插件只做一件事——锚定轮结束后（we 确认或兜底）注入一次提示词。
- id: prompt-injector
  name: ./prompt-injector.mjs
  config:
    promptText: |-
      __PROMPT_TOOL_TEXT__
`

const TURN_ANCHOR_BLOCK = `# prompt-tool 可选附加件：首轮独立锚定轮。启用后首个真实用户消息先入
# next-step inbox，首步只发 anchorText；模型回应锚定句后，driver 在同轮
# 内自动消费任务继续执行。关闭时不生成此行。
- id: turn-anchor
  name: ./turn-anchor.mjs
  config:
    anchorText: |-
      __ANCHOR_TEXT__
`

// 解析 prompt/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: SkillFrontmatter = {}
  const doc = parseYaml(match[1]!, { logLevel: 'silent' }) as Record<string, unknown> | null
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object') {
      data.metadata = doc.metadata as Record<string, unknown>
    }
  }
  return { data, body: text.slice(match[0].length) }
}

export interface BuildCordisOptions {
  /** 首轮独立锚定轮：首个用户消息先入 next-step inbox，首步只发 anchorText。 */
  anchorFirstTurn?: boolean
  anchorText?: string
}

// agent.cordis.yml 直引子模块 + 运行时注入 prompt-injector 块（可选 turn-anchor 块）。
// 锚点定位到 tool-bootstrap 行与其后第一个零缩进非空行，不依赖 config 字段文本；
// 替换占位符后断言无残留，并用 YAML 解析器验证生成文件结构，失败即 fail loud。
export function buildCordis(prompt: string, options: BuildCordisOptions = {}): string {
  const anchorFirstTurn = options.anchorFirstTurn === true
  const anchorText = typeof options.anchorText === 'string' && options.anchorText.length > 0
    ? options.anchorText
    : "You are a helpful software assistant.\n\nBegin every reasoning block with 'We need'."
  const indent = (s: string) => s.split(/\r?\n/).map((l) => l.length === 0 ? '' : '      ' + l).join('\n')
  const up = readFileSync(VENDOR_CORDIS, 'utf8').replace(/\r\n/g, '\n')

  // 1) 定位 tool-bootstrap 顶层条目，并把插入点放在该条目之后：
  //    条目内部行（缩进行）与空行跳过，遇到下一个零缩进非空行（注释块或条目）即停。
  const bootstrap = /^-\s+id:\s+tool-bootstrap\s*$/m.exec(up)
  if (!bootstrap) throw new Error('vendor agent.cordis.yml missing tool-bootstrap row')
  let cursor = up.indexOf('\n', bootstrap.index)
  if (cursor < 0) throw new Error('vendor agent.cordis.yml has no top-level row after tool-bootstrap')
  cursor += 1
  let insertAt = -1
  while (cursor <= up.length) {
    const lineEnd = up.indexOf('\n', cursor)
    const line = lineEnd < 0 ? up.slice(cursor) : up.slice(cursor, lineEnd)
    if (line.trim() !== '' && !/^\s/.test(line)) {
      insertAt = cursor
      break
    }
    if (lineEnd < 0) break
    cursor = lineEnd + 1
  }
  if (insertAt < 0) throw new Error('vendor agent.cordis.yml has no top-level row after tool-bootstrap')
  const head = up.slice(0, insertAt)
  const tail = up.slice(insertAt)
  const separator = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'

  // 2) 注入 promptText，并断言占位符确实被替换、没有残留。
  const promptMarker = '    promptText: |-\n      __PROMPT_TOOL_TEXT__'
  if (!LOCAL_INJECTOR_BLOCK.includes(promptMarker)) {
    throw new Error('internal error: prompt-injector template lost its promptText placeholder')
  }
  const injector = LOCAL_INJECTOR_BLOCK.replace(promptMarker, '    promptText: |-\n' + indent(prompt))

  // 可选：首轮独立锚定轮块，注册在 prompt-injector 之前。
  let extra = injector
  if (anchorFirstTurn) {
    const anchorMarker = '    anchorText: |-\n      __ANCHOR_TEXT__'
    if (!TURN_ANCHOR_BLOCK.includes(anchorMarker)) {
      throw new Error('internal error: turn-anchor template lost its anchorText placeholder')
    }
    extra = TURN_ANCHOR_BLOCK.replace(anchorMarker, '    anchorText: |-\n' + indent(anchorText)) + '\n' + injector
  }

  const out = head + separator + extra + '\n' + tail
  if (out.includes('__PROMPT_TOOL_TEXT__') || (anchorFirstTurn && out.includes('__ANCHOR_TEXT__'))) {
    throw new Error('internal error: preset template placeholder was not replaced')
  }

  // 3) 生成文件必须是合法 YAML，且本插件行确实落位。
  let parsed: unknown
  try {
    parsed = parseYaml(out, { logLevel: 'silent' })
  } catch (error) {
    throw new Error(`generated agent.cordis.yml is invalid YAML: ${String((error as Error & { message?: string }).message ?? error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('generated agent.cordis.yml is not a YAML array')
  const ids = new Set(parsed.map((row) => (row as { id?: string } | null)?.id))
  if (!ids.has('prompt-injector')) throw new Error('generated agent.cordis.yml is missing the prompt-injector row')
  if (anchorFirstTurn && !ids.has('turn-anchor')) throw new Error('generated agent.cordis.yml is missing the turn-anchor row')
  return out
}
