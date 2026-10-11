import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { appendModuleMemory, readModuleMemory } from '../host/module-memory.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'

export function registerModuleMemoryTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const disposers = [
      toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.memoryRead,
        description: '读取 moduleId 声明模块的持久记忆 memory.md；每次读取最新内容，缺失为空，失败明确报错。记忆不会自动注入规则。',
        parameters: { moduleId: MODULE_ID_PARAM },
        output: { schema: { type: 'object', additionalProperties: false, properties: { memory: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.memory }] },
        execute: async (args, exec) => { exec.signal?.throwIfAborted(); return { memory: readModuleMemory(host.target(exec, args.moduleId).dir) } },
      })),
      toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.memoryAppend,
        description: '向 moduleId 声明模块的 memory.md 追加持久记忆。空白内容不写入，不修改规则，也不重新装配。',
        parameters: { content: { type: 'string', required: true }, moduleId: MODULE_ID_PARAM },
        output: { schema: { type: 'object', additionalProperties: false, properties: { appended: { type: 'boolean', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.appended ? '模块记忆已追加' : '空内容未追加' }] },
        execute: async (args, exec) => {
          if (typeof args?.content !== 'string' || Buffer.byteLength(args.content) > 1024 * 1024
            || Object.keys(args).some(key => !['content', 'moduleId'].includes(key))) throw new TypeError('记忆追加需要 1 MiB 以内的 content')
          const target = host.target(exec, args.moduleId)
          exec.signal?.throwIfAborted()
          appendModuleMemory(target.dir, args.content)
          return { appended: args.content.trim().length > 0 }
        },
      })),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
