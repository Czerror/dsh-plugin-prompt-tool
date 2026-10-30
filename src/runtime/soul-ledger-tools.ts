import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SOUL_SELF_SERVICE } from '../../engine/service-names.mjs'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { appendSoulLedger, closeSoulLedger, readSoulLedger, SOUL_LEDGER_TYPES } from '../host/soul-ledger.ts'

export function registerSoulLedgerTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const offGate = toolsCtx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const args = exec.arguments as Record<string, unknown> | null
      if (decision.kind !== 'allow' || exec.name !== MODULE_TOOL_NAMES.soulLedger || args?.action !== 'append' || args?.type !== 'lead') return decision
      exec.signal.throwIfAborted()
      return { kind: 'ask', reason: '变更 soul 账本主导会话，需要用户明确指定' }
    })
    const offTool = toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.soulLedger,
    description: '读取、追加或逐项收口模块账本。作者时间由真实会话提供；promise 仅当前 lead 可写/收口，shelved 原作者或当前 lead 可收口。close 用 targetId、completed/cancelled 和非空 reason；ref 是证据出处。pending/open/pending-review 视图支持版本游标分页。lead 必须用户指定并附 ref。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      action: { type: 'string', enum: ['list', 'append', 'close'], required: true },
      targetId: { type: 'string' }, outcome: { type: 'string', enum: ['completed', 'cancelled'] }, reason: { type: 'string' },
      type: { type: 'string', enum: [...SOUL_LEDGER_TYPES, 'close'] },
      view: { type: 'string', enum: ['history', 'pending', 'open', 'pending-review'] }, cursor: { type: 'string' },
      text: { type: 'string' }, '概要': { type: 'string' }, ref: { type: 'string' }, feel: { type: 'string' }, limit: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        entry: { type: 'object', additionalProperties: true }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' },
        nextCursor: { type: 'string' }, initialized: { type: 'boolean' }, revision: { type: 'string' },
        derived: { type: 'object', additionalProperties: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action', 'type', 'text', '概要', 'ref', 'feel', 'limit', 'targetId', 'outcome', 'reason', 'view', 'cursor'].includes(key))) throw new Error('账本工具含未知字段，不能指定作者或覆盖历史')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId)
      const committed = (result: ReturnType<typeof appendSoulLedger>) => {
        try {
          const owner = ctx.get?.(SOUL_SELF_SERVICE) as { committed?: (id: string, agent: Agent) => { state: string } } | undefined
          const derived = exec.agent && owner?.committed?.(target.id, exec.agent)
          return { ...result, ...(derived ? { derived } : {}) }
        } catch { return { ...result, derived: { state: 'failed', error: '账本已提交；派生状态通知失败，请用soul_state check核对，勿重放写入。' } } }
      }
      if (args.action === 'close') {
        if (args.type !== undefined || args.text !== undefined || args['概要'] !== undefined || args.feel !== undefined || args.limit !== undefined || args.view !== undefined || args.cursor !== undefined) throw new Error('收口不接受追加或读取字段')
        if (!args.targetId || !args.outcome || !args.reason) throw new Error('收口需要 targetId、outcome 与 reason')
        return committed(closeSoulLedger(target.dir, { targetId: args.targetId, outcome: args.outcome, reason: args.reason, ...(args.ref === undefined ? {} : { ref: args.ref }) }, { sessionId: exec.agent?.session.id, signal: exec.signal }))
      }
      if (args.targetId !== undefined || args.outcome !== undefined || args.reason !== undefined) throw new Error('只有收口接受 targetId、outcome 与 reason')
      if (args.action === 'list') {
        if (args.text !== undefined || args['概要'] !== undefined || args.ref !== undefined || args.feel !== undefined) throw new Error('读取账本不接受写入字段')
        return readSoulLedger(target.dir, { limit: args.limit, type: args.type, view: args.view, cursor: args.cursor })
      }
      if (args.limit !== undefined || args.view !== undefined || args.cursor !== undefined || args.type === undefined) throw new Error('追加账本需要 type 且不接受读取字段')
      if (args.type === 'lead' && !args.ref?.trim()) throw new Error('lead 必须提供用户指定主导的 ref')
      return committed(appendSoulLedger(target.dir, { type: args.type, ...(args.text === undefined ? {} : { text: args.text }), ...(args['概要'] === undefined ? {} : { '概要': args['概要'] }),
        ...(args.ref === undefined ? {} : { ref: args.ref }), ...(args.feel === undefined ? {} : { feel: args.feel }) }, { sessionId: exec.agent?.session.id, signal: exec.signal }))
    },
    }))
    return () => { offGate(); offTool() }
  })
  return () => { void fiber.dispose() }
}
