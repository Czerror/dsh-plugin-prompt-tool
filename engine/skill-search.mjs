/**
 * skill-search — on-demand skill discovery and loading, replacing
 * `dsh-tool-skill`'s full-catalog injection.
 *
 * WHY: the available-skills reminder (`<available_skills>`, ~9KB with many
 * skills) is injected into the first step by dsh-tool-skill and again after
 * every promotion/compaction. That large injected block perturbs the
 * trajectory (issue #6: 0/9 anchored with the catalog present vs ~81%
 * without). We remove the catalog injection entirely and expose two small
 * tools instead — the Claude tool-search pattern:
 *
 *  - `skill_search` — list skills whose name/description match a query
 *    (summaries only, bounded; no bodies). The model discovers what exists
 *    without a 9KB dump.
 *  - `skill_load` — load ONE skill's full instructions by exact name and
 *    inject them for the NEXT request via `agent.inject` (the non-waking
 *    next-step inbox). The model (or the user) calls this only when the
 *    skill is actually needed.
 *
 * Discovery reads `ctx.skills` scoped to the calling agent, exactly like
 * dsh-tool-skill. If skills are unavailable the tools answer with a short
 * message instead of throwing.
 *
 * 与 `tool-search.mjs` 同形状的三条修正（2026-10-16，技能面照搬工具面）：
 *  1. **打分而非 AND 过滤**：完整命中（命中全部 token）优先，其次近似命中；
 *     长自然语言查询不再全灭。精确名命中最前。中文与英文同口径——中文整句
 *     是一个 token，`includes` 仍是子串匹配。
 *  2. **空查询列出全部（截到上限）**：`skill_load` 已有精确名时直接加载，空查询是
 *     「先看看有什么」的入口——完整列表连同截断标注比分组摘要更好用。
 *  3. **截断与空结果都明说**：显示条数 / 命中总数分列，并写明「空结果只说明
 *     关键词没命中」——模型据此收窄查询或直接按精确名 `skill_load`，而不是
 *     转去翻文件系统猜名字。
 *
 * NOTE: this plugin REPLACES the `dsh-tool-skill` row in the composition —
 * the composition must NOT mount both, or the catalog injection returns.
 */
import { importHostPackage } from './host-package.mjs'
import { toJsonSchema } from './shared.mjs'

const { isModelInvocable, renderSkillContent } = await importHostPackage('@deepseek-ai/dsh-skill')

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

/** 参数 schema 由 `shared.mjs` 的统一实现生成（与 `tool-search` 同一份）。 */

/** 把查询切成小写 token（Unicode 字母数字与下划线连字符，与 tool-search 同口径）。 */
export function queryTokens(query) {
  return (typeof query === 'string' ? query : '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
}

/**
 * 对目录打分排序（纯函数，可单测）：
 * **完整命中是准入条件**（每个 token 都命中），精确名命中排最前；同为准入者按命中数、
 * 再按名字字典序。`wanted` 为空时返回空数组——调用方据此区分「没给查询」与「没搜到」。
 *
 * 准入用 AND 而不是「命中任意 token」：`代码 中文` 这类多词查询里，近似命中会把
 * 只沾一个词的无关技能一起倒出来（技能 description 很短，噪声占比远高于工具面）。
 */
export function scoreSkills(skills, wanted) {
  if (!Array.isArray(skills) || wanted.length === 0) return []
  return skills
    .map((skill) => {
      const name = typeof skill?.name === 'string' ? skill.name : ''
      const haystack = `${name} ${skill?.description ?? ''} ${skill?.whenToUse ?? ''}`.toLowerCase()
      let score = 0
      for (const token of wanted) if (haystack.includes(token)) score += 1
      return { skill, name, score, exact: wanted.includes(name.toLowerCase()) }
    })
    .filter((entry) => entry.name.length > 0 && (entry.exact || entry.score === wanted.length))
    .sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || a.name.localeCompare(b.name))
}

/** 搜索结果上限：再多就该让模型收窄关键词。 */
const MAX_RESULTS = 20

/** 把目录搜索结果渲染成给模型的文本（带截断提示与加载引导）。 */
export function renderMatches(scored, query, complete = true) {
  const matches = scored.slice(0, MAX_RESULTS)
  if (matches.length === 0) {
    return [
      complete
        ? `No skills match "${query}". An empty result only means no skill matched your keywords — it does NOT mean the skill is unavailable. If you know the exact name (the user named it, or you saw it earlier), load it directly with skill_load({"name":"<exact-name>"}).`
        // 没读全就不下结论：措辞上也不能出现「没有匹配」的断言形式。
        : `Skill discovery did not complete, so nothing can be concluded about "${query}". Retry skill_search before treating a skill as unavailable.`,
    ]
  }
  const lines = [`Matching skills (${matches.length}${scored.length > MAX_RESULTS ? ` of ${scored.length}` : ''}):`]
  for (const { skill, name, exact } of matches) {
    lines.push(`- ${name}${exact ? ' (exact)' : ''}: ${String(skill?.description ?? '').split('\n')[0]}`)
  }
  if (scored.length > MAX_RESULTS) lines.push(`(truncated at ${MAX_RESULTS} — add tokens to narrow the query)`)
  if (!complete) lines.push('Skill discovery is incomplete; these results may be partial.')
  lines.push('Load one with skill_load({"name": "<exact name>"}).')
  return lines
}

