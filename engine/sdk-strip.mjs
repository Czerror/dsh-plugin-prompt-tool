/**
 * sdk-strip — PTC SDK 声明文本的保守裁剪（B3 T2 第 (6) 类动作的实现层）。
 *
 * 为什么需要它：官方 `dsh-tools` 在 `mode: ptc` 下把可见工具投影成 `tools:sdk`
 * 段（`renderToolsSdk` / `renderToolsSdkPy`），而 `run_code` 程序里的绑定建自
 * `registry.schemas(exec.agent)`（安装包 `dsh-tools/lib/types/ptc.js:576`）。
 * 因此「把工具从装配目录里剔掉」既不改 SDK 正文、也不改绑定——正文里仍写着被剔
 * 工具的形态。本模块是**剩余呈现补救**：只对官方已产出的正文做删行，不生成、
 * 不新增任何声明，任何不确定一律原样返回（保守失败）。
 *
 * 只有两种官方形态被识别（其余一律原样返回）：
 *   - TypeScript：`interface ToolArgsMap {…}` 与 `interface ToolOutputMap {…}` 的
 *     成员（成员可跨行；键用 `JSON.stringify` 转义，见 `ts-types.js` 的 `renderKey`）；
 *   - Python：`class Tools(Protocol):` 的成员（`async def <name>(self, args: …)` 或
 *     `# tools["<name>"](args: …)` 下标注释）以及只被被剔工具引用的 `TypedDict` 类。
 *
 * 裁剪后必须自校验：解析回读、成员集合等于「原集合 − 名单」、保留成员逐字节未变、
 * 整体行多重集只减不增。任一不成立 → 返回原文。
 * 自校验用的是**本模块的再解析**（engine 自包含，不 import `@deepseek-ai/dsh-tools`
 * 的渲染器）：它证明「只删不增 + 保留部分逐字节不变 + 集合正确」，**不**证明结果
 * 等于「官方对裁剪后名单的重新渲染」（剩余的空行/未用 import 属可接受的残留）。
 *
 * 已知上限（保守失败，不是可用性缺口）：
 *   - 只删到 `class Tools(Protocol):` 正文一条语句都不剩时**放弃裁剪**——Python 的
 *     纯注释类体不是合法语法，而补 `pass` 属于"新增文本"，与"只删不增"冲突。
 *     真要「一个工具都不给」，正确层是名单/guard（执行边界），不是文本裁剪。
 *   - 不做变量引用改写、不处理未识别的自定义渲染器（官方只有 ts/python 两个）。
 *
 * @module engine/sdk-strip
 */

/** 官方 PTC SDK 段名（`dsh-tools/lib/index.js` 的 `sdkSection().name`）。 */
export const SDK_SECTION_NAME = 'tools:sdk'

/** 官方 TS 投影的两个成员表头（`ts-types.js:279-280`）。 */
const TS_MAPS = ['interface ToolArgsMap {', 'interface ToolOutputMap {']
/** TS 成员行：`<2 空格><裸键 | JSON 字符串键>: `。 */
const TS_MEMBER_KEY = /^ {2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][A-Za-z0-9_$]*)): /
/** TS 成员的单行 JSDoc（`docLines(description, 1)`）。 */
const TS_DOC = /^ {2}\/\*\* .* \*\/$/
/** Python 协议头与尾。 */
const PY_PROTOCOL_HEADER = 'class Tools(Protocol):'
const PY_FOOTER = 'tools: Tools'
/** Python 成员：具名方法或下标注释（`py-types.js:753-771`）。 */
const PY_MEMBER_DEF = /^ {4}async def ([^ (]+)\(self, args: /
const PY_MEMBER_SUBSCRIPT = /^ {4}# tools\[("(?:[^"\\]|\\.)*")\]\(args: /
/** Python 类声明（TypedDict / 其它基类；`ToolCallError` 永不被删）。 */
const PY_CLASS_HEADER = /^class ([A-Za-z_][A-Za-z0-9_]*)\(([A-Za-z_][A-Za-z0-9_]*)\):$/
/** 永不可删的类名（错误类型由 `from typing` 之外的固定文本声明）。 */
const PY_PINNED_CLASSES = new Set(['ToolCallError'])

/** 把名单归一为 Set；非法的非集合输入视为空名单（调用方已 fail loud）。 */
function nameSetOf(names) {
  if (names instanceof Set) return names
  if (Array.isArray(names)) return new Set(names.filter((item) => typeof item === 'string' && item.length > 0))
  return new Set()
}

/**
 * 字符串感知的花括号增量：字符串字面量里的 `{}` 不参与计数
 * （`const`/`enum` 的标量由 `JSON.stringify` 渲染，可以含任意花括号与引号）。
 */
function braceDelta(line) {
  let depth = 0
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') depth -= 1
  }
  return depth
}

/** JSON 字符串键的还原（`renderKey` 用的是 `JSON.stringify`）。 */
function decodeQuotedKey(body) {
  try {
    const decoded = JSON.parse(`"${body}"`)
    return typeof decoded === 'string' ? decoded : undefined
  } catch {
    return undefined
  }
}

/** 定位 `header … 空行/`}` 块；识别不出返回 undefined（保守失败）。 */
function findBraceBlock(lines, header) {
  const start = lines.indexOf(header)
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index] === '}') return { start, end: index }
  }
  return undefined
}

