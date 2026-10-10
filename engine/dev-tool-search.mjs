/**
 * 工具面的按需发现与解锁。
 *
 * 为什么：工具面实测 **156 个、工具描述合计 46894 字符**（≈12K token，每个请求都付），
 * 而多数请求只用到其中几个。收窄成常驻核心集之后，本工具是唯一的发现入口。
 *
 * 两个动作合一：
 *  - `query` 关键词搜索**完整装配目录**（只回名字 + 一行截断描述，不回 parameters）；
 *  - `toolNames` 按**精确名**解锁。解锁名写进本次 `tool/call` 的持久参数，
 *    `assembly.target.tools.allowFrom` 从那里读回 → 下次请求起生效，且跨压缩保留。
 *
 * **能力摘要来自运行时截获，不手工维护**（2026-10-05 用户指出）：空查询时按前缀把
 * `ctx.tools.schemas()` 的可见目录折叠成分组摘要（`mcp__github__* ×46`，实测 433 字符
 * 覆盖全部 156 个工具）。此前的实现写死一份 UNLOCKABLE_INDEX——工具增删就要改代码，
 * 名字写错还会让模型照着错名字解锁（那份实现甚至需要一条专门测试来防错名）。
 * 官方注册表只投影 name/description（无分组字段），所以分组只能按前缀在本地折叠。
 *
 * 与原 `dev-tool-search.mjs` 的两处修正照搬：
 *  1. 匹配是**打分**而非 AND 过滤——长自然语言查询（"file edit write replace"）在
 *     AND 口径下命中零个，等于白搜。现在精确名优先，其次按命中 token 数排序。
 *  2. 描述里显式教解锁路径（"搜索为空 ≠ 工具不存在"）——实测模型只会搜、不会传
 *     toolNames，于是收窄后永远拿不到工具。
 */
export const name = 'dev-tool-search'

/** 工具注册表必须先于本工具存在（同 skill-search 的 inject 纪律）。 */
export const inject = ['tools']

/** 单次搜索结果上限：再多就该让模型收窄关键词。 */
export const MAX_RESULTS = 25

/** 一行描述在结果里的截断长度。 */
const DESC_LIMIT = 90

/** 空查询摘要里最多列出的分组数，超出则并入「其他」。 */
const MAX_GROUPS = 24

/** 常驻核心集：由工具面收窄模板声明，这里只在描述里如实告知模型。 */
const RESIDENT = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill_search', 'skill_load']

/** 零依赖的最小 JSON schema 编译器（与 skill-search 同构）。 */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    if (meta.items) prop.items = meta.items
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 能力索引：常驻核心集（pwsh / read / write / edit / glob / grep / todo_write /
 * skill_search / skill_load）覆盖不到的能力。名字全部取自实测工具面。
 */

/** 把查询切成小写 token（Unicode 字母数字与下划线连字符，与 skill-search 同口径）。 */
export function queryTokens(query) {
  return (typeof query === 'string' ? query : '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
}

/**
 * 一个工具名的分组键：MCP 工具折到服务级（`mcp__github__*`），其余折到首个下划线段
 * （`task_board_create` → `task_*`），无下划线的单名自成一组。
 */
export function groupKeyOf(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return parts.length >= 2 ? `${parts[0]}__${parts[1]}__*` : `${name}*`
  }
  const cut = name.indexOf('_')
  return cut <= 0 ? name : `${name.slice(0, cut)}_*`
}

/**
 * 从**运行时目录**折叠出分组摘要——这是替代手工能力索引的唯一来源。
 * 名字、分组、数量全部来自 `ctx.tools.schemas()`，工具增删不需要改本模块的代码。
 * 超过 MAX_GROUPS 个分组时，把长尾并成一行「其他」而不是无限增长。
 */
export function summarizeCatalog(schemas) {
  const counts = new Map()
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const key = groupKeyOf(schema?.name)
    if (key === undefined) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  const head = sorted.slice(0, MAX_GROUPS)
  const tail = sorted.slice(MAX_GROUPS)
  const parts = head.map(([key, count]) => `${key}(${count})`)
  if (tail.length > 0) parts.push(`其他 ${tail.length} 组(${tail.reduce((sum, [, n]) => sum + n, 0)})`)
  return { total: [...counts.values()].reduce((sum, n) => sum + n, 0), text: parts.join(' ') }
}

/**
 * 对目录打分排序（纯函数，可单测）：
 * 精确名命中排最前，其次按命中 token 数降序，同分按名字字典序。
 * `wanted` 为空时返回空数组——调用方据此区分「没给查询」与「没搜到」。
 */
