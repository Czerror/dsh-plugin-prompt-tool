/**
 * Anchored tool bootstrap — keep the FIRST model request on the Minimal
 * preset's REAL tool schema (persistent `bash` + `str_replace_editor`), then
 * keep the assembled catalog once the session has produced its first durable
 * promotion signal. Code Mode (PTC) wire presentation lives in the companion
 * `promoted-code-mode` plugin (mounted as a separate row), not here.
 * Injected-context control lives in the companion `context-gate` plugin.
 *
 * GATE MODE (strict two-phase stabilization extension, source: xiaobright/dsh-anchored-standard
 * MIT + phase-1 quarantine): `promoteGate: true` gates the promotion on the
 * first reasoning block classifying minimal-like (`we` present, no `let me`),
 * `maxPromoteSteps`（门控回退步数，来自配置）是门控兜底，且
 * `promoteAfterFirstResponse: true` promotes a tool-less first response and
 * releases an anchor-gated session at its first `turn/end`.
 * `personaSectionsOnly: true` narrows phase-1 prompt sections to the persona
 * (plan-mode policy and other sections return after promotion);
 * `workspaceLine: true` appends the session's working directory to the
 * promoted persona; `phase1FirstCallInstruction` is an opt-in extra line
 * appended to the phase-1 persona (test builds, issue #274) — unset keeps
 * the exact one-line Minimal anchor.
 *
 * STAGES MODE (渐进披露, 参考 dsh-router-standard progressive disclosure 自写,
 * MIT): `stages: [{ name, tools }]` 声明时激活多级阶段窄化——目录 = 当前阶段
 * 工具 + 预放（stagePreUnlock 档，来自配置）+ 本模块注册的推进工具（R8：它不在
 * stages 声明里，但 {{advanceTool}} 提示要求模型调用它，因此必须同源可见）；
 * `stageAdvanceTool`（推进工具名来自配置）推进阶段；调用更高阶段工具 = 直达
 * （自动跳到其档）；阶段
 * 状态由 durable tool/call 事件推导（resume/reload 自动恢复，无文件），
 * compaction 不重置（阶段是会话级进度）。阶段文案经 `stageSectionTemplate`
 * 参数化（引擎只提供动态状态，不写死引导文本）。stages 与 promoteOn 门控
 * 互不影响：阶段窄化从首轮开始，晋升/compaction 仍由 context-gate 管注入。
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and later requests keep the
 * assembled catalog. The original `'tool-call'` mode is kept for compatibility,
 * but it can trap a session in bootstrap forever when the first model reply
 * makes no tool call — the `'either'` default removes that trap while keeping
 * the first-request anchor intact.
 *
 * First-request conditions established by the reproduction work (issues #6
 * and #11, 2026-08-15):
 *
 *  1. Tool schema. The API-visible first-request catalog decides whether the
 *     session anchors on the Minimal trajectory. At the adapter-default
 *     maxTokens (256000 on the official endpoint) the Minimal tool pair —
 *     persistent `bash` + `str_replace_editor` — anchored 5/5 runs with zero
 *     `let me` first-lines, while every standard-family schema (pwsh/read,
 *     pwsh only, sandboxed bash/read) fell into standard-like behavior
 *     (11/11). Bootstrap therefore exposes exactly the Minimal pair, not
 *     Standard's `pwsh`/`read`.
 *
 *  2. Output budget. On the official endpoint the first request's `max_tokens`
 *     also dominated the trajectory anchor at 1024 (`We need` style in 26/32
 *     runs against 0/5 at 256000, independent of tool descriptions). The
 *     Minimal tool schema, however, anchors at 256000 WITHOUT any cap, and the
 *     cap's delivery depends on the profile package's `prepareCall` behavior
 *     (it reaches the request on the 0.1.0-rc.5 source checkout; a prebuilt
 *     rc.6-reporting profile package observed in issue #11 overwrote it with
 *     `adapterDefaults.maxTokens`). `bootstrapMaxTokens` is therefore OPT-IN:
 *     leave it unset to run the Minimal schema at the adapter default, or set
 *     it to cap the first request. When set, the cap is stripped after
 *     promotion — the next request's seed proposal carries the previous
 *     header's maxTokens forward, so the release must be explicit.
 *
 *  3. Injected context is NOT this plugin's concern: the companion
 *     `context-gate` plugin (shared/context-gate.mjs, mounted as the FIRST
 *     row) owns the unified injection control — runtime-context suppression
 *     on the assembly path and a claimed-baseline deny on the pre-step
 *     waterfall, both keyed to the same epoch-aware promotion phase. Mount it
 *     separately for context control alone; this file narrows only the tool
 *     catalog (plus the optional output cap below).
 *
 * SUBAGENTS: `includeSubagents` (default false) controls whether subagents
 * (delegationDepth > 0) follow the same bootstrap phase as the main session —
 * false (default) keeps the assembled catalog from their very first request
 * (the historical prompt-tool default: delegated agents inherit the full
 * tool surface); true makes their first request see the bootstrap pair and
 * their own first reply or tool call promotes them. Keep in sync with the
 * context-gate row's flag when both rows are present.
 *
 * POST-PROMOTION CATALOG (prompt-tool patch): after promotion both modes
 * keep the assembled catalog (no narrowing). The controlled phase below
 * still narrows the catalog before promotion and after compaction.
 * COMPACTION (local addition): a successful compaction rewrites the whole surface, so the
 * first post-compaction request is a "second first request". Promotion is
 * epoch-aware (see compaction-epoch.mjs): after a successful `compaction/end` the session
 * falls back to the controlled phase — the bootstrap pair plus
 * `compactionTools` (a core work set, default none) — until a NEW durable
 * promotion signal exists past that boundary. The model is mid-task and needs
 * to keep working, but still faces a small catalog instead of the full
 * Standard set.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - Subagents keep the assembled catalog unless `includeSubagents: true`.
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - Invalid config (bad tool lists, unknown `promoteOn`, malformed flags,
 *    non-positive `bootstrapMaxTokens`) fails at apply time, i.e. at preset
 *    mount, where it is visible and fixable.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { booleanOption, createWarnOnce, parsePromoteOn, requiredInt, requiredText, sessionEvents, sessionState, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Keep this row right AFTER the context-gate row in agent.cordis.yml:
 * waterfall after-next transforms apply in reverse registration order, so the
 * tool filter here must register before any plugin that touches the same
 * assembly. The optional budget listener registers with `prepend: true` so a
 * later listener can never override the first-round cap after we set it.
 */
