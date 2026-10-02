/** 角色卡库模型工具：模型可导入角色卡、应用/移除到执行会话绑定的模块。
 *  与 UI 角色管理页共用 host/characters.ts 同一套库与合并逻辑。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { rebuildSavedPreset } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import {
  applyCharacterToPreset,
  deleteCharacterCard,
  importCharacterCard,
  listCharacterCards,
  removeCharacterFromPreset,
} from '../host/characters.ts'

const text = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

/** 注册角色卡库模型工具；返回 disposer，随 character-tools 模块生命周期清理。 */
export function registerCharacterTools(ctx: Context, host: ModuleToolHost): () => void {
  const fiber = ctx.inject(['tools'], (toolsCtx) => {
    const disposers: Array<() => void> = []
    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_list',
      description: '列出角色卡库：每张卡（id / 名称 / 描述 / 是否已导入当前模块）。'
        + '导入角色卡、应用到当前模块或移除前先调用本工具获取 id。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            characters: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string' },
                  hasAvatar: { type: 'boolean', required: true },
                  imported: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => text(JSON.stringify(value.characters)),
      },
      execute: async (_args, exec) => {
        const target = host.target(exec)
        return { characters: listCharacterCards(target.root, target.id) }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_import',
      description: '导入一张 SillyTavern 角色卡或自包含原生角色片段到角色卡库：接收 JSON / YAML 文本内容'
        + '（可先读取文件）。PNG 角色卡请让用户从 UI 角色管理页导入。导入后需调用 character_apply 应用到当前模块。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: '角色卡文件名（不含 .json 扩展名），将作为模块/角色卡 id 基础。',
        },
        content: {
          type: 'string',
          required: true,
          description: '角色卡 JSON / YAML 文本：SillyTavern chara_card_v2/v3，或含 id/name/promptConfigs 的原生片段。原生片段只支持内嵌 text/texts 和控制配置，不支持外部文件。',
        },
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
        render: (_args, value) => text(`角色卡已入库：${value.name}（id=${value.id}）。调用 character_apply 可应用到当前模块。`),
      },
      execute: async (args, exec) => {
        const target = host.target(exec)
        const result = importCharacterCard(target.root, [{ path: `${args.name}.json`, content: args.content }])
        if (!result.ok) throw new Error(result.message)
        return { id: result.id, name: result.name }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_apply',
      description: '把角色卡库中一张角色卡的参数（角色设定 / 系统提示 / 开场白 / 世界书 / 提示词配置）'
        + '合并进当前会话绑定的模块（promptConfigs 带 chara-<id>- 前缀防冲突，params 合并，meta.importedCharacters 记录），'
        + '并立即重建生成目录。重复应用幂等。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '角色卡 id（character_list 返回）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => text(`已导入到当前模块（${value.count} 条配置），生成目录已重建。`),
      },
      execute: async (args, exec) => {
        const target = host.target(exec)
        const result = applyCharacterToPreset(target.root, target.id, args.id)
        if (!result.ok) throw new Error(result.message)
        await rebuildSavedPreset(host, target.id)
        return { id: args.id, count: result.count }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_remove',
      description: '从当前会话绑定的模块移除一张已导入角色卡的参数（删 chara-<id>- 前缀配置、该卡声明的 params 键、'
        + 'meta.importedCharacters 除名），并立即重建生成目录。角色卡库条目不受影响。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '角色卡 id（character_list 返回，imported=true 的卡）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => text(`已从当前模块移除（${value.count} 条配置），生成目录已重建。`),
      },
      execute: async (args, exec) => {
        const target = host.target(exec)
        const result = removeCharacterFromPreset(target.root, target.id, args.id)
        if (!result.ok) throw new Error(result.message)
        await rebuildSavedPreset(host, target.id)
        return { id: args.id, count: result.count }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_delete',
      description: '从角色卡库删除一张角色卡（含其转换参数与头像）。已导入当前模块的参数不受影响'
        + '（如需清理请先调用 character_remove）。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '角色卡 id（character_list 返回）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`角色卡 ${value.id} 已从库中删除。`),
      },
      execute: async (args, exec) => {
        const result = deleteCharacterCard(host.target(exec).root, args.id)
        if (!result.ok) throw new Error(result.message)
        return { id: args.id }
      },
    })))
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