/** 解析一个 TS 成员表的成员跨度；形态不认识返回 undefined。 */
function parseTsMembers(lines, block) {
  const members = []
  let index = block.start + 1
  while (index < block.end) {
    const docStart = TS_DOC.test(lines[index]) ? index : -1
    const keyLine = docStart >= 0 ? index + 1 : index
    if (keyLine >= block.end) return undefined
    const match = TS_MEMBER_KEY.exec(lines[keyLine])
    if (match === null) return undefined
    const key = match[1] !== undefined ? decodeQuotedKey(match[1]) : match[2]
    if (typeof key !== 'string' || key.length === 0) return undefined
    let end = -1
    let depth = 0
    for (let cursor = keyLine; cursor < block.end; cursor += 1) {
      depth += braceDelta(lines[cursor])
      if (depth < 0) return undefined
      if (depth === 0 && lines[cursor].endsWith(';')) { end = cursor; break }
    }
    if (end < 0) return undefined
    members.push({ start: docStart >= 0 ? docStart : keyLine, end, key })
    index = end + 1
  }
  return members
}

/** 行多重集包含：`after` 的每一行都能在 `before` 里找到未用尽的同款（= 只删不增）。 */
function linesOnlyRemoved(before, after) {
  // ponytail: O(行长) 计数表，够用；段文本是单次 assembly 的投影，不做字典序指纹。
  const pool = new Map()
  for (const line of before) pool.set(line, (pool.get(line) ?? 0) + 1)
  for (const line of after) {
    const left = pool.get(line) ?? 0
    if (left === 0) return false
    pool.set(line, left - 1)
  }
  return true
}

/** 保留成员必须逐字节未变：删除是纯行删除，故按"删掉的行数"精确定位回读。 */
function retainedSpansIntact(before, after, spans, drop) {
  const beforeDrop = (line) => {
    let count = 0
    for (const index of drop) if (index < line) count += 1
    return count
  }
  for (const span of spans) {
    const at = span.start - beforeDrop(span.start)
    const slice = before.slice(span.start, span.end + 1)
    if (after.slice(at, at + slice.length).join('\n') !== slice.join('\n')) return false
  }
  return true
}

/** TS 载荷：删掉两个成员表里命中名单的成员（含其 JSDoc 行）。 */
function stripTypeScript(lines, names) {
  const blocks = TS_MAPS.map((header) => findBraceBlock(lines, header))
  if (blocks.some((block) => block === undefined)) return undefined
  const parsed = []
  for (const block of blocks) {
    const members = parseTsMembers(lines, block)
    if (members === undefined) return undefined
    parsed.push(members)
  }
  const keysBefore = parsed.map((members) => members.map((member) => member.key))
  const removed = new Set()
  const drop = new Set()
  for (const members of parsed) {
    for (const member of members) {
      if (!names.has(member.key)) continue
      removed.add(member.key)
      for (let line = member.start; line <= member.end; line += 1) drop.add(line)
    }
  }
  if (removed.size === 0) return undefined
  const after = lines.filter((_line, index) => !drop.has(index))
  if (!linesOnlyRemoved(lines, after)) return undefined
  if (!retainedSpansIntact(lines, after, parsed.flat().filter((member) => !names.has(member.key)), drop)) return undefined
  // 回读自校验：两个表的成员键必须恰好等于「原键集合 − 名单」。
  for (const [position, header] of TS_MAPS.entries()) {
    const block = findBraceBlock(after, header)
    if (block === undefined) return undefined
    const members = parseTsMembers(after, block)
    if (members === undefined) return undefined
    const expected = keysBefore[position].filter((key) => !names.has(key))
    const actual = members.map((member) => member.key)
    if (actual.length !== expected.length) return undefined
    for (const [index, key] of actual.entries()) if (key !== expected[index]) return undefined
  }
  // 名单里但正文中不存在的工具：不是错误（呈现与装配不同源），但不得因此放行整体裁剪。
  return after.join('\n')
}

