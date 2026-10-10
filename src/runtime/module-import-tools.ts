/** 所有已支持来源均通过模块导入预览、凭据与候选安装。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { expandModuleSource, moduleImportPreview, installModulePackage } from '../host/module-package.ts'
import type { AssetFile, AssetImportRequest } from '../shared/asset-transfer.ts'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'

export function registerModuleImportTools(ctx: Context, host: ModuleToolHost): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.import,
    description: '导入原生模块、SillyTavern 预设、角色卡或独立世界书。先 preview=true 获取来源、顺序组、降级报告与版本凭据；完成选择后带原始 files、凭据并设置 preview=false 提交。默认同名另存，不自动启用。路径仅是上传包内相对路径，不读取任意磁盘文件。',
    parameters: {
      files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, content: { type: 'string', required: true }, encoding: { type: 'string', enum: ['utf8', 'base64'] },
      } } },
      preview: { type: 'boolean' }, targetId: { type: 'string' }, targetName: { type: 'string' }, overwrite: { type: 'boolean' },
      sourceKind: { type: 'string', enum: ['native-preset', 'native-character', 'st-preset', 'st-character', 'world-book'] },
      promptOrderCharacterId: { type: 'string' }, expectedSourceDigest: { type: 'string' }, expectedPreviewRevision: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['files', 'preview', 'targetId', 'targetName', 'overwrite', 'sourceKind', 'promptOrderCharacterId', 'expectedSourceDigest', 'expectedPreviewRevision'].includes(key))) throw new TypeError('模块导入包含未知字段')
      exec.signal.throwIfAborted()
      const target = host.target(exec)
      const files = await expandModuleSource(args.files as AssetFile[])
      exec.signal.throwIfAborted()
      const request = args as AssetImportRequest
      const preview = moduleImportPreview(target.root, files, request)
      // 共享报告是具名接口；SDK 的 JSON 索引签名不推导其字段，值仍由官方输出校验。
      if (!('prepared' in preview)) return { ...preview } as unknown as Record<string, ToolExecutionSuccess['value']>
      if (args.preview !== false) return {
        state: 'ready', summary: preview.summary, sourceDigest: preview.sourceDigest, previewRevision: preview.previewRevision,
        ...(preview.prepared.report === undefined ? {} : { report: preview.prepared.report }),
      } as unknown as Record<string, ToolExecutionSuccess['value']>
      const result = await installModulePackage(target.root, files, request, { preserveAssets: true, signal: exec.signal })
      const saved = { state: 'imported', ...result, name: preview.summary.targetName, persisted: true }
      try {
        exec.signal.throwIfAborted()
        await host.rebuild(result.id)
        return { ...saved, publicationPending: false }
      } catch (error) {
        return { ...saved, publicationPending: true, publicationError: `模块已导入，但运行发布失败：${String(error)}` }
      }
    },
  })))
  return () => { void fiber.dispose() }
}
