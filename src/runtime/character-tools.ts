/** 角色卡库模型工具：模型可在会话中直接导入角色卡、应用/移除到当前预设。
 *  与 UI 角色管理页共用 host/characters.ts 同一套库与合并逻辑。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyCharacterToPreset,
  deleteCharacterCard,
  importCharacterCard,
  listCharacterCards,
  removeCharacterFromPreset,
} from '../host/characters.ts'

/** 工具执行所需的运行时宿主能力（index.ts 闭包提供）。 */
export interface CharacterToolHost {
  /** 预设根目录（presetDir）。 */
  presetRoot: () => string
  /** 当前激活预设模板名。 */
  templateName: () => string
  /** 应用/移除后重建生成目录（写 preset.yml 后使参数生效）。 */
  rebuild: () => void
}

const text = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

/** 注册角色卡库模型工具；返回 disposer，随 character-tools 预设模块生命周期清理。 */
export function registerCharacterTools(ctx: Context, host: CharacterToolHost): () => void {
  const fiber = ctx.inject(['tools'], (toolsCtx) => {
    const disposers: Array<() => void> = []
    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_list',
      description: '列出 SillyTavern 角色卡库：每张卡（id / 名称 / 描述 / 是否已导入当前预设）。'
        + '导入角色卡、应用到当前预设或移除前先调用本工具获取 id。',
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
                  imported: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => text(JSON.stringify(value.characters)),
      },
      execute: async () => ({
        characters: listCharacterCards(host.presetRoot(), host.templateName()),
      }),
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_import',
      description: '导入 SillyTavern 角色卡（chara_card_v2/v3 JSON）到角色卡库：接收角色卡 JSON 文本内容'
        + '（可先读取文件）。PNG 角色卡请让用户从 UI 角色管理页导入。导入后需调用 character_apply 应用到当前预设。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: '角色卡文件名（不含 .json 扩展名），将作为预设/角色卡 id 基础。',
        },
        content: {
          type: 'string',
          required: true,
          description: '角色卡 JSON 文本（spec: chara_card_v2/v3，含 name/description/data 等字段）。',
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
        render: (_args, value) => text(`角色卡已入库：${value.name}（id=${value.id}）。调用 character_apply 可应用到当前预设。`),
      },
      execute: async (args) => {
        const result = importCharacterCard(host.presetRoot(), [{ path: `${args.name}.json`, content: args.content }])
        if (!result.ok) throw new Error(result.message)
        return { id: result.id, name: result.name }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_apply',
      description: '把角色卡库中一张角色卡的参数（角色设定 / 系统提示 / 开场白 / 世界书 / 提示词库 / 采样参数）'
        + '合并进当前激活预设（promptConfigs 带 chara-<id>- 前缀防冲突，params 合并，meta.importedCharacters 记录），'
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
        render: (_args, value) => text(`已导入到当前预设（${value.count} 条配置），生成目录已重建。`),
      },
      execute: async (args) => {
        const result = applyCharacterToPreset(host.presetRoot(), host.templateName(), args.id)
        if (!result.ok) throw new Error(result.message)
        host.rebuild()
        return { id: args.id, count: result.count }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_remove',
      description: '从当前激活预设移除一张已导入角色卡的参数（删 chara-<id>- 前缀配置、该卡声明的 params 键、'
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
        render: (_args, value) => text(`已从当前预设移除（${value.count} 条配置），生成目录已重建。`),
      },
      execute: async (args) => {
        const result = removeCharacterFromPreset(host.presetRoot(), host.templateName(), args.id)
        if (!result.ok) throw new Error(result.message)
        host.rebuild()
        return { id: args.id, count: result.count }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'character_delete',
      description: '从角色卡库删除一张角色卡（含其转换参数与头像）。已导入当前预设的参数不受影响'
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
      execute: async (args) => {
        const result = deleteCharacterCard(host.presetRoot(), args.id)
        if (!result.ok) throw new Error(result.message)
        return { id: args.id }
      },
    })))
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
