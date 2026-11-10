import { toolStepFor } from './tool-scope.mjs'

export function validateSubagentParams(action) {
  if (action.provider !== 'spawn') throw new TypeError('subagent-params.provider must be spawn')
  if (typeof action.tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(action.tool)) throw new TypeError('subagent-params.tool must be a tool name')
  if (!Number.isSafeInteger(action.maxDepth) || action.maxDepth < 0) throw new TypeError('subagent-params.maxDepth must be a non-negative safe integer')
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('subagent-params is prepared before assemble')
}

export function subagentParamsStatus(ctx, action, context, agent = context?.agent) {
  try {
    const step = toolStepFor(context, agent)
    const subagents = ctx.get('subagents')
    if (typeof subagents?.startActivation !== 'function' || subagents.getProvider?.(action.provider)?.capabilities?.depthLimit !== true) return { available: false, reason: '委派提供者未就绪或不支持深度限制' }
    const tools = ctx.get('tools')
    if (step == null || step.status === 'closed' || tools?.executable?.(action.tool, agent, step.toolSet) === undefined) return { available: false, reason: '当前步骤的委派工具不可用' }
    return { available: true }
  } catch { return { available: false, reason: '委派依赖读取失败' } }
}

/** 深度说明和执行共用已接受步骤；不读取另一 Agent 或后续保存值。 */
export function applySubagentDepthContexts(assembly, context, step) {
  if (!step?.subagentParams?.length || !Array.isArray(assembly.contexts)) return assembly
  let contexts = assembly.contexts
  for (const entry of step.subagentParams) {
    const name = `tool:${entry.tool}:depth`
    contexts = contexts.filter(item => item.name !== name)
    const depth = context.agent?.session?.header?.delegationDepth ?? 0
    if (depth >= entry.maxDepth) contexts.push({ name, order: entry.contextOrder,
      text: `Delegation depth for \`${entry.tool}\`: current ${depth}, maximum ${entry.maxDepth}, remaining levels 0. Do not call \`${entry.tool}\` at this depth; carry out the work directly.` })
  }
  return { ...assembly, contexts }
}
