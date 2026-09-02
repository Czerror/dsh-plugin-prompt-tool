/**
 * subagent-tool-policy — agent-scoped subagent/subagent_fork shadow 工具。
 *
 * 策略启用时，本模块在每个 Agent scope 注册同名 shadow 工具（agent-local 注册
 * 遮蔽预设层官方 @deepseek-ai/dsh-tool-subagent），模型参数扩展实例级工具授权：
 *   tool_profile / character_id / task_type / additional_tools / restrict_tools。
 * 实例工具集在子代理创建窗口经官方 SubagentStartRequest.toolFilter 冻结并生效，
 * 不热更新；未启用策略的预设完全不注册本模块（官方 delegation 原行为）。
 *
 * 只调用公开 seam：
 *   - 创建：ctx.subagents.start(provider, request) / startContinuable(...)；
 *   - 工具面：ctx.tools.schemas(agent)（presetAvailable 过滤）；
 *   - 扩权批准：ctx.get('approval')（无批准通道 fail closed）。
 * provider 不支持 toolFilter / agentOptions / depthLimit 时启动前 fail loud，
 * 不做 prompt-only 假过滤。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'
import {
  buildSubagentToolParameters,
  compileSubagentToolPolicy,
  resolveSubagentToolPolicy,
} from './subagent-tool-policy-core.mjs'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'subagent-tool-policy'

export const inject = ['subagents', 'tools']

/** 官方 subagent 工具基础参数（spawn 开放 provider/model/reasoning_effort；fork 不开放）。 */
const BASE_PARAMETERS = {
  description: { type: 'string', description: '被委派任务的简短说明（展示用）' },
  prompt: { type: 'string', description: '子代理用户消息内容' },
  run_in_background: { type: 'boolean', description: '后台可续跑，立即返回 durable 子代理 id' },
}
const SPAWN_PARAMETERS = {
  provider: { type: 'string', description: '子代理 LLM provider 路由（与 model 成对）' },
  model: { type: 'string', description: '子代理模型 id（与 provider 成对）' },
  reasoning_effort: { type: 'string', description: '子代理推理强度' },
}

/** 解析策略文件路径（config.policyFile 相对本模块位置 = 预设目录）。 */
function resolvePolicyFile(config) {
  const raw = typeof config?.policyFile === 'string' && config.policyFile.length > 0
    ? config.policyFile
    : '../subagent-tools/policy.yml'
  return fileURLToPath(new URL(raw, import.meta.url))
}

/** 读取并编译策略；文件缺失/非法时 warn 并返回 undefined（模块挂载即禁用）。 */
function loadCompiledPolicy(config) {
  try {
    const raw = readFileSync(resolvePolicyFile(config), 'utf8')
    const parsed = parseYaml(raw, { logLevel: 'silent' })
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('policy.yml must be a YAML map')
    }
    return compileSubagentToolPolicy(parsed)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 扩权批准门：requireApproval 且 additional_tools 非空时先批准；无批准通道 fail closed。 */
async function expansionApproval(ctx, run, toolName, reason) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    return { ok: false, message: `tool ${toolName} requests additional_tools, but no approval channel is available` }
  }
  if (run.agent === undefined) {
    return { ok: false, message: `tool ${toolName} requests additional_tools, but the call has no agent` }
  }
  const outcome = await approval.request({
    agent: run.agent,
    toolName,
    callId: run.callId,
    reason,
    signal: run.signal,
  })
  if (outcome === 'allowed-once') return { ok: true }
  return { ok: false, message: `approval for ${toolName} additional_tools was ${outcome}` }
}

