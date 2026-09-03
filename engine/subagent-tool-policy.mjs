/**
 * subagent-tool-policy — agent-scoped subagent/subagent_fork shadow 工具。
 *
 * 本模块通过运行中 DSH 入口解析同一份 dsh-tools / dsh-scope，避免生成目录
 * 加载第二份 registry 类型。每个 shadow 只安装到当前 preset generation 的
 * descendant Agent；实例权限在 SubagentStartRequest 创建窗口冻结。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'
import {
  buildSubagentToolParameters,
  compileSubagentToolPolicy,
  resolveSubagentToolPolicy,
} from './subagent-tool-policy-core.mjs'

export const name = 'subagent-tool-policy'
export const inject = ['agents', 'subagents', 'tools']

const hostEntry = typeof process.argv[1] === 'string' && process.argv[1].length > 0
  ? process.argv[1]
  : fileURLToPath(import.meta.url)
const hostRequire = createRequire(hostEntry)
async function importHostPackage(id) {
  const resolved = hostRequire.resolve(id)
  return import(pathToFileURL(resolved).href)
}
const [{ ToolArgsError }, { scopeChainOf, scopeOf }] = await Promise.all([
  importHostPackage('@deepseek-ai/dsh-tools'),
  importHostPackage('@deepseek-ai/dsh-scope'),
])

const BASE_PARAMETERS = {
  description: { type: 'string', description: '被委派任务的简短说明（展示用）' },
  prompt: { type: 'string', description: '子代理用户消息内容' },
  run_in_background: { type: 'boolean', description: '后台可续跑，立即返回 durable 子代理 id' },
}
const SPAWN_PARAMETERS = {
  provider: { type: 'string', description: '子代理 LLM provider；与 model 成对提供' },
  model: { type: 'string', description: '子代理模型 id；与 provider 成对提供' },
  reasoning_effort: { type: 'string', description: '子代理推理强度' },
}

function resolvePolicyFile(config) {
  const raw = typeof config?.policyFile === 'string' && config.policyFile.length > 0
    ? config.policyFile
    : '../subagent-tools/policy.yml'
  return fileURLToPath(new URL(raw, import.meta.url))
}

function loadCompiledPolicy(config) {
  const raw = readFileSync(resolvePolicyFile(config), 'utf8')
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('policy.yml must be a YAML map')
  }
  return compileSubagentToolPolicy(parsed)
}

function providerFor(kind, config) {
  if (kind === 'fork') return typeof config?.forkProvider === 'string' && config.forkProvider.length > 0 ? config.forkProvider : 'fork'
  return typeof config?.spawnProvider === 'string' && config.spawnProvider.length > 0 ? config.spawnProvider : 'spawn'
}

function assertString(value, field, required = false) {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || value.length === 0) throw new ToolArgsError([`${field}: expected non-empty string`])
}

function validateShadowArgs(args, compiled, kind) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ToolArgsError(['arguments: expected object'])
  assertString(args.description, 'description', true)
  assertString(args.prompt, 'prompt', true)
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') {
    throw new ToolArgsError(['run_in_background: expected boolean'])
  }
  for (const field of ['tool_profile', 'character_id', 'task_type']) assertString(args[field], field)
  if (kind === 'spawn') {
    for (const field of ['provider', 'model', 'reasoning_effort']) assertString(args[field], field)
    if ((args.provider === undefined) !== (args.model === undefined)) {
      throw new ToolArgsError(['provider and model must be supplied together'])
    }
  }
  const properties = buildSubagentToolParameters(compiled)
  for (const field of ['tool_profile', 'character_id', 'task_type']) {
    if (args[field] !== undefined && !properties[field]?.enum?.includes(args[field])) {
      throw new ToolArgsError([`${field}: value is not model-selectable`])
    }
  }
  for (const field of ['additional_tools', 'restrict_tools']) {
    if (args[field] !== undefined && (!Array.isArray(args[field]) || args[field].some((item) => typeof item !== 'string' || item.length === 0))) {
      throw new ToolArgsError([`${field}: expected an array of non-empty strings`])
    }
  }
  if (args.additional_tools !== undefined) {
    if (properties.additional_tools === undefined) throw new ToolArgsError(['additional_tools: expansion is disabled'])
    if (args.additional_tools.length > compiled.expansion.maxAdditionalTools) {
      throw new ToolArgsError([`additional_tools: exceeds maxAdditionalTools (${compiled.expansion.maxAdditionalTools})`])
    }
    const invalid = args.additional_tools.filter((tool) => !properties.additional_tools.items.enum.includes(tool))
    if (invalid.length > 0) throw new ToolArgsError([`additional_tools: unauthorized tools ${invalid.join(', ')}`])
  }
}

async function expansionApproval(ctx, run, toolName, resolved) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new Error(`tool ${toolName} requests additional_tools, but no approval channel is available`)
  }
  const outcome = await approval.request({
    agent: run.agent,
    toolName,
    callId: run.callId,
    reason: `parent=${run.agent.id}; profile=${resolved.profileId}; character=${resolved.characterId ?? '-'}; task=${resolved.taskType ?? '-'}; additional=[${resolved.additionalTools.join(', ')}]; effective=[${resolved.effectiveTools.join(', ')}]`,
    signal: run.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(`approval for ${toolName} additional_tools was ${outcome}`)
}

function configuredAgentOptions(config) {
  const raw = config?.agentOptions
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : undefined
}

function requestedAgentOptions(config, request) {
  const baseline = configuredAgentOptions(config)
  if (request.provider === undefined && request.model === undefined && request.reasoning_effort === undefined) return baseline
  return {
    ...(baseline ?? {}),
    ...(request.provider !== undefined ? { provider: request.provider, model: request.model } : {}),
    ...(request.reasoning_effort !== undefined ? { reasoningEffort: request.reasoning_effort } : {}),
  }
}

async function preflightRoute(ctx, parent, options, signal) {
  if (options === undefined) return
  const provider = options.provider ?? parent.options?.provider
  const model = options.model ?? parent.options?.model
  if (provider === undefined || model === undefined) throw new Error('cannot select child LLM values without an effective provider and model')
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    throw new Error('cannot resolve the selected child LLM route because the llm service is unavailable')
  }
  await llm.resolveCallConfig({
    provider,
    model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  }, signal)
}

async function settleForeground(run) {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') throw execution.reason
  if (disposal.status === 'rejected') throw disposal.reason
  const result = execution.value
  if (result.stopReason !== 'completed') {
    throw new Error(`subagent stopped with ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`)
  }
  return { kind: 'foreground', runId: run.id, output: result.output }
}

function availablePresetTools(tools, compositionScope) {
  return tools.schemas(compositionScope).map((schema) => schema.name)
}

function createShadowTool(ctx, tools, compositionScope, compiled, kind, config) {
  const toolName = kind === 'fork' ? 'subagent_fork' : 'subagent'
  const provider = providerFor(kind, config)
  const properties = { ...BASE_PARAMETERS, ...(kind === 'spawn' ? SPAWN_PARAMETERS : {}), ...buildSubagentToolParameters(compiled) }
  return {
    name: toolName,
    description: `创建子代理执行委派任务；实例工具权限由 subagentToolPolicy 解析并在创建时冻结。`,
    parameters: { type: 'object', properties, required: ['description', 'prompt'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args, run) => {
      validateShadowArgs(args, compiled, kind)
      if (run.agent === undefined) throw new Error('no active agent for subagent start')
      const resolved = resolveSubagentToolPolicy(compiled, args, availablePresetTools(tools, compositionScope))
      if (resolved.requiresApproval) await expansionApproval(ctx, run, toolName, resolved)
      const childProvider = ctx.subagents.getProvider(provider)
      if (childProvider === undefined) throw new Error(`subagent provider ${provider} is not registered`)
      if (childProvider.capabilities?.toolFilter !== true) {
        throw new Error(`provider ${provider} does not support per-child toolFilter`)
      }
      const maxDepth = config?.maxDepth === 'provider-managed' ? undefined : config?.maxDepth
      if (typeof maxDepth === 'number' && childProvider.capabilities?.depthLimit !== true) {
        throw new Error(`provider ${provider} cannot enforce maxDepth`)
      }
      const agentOptions = kind === 'spawn' ? requestedAgentOptions(config, args) : undefined
      if (agentOptions !== undefined && childProvider.capabilities?.agentOptions !== true) {
        throw new Error(`provider ${provider} does not support child agentOptions`)
      }
      if (kind === 'spawn' && agentOptions !== undefined) {
        await preflightRoute(ctx, run.agent, agentOptions, run.signal)
        if (ctx.subagents.getProvider(provider) !== childProvider) throw new Error(`subagent provider ${provider} changed during route preflight`)
      }
      run.signal.throwIfAborted()
      const request = {
        prompt: [{ type: 'text', text: args.prompt }],
        parent: run.agent,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        toolFilter: { allow: resolved.effectiveTools },
      }
      const policy = {
        profile: resolved.profileId,
        characterId: resolved.characterId ?? null,
        taskType: resolved.taskType ?? null,
        adoptedSelectors: resolved.adopted,
        ignoredSelectors: resolved.ignored,
        additionalTools: resolved.additionalTools,
        effectiveTools: resolved.effectiveTools,
      }
      if (args.run_in_background !== false) {
        if (childProvider.prepareContinuable === undefined) throw new Error(`provider ${provider} does not support continuable children`)
        const child = await ctx.subagents.startContinuable({ provider, label: args.description, request, signal: run.signal })
        return { kind: 'continuable', subagentId: child.childId, policy }
      }
      const childRun = await ctx.subagents.start(provider, { ...request, label: args.description, signal: run.signal })
      return { ...(await settleForeground(childRun)), policy }
    },
  }
}

export function apply(ctx, config) {
  let compiled
  try {
    compiled = loadCompiledPolicy(config)
  } catch (error) {
    throw new Error(`${name}: cannot load policy: ${error instanceof Error ? error.message : String(error)}`)
  }
  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) throw new Error(`${name}: requires a preset scope`)
  const installs = new WeakMap()
  const belongsToComposition = (agent) => scopeChainOf(scopeOf(agent.ctx)).includes(compositionScope)
  const install = (agent) => {
    if (installs.has(agent) || !belongsToComposition(agent)) return
    const dispose = agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.tools.register(createShadowTool(ctx, agent.ctx.tools, compositionScope, compiled, 'spawn', config)),
        agent.ctx.tools.register(createShadowTool(ctx, agent.ctx.tools, compositionScope, compiled, 'fork', config)),
      ]
      return () => { for (const item of disposers) item() }
    }, `${name}: ${agent.id} shadow`)
    installs.set(agent, dispose)
  }
  const remove = (agent) => {
    const dispose = installs.get(agent)
    if (dispose === undefined) return
    installs.delete(agent)
    void Promise.resolve(dispose()).catch((error) => ctx.logger?.warn(`${name}: shadow cleanup failed: ${String(error)}`))
  }
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => remove(agent))
  const reconcile = () => {
    for (const agent of ctx.agents.list()) {
      if (belongsToComposition(agent)) install(agent)
      else remove(agent)
    }
  }
  ctx.on('tools/change', reconcile)
  reconcile()
}