/** 注册两个按需技能工具。 */
/**
 * 本模块**刻意保持单参形态**：它不读任何 config 键，因此没有白名单可声明。
 * B2 T4 要求「四个无白名单插件行补字段声明与校验」，本行按 PLAN 的例外处理——
 * 若将来需要 config，先确认组合行与调用方确实在传 config，再补 defineConfig 声明。
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'skill_search',
    description: [
      'Search the available skills by keyword and return matching skill names with short descriptions.',
      '',
      'This session keeps NO skill catalog in the prompt — call skill_search FIRST to find a skill, then skill_load to activate it. Do NOT assume skill names from memory.',
      '',
      'Usage:',
      '- `query` — search skill names and descriptions (1-2 short words work best; Chinese keywords work).',
      '- call with NO arguments — list up to 20 registered skills (truncation is marked with the matching total).',
      '',
      'IMPORTANT: an empty search result does NOT mean a skill is unavailable — it only means no skill matched your keywords. Search results are discovery only; `skill_load` accepts ANY exact name in the registry, including one the user just named. Never conclude from an empty search that no skill exists.',
    ].join('\n'),
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: 'search keywords (e.g. "pdf", "obsidian", "代码审查")' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      try {
        // 执行中的 agent 就是观察作用域（同 tool-search）：preset 层注册的技能不带
        // scope 时看不到；cwd 决定项目级技能根，两个入口共用同一组查询参数。
        const snapshot = await ctx.skills.snapshot({
          scope: exec?.agent ?? ctx,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        exec?.signal?.throwIfAborted()
        const visible = snapshot.skills.filter(isModelInvocable)
        // 空查询列出可见技能（`scoreSkills` 按契约对空 token 返回 `[]`，不能代表「列出全部」）；
        // 不完整读只作标注、不作否决，避免把「没读全」变成「搜不到」。
        const scored = query.length === 0
          ? visible.map((skill) => ({ skill, name: skill.name, score: 0, exact: false }))
          : scoreSkills(visible, queryTokens(query))
        return { text: renderMatches(scored, query, snapshot.complete).join('\n') }
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error && error.message) || error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name and inject them for the next request. Call this before acting on a task that matches the skill. The name may come from skill_search, from the catalog overview, or from the user — any exact name in the registry works.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, as registered)' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (agent === undefined) return { text: 'skill_load requires an agent context.' }
        const options = {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        }
        const snapshot = await ctx.skills.snapshot(options)
        options.signal?.throwIfAborted()
        const summary = snapshot.skills.find((entry) => entry.name === args.name)
        if (summary === undefined) {
          // 名字错、发现没跑完、调用面缺 agent——三种成因的应对不同。
          return { text: snapshot.complete
            ? `No skill named "${args.name}" is registered for this session. Check the exact name (skill_search lists what is registered), then call skill_load again.`
            : 'Skill discovery is incomplete, so the name could not be confirmed. Retry skill_load before concluding the skill does not exist.' }
        }
        if (!isModelInvocable(summary)) return { text: `Skill "${args.name}" is not available for model invocation.` }
        const skill = await ctx.skills.get(args.name, options)
        options.signal?.throwIfAborted()
        if (skill === undefined) {
          return { text: `Skill "${args.name}" is no longer available — it was registered but its body could not be loaded. Retry once, then run skill_search to see what is still registered.` }
        }
        if (!isModelInvocable(skill)) return { text: `Skill "${args.name}" is not available for model invocation.` }
        if (skill.content.trim().length === 0) {
          return { text: `Skill "${args.name}" has no loadable body.` }
        }
        // Queue the skill content as a non-waking next-step context message,
        // exactly like dsh-tool-skill's invocation injection.
        agent.inject({
          id: `skill-load-${args.name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: renderSkillContent(skill) }],
          source: { kind: 'skill-invocation', name: args.name, form: 'instructions' },
        })
        return { text: `Skill "${args.name}" loaded; its instructions will be injected for the next request.` }
      } catch (error) {
        return { text: `skill_load failed: ${String((error && error.message) || error)}` }
      }
    },
  })
}