/** 构建一个 shadow 工具（spawn 或 fork）。 */
function createShadowTool(ctx, compiled, kind, config) {
  const toolName = kind === 'fork' ? 'subagent_fork' : 'subagent'
  const provider = typeof config?.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn'
  const backgroundMode = config?.backgroundMode === 'one-shot' ? 'one-shot' : 'continuable'
  const policyParameters = buildSubagentToolParameters(compiled)
  const properties = {
    ...BASE_PARAMETERS,
    ...(kind === 'spawn' ? SPAWN_PARAMETERS : {}),
    ...policyParameters,
  }
  return {
    name: toolName,
    description: `创建一个子代理执行委派任务。子代理工具权限由 subagentToolPolicy 实例级解析并冻结：`
      + `tool_profile/character_id/task_type 选择工具档，additional_tools 在用户配置上限内扩权，`
      + `restrict_tools 进一步收紧；实例创建后不再改变。`,
    parameters: { type: 'object', properties, required: ['description', 'prompt'] },
    output: { schema: { type: 'object', additionalProperties: true } },
    execute: async (args, run) => {
      const request = args ?? {}
      const tools = ctx.tools
      if (tools === undefined || typeof tools.schemas !== 'function') {
        return { ok: false, error: 'no tool runtime is available for policy resolution' }
      }
      // presetAvailable = 当前 Agent 实际可见工具（继承面）；有效集与 ceiling 交集。
      const visible = tools.schemas(run.agent).map((schema) => schema.name)
      const resolved = resolveSubagentToolPolicy(compiled, request, visible)
      if (resolved.additionalTools.length > 0 && compiled.expansion.requireApproval) {
        const gate = await expansionApproval(ctx, run, toolName,
          `subagent ${toolName}: profile=${resolved.profileId}, additional_tools=[${resolved.additionalTools.join(', ')}], effective=[${resolved.effectiveTools.join(', ')}]`)
        if (!gate.ok) return { ok: false, error: gate.message }
      }
      const subagents = ctx.subagents
      if (subagents === undefined || typeof subagents.start !== 'function') {
        return { ok: false, error: 'no subagents runtime is available' }
      }
      const childProvider = subagents.getProvider(provider)
      const capabilities = childProvider?.capabilities
      if (capabilities?.toolFilter !== true) {
        return { ok: false, error: `provider ${provider} does not support per-child toolFilter; instance tool policy unavailable (fail loud)` }
      }
      if (run.agent === undefined) {
        return { ok: false, error: 'no active agent for subagent start' }
      }
      const startRequest = {
        label: typeof request.description === 'string' ? request.description : toolName,
        prompt: [{ type: 'text', text: String(request.prompt ?? '') }],
        parent: run.agent,
        signal: run.signal,
        toolFilter: { allow: resolved.effectiveTools },
        ...(kind === 'spawn' && (typeof request.provider === 'string' || typeof request.model === 'string')
          ? { agentOptions: { ...(typeof request.provider === 'string' ? { provider: request.provider } : {}), ...(typeof request.model === 'string' ? { model: request.model } : {}) } }
          : {}),
        ...(typeof config?.maxDepth === 'number' ? { maxDepth: config.maxDepth } : {}),
      }
      let runHandle
      let durableId
      try {
        if (request.run_in_background !== false && backgroundMode === 'continuable') {
          const child = await subagents.startContinuable({ provider, label: startRequest.label, request: startRequest })
          durableId = child.sessionId
          runHandle = child
        } else {
          runHandle = await subagents.start(provider, startRequest)
          durableId = runHandle.sessionId
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (request.run_in_background !== false && backgroundMode === 'continuable') {
        return {
          ok: true,
          value: {
            kind: 'continuable',
            subagentId: String(durableId ?? ''),
            policy: {
              profile: resolved.profileId,
              characterId: resolved.characterId ?? null,
              taskType: resolved.taskType ?? null,
              additionalTools: resolved.additionalTools,
              effectiveTools: resolved.effectiveTools,
            },
          },
        }
      }
      try {
        const result = await runHandle.settled()
        const policySummary = {
          profile: resolved.profileId,
          characterId: resolved.characterId ?? null,
          taskType: resolved.taskType ?? null,
          additionalTools: resolved.additionalTools,
          effectiveTools: resolved.effectiveTools,
        }
        return { ok: true, value: { result, policy: policySummary } }
      } finally {
        try { await runHandle.dispose?.() } catch { /* 运行已结束，忽略 */ }
      }
    },
  }
}

/** 插件入口：为每个 Agent scope 注册 shadow 工具。 */
export function apply(ctx, config) {
  const loaded = loadCompiledPolicy(config)
  if ('error' in loaded) {
    ctx.logger?.warn(`${name}: cannot load subagent tool policy: ${loaded.error}; module disabled`)
    return
  }
  const compiled = loaded
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent.ctx === undefined) return
    agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.tools.register(createShadowTool(ctx, compiled, 'spawn', config)),
        agent.ctx.tools.register(createShadowTool(ctx, compiled, 'fork', config)),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, `${name}: ${agent.sessionId ?? 'agent'} shadow`)
  })
}