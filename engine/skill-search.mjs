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
import { currentEvents } from './history.mjs'
import { queryTokens, renderRows, rankRows, scoreRows } from './discovery.mjs'
import { DISCOVERY_SERVICE } from './service-names.mjs'

const { isModelInvocable, renderSkillContent } = await importHostPackage('@deepseek-ai/dsh-skill')

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

/** 参数 schema 由 `shared.mjs` 的统一实现生成（与 `tool-search` 同一份）。 */

/** 把查询切成小写 token（Unicode 字母数字与下划线连字符，与 tool-search 同口径）。 */
export { queryTokens }

/**
 * 对目录打分排序（纯函数，可单测）：
 * **完整命中是准入条件**（每个 token 都命中），精确名命中排最前；同为准入者按命中数、
 * 再按名字字典序。`wanted` 为空时返回空数组——调用方据此区分「没给查询」与「没搜到」。
 *
 * 准入用 AND 而不是「命中任意 token」：`代码 中文` 这类多词查询里，近似命中会把
 * 只沾一个词的无关技能一起倒出来（技能 description 很短，噪声占比远高于工具面）。
 */
export function scoreSkills(skills, wanted) {
  return rankRows(scoreRows(skills, wanted, {
    nameOf: (skill) => skill?.name,
    haystackOf: (skill) => `${skill?.name ?? ''} ${skill?.description ?? ''} ${skill?.whenToUse ?? ''}`,
  }), (row) => row.exact || row.score === wanted.length).map((row) => ({ ...row, skill: row.item }))
}

/** 搜索结果上限：再多就该让模型收窄关键词。 */
const MAX_RESULTS = 20

/** 把目录搜索结果渲染成给模型的文本（带截断提示与加载引导）。 */
export function renderMatches(scored, query, complete = true) {
  return renderRows(scored, {
    query,
    limit: MAX_RESULTS,
    noun: 'skills',
    emptyText: complete
      ? `No skills match "${query}" — no skill matched your keywords; skill_load still loads any exact name in the registry, and calling skill_search with no arguments lists every visible skill.`
      : `Skill discovery did not complete, so nothing can be concluded about "${query}". Retry skill_search before treating a skill as unavailable.`,
    lineOf: ({ skill, name, exact }) => `- ${name}${exact ? ' (exact)' : ''}: ${String(skill?.description ?? '').split('\n')[0]}`,
    warnings: complete ? [] : ['Skill discovery is incomplete; these results may be partial.'],
    footer: 'Load one with skill_load({"name": "<exact name>"}).',
  })
}

/**
 * 该技能是否已在本会话的**当前可见上下文**里注入过——去重按 `currentEvents()` 口径：
 * 压缩/位置替换遮蔽掉的注入不算「已加载」，下次 `skill_load` 仍会重新注入正文。
 * 官方 `/名字` 手势与 `skill_load` 写的是同一形状的 `skill-invocation` 事件，因此一并覆盖。
 */
export function skillLoadedInContext(session, name) {
  return currentEvents(session).some(event => event?.type === 'user/message'
    && event.data?.source?.kind === 'skill-invocation'
    && event.data.source.name === name)
}

/** 注册两个按需技能工具。 */
/**
 * 本模块**刻意保持单参形态**：它不读任何 config 键，因此没有白名单可声明。
 * B2 T4 要求「四个无白名单插件行补字段声明与校验」，本行按 PLAN 的例外处理——
 * 若将来需要 config，先确认组合行与调用方确实在传 config，再补 defineConfig 声明。
 */
