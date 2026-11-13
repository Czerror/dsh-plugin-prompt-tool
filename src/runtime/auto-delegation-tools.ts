/**
 * 自动派工的产品入口：真实根会话用一次工具调用提交整份计划。
 *
 * 编排语义（登记官方任务 → 真实派发 → 等匹配终态 → 按事实汇总）只有
 * auto-delegation.ts 一份；本文件只做三件事：参数窄化、调用方门控、把官方事实原样交回。
 * 不新建任务表、成员库或调度器，也不把「已提交」当成结果：返回的是每项的
 * taskId / childSession / runId / taskStatus 与失败原因。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { AutoDelegationError, BRIEF_SECTIONS } from './auto-delegation.ts'
import type { AutoDelegationRuntime, PlannedSubtask, TaskBrief } from './auto-delegation.ts'

/** 派工入口的工具名：运行纪律正文与文档都指这个名字。 */
export const AUTO_DELEGATION_TOOL_NAME = 'auto_delegate_plan'

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    planId: { type: 'string' },
    completed: { type: 'boolean' },
    cancelled: { type: 'boolean' },
    outcomes: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
} as const
type Result = InferValue<typeof schema>

const textOf = (value: unknown): string => typeof value === 'string' ? value : ''
const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

/** 入参是模型给的 JSON：六段缺项一律窄化成空串，交给计划校验报 AUTO_BRIEF_INCOMPLETE，不拼半份任务书。 */
const toSubtask = (value: unknown): PlannedSubtask => {
  const item = (value ?? {}) as Record<string, unknown>
  const brief = (item.brief ?? {}) as Record<string, unknown>
  const blockedBy = stringsOf(item.blockedBy)
  const writeScopes = stringsOf(item.writeScopes)
  const label = textOf(item.label)
  return {
    key: textOf(item.key), role: textOf(item.role), subject: textOf(item.subject),
    brief: Object.fromEntries(BRIEF_SECTIONS.map(([field]) => [field, textOf(brief[field])])) as unknown as TaskBrief,
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(writeScopes === undefined ? {} : { writeScopes }),
    ...(label === '' ? {} : { label }),
  }
}

interface AgentSurface {
  readonly id?: string
  readonly session?: { readonly id?: string; readonly header?: { readonly parentSession?: unknown } }
}

/** 指挥身份与编排入口都只归真实根会话：子会话拿到它只会拆出一个没有受众的计划。 */
const assertRoot = (agent: unknown): void => {
  const surface = agent as AgentSurface | undefined
  const header = surface?.session?.header
  if (header === undefined) {
    throw new AutoDelegationError('AUTO_DELEGATION_ROOT_REQUIRED', '自动派工需要真实会话身份：没有 Agent 上下文时不派工')
  }
  if (header.parentSession !== undefined) {
    throw new AutoDelegationError('AUTO_DELEGATION_ROOT_ONLY',
      `会话 ${String(surface?.session?.id)} 是子会话：拆解与汇总只归真实根会话；需要继续工作请在任务书范围内直接执行`)
  }
}

export function registerAutoDelegationTools(ctx: Context, options: { runtime: AutoDelegationRuntime }): () => void {
  const { runtime } = options
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const off = toolsCtx.tools.register(defineTool({
      name: AUTO_DELEGATION_TOOL_NAME,
      description: '把一份自包含计划交给自动派工：登记官方 Team 任务（含 blockedBy/writeScopes）、真实启动执行角色、等待匹配运行终态，然后返回每项的 taskId、childSession、runId、taskStatus 与失败原因。同步执行到本次计划收口，不返回「已提交」。只在模块规则 auto-delegation 开启时可用，且只接受真实根会话调用。subtasks 每项含 key、role（recon/assess/vuln-scan/exploit/internal）、subject 与六段 brief（objective/inputs/known/expected/acceptance/tools），可选 blockedBy（按 key）与 writeScopes；parallel 只约束互不依赖的任务。',
      parameters: {
        planId: { type: 'string' },
        subtasks: { type: 'array', required: true, items: { type: 'json' } },
        parallel: { type: 'integer' },
      },
      output: {
        schema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const unknownField = Object.keys(args).find(key => !['planId', 'subtasks', 'parallel'].includes(key))
        try {
          if (unknownField !== undefined) throw new AutoDelegationError('AUTO_PLAN_INVALID', `入口只接受 planId/subtasks/parallel，收到 ${unknownField}`)
          assertRoot(exec.agent)
          const planId = textOf(args.planId).trim()
          return await runtime.run({
            parent: exec.agent,
            // 未给计划标识时生成一个：本次结果里会带回，重跑时传同一个值就能读回官方已有事实。
            planId: planId === '' ? 'auto-' + randomUUID() : planId,
            subtasks: (Array.isArray(args.subtasks) ? args.subtasks : []).map(toSubtask),
            signal: exec.signal,
            ...(typeof args.parallel === 'number' ? { parallel: args.parallel } : {}),
          }) as unknown as Result
        } catch (error) {
          // 宿主只把 message 交给模型：把稳定 code 放进文本，模型才能据码判断而不是猜措辞。
          if (error instanceof AutoDelegationError) throw new AutoDelegationError(error.code, error.code + '：' + error.message)
          throw error
        }
      },
    }))
    return () => { off() }
  })
  return () => { void fiber.dispose() }
}
