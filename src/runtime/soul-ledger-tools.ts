import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { appendSoulLedger, readSoulLedger, SOUL_LEDGER_TYPES } from '../host/soul-ledger.ts'

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
    description: '读取或追加模块只追加账本。作者和时间来自真实执行会话；promise 仅当前 lead 署名者能写。lead 必须由用户指定并附 ref；text 与概要二选一，feel 有感受才写。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      action: { type: 'string', enum: ['list', 'append'], required: true },
      type: { type: 'string', enum: [...SOUL_LEDGER_TYPES] },
      text: { type: 'string' }, '概要': { type: 'string' }, ref: { type: 'string' }, feel: { type: 'string' }, limit: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        entry: { type: 'object', additionalProperties: true }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action', 'type', 'text', '概要', 'ref', 'feel', 'limit'].includes(key))) throw new Error('账本工具含未知字段，不能指定作者或覆盖历史')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId)
      if (args.action === 'list') {
        if (args.text !== undefined || args['概要'] !== undefined || args.ref !== undefined || args.feel !== undefined) throw new Error('读取账本不接受写入字段')
        return readSoulLedger(target.dir, { limit: args.limit, type: args.type })
      }
      if (args.limit !== undefined || args.type === undefined) throw new Error('追加账本需要 type 且不接受 limit')
      if (args.type === 'lead' && !args.ref?.trim()) throw new Error('lead 必须提供用户指定主导的 ref')
      return appendSoulLedger(target.dir, { type: args.type, ...(args.text === undefined ? {} : { text: args.text }), ...(args['概要'] === undefined ? {} : { '概要': args['概要'] }),
        ...(args.ref === undefined ? {} : { ref: args.ref }), ...(args.feel === undefined ? {} : { feel: args.feel }) }, { sessionId: exec.agent?.session.id, signal: exec.signal })
    },
    }))
    return () => { offGate(); offTool() }
  })
  return () => { void fiber.dispose() }
}