export function apply(ctx, _config, options = {}) {
  const disposeSearch = ctx.tools.register({
    name: 'skill_search',
    description: [
      'Search the available skills by keyword and return matching skill names with short descriptions.',
      '',
      'skill_load loads any exact name in the registry, so a skill the search did not surface still loads by its name.',
      '',
      'Usage:',
      '- `query` — search skill names and descriptions (Chinese keywords work).',
      '- call with NO arguments — list every visible skill (truncation is marked with the matching total).',
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

  const disposeLoad = ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact registered name and inject them for the next request. Call this before acting on a task that matches the skill. The name may come from skill_search, from the skill list, or from the user — any exact name in the registry works, and when nothing matches, ask the user for it.',
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
        // 名字归一：非字符串与去空白后为空都算「没给名字」，与 tool_search 的
        // unlockNames 同口径。否则空串会落进「未注册」文案，调用方分不清是输入
        // 非法还是名字拼错——这两件事该做的事不同。
        const name = typeof args?.name === 'string' ? args.name.trim() : ''
        if (name.length === 0) {
          return { text: 'skill_load needs an exact skill name — call it with one, or run skill_search with no arguments to list every visible skill.' }
        }
        const options = {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        }
        const snapshot = await ctx.skills.snapshot(options)
        options.signal?.throwIfAborted()
        const summary = snapshot.skills.find((entry) => entry.name === name)
        if (summary === undefined) {
          // 名字错、发现没跑完、调用面缺 agent——三种成因的应对不同。
          return { text: snapshot.complete
            ? `No skill named "${name}" is registered for this session. Check the exact name against what skill_search lists, or ask the user for it.`
            : 'Skill discovery is incomplete, so the name could not be confirmed. Retry skill_load before concluding the skill does not exist.' }
        }
        if (!isModelInvocable(summary)) return { text: `Skill "${name}" is not available for model invocation.` }
        const skill = await ctx.skills.get(name, options)
        options.signal?.throwIfAborted()
        if (skill === undefined) {
          return { text: `Skill "${name}" is no longer available — it was registered but its body could not be loaded. Retry once, then run skill_search to see what is still registered.` }
        }
        // 去重：正文已在当前可见上下文里就不再注入（少一份重复 token）。
        // 只有「已加载且仍可见」才跳过——压缩遮蔽掉的注入不算已加载，见 skillLoadedInContext。
        // shortcut: 同一批次内连调两次 `skill_load` 时，第一次的注入尚未落入会话，去重看不到，
        // 会重复注入一份；跨批次重复才是常态，等真出现同批重复再按 step 消息判重。
        if (skillLoadedInContext(agent.session, name)) {
          return { text: `Skill "${name}" is already loaded in this context — its instructions are above (or earlier in this session), so nothing was injected again. Follow them without another load; if the user explicitly asks to reload it, let them re-send it as a /${name} gesture.` }
        }
        if (!isModelInvocable(skill)) return { text: `Skill "${name}" is not available for model invocation.` }
        if (skill.content.trim().length === 0) {
          return { text: `Skill "${name}" has no loadable body.` }
        }
        // Queue the skill content as a non-waking next-step context message,
        // exactly like dsh-tool-skill's invocation injection.
        agent.inject({
          id: `skill-load-${name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: renderSkillContent(skill) }],
          source: { kind: 'skill-invocation', name, form: 'instructions' },
        })
        return { text: `Skill "${name}" loaded; its instructions will be injected for the next request.` }
      } catch (error) {
        return { text: `skill_load failed: ${String((error && error.message) || error)}` }
      }
    },
  })
  const registry = typeof ctx.get === 'function' ? ctx.get(DISCOVERY_SERVICE) : undefined
  const disposeAdapter = registry === undefined ? undefined : registry.register(options.agent, 'skills', discoveryAdapter)
  return () => {
    if (typeof disposeAdapter === 'function') disposeAdapter()
    if (typeof disposeSearch === 'function') disposeSearch()
    if (typeof disposeLoad === 'function') disposeLoad()
  }
}

/** 本引擎向发现注册表提供的元数据：技能面没有「解锁名单」，只登记工具身份。 */
export const discoveryAdapter = Object.freeze({
  kind: 'skills',
  tool: 'skill_search',
})