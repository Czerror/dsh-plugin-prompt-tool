import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ResolvedToolSet, ToolActivationContext, ToolBatchInput } from '@deepseek-ai/dsh-tools'
import { associateToolStep, hasToolStep, toolStepOf, toolSurfaceNames, type ToolStep } from '../../engine/tool-scope.mjs'

interface Options {
  knows(agent: Agent): boolean
  ensureFresh(agent: Agent): Promise<void>
  assemble(context: AssembleContext, invoke: () => Promise<PromptAssembly>): Promise<PromptAssembly>
  settle(assembly: PromptAssembly, context: AssembleContext): Promise<PromptAssembly>
}

/** 只适配公开服务；步骤集合拥有准入，裸装配只产生展示，不自动 resolve。 */
export function installToolStepAssembly(ctx: Context, options: Options): () => void {
  const wrappers = new WeakMap<ResolvedToolSet, ResolvedToolSet>()
  const snapshots = new WeakMap<ToolStep, PromptAssembly>()
  const settling = new WeakMap<ToolStep, Promise<PromptAssembly>>()
  const closes = new Set<() => void>()
  let active = true
  const unavailable = () => Object.assign(new Error('prompt-tool: tool step is pending or closed'), { code: 'TOOL_STEP_UNAVAILABLE' })
  const wrap = (original: ResolvedToolSet, context: ToolActivationContext): ResolvedToolSet => {
    const existing = wrappers.get(original)
    if (existing !== undefined) {
      if (toolStepOf(existing, context.agent) === undefined) throw new Error('prompt-tool: tool set belongs to another Agent')
      return existing
    }
    const step: ToolStep = { status: 'pending', modelSelection: context.modelSelection === undefined
      ? undefined : Object.freeze({ ...context.modelSelection }) }
    const wrapped: ResolvedToolSet = Object.freeze({
      view(scope: ScopeKey | undefined) {
        const admitted = original.view(scope)
        if (step.status === 'closed') return new Map()
        return step.allowed === undefined ? admitted : new Map([...admitted].filter(([name]) => step.allowed!.has(name)))
      },
      dispose() {
        if (step.status === 'closed') return
        step.status = 'closed'
        closes.delete(wrapped.dispose)
        original.dispose()
      },
    })
    wrappers.set(original, wrapped)
    wrappers.set(wrapped, wrapped)
    associateToolStep(original, wrapped, context.agent, step)
    closes.add(wrapped.dispose)
    return wrapped
  }
  const guard = ctx.inject(['tools'], child => {
    child.tools.guard(exec => {
      const step = toolStepOf(exec.toolSet, exec.agent)
      if (hasToolStep(exec.toolSet) && step?.status !== 'sealed') return unavailable().message
      if (step?.allowed !== undefined && exec.name !== 'run_code' && !step.allowed.has(exec.name)) return 'prompt-tool: tool is outside the sealed step'
      return undefined
    })
  })
  const off = ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if ((name !== 'tools' && name !== 'systemPrompt') || service === undefined) return service
    return new Proxy(service, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (name === 'tools' && property === 'resolve') return async (context: ToolActivationContext) => {
        if (!options.knows(context.agent)) return Reflect.apply(value, target, [context])
        context.signal.throwIfAborted()
        const captured = { ...context, modelSelection: context.modelSelection === undefined
          ? context.modelSelection : Object.freeze({ ...context.modelSelection }) }
        await options.ensureFresh(context.agent)
        context.signal.throwIfAborted()
        const original: ResolvedToolSet = await Reflect.apply(value, target, [captured])
        try {
          context.signal.throwIfAborted()
          if (!active) throw unavailable()
          return wrap(original, captured)
        } catch (error) { original.dispose(); throw error }
      }
      if (name === 'tools' && property === 'execute') return async (input: ToolBatchInput) => {
        const step = toolStepOf(input.toolSet, input.agent)
        if (hasToolStep(input.toolSet) && step?.status !== 'sealed') throw unavailable()
        return Reflect.apply(value, target, [input])
      }
      if (name !== 'systemPrompt' || property !== 'assemble') return value
      return async (context: AssembleContext = {}) => {
        const agent = context.agent
        if (agent === undefined || !options.knows(agent)) return Reflect.apply(value, target, [context])
        const wrapped = context.toolSet === undefined ? undefined : wrappers.get(context.toolSet)
        if (context.toolSet !== undefined && wrapped === undefined) throw new Error('prompt-tool: assemble requires a tool set from the adapted resolve')
        const step = toolStepOf(wrapped, agent)
        if (wrapped !== undefined && step === undefined) throw new Error('prompt-tool: tool set belongs to another Agent')
        try { context.signal?.throwIfAborted() } catch (error) { wrapped?.dispose(); throw error }
        if (step?.status === 'closed') throw unavailable()
        if (step?.status === 'sealed') return snapshots.get(step)!
        if (step !== undefined && settling.has(step)) return settling.get(step)!
        const run = async () => {
          try {
            context.signal?.throwIfAborted()
            if (step === undefined) await options.ensureFresh(agent)
            const captured = { ...context, ...(step === undefined ? {} : { toolSet: wrapped, modelSelection: step.modelSelection }) }
            const result = await options.assemble(captured, () => Reflect.apply(value, target, [captured]))
            captured.signal?.throwIfAborted()
            const final = await options.settle(result, captured)
            captured.signal?.throwIfAborted()
            if (step !== undefined) {
              if (step.status === 'closed') throw unavailable()
              step.allowed = toolSurfaceNames(final)
              step.status = 'sealed'
              snapshots.set(step, final)
            }
            return final
          } catch (error) { wrapped?.dispose(); throw error }
        }
        const result = run()
        if (step !== undefined) settling.set(step, result)
        return result
      }
    } })
  }, { global: true })
  return () => { active = false; off(); void guard.dispose(); for (const close of closes) close() }
}
