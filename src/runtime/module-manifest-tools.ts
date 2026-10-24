/** 通用 manifest 工具：只解释模块清单声明的操作，不认业务字段。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { runModuleManifest } from '../host/module-manifest.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'

const ACTIONS = ['next', 'check', 'apply'] as const
type ManifestAction = (typeof ACTIONS)[number]

export function registerModuleManifestTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.manifest,
    description: '执行 moduleId 声明模块的 assets/manifest.yml：next 返回第一条缺失，check 返回全部检查结果，apply 建目录并只落缺失文件。from 只读 assets/，其余只写 data/；不覆盖、不删除。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      action: { type: 'string', enum: [...ACTIONS], required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action'].includes(key))) throw new TypeError('模块清单工具含未知字段')
      if (typeof args.action !== 'string' || !ACTIONS.includes(args.action as ManifestAction)) {
        throw new TypeError('action 必须是 next、check 或 apply')
      }
      exec.signal?.throwIfAborted()
      const result = runModuleManifest(host.target(exec, args.moduleId).dir, args.action as ManifestAction)
      return { action: result.action, ok: result.ok, entries: result.entries as unknown as Record<string, ToolExecutionSuccess['value']>[] }
    },
  })))
  return () => { void fiber.dispose() }
}
