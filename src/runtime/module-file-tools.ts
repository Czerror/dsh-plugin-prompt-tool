/** 模块私有文件工具：只调用 host owner，不触达规则或装配。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { appendModuleLine, readModuleFile } from '../host/module-files.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'

const PATH_PARAM = {
  type: 'string',
  required: true,
  description: '模块内相对路径。读取允许 memory.md、assets/、data/；追写允许 memory.md 与 data/。',
} as const

export function registerModuleFileTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const disposers = [
      toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.fileRead,
        description: '读取 moduleId 声明模块的私有文件：memory.md、assets/ 知识资产、data/ 账本。每次读取最新内容，缺失为空，超过 1 MiB 或非 UTF-8 明确报错。文件不会自动注入规则。',
        parameters: { moduleId: MODULE_ID_PARAM, path: PATH_PARAM },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              content: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.content }],
        },
        execute: async (args, exec) => {
          if (Object.keys(args).some(key => !['moduleId', 'path'].includes(key))) throw new TypeError('模块文件读取含未知字段')
          if (typeof args?.path !== 'string' || args.path.trim().length === 0) throw new TypeError('模块文件读取需要非空 path')
          exec.signal?.throwIfAborted()
          return readModuleFile(host.target(exec, args.moduleId).dir, args.path)
        },
      })),
      toolsCtx.tools.register(defineTool({
        name: MODULE_TOOL_NAMES.fileAppend,
        description: '向 moduleId 声明模块的 memory.md 或 data/ 文件追加一行。content 是纯文本；entry 是任意 JSON 对象，序列化为一行。两者只能给一个；assets/ 只读。空白文本不写入，不修改规则，也不重新装配。',
        parameters: {
          moduleId: MODULE_ID_PARAM,
          path: PATH_PARAM,
          content: { type: 'string' },
          entry: { type: 'object', additionalProperties: true },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { appended: { type: 'boolean', required: true }, path: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `${value.appended ? '已追加' : '空内容未追加'} ${value.path}` }],
        },
        execute: async (args, exec) => {
          if (Object.keys(args).some(key => !['moduleId', 'path', 'content', 'entry'].includes(key))) throw new TypeError('模块文件追加含未知字段')
          if (typeof args?.path !== 'string' || args.path.trim().length === 0) throw new TypeError('模块文件追加需要非空 path')
          const hasContent = args.content !== undefined
          const hasEntry = args.entry !== undefined
          if (hasContent === hasEntry) throw new TypeError('模块文件追加需要 content 或 entry 之一，不能同时给')
          const target = host.target(exec, args.moduleId)
          exec.signal?.throwIfAborted()
          let line: string
          if (hasContent) {
            if (typeof args.content !== 'string') throw new TypeError('content 必须是字符串')
            if (args.content.trim().length === 0) return { appended: false, path: args.path }
            line = args.content
          } else {
            if (args.entry === null || typeof args.entry !== 'object' || Array.isArray(args.entry)) throw new TypeError('entry 必须是 JSON 对象')
            line = JSON.stringify(args.entry)
          }
          appendModuleLine(target.dir, args.path, line)
          return { appended: true, path: args.path }
        },
      })),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
