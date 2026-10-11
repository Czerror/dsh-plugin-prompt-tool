/** 模型通过完整规则事务编辑 moduleId 声明的模块，读写不展开或重造注入叶子。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { editModuleRules, readModuleRules } from '../host/module-rules.ts'
import type { ModuleRuleEditRequest, ModuleRulesSnapshot } from '../host/module-rules.ts'
import { loadModuleDefinition, ModuleRulesError } from '../host/module-storage.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { MAX_BRIDGE_BODY_BYTES } from '../shared/bridge-contract.ts'
// @ts-expect-error 动作与条件目录归唯一引擎编译器。
import { getRuleEditorMeta } from '../../engine/rule-spec.mjs'

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    moduleId: { type: 'string', required: true }, rules: { type: 'array', required: true, items: { type: 'json' } },
    revisions: { type: 'object', additionalProperties: true, required: true }, meta: { type: 'object', additionalProperties: true, required: true },
    persisted: { type: 'boolean' }, publicationPending: { type: 'boolean' }, publicationError: { type: 'string' },
  },
} as const
type Result = InferValue<typeof schema>
const result = (moduleId: string, state: ModuleRulesSnapshot, status = {}): Result => ({ moduleId, ...state, meta: getRuleEditorMeta(), ...status }) as unknown as Result
const allowed = (args: object, keys: string[]): void => {
  if (Object.keys(args).some(key => !keys.includes(key))) throw new ModuleRulesError('规则工具含未知字段')
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_BRIDGE_BODY_BYTES) throw new ModuleRulesError('规则工具请求超过大小限制')
}

export function registerModuleRuleTools(ctx: Context, host: ModuleToolHost): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const read = toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.rulesRead,
      description: '读取 moduleId 声明模块的完整原始规则树、按域版本和引擎动作/条件目录。编辑前先读取；保留未修改的条件、then/else、动作与参数。',
      parameters: { moduleId: MODULE_ID_PARAM },
      output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        allowed(args, ['moduleId'])
        exec.signal.throwIfAborted()
        const target = host.target(exec, args.moduleId)
        return result(target.id, readModuleRules(target.dir))
      },
    }))
    const edit = toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.rulesEdit,
      description: '按 moduleId 声明的模块和读取时的 expectedRevisions 提交完整规则事务。edits 每项含 previousId、完整 rule，可选 settingsChanged；rule=null 明确删除整规则。关闭规则标记 settingsChanged，启用用 activateRuleId。validateOnly 只校验；已保存但发布失败时用 refreshOnly 重试发布，不重放 edits。',
      parameters: {
        moduleId: MODULE_ID_PARAM,
        expectedRevisions: { type: 'object', additionalProperties: true, required: true },
        edits: { type: 'array', items: { type: 'json' } },
        activateRuleId: { type: 'string' }, validateOnly: { type: 'boolean' }, refreshOnly: { type: 'boolean' },
      },
      output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        allowed(args, ['moduleId', 'expectedRevisions', 'edits', 'activateRuleId', 'validateOnly', 'refreshOnly'])
        if (args.refreshOnly === true && (args.edits !== undefined || args.activateRuleId !== undefined || args.validateOnly !== undefined)) throw new ModuleRulesError('refreshOnly 不能混用规则修改或候选校验')
        if (args.refreshOnly !== true && args.edits === undefined && args.activateRuleId === undefined) throw new ModuleRulesError('规则事务需要 edits 或 activateRuleId')
        exec.signal.throwIfAborted()
        const target = host.target(exec, args.moduleId)
        const { moduleId: _id, refreshOnly: _refresh, ...request } = args
        let state: ModuleRulesSnapshot
        try {
          state = editModuleRules(target.dir, args.refreshOnly === true
            ? { expectedRevisions: request.expectedRevisions, edits: [], validateOnly: true } as ModuleRuleEditRequest
            : request as unknown as ModuleRuleEditRequest)
        }
        catch (error) {
          if (!(error instanceof ModuleRulesError) || !error.persisted) throw error
          const saved = loadModuleDefinition(target.dir)
          return result(target.id, { rules: saved.rules, revisions: saved.revisions }, { persisted: true, publicationPending: true, publicationError: error.message })
        }
        if (args.validateOnly === true) return result(target.id, state)
        try {
          exec.signal.throwIfAborted()
          await host.rebuild(target.id)
          return result(target.id, readModuleRules(target.dir), { persisted: true, publicationPending: false })
        } catch (error) {
          return result(target.id, state, { persisted: true, publicationPending: true, publicationError: `规则已保存，但运行发布失败：${String(error)}` })
        }
      },
    }))
    return () => { read(); edit() }
  })
  return () => { void fiber.dispose() }
}
