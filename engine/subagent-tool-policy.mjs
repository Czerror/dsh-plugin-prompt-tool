/**
 * subagent-tool-policy — agent-scoped subagent/subagent_fork shadow 工具。
 *
 * 本模块通过运行中 DSH 入口解析同一份 dsh-tools / dsh-scope，避免生成目录
 * 加载第二份 registry 类型。每个 shadow 只安装到当前 preset generation 的
 * descendant Agent；实例权限在 SubagentStartRequest 创建窗口冻结。
 *
 * ── 能力提供者边界（T4）────────────────────────────────────────────────────
 * 本模块是**能力提供者**，不是触发器。分类判据（与组合源 subagent-tool-policy.yml、
 * tool-config-engine.yml 及 test/engine/provider-boundary.test.mjs 同一份措辞）：
 *   - 会给模型提供可调用能力（注册工具 / 域 / 服务）的 → 能力提供者；
 *   - 干预流程（改提示词、改装配、裁决、追加）的 → 声明式触发器。
 * 因此本模块**不接入** engine/trigger.mjs：它不订阅装配 waterfall，也没有 when/do
 * 声明，只在 agent 创建时向该 agent 的 scope 注册两个可调用工具。影子工具解决的是
 * 「子代理能用什么工具」，属于能力面，不是流程干预面。
 *
 * 样板收敛：
 *   - 配置声明走 fields.mjs 的 `defineConfig`（未知键在挂载期 fail loud）；
 *   - 注册走 disposer 契约，但这里保留 `agent.ctx.effect(...)` 而不是 shared.keepDisposer，
 *     依据见 install() 内的注释（整组原子回滚 + 按 agent 定向撤销句柄）；
 *   - 降级告警统一 `${name}: <what>; <fallback>` 一个前缀格式。
 *
 * 安全边界（T4 明令不得触碰，改动本模块时同样不得放宽）：
 *   - 扩权审批门 expansionApproval：requested additional_tools 必须先拿到
 *     `allowed-once`，无 approval 通道时 fail loud（不静默放行）；
 *   - fail loud 语义：策略文件存在但内容非法一律抛错；只有 ENOENT（用户关掉能力卡）
 *     才降级为官方委派行为。
 *
 * 登记入口：`engineProvider`（数据导出），供边界守卫消费。提供者登记与声明式触发器
 * 声明（约定为 `engineTriggers`）**互斥**，同一模块不得同时导出两者。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { importHostPackage } from './host-package.mjs'
import {
  buildSubagentToolParameters,
  compileSubagentToolPolicy,
  resolveSubagentToolPolicy,
} from './subagent-tool-policy-core.mjs'
import { defineConfig, passthrough } from './fields.mjs'

export const name = 'subagent-tool-policy'
export const inject = ['agents', 'subagents', 'tools']

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

/** 两个 shadow 的模型可见工具名：注册点与 engineProvider 登记共用这一份，防清单漂移。 */
const SHADOW_TOOL_NAMES = { spawn: 'subagent', fork: 'subagent_fork' }

/**
 * 配置契约：白名单由字段声明派生（此前没有白名单，未知键被静默忽略）。
 * 五个键**全部**用 passthrough：迁移前它们对非字符串/非对象值都是静默取默认或忽略
 *（policyFile / spawnProvider / forkProvider 取默认名，agentOptions 非对象则 undefined，
 * maxDepth 原样透传、由下游按 `'provider-managed'` 或数字自行判定），
 * 换成严格字段类型会引入 B2 未授权的行为变更。归一化结果与迁移前逐字段等价，
 * 唯一新增的是「未知键报错」。
 */
export const configContract = defineConfig({
  policyFile: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : '../subagent-tools/policy.yml')),
  spawnProvider: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : 'spawn')),
  forkProvider: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : 'fork')),
  maxDepth: passthrough((value) => value),
  agentOptions: passthrough((value) => value),
})

/**
 * 能力提供者登记（T4 边界守卫的数据源）。
 * `provides.kind === 'fixed'`：工具名在装配期就是确定的（两种委派入口各一个 shadow），
 * 守卫据此断言「提供者登记的工具名 = 实际注册的工具名」，并断言它们不出现在触发器声明里。
 */
export const engineProvider = {
  kind: 'provider',
  moduleId: name,
  registers: 'tools',
  provides: { kind: 'fixed', tools: Object.values(SHADOW_TOOL_NAMES) },
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
  const toolName = SHADOW_TOOL_NAMES[kind]
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
  // 校验入口：未知键在挂载期报错；五个键的归一化结果与迁移前逐字段一致（见 configContract）。
  const source = configContract.parse(config, name)
  let compiled
  try {
    compiled = loadCompiledPolicy(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 策略文件缺失 = 用户在能力卡里把开关关掉了（模块声明保留）：降级为官方委派行为，
    // 不注册 shadow 工具，也不让整个预设启动失败。文件在但内容损坏才是真错误——fail loud。
    if (error?.code === 'ENOENT') {
      ctx.logger?.warn(`${name}: policy file missing, subagent tool policy disabled; official delegation behavior kept`)
      return
    }
    throw new Error(`${name}: cannot load policy: ${message}`)
  }
  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) throw new Error(`${name}: requires a preset scope`)
  const installs = new WeakMap()
  const belongsToComposition = (agent) => scopeChainOf(scopeOf(agent.ctx)).includes(compositionScope)
  const install = (agent) => {
    if (installs.has(agent) || !belongsToComposition(agent)) return
    // 注册走 disposer 契约。这里保留 ctx.effect 而不是 shared.keepDisposer，两条依据：
    // (1) 两个 shadow 必须整组注册：任一个失败时由 Cordis 回滚已注册的那个
    //     （keepDisposer 无回滚语义，第二个失败会留下第一个的残留注册）；
    // (2) remove(agent) 需要按 agent 定向撤销，而 keepDisposer 返回 void，拿不到句柄。
    const dispose = agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.tools.register(createShadowTool(ctx, agent.ctx.tools, compositionScope, compiled, 'spawn', source)),
        agent.ctx.tools.register(createShadowTool(ctx, agent.ctx.tools, compositionScope, compiled, 'fork', source)),
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
