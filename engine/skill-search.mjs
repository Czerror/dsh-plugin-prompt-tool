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
 * NOTE: this plugin REPLACES the `dsh-tool-skill` row in the composition —
 * the composition must NOT mount both, or the catalog injection returns.
 */
import { importHostPackage } from './host-package.mjs'

const { isModelInvocable, renderSkillContent } = await importHostPackage('@deepseek-ai/dsh-skill')

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

const MAX_RESULTS = 20

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Register the two on-demand skill tools. */
export function apply(ctx) {
  /** Normalize a query into lowercase tokens for simple substring matching. */
  const tokens = (text) => (text || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)

  ctx.tools.register({
    name: 'skill_search',
    description: 'Search the available skills by keyword and return matching skill names with short descriptions. This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, game reviews, markdown, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory.',
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: 'search keywords (e.g. "pdf", "obsidian", "game review")' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const wanted = tokens(args.query)
      const scope = exec?.agent ?? ctx
      try {
        const snapshot = await ctx.skills.snapshot({
          scope,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        exec?.signal?.throwIfAborted()
        const matches = snapshot.skills.filter(isModelInvocable).filter((skill) => {
          if (wanted.length === 0) return true
          const haystack = tokens(`${skill.name} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`).join(' ')
          return wanted.every((token) => haystack.includes(token))
        })
        const head = matches.slice(0, MAX_RESULTS)
        const lines = head.map((skill) => {
          const desc = (skill.description || '').split('\n')[0]
          return `- ${skill.name}: ${desc}`
        })
        if (lines.length === 0) return { text: snapshot.complete
          ? `No skills match "${args.query}". Use skill_search with other keywords.`
          : 'Skill discovery is incomplete. Retry skill_search before concluding no skills match.' }
        const extra = matches.length > MAX_RESULTS ? `\n…(${matches.length - MAX_RESULTS} more)` : ''
        const incomplete = snapshot.complete ? '' : '\nSkill discovery is incomplete; these results may be partial.'
        return { text: `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}${incomplete}\n\nLoad one with skill_load (exact name).` }
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error && error.message) || error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name (from skill_search results) and inject them for the next request. Call this before acting on a task that matches the skill.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, from skill_search)' },
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
          return { text: snapshot.complete
            ? `No skill named "${args.name}". Run skill_search to list available skills.`
            : 'Skill discovery is incomplete. Retry skill_search before loading this skill.' }
        }
        if (!isModelInvocable(summary)) return { text: `Skill "${args.name}" is not available for model invocation.` }
        const skill = await ctx.skills.get(args.name, options)
        options.signal?.throwIfAborted()
        if (skill === undefined) {
          return { text: `Skill "${args.name}" is no longer available. Run skill_search again.` }
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
