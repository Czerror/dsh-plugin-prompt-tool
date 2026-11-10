import { associateToolStep, associateToolSelection, associateToolAssembly, beginToolCatalog, settleToolCatalog, toolAssemblyContext, hasToolStep, toolStepOf } from './tool-scope.mjs'
import { toolDependenciesReady } from './tool-definition.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { applySubagentDepthContexts } from './subagent-params.mjs'
import { applyAcceptedContextReplacements } from './actions/assembly.mjs'

const installations = new WeakMap()
const guardedRoots = new WeakSet()
const unavailable = () => Object.assign(new Error('prompt-tool: tool step is pending or closed'), { code: 'TOOL_STEP_UNAVAILABLE' })
const guardToolStep = exec => {
  const step = toolStepOf(exec.toolSet, exec.agent)
  if (hasToolStep(exec.toolSet) && step?.status !== 'sealed') return unavailable().message
  if (step?.allowed !== undefined && exec.name !== 'run_code' && !step.allowed.has(exec.name)) return 'prompt-tool: tool is outside the sealed step'
  return undefined
}

/** 多个真实装配入口共用一个公开服务适配，集合只封存一次。 */
export function installToolStepAssembly(ctx, options) {
  const root = ctx.root
  if (!guardedRoots.has(root)) {
    guardedRoots.add(root)
    // 已发行集合可被原服务保留；唯一拒绝闸随 root 释放，只读取弱关联步骤。
    root.inject(['tools'], child => { child.tools.guard(guardToolStep) })
  }
  let installation = installations.get(root)
  if (installation === undefined) {
    installation = createInstallation(root)
    installations.set(root, installation)
  }
  installation.owners.add(options)
  return () => {
    if (!installation.owners.delete(options)) return
    if (installation.owners.size !== 0) return
    installation.dispose()
    installations.delete(root)
  }
}