/** Python 协议正文的成员跨度（语句 + 其后附带的 docstring / 描述行）。 */
function parsePyMembers(lines, from, to) {
  const starts = []
  for (let index = from; index < to; index += 1) {
    const line = lines[index]
    if (PY_MEMBER_DEF.test(line)) {
      starts.push({ line: index, name: PY_MEMBER_DEF.exec(line)[1] })
      continue
    }
    const subscript = PY_MEMBER_SUBSCRIPT.exec(line)
    if (subscript !== null) {
      const name = decodeQuotedKey(subscript[1].slice(1, -1))
      if (typeof name !== 'string' || name.length === 0) return undefined
      starts.push({ line: index, name })
    }
  }
  return starts.map((entry, position) => ({
    ...entry,
    start: entry.line,
    end: (position + 1 < starts.length ? starts[position + 1].line : to) - 1,
  }))
}

/** Python 类块（含 4 空格缩进体）。 */
function parsePyClasses(lines, from, to) {
  const blocks = []
  for (let index = from; index < to; index += 1) {
    const match = PY_CLASS_HEADER.exec(lines[index])
    if (match === null) continue
    let end = index + 1
    while (end < to && lines[end].startsWith('    ')) end += 1
    blocks.push({ start: index, end: end - 1, name: match[1], base: match[2] })
    index = end - 1
  }
  return blocks
}