export const inject = []

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools',
  'includeSubagents',
  'promoteGate', 'maxPromoteSteps', 'promoteAfterFirstResponse',
  'personaSectionsOnly', 'workspaceLine', 'phase1FirstCallInstruction',
  'stages', 'stagePreUnlock', 'stageAdvanceTool', 'stageAdvanceDescription', 'stageSectionTemplate',
])

/** 预设 persona section 名（官方注册名；旧名由 scripts/migrate-presets.mjs 离线迁移）。 */
const PERSONA_SECTION_NAMES = new Set(['deployment:persona-prefix', 'deployment:persona-suffix'])

/** 晋升后 persona 附加的工作目录行前缀。 */
const WORKSPACE_LINE_PREFIX = '\n\nYour working directory is '


/** Non-empty string list config validator. */
function stringList(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || (value.length === 0 && !allowEmpty) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

/** 阶段定义校验：非空数组，每项 { name: string, tools: 非空字符串数组 }。 */
function stageDefs(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of { name, tools }`)
  }
  return value.map((stage, index) => {
    const label = `${field}[${index}]`
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new TypeError(`${name}: ${label} must be an object`)
    }
    if (typeof stage.name !== 'string' || stage.name.length === 0) {
      throw new TypeError(`${name}: ${label}.name must be a non-empty string`)
    }
    const tools = stringList(stage.tools, `${label}.tools`)
    return { name: stage.name, tools }
  })
}


/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * stages 声明时必填的机制字段：缺键 / 类型错 / 空值一律 fail loud。
 * 默认值（推进工具名、工具描述、状态文案）归模板与预设，引擎不内置。
 */
function requiredStageField(field, value, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name}: ${field} is required when stages is declared — 默认值归模板/预设，请在本预设或组合源提供`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const promoteGate = source.promoteGate === true
  const promoteAfterFirstResponse = source.promoteAfterFirstResponse === true
  // 门控模式（promoteGate / promoteAfterFirstResponse）固定 either 晋升语义，
  // promoteOn 显式非 either 时与门控互斥，fail loud 而非静默忽略。
  if ((promoteGate || promoteAfterFirstResponse)
    && source.promoteOn !== undefined && source.promoteOn !== 'either') {
    throw new TypeError(`${name}: promoteGate/promoteAfterFirstResponse 门控模式固定 either 晋升语义，promoteOn 必须省略或为 "either"`)
  }
  // bootstrapTools 允许空数组 = 零工具模式（上游 zero-tool-bootstrap 等价：
  // 首请求 tools: [] 产生最深 "we" 轨迹，assistant/message 后晋升）。
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools', true)
  // 门控晋升的步数兜底归模板/预设：开启门控时必须给出，缺失即 fail loud（不再内置默认 4）。
  const maxPromoteSteps = promoteGate || promoteAfterFirstResponse
    ? requiredInt(name, source.maxPromoteSteps, 'maxPromoteSteps', 1)
    : source.maxPromoteSteps
  const promoteEvents = parsePromoteOn(name, source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const personaSectionsOnly = booleanOption(name, source.personaSectionsOnly, 'personaSectionsOnly', false)
  const workspaceLine = booleanOption(name, source.workspaceLine, 'workspaceLine', false)
  const phase1FirstCallInstruction = typeof source.phase1FirstCallInstruction === 'string'
    ? source.phase1FirstCallInstruction
    : ''
  // 渐进披露（stages 模式）：声明时激活多级阶段窄化，替代"两相"窄化语义。
  // 阶段机制字段（预放档、推进工具名、工具描述、状态文案）随 stages 一并必填。
  const stages = stageDefs(source.stages, 'stages')
  const stagePreUnlock = stages === undefined ? undefined : requiredInt(name, source.stagePreUnlock, 'stagePreUnlock', 0)
  const stageAdvanceTool = stages === undefined ? undefined : requiredStageField('stageAdvanceTool', source.stageAdvanceTool)
  const stageAdvanceDescription = stages === undefined
    ? undefined
    : requiredStageField('stageAdvanceDescription', source.stageAdvanceDescription)
  // 空串 = 不注入阶段状态 section，是合法取值，故允许为空。
  const stageSectionTemplate = stages === undefined
    ? undefined
    : requiredStageField('stageSectionTemplate', source.stageSectionTemplate, true)
  // 工具名 → 阶段索引（直达语义查询表）。
  const toolStage = new Map()
  if (stages !== undefined) {
    stages.forEach((stage, index) => {
      for (const tool of stage.tools) toolStage.set(tool, index)
    })
  }
  /**
   * 当前阶段条目（`sessionState`：统一访问接口，策略逐条声明）。
   *
   * 键类型 `session.id`；淘汰策略超限 `clear()` 全清（与迁移前的 `sessionMapGet` 同档：
   * 写入前 size 达上限就清空整个容器，只触发一次冷扫重建）；**不声明复位**——阶段是
   * 会话级进度、由 durable tool/call 事件推导，**compaction 不重置**（B4 T2 的 `stage`
   * 字段级声明；同模块的 `promotion` 字段相反，它订阅复位，由 compaction-epoch 自己管）。
   *
   * 读只用 `peek`：`get` 会在无条目时写入一个 0，让 `currentStage` 跳过冷扫，与迁移前
   * 的读法（`map.get() ?? scanStage()`）不等价。`() => 0` 只是接口要求的缺省工厂。
   */
  const stageState = sessionState(ctx, () => 0)
  /** 从 tool/call 事件提取工具名（兼容 source.tool / toolName / name 形状）。 */
  const toolNameOf = (event) => {
    const data = event?.data
    if (data === null || typeof data !== 'object') return ''
    const message = data.message !== null && typeof data.message === 'object' ? data.message : data
    if (message === null || typeof message !== 'object') return ''
    if (typeof message?.source?.tool === 'string') return message.source.tool
    if (typeof message?.toolName === 'string') return message.toolName
    if (typeof message?.name === 'string') return message.name
    return ''
  }
  const advanceStage = (session, toolName) => {
    if (stages === undefined) return
    const current = stageState.peek(session) ?? 0
    if (toolName === stageAdvanceTool) {
      // `set` 内部先淘汰后写入，与旧代码的「先 cap 再 set」同序。
      stageState.set(session, Math.min(current + 1, stages.length - 1))
      return
    }
    const owned = toolStage.get(toolName)
    if (owned !== undefined && owned > current) {
      stageState.set(session, owned)
    }
  }
  /** 冷启动：从 durable log 重建阶段（resume/reload 同相位）。 */
  const scanStage = (session) => {
    let stage = 0
    for (const event of sessionEvents(session)) {
      if (event?.type !== 'tool/call') continue
      const toolName = toolNameOf(event)
      if (toolName === stageAdvanceTool) stage = Math.min(stage + 1, stages.length - 1)
      else {
        const owned = toolStage.get(toolName)
        if (owned !== undefined && owned > stage) stage = owned
      }
    }
    stageState.set(session, stage)
    return stage
  }
  const currentStage = (session) => {
    if (stages === undefined) return 0
    if (session === undefined) return 0
    const entry = stageState.peek(session)
    return entry === undefined ? scanStage(session) : entry
  }
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')

  const promotion = createEpochPromotion(promoteEvents, {
    includeSubagents,
    promoteGate,
    promoteAfterFirstResponse,
    maxPromoteSteps,
  })

  ctx.on('session/event', (session, event) => promotion.observe(session, event))
  // 渐进披露：阶段推进/直达（stages 模式；durable 推导，compaction 不重置）。
  if (stages !== undefined) {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'tool/call') return
      advanceStage(session, toolNameOf(event))
    })
  }

  const warnOnce = createWarnOnce(ctx, name)

  /** 晋升后给 persona 追加工作目录行（无 persona/无 cwd/已含则原样返回）。 */
  const withWorkspaceLine = (assembly, agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return assembly
    if (!Array.isArray(assembly.sections)) return assembly
    const line = `${WORKSPACE_LINE_PREFIX}${cwd}.`
    const persona = assembly.sections.find((section) =>
      PERSONA_SECTION_NAMES.has(section?.name)
      && typeof section?.text === 'string'
      && !section.text.includes(line))
    if (persona === undefined) return assembly
    return {
      ...assembly,
      sections: assembly.sections.map((section) => section === persona
        ? { ...section, text: `${persona.text}${line}` }
        : section),
    }
  }

  /**
   * Narrow the assembled catalog to a keep-set; validate required names.
   * `required` 默认等于 keep 集合；阶段分支只把 stages 声明的工具交给它做缺失
   * 校验，本模块自注册的推进工具另行保留（见下方 R8 修复）。
   */
  const keepTools = (assembled, keep, missingAllowsFullCatalog, required = keep) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...required].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const agent = context.agent
      if (agent === undefined) return assembled
      if (agent.session === undefined) return assembled
      if ((agent.session?.header?.delegationDepth ?? 0) > 0 && !includeSubagents) {
        // 默认：子代理继承完整目录（历史 prompt-tool 默认）；
        // includeSubagents=true 时落到下方正常相位逻辑（首轮裁剪 + 晋升）。
        return assembled
      }
      if (stages !== undefined) {
        // 渐进披露：目录 = 当前阶段 + 预放档工具 + 本模块注册的推进工具；
        // 阶段 section 按模板注入（文案参数化）。
        const stage = currentStage(agent.session)
        const stageTools = new Set()
        const upper = Math.min(stage + stagePreUnlock, stages.length - 1)
        for (let i = 0; i <= upper; i += 1) {
          for (const toolName of stages[i].tools) stageTools.add(toolName)
        }
        // R8：推进工具不在 stages 声明里，但阶段提示按 {{advanceTool}} 要求模型调用它，
        // 因此注册、提示与目录裁剪必须同源于 stageAdvanceTool——否则推进工具被裁掉，
        // 模型既看不到它又被要求调用它（stagePreUnlock=0 时尤其致命）。
        // 它不参与阶段工具的缺失校验：已经不在装配目录里（被外层工具策略挡掉）时不复活，
        // 也不把阶段目录降级成完整目录，否则会把未授权的业务工具一起放开。
        const keep = new Set(stageTools)
        keep.add(stageAdvanceTool)
        let next = keepTools(assembled, keep, true, stageTools)
        if (stageSectionTemplate.length > 0) {
          const unlocked = stages
            .slice(0, upper + 1)
            .flatMap((s) => s.tools)
            .join(', ')
          const text = stageSectionTemplate
            .replaceAll('{{stage}}', String(stage + 1))
            .replaceAll('{{stageName}}', stages[stage].name)
            .replaceAll('{{unlocked}}', unlocked)
            .replaceAll('{{total}}', String(stages.length))
            .replaceAll('{{advanceTool}}', stageAdvanceTool)
          next = {
            ...next,
            sections: Array.isArray(next.sections)
              ? [...next.sections, { name: 'stage-status', text }]
              : [{ name: 'stage-status', text }],
          }
        }
        return next
      }
      const status = promotion.status(agent)
      if (status.promoted) {
        // prompt-tool patch: keep the assembled catalog after promotion
        // (Code Mode presentation is the companion promoted-code-mode row's job).
        return workspaceLine ? withWorkspaceLine(assembled, agent) : assembled
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue. Context control is
      // NOT here: the companion `context-gate` plugin owns it (see the header
      // note), so this filter touches only the tool catalog.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) {
        for (const toolName of compactionTools) keep.add(toolName)
        // 零工具模式：compaction 回退补 shell（对齐上游 zero-tool-bootstrap），
        // 否则 mid-task 模型无 shell 可用。
        if (bootstrapTools.length === 0) {
          const available = new Set(assembled.tools.map((tool) => tool.name))
          for (const toolName of ['bash', 'pwsh']) if (available.has(toolName)) keep.add(toolName)
        }
      }
      let next = keepTools(assembled, keep, true)
      if (personaSectionsOnly) {
        // Phase-1 提示词段只留 persona（plan-mode 策略等晋升后才恢复）。
        const sections = Array.isArray(next.sections)
          ? next.sections.filter((section) => PERSONA_SECTION_NAMES.has(section?.name))
          : undefined
        if (sections !== undefined) {
          const phase1Sections = phase1FirstCallInstruction === ''
            ? sections
            : sections.map((section) => {
                if (typeof section?.text !== 'string' || section.text.includes(phase1FirstCallInstruction)) return section
                return { ...section, text: `${section.text}${phase1FirstCallInstruction}` }
              })
          next = { ...next, sections: phase1Sections }
        }
      }
      return next
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // 渐进披露：阶段推进工具（stages 模式）。推进状态由事件流推导（observe），
  // 本工具只返回推进结果文案——绝不手改 state（durable 单一真相）。
  if (stages !== undefined) {
    ctx.tools.register({
      name: stageAdvanceTool,
      description: stageAdvanceDescription,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session
        if (session === undefined) return { text: 'phase_advance: no session context' }
        const stage = currentStage(session)
        const next = Math.min(stage + 1, stages.length - 1)
        const text = stage >= stages.length - 1
          ? `Already at the final stage (${stages[stage].name}) — all tools unlocked.`
          : `Advanced to stage ${next + 1}/${stages.length} (${stages[next].name}). Unlocked: ${stages[next].tools.join(', ')}.`
        return { text }
      },
    })
  }
}
