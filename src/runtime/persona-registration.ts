/**
 * persona-registration — 人设段在运行时配装通道里的装载。
 *
 * 官方把 `deployment:persona-prefix/suffix` 设计成可替换槽位：同名段按 scope 链遮蔽、近者胜
 * （`@deepseek-ai/dsh-scope` 的 `ScopedLayers.merge`），只有**同一层内**重名才抛。于是本模块只做两件事：
 *   1. 计划：把所选来源模块的受众字段算成要在 Agent 自己 scope 注册的段落——遮蔽全局部署人设
 *      与预设挂在祖先 scope 的 persona 行，不必接管任何人的 fiber；
 *   2. 接住：在 AgentSetup 窗口内捕获同层已注册的同名段，供装配期先撤后挂（插件人设优先级最高）。
 *
 * 撤销即接管：被撤段落的文本与 complete 按「未声明即继承」并入我们的段落，释放后回落祖先声明，
 * 不回装被撤段落——同层声明一旦被接管，此后归属由本插件负责。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptSection, PromptSectionOrderName } from '@deepseek-ai/dsh-system-prompt'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { readPersonaSpec, type PersonaAudience, type PersonaSpec, type PersonaTargetSpec } from '../shared/persona-section.ts'
import { renderTemplate, type TemplateVariableStore } from '../../engine/template-frame.mjs'

/** 本插件接管的人设槽位；只有这两个名字参与捕获与遮蔽。 */
export const PERSONA_SECTION_NAMES = [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION] as const

export interface PersonaModule {
  moduleId: string
  persona?: PersonaSpec
  variablesEnabled?: boolean
}

/** 被接住的同层声明：`off` 撤销它，`section` 是被撤下的原对象。 */
export interface CapturedSection {
  name: string
  section: PromptSection
  off: () => void
}

export interface PersonaCapture {
  /** 该 scope 在 AgentSetup 窗口内注册的同名人设段，按注册顺序。 */
  records(scope: ScopeKey): readonly CapturedSection[]
  dispose(): void
}

/**
 * 只接住两个官方人设槽位，窗口是 `agents.create` / `agents.resume` 的 setup 回调。
 * 窗口之外（含本插件自己的装配注册）一律不捕获。
 */
export function installPersonaCapture(ctx: Context): PersonaCapture {
  // 弱引用：scope 释放后捕获记录随之回收，不随会话数增长。
  const records = new WeakMap<ScopeKey, CapturedSection[]>()
  const pending = new Set<ScopeKey>()
  let active = true
  const isPersonaSection = (name: string): boolean => (PERSONA_SECTION_NAMES as readonly string[]).includes(name)
  const stopPrompt = ctx.on('internal/get', (caller, name, _error, next) => {
    const service = next()
    const scope = scopeOf(caller)
    if (!active || name !== 'systemPrompt' || scope === undefined || !pending.has(scope)) return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'section') return method
        return (section: PromptSection) => {
          if (!active || !isPersonaSection(section.name)) return Reflect.apply(method, target, [section])
          const off = Reflect.apply(method, target, [section]) as () => void
          const list = records.get(scope)
          if (list === undefined) records.set(scope, [{ name: section.name, section, off }])
          else list.push({ name: section.name, section, off })
          return off
        }
      },
    })
  }, { global: true })
  const stopAgents = ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if (!active || name !== 'agents') return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'create' && property !== 'resume') return method
        return (options: CreateAgentOptions | ResumeAgentOptions) => Reflect.apply(method, target, [{
          ...options,
          setup: async (agentCtx: Context, agent: Agent) => {
            const scope = scopeOf(agentCtx)
            if (scope === undefined) return options.setup?.(agentCtx, agent)
            pending.add(scope)
            try { return await options.setup?.(agentCtx, agent) } finally { pending.delete(scope) }
          },
        }])
      },
    })
  }, { global: true })
  return {
    records: scope => records.get(scope) ?? [],
    dispose: () => { active = false; pending.clear(); stopPrompt(); stopAgents() },
  }
}

export interface PersonaPlanOptions {
  audience: PersonaAudience
  /** 已按受众过滤的来源模块；同一受众出现两个来源即 fail loud。 */
  modules: readonly PersonaModule[]
  /** 祖先层或同层已有的同名声明：未声明的字段、位置与 complete 从它继承。 */
  inherited: (name: string) => PromptSection | undefined
  /** 没有继承源时的段落位置。 */
  order: (name: PromptSectionOrderName) => number
  variableStore?: TemplateVariableStore
  warn?: (message: string) => void
}

export interface PersonaPlan {
  sections: readonly PromptSection[]
  suppressRuntimeContext: boolean
}

/**
 * 把来源模块的受众字段算成待注册段落：字段未声明就不产出该段（祖先声明原样生效）；
 * 只声明正文时，位置与 complete 继承已有声明；继承正文不被当作本插件模板重执行。
 */
export function planPersonaSections(options: PersonaPlanOptions): PersonaPlan {
  const { audience, modules, inherited, order, variableStore, warn } = options
  let owner: PersonaModule | undefined
  let spec: PersonaTargetSpec = {}
  for (const module of modules) {
    const target = readPersonaSpec(module.persona)?.[audience]
    if (target === undefined) continue
    if (owner !== undefined) throw new Error(`人设受众 ${audience} 有多个来源模块：${owner.moduleId}、${module.moduleId}`)
    owner = module
    spec = target
  }
  if (owner === undefined) return { sections: [], suppressRuntimeContext: false }
  const sections: PromptSection[] = []
  for (const [name, field] of [[PERSONA_PREFIX_SECTION, 'prefix'], [PERSONA_SUFFIX_SECTION, 'suffix']] as const) {
    const text = spec[field]
    const complete = field === 'prefix' ? spec.complete : undefined
    if (text === undefined && complete === undefined) continue
    const base = inherited(name)
    sections.push({
      name,
      order: base?.order ?? order(field === 'prefix' ? 'DEPLOYMENT_PERSONA_PREFIX' : 'DEPLOYMENT_PERSONA_SUFFIX'),
      ...(complete ?? base?.complete) === true ? { complete: true } : {},
      ...base?.interpolate === undefined ? {} : { interpolate: base.interpolate },
      ...text === undefined ? { text: base?.text ?? '' } : {
        text: (context: AssembleContext) => renderTemplate({
          sourceModuleId: owner!.moduleId, ruleId: 'persona', id: `persona-${audience}-${field}`, texts: [text],
        }, context, { variableStore, enabled: owner!.variablesEnabled !== false, warn }),
      },
    })
  }
  return { sections, suppressRuntimeContext: spec.includeRuntimeContext === false }
}