/** 文本里的标识符词元（类可达性用）。 */
function identifiersOf(text, known) {
  const found = new Set()
  for (const token of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (known.has(token[0])) found.add(token[0])
  return found
}

/** Python 载荷：删协议成员，再删只被被删成员引用的类声明。 */
function stripPython(lines, names) {
  const header = lines.indexOf(PY_PROTOCOL_HEADER)
  const footer = lines.lastIndexOf(PY_FOOTER)
  if (header < 0 || footer <= header) return undefined
  const classRegionStart = lines.findIndex((line) => /^from typing import /.test(line))
  if (classRegionStart < 0 || classRegionStart >= header) return undefined
  const classes = parsePyClasses(lines, classRegionStart + 1, header)
  if (classes.length === 0) return undefined
  const members = parsePyMembers(lines, header + 1, footer)
  if (members === undefined || members.length === 0) return undefined

  const drop = new Set()
  const removed = new Set()
  const keptMembers = []
  for (const member of members) {
    if (!names.has(member.name)) { keptMembers.push(member); continue }
    removed.add(member.name)
    for (let line = member.start; line <= member.end; line += 1) drop.add(line)
  }
  if (removed.size === 0) return undefined
  // 删空协议体（只剩注释）不是合法 Python，而补 pass 属于"新增"：保守放弃。
  // ponytail: 这是刻意的保守上限，不是缺口——真要「一个工具都不给」应在名单/guard
  // 层表达（执行边界），文本裁剪只做剩余呈现补救；若将来需要裁剪到空，改法是把
  // pruned 名单交回官方渲染器重生全文，而不是在这里补 pass。
  const body = lines.slice(header + 1, footer)
  const hadStatement = body.some((line) => PY_MEMBER_DEF.test(line))
  const keptStatement = body.some((line, offset) => !drop.has(header + 1 + offset) && PY_MEMBER_DEF.test(line))
  if (hadStatement && !keptStatement) return undefined

  const keptText = keptMembers.map((member) => lines.slice(member.start, member.end + 1).join('\n')).join('\n')
  const known = new Set(classes.map((block) => block.name))
  const reachable = new Set(PY_PINNED_CLASSES)
  const queue = [...identifiersOf(keptText, known)]
  while (queue.length > 0) {
    const name = queue.pop()
    if (reachable.has(name)) continue
    reachable.add(name)
    const block = classes.find((item) => item.name === name)
    if (block === undefined) continue
    for (const token of identifiersOf(lines.slice(block.start, block.end + 1).join('\n'), known)) queue.push(token)
  }
  for (const block of classes) {
    if (reachable.has(block.name)) continue
    for (let line = block.start; line <= block.end; line += 1) drop.add(line)
    // 类块后的一个空行一并删掉，避免留下连续空行（仍是删除，不新增）。
    if (lines[block.end + 1] === '') drop.add(block.end + 1)
  }

  const after = lines.filter((_line, index) => !drop.has(index))
  if (!linesOnlyRemoved(lines, after)) return undefined
  // 保留的成员与类必须逐字节未变。
  const keptClassSpans = classes.filter((block) => reachable.has(block.name))
  if (!retainedSpansIntact(lines, after, [...keptMembers, ...keptClassSpans], drop)) return undefined
  // 被剔工具名不得以成员形态残留。
  const tail = after.join('\n')
  for (const name of removed) {
    if (tail.includes(`    async def ${name}(self, args: `)) return undefined
    if (tail.includes(`    # tools[${JSON.stringify(name)}](args: `)) return undefined
  }
  // 协议头之后只允许出现"被删成员"这一次差异，其余逐字节不变。
  const headerAt = after.indexOf(PY_PROTOCOL_HEADER)
  if (headerAt < 0) return undefined
  const expectedTail = lines.slice(header).filter((_line, offset) => !drop.has(header + offset))
  if (after.slice(headerAt).join('\n') !== expectedTail.join('\n')) return undefined
  // 保留类仍声明、被删类不再声明。
  const declaredAfter = new Set(parsePyClasses(after, 0, headerAt).map((block) => block.name))
  for (const block of keptClassSpans) if (!declaredAfter.has(block.name)) return undefined
  for (const block of classes) if (!reachable.has(block.name) && declaredAfter.has(block.name)) return undefined
  return tail
}

/**
 * 读出一段 SDK 文本声明的全部工具名（allow 名单需要「正文里有哪些工具」才能算差集）。
 *
 * @param text 官方 `tools:sdk` 段的已解析文本。
 * @returns 声明的工具名数组；形态不认识时返回空数组（调用方按"无可裁"处理）。
 */
export function sdkToolNames(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const lines = text.split(text.includes('\r\n') ? '\r\n' : '\n')
  try {
    if (lines.includes(TS_MAPS[0]) || lines.includes(TS_MAPS[1])) {
      const names = new Set()
      for (const header of TS_MAPS) {
        const block = findBraceBlock(lines, header)
        if (block === undefined) return []
        const members = parseTsMembers(lines, block)
        if (members === undefined) return []
        for (const member of members) names.add(member.key)
      }
      return [...names]
    }
    const header = lines.indexOf(PY_PROTOCOL_HEADER)
    const footer = lines.lastIndexOf(PY_FOOTER)
    if (header < 0 || footer <= header) return []
    const members = parsePyMembers(lines, header + 1, footer)
    if (members === undefined) return []
    return [...new Set(members.map((member) => member.name))]
  } catch {
    return []
  }
}

/**
 * 按名单裁剪 SDK 声明文本；只删不增，任何不确定一律返回原文。
 *
 * @param text 官方 `tools:sdk` 段的已解析文本（`assembly.sections[].text`）。
 * @param names 要剔除的工具名集合（Set 或字符串数组）。
 * @returns 裁剪后的文本；空名单、形态不认识、自校验失败一律返回 `text` 原值。
 */
export function stripSdkDeclarations(text, names) {
  const strip = nameSetOf(names)
  // 空名单零开销：不切行、不解析、不分配（与 tool-filter 的"两者都空 = 不过滤"同纪律）。
  if (strip.size === 0) return text
  if (typeof text !== 'string' || text.length === 0) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const isTs = lines.includes(TS_MAPS[0]) || lines.includes(TS_MAPS[1])
  const isPy = lines.includes(PY_PROTOCOL_HEADER)
  if (isTs === isPy) return text
  try {
    const stripped = isTs ? stripTypeScript(lines, strip) : stripPython(lines, strip)
    return typeof stripped === 'string' ? stripped : text
  } catch {
    // 裁剪不是执行边界：任何解析异常都退回原文，绝不改成"少写一点"的正文。
    return text
  }
}