function createInstallation(ctx) {
  const owners = new Set()
  const wrappers = new WeakMap()
  const snapshots = new WeakMap()
  const settling = new WeakMap()
  const closes = new Set()
  const calls = new AsyncLocalStorage()
  let active = true
  const offExecute = ctx.on('tools/execute', (exec, next) => calls.run(exec, next), { global: true, prepend: true })
  const selected = agent => [...owners].filter(owner => owner.knows(agent))
  const wrap = (original, context, tools) => {
    const existing = wrappers.get(original)
    if (existing !== undefined) {
      if (toolStepOf(existing, context.agent) === undefined) throw new Error('prompt-tool: tool set belongs to another Agent')
      return existing
    }
    const step = { status: 'pending', modelSelection: context.modelSelection === undefined
      ? undefined : Object.freeze({ ...context.modelSelection }) }
    const wrapped = Object.freeze({
      view(scope) {
        const admitted = new Map([...original.view(scope)].filter(([, definition]) => toolDependenciesReady(tools, definition, context.agent, original)))
        if (step.status === 'closed') return new Map()
        return step.allowed === undefined ? admitted : new Map([...admitted].filter(([name]) => step.allowed.has(name)))
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
    step.toolSet = wrapped
    associateToolStep(original, wrapped, context.agent, step)
    closes.add(wrapped.dispose)
    return wrapped
  }
  const off = ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if ((name !== 'tools' && name !== 'systemPrompt' && name !== 'subagents') || service === undefined) return service
    return new Proxy(service, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (name === 'subagents' && property === 'startActivation') return spec => {
        const exec = calls.getStore()
        const step = exec === undefined ? undefined : toolStepOf(exec.toolSet, exec.agent)
        const entry = step?.subagentParams?.find(entry => entry.tool === exec.name && entry.provider === spec.provider)
        if (entry === undefined || spec.request?.parent !== exec.agent) return Reflect.apply(value, target, [spec])
        if (step.status !== 'sealed') throw unavailable()
        exec.signal.throwIfAborted()
        if (target.getProvider(spec.provider)?.capabilities?.depthLimit !== true) throw new Error('prompt-tool: delegation provider no longer supports depth limits')
        return Reflect.apply(value, target, [{ ...spec, request: { ...spec.request, maxDepth: entry.maxDepth } }])
      }
      if (name === 'tools' && property === 'resolve') return async context => {
        const current = selected(context.agent)
        if (current.length === 0) return Reflect.apply(value, target, [context])
        context.signal.throwIfAborted()
        const captured = { ...context, modelSelection: context.modelSelection === undefined
          ? context.modelSelection : Object.freeze({ ...context.modelSelection }) }
        for (const owner of current) await owner.ensureFresh(context.agent)
        context.signal.throwIfAborted()
        const original = await Reflect.apply(value, target, [captured])
        try {
          context.signal.throwIfAborted()
          if (!active) throw unavailable()
          const wrapped = wrap(original, captured, target)
          associateToolSelection(context.modelSelection, context.agent, toolStepOf(wrapped, context.agent))
          return wrapped
        } catch (error) { original.dispose(); throw error }
      }
      if (name === 'tools' && property === 'execute') return async input => {
        const step = toolStepOf(input.toolSet, input.agent)
        if (hasToolStep(input.toolSet) && step?.status !== 'sealed') throw unavailable()
        return Reflect.apply(value, target, [input])
      }
      if (name === 'systemPrompt' && property === 'refreshContext') return (assembly, context = {}) => {
        const captured = toolAssemblyContext(assembly, context)
        if (captured === undefined) throw unavailable()
        const step = toolStepOf(captured.toolSet, captured.agent)
        const refreshed = applyAcceptedContextReplacements(applySubagentDepthContexts(Reflect.apply(value, target, [assembly, captured]), captured, step), step)
        if (step !== undefined) associateToolAssembly(refreshed, captured.agent, step)
        return refreshed
      }
      if (name !== 'systemPrompt' || property !== 'assemble') return value
      return async (context = {}) => {
        const agent = context.agent
        const current = agent === undefined ? [] : selected(agent)
        if (current.length === 0) return Reflect.apply(value, target, [context])
        const wrapped = context.toolSet === undefined ? undefined : wrappers.get(context.toolSet)
        if (context.toolSet !== undefined && wrapped === undefined) throw new Error('prompt-tool: assemble requires a tool set from the adapted resolve')
        const step = toolStepOf(wrapped, agent)
        if (wrapped !== undefined && step === undefined) throw new Error('prompt-tool: tool set belongs to another Agent')
        try { context.signal?.throwIfAborted() } catch (error) { wrapped?.dispose(); throw error }
        if (step?.status === 'closed') throw unavailable()
        if (step?.status === 'sealed') return snapshots.get(step)
        if (step !== undefined && settling.has(step)) return settling.get(step)
        const run = async () => {
          try {
            context.signal?.throwIfAborted()
            if (step === undefined) for (const owner of current) await owner.ensureFresh(agent)
            const captured = { ...context, ...(step === undefined ? {} : { toolSet: wrapped, modelSelection: step.modelSelection }) }
            beginToolCatalog(captured)
            const invoke = index => index === current.length
              ? Reflect.apply(value, target, [captured]) : current[index].assemble(captured, () => invoke(index + 1))
            let final = await invoke(0)
            for (const owner of current) {
              captured.signal?.throwIfAborted()
              final = await owner.settle(final, captured)
            }
            final = applySubagentDepthContexts(final, captured, step)
            captured.signal?.throwIfAborted()
            await settleToolCatalog(final, captured)
            captured.signal?.throwIfAborted()
            if (step !== undefined) {
              if (step.status === 'closed') throw unavailable()
              step.allowed ??= new Set(wrapped.view(agent).keys())
              if (step.contextReplacements !== undefined) Object.freeze(step.contextReplacements)
              step.status = 'sealed'
              snapshots.set(step, final)
              associateToolAssembly(final, agent, step)
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
  return { owners, dispose() { active = false; off(); offExecute(); for (const close of closes) close() } }
}
