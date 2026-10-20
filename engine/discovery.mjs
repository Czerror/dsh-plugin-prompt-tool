/**
 * discovery —— 发现引擎：搜索、排序、截断渲染与「适配器注册表」的唯一实现。
 *
 * 两个数据源（工具目录 / 技能目录）共用：
 *  - 分词与候选打分（queryTokens / scoreRows）；
 *  - 准入与排序（rankRows：工具面 any-token，技能面 all-token，由调用方给 admit）；
 *  - 截断、空结果与页脚（renderRows）。
 *
 * 引擎之间通过 **cordis 服务** 互相调用，而不是直接 import 实现：
 *  - 宿主 root provide `promptToolDiscovery`（createDiscoveryRegistry）；
 *  - adapter 行的 apply 在拿到 { agent } 时注册自己的元数据；
 *  - 消费方（tool-visibility）在首次装配时用 `ctx.get(DISCOVERY_SERVICE)` 按 agent 解析。
 * 服务读取用 `ctx.get`（不需要 inject；cordis reflect.ts 的 get 明确「without the inject
 * requirement」），属性读才需要 inject 且沿祖先链——这里刻意用 get。
 *
 * 注册表只存**元数据**（kind / tool / unlock / adapter 身份），工具仍由 adapter 行自己注册：
 * 行的语义不变（挂行 = 有该工具），消费方只消费元数据（解锁名单从哪个参数回收、该用哪个工具名）。
 */

/** 每个 agent 的 adapter 只保留一份：同一个 adapter 重复注册是幂等的。 */
export function createDiscoveryRegistry() {
  const byAgent = new WeakMap()
  const assertAdapter = (kind, adapter) => {
    if (typeof kind !== 'string' || kind.length === 0) throw new TypeError('discovery adapter kind must be a non-empty string')
    if (adapter === null || typeof adapter !== 'object') throw new TypeError(`discovery adapter "${kind}" must be an object`)
    if (typeof adapter.tool !== 'string' || adapter.tool.length === 0) {
      throw new TypeError(`discovery adapter "${kind}" needs a tool name`)
    }
    if (adapter.unlock !== undefined) {
      for (const field of ['tool', 'key']) {
        if (typeof adapter.unlock[field] !== 'string' || adapter.unlock[field].length === 0) {
          throw new TypeError(`discovery adapter "${kind}" unlock.${field} must be a non-empty string`)
        }
      }
    }
  }
  return {
    /**
     * 注册一份 adapter 元数据；同一 agent 同一 kind 只允许一个实现。
     * 同一 adapter 身份重复注册（同一行在重绑/多次装配中再次 apply）是幂等的。
     */
    register(agent, kind, adapter) {
      if (agent === undefined || agent === null) return () => {}
      assertAdapter(kind, adapter)
      let entries = byAgent.get(agent)
      if (entries === undefined) {
        entries = new Map()
        byAgent.set(agent, entries)
      }
      const existing = entries.get(kind)
      if (existing !== undefined) {
        if (existing === adapter) return () => {}
        throw new Error(`discovery kind "${kind}" is already registered for this agent`)
      }
      entries.set(kind, adapter)
      return () => { if (entries.get(kind) === adapter) entries.delete(kind) }
    },
    /** 解析某 agent 的 adapter 元数据；没有注册过时返回 undefined（发现是可选能力）。 */
    get(agent, kind) {
      if (agent === undefined || agent === null) return undefined
      return byAgent.get(agent)?.get(kind)
    },
  }
}

/** kind → 提供该 adapter 的组合行 id（准备期静态校验：声明了 discovery 就必须列对应行）。 */
export const DISCOVERY_ADAPTER_ROWS = Object.freeze({
  tools: 'tool-search',
  skills: 'skill-search',
})

/** 可按名解锁的 kind：技能面只有搜索/加载，没有「解锁名单」语义。 */
export const UNLOCKABLE_DISCOVERY_KINDS = new Set(['tools'])

/**
 * 准备期校验（纯函数，供 agent-assembly 调用）：规则里出现的 discovery.kind 必须有对应行。
 * 失败信息点明缺哪一行，避免「装配成功但发现能力静默缺失」。
 */
export function assertDiscoveryRows(rules, moduleIds, moduleId) {
  const ids = new Set(Array.isArray(moduleIds) ? moduleIds : [])
  for (const rule of Array.isArray(rules) ? rules : []) {
    // 未启用的规则不装配，也就不需要适配器行；启用后缺行会在下一次准备期失败。
    if (rule?.enabled === false) continue
    for (const action of Array.isArray(rule?.actions) ? rule.actions : []) {
      const discovery = action?.discovery
      if (discovery === undefined) continue
      const kind = discovery.kind
      const row = DISCOVERY_ADAPTER_ROWS[kind]
      if (row === undefined) {
        throw new TypeError(`模块 ${moduleId}：未知 discovery kind ${JSON.stringify(kind)} — 可用值：${Object.keys(DISCOVERY_ADAPTER_ROWS).join(', ')}`)
      }
      if (!ids.has(row)) {
        throw new TypeError(`模块 ${moduleId} 声明 discovery kind "${kind}"，但 modules 未包含 "${row}" 行 — 发现适配器必须作为引擎行装配`)
      }
    }
  }
}

/** 查询切成小写 token（Unicode 字母数字与下划线连字符；两个数据源同一口径）。 */
export function queryTokens(query) {
  return (typeof query === 'string' ? query : '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
}

/**
 * 候选打分：每个 token 在 haystack 里出现一次记 1 分；空查询返回空数组
 * （调用方据此区分「没给查询」与「没搜到」）。
 */
export function scoreRows(items, tokens, { nameOf, haystackOf } = {}) {
  if (!Array.isArray(items) || tokens.length === 0) return []
  const name = nameOf ?? ((item) => item?.name)
  const haystack = haystackOf ?? ((item) => `${item?.name ?? ''} ${item?.description ?? ''}`)
  return items
    .map((item) => {
      const itemName = String(name(item) ?? '')
      const text = String(haystack(item) ?? '').toLowerCase()
      let score = 0
      for (const token of tokens) if (text.includes(token)) score += 1
      return { item, name: itemName, score, exact: tokens.includes(itemName.toLowerCase()) }
    })
    .filter((row) => row.name.length > 0)
}

/**
 * 准入与排序：admit 决定哪些行算命中（工具面 any-token，技能面 all-token）；
 * 精确名优先，其次命中数，同分按名字字典序。
 */
export function rankRows(rows, admit = (row) => row.exact || row.score >= 1) {
  return rows
    .filter(admit)
    .sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || a.name.localeCompare(b.name))
}

/**
 * 渲染命中：标题、逐行、截断提示、页脚；空结果只回 emptyText。
 * lineOf 负责单个条目的格式（描述截断长度等由各 adapter 决定）。
 */
export function renderRows(rows, { query, limit, noun, lineOf, emptyText, footer, warnings = [] } = {}) {
  const matches = rows.slice(0, limit)
  if (matches.length === 0) return [emptyText]
  const lines = [`Matching ${noun} (${matches.length}${rows.length > limit ? ` of ${rows.length}` : ''}):`]
  for (const row of matches) lines.push(lineOf(row))
  if (rows.length > limit) lines.push(`(truncated at ${limit} — add tokens to narrow the query)`)
  for (const warning of warnings) lines.push(warning)
  if (footer !== undefined && footer.length > 0) lines.push(footer)
  return lines
}
