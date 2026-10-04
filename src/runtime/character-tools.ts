/** 角色卡导入工具：角色内容直接安装为普通模块，由统一模块入口管理。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { importCharacterCard } from '../host/characters.ts'

export function registerCharacterTools(ctx: Context, host: ModuleToolHost): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: 'character_import',
    description: '把一张 SillyTavern 角色卡或自包含原生角色片段直接导入为普通模块，接收 JSON / YAML 文本。'
      + 'PNG 从模块页导入。默认同名另存，不自动启用；导入后通过模块管理选择启用，不再使用角色卡库或应用步骤。',
    parameters: {
      name: { type: 'string', required: true, description: '来源文件名（不含扩展名），作为普通模块 id 的基础。' },
      content: { type: 'string', required: true, description: '角色卡 JSON / YAML 文本；原生片段含 id/name/rules，规则注入动作使用内嵌 text/texts，不支持外部文件。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已导入普通模块：${value.name}（id=${value.id}）。在模块管理中启用后参与装配。` }],
    },
    execute: async (args, exec) => {
      const target = host.target(exec)
      const result = await importCharacterCard(target.root, [{ path: `${args.name}.json`, content: args.content }])
      if (!result.ok) throw new Error(result.message)
      return { id: result.id, name: result.name }
    },
  })))
  return () => { void fiber.dispose() }
}