export function scoreTools(schemas, wanted) {
  if (!Array.isArray(schemas) || wanted.length === 0) return []
  return schemas
    .map((schema) => {
      const name = typeof schema?.name === 'string' ? schema.name : ''
      const haystack = `${name} ${schema?.description ?? ''}`.toLowerCase()
      let score = 0
      for (const token of wanted) if (haystack.includes(token)) score += 1
      return { schema, name, score, exact: wanted.includes(name.toLowerCase()) }
    })
    .filter((entry) => entry.name.length > 0 && (entry.exact || entry.score >= 1))
    .sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || a.name.localeCompare(b.name))
}

/** 解锁名单归一：只留非空字符串，去重保序。 */
export function unlockNames(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name.length > 0) seen.add(name)
  }
  return [...seen]
}

/** 把目录搜索结果渲染成给模型的文本（带截断提示与解锁引导）。 */
export function renderMatches(scored, query) {
  const lines = []
  const matches = scored.slice(0, MAX_RESULTS)
  if (matches.length === 0) {
    lines.push(
      `No tools match "${query}". An empty result only means no tool matched your keywords — if you need a specific tool, unlock it directly by exact name, e.g. dev_tool_search({"toolNames":["web_search"]}).`,
    )
    return lines
  }
  lines.push(`Matching tools (${matches.length}${scored.length > MAX_RESULTS ? ` of ${scored.length}` : ''}):`)
  for (const { schema, name, exact } of matches) {
    const desc = String(schema?.description ?? '').split('\n')[0].slice(0, DESC_LIMIT)
    lines.push(`- ${name}${exact ? ' (exact)' : ''}: ${desc}`)
  }
  if (scored.length > MAX_RESULTS) {
    lines.push(`(truncated at ${MAX_RESULTS} — add tokens to narrow the query)`)
  }
  lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
  return lines
}

/** 注册模型可见的 `dev_tool_search`。 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dev_tool_search',
    description: [
      'Discover and unlock tools that are NOT currently available.',
      '',
      `This session starts with a minimal resident set: ${RESIDENT.join(', ')}. Everything else is unlocked on demand through this tool.`,
      '',
      'Usage:',
      '- `query` — search the catalog by keyword (matches tool names AND descriptions, 1-2 short words work best).',
      '- call with NO arguments — list the catalog as group counts (`<prefix>_*(count) ...`), so you can see what exists before searching.',
      '- `toolNames` — unlock exact names. Unlocked tools appear from the NEXT request on and stay unlocked for the session.',
      '',
      'Example: dev_tool_search({"query":"pull request","toolNames":["mcp__github__create_pull_request"]}) — search AND unlock in one call.',
      'IMPORTANT: if the task needs a capability outside that resident set — web search, subagents, task boards, MCP servers, anything not listed above — search for it here and unlock it. Do NOT make do with a resident tool when the tool you actually need is merely locked; an empty search result does NOT mean the tool does not exist, it only means no tool matched your keywords. Call with no arguments to see the catalog groups, then unlock by exact name.',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: 'search keywords (e.g. "web", "subagent", "github")' },
      toolNames: {
        type: 'array',
        required: false,
        items: { type: 'string' },
        description: 'exact tool names to unlock for the next request',
      },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const unlock = unlockNames(args?.toolNames)
      const lines = []
      // 解锁动作本身不需要任何运行时服务：引擎的 allowFrom 只读本工具的持久调用参数，
      // 所以即便目录不可用（无 tools 服务/无 agent），解锁也必须照样回报成功。
      if (unlock.length > 0) lines.push(`Unlocked for the next request: ${unlock.join(', ')}`)
      if (query.length === 0 && unlock.length > 0) return { text: lines.join('\n') }
      let schemas
      try {
        // 执行中的 agent 就是观察作用域：preset 工具注册在 agent scope 层，
        // 不带 scope 的 schemas() 只看全局层，会漏掉它们。
        schemas = ctx.tools.schemas(exec?.agent)
      } catch (error) {
        return { text: [...lines, `catalog search unavailable: ${String(error?.message ?? error)}`].join('\n') }
      }
      // 空查询 = 要目录概览。摘要由运行时目录折叠而来，不需要维护任何索引。
      if (query.length === 0) {
        const summary = summarizeCatalog(schemas)
        lines.push(
          summary.total === 0
            ? 'The catalog is empty — nothing to unlock.'
            : `Catalog groups (${summary.total} tools): ${summary.text}`,
          'Search with `query`, or unlock by exact name with `toolNames`.',
        )
        return { text: lines.join('\n') }
      }
      lines.push(...renderMatches(scoreTools(schemas, queryTokens(query)), query))
      return { text: lines.join('\n') }
    },
  })
}
