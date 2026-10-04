/** 世界书模型工具：维护执行会话绑定模块的世界书条目与 memory.md。
 *  记忆只由显式读取工具提供给调用方，不生成自动注入规则。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendModuleMemory, readModuleMemory } from '../host/characters.ts'
import { buildWorldBookEntry, deleteWorldBookEntry, listWorldBookEntries, upsertWorldBookEntry } from '../host/worldbook.ts'
import { refreshModuleAfterSave } from '../host/module-tool-target.ts'
import type { ModuleToolHost, ModuleToolTarget } from '../host/module-tool-target.ts'

const text = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

/** 注册世界书条目级模型工具；返回 disposer，随 world-book-tools 模块生命周期清理。 */
export function registerWorldBookTools(ctx: Context, host: ModuleToolHost): () => void {
  const fiber = ctx.inject(['tools'], (toolsCtx) => {
    const disposers: Array<() => void> = []
    const writeNote = (target: ModuleToolTarget, note: string): void => {
      appendModuleMemory(target.dir, note)
    }

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'world_book_read_memory',
      description: '读取当前模块的持久记忆 memory.md。每次调用读取最新文件；没有记忆时返回空文本。记忆不会自动注入，读取失败会报错。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { memory: { type: 'string', required: true } },
        },
        render: (_args, value) => text(value.memory),
      },
      execute: async (_args, exec) => ({ memory: readModuleMemory(host.target(exec).dir) }),
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'world_book_list',
      description: '列出当前模块的世界书条目（world-book 策略配置：id / 名称 / 关键字 / 常驻 / 启用）。'
        + '世界书 = 上下文条目：无 keys 的全局条目每次注入，有 keys 条目命中聊天内容才注入。'
        + '增删改前先调用本工具获取 id。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  keys: { type: 'array', items: { type: 'string' } },
                  constant: { type: 'boolean' },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => text(JSON.stringify(value.entries)),
      },
      execute: async (_args, exec) => {
        const entries = listWorldBookEntries(host.target(exec).dir)
          .map((config) => {
            const params = config.params as Record<string, unknown> | undefined
            const keys = params?.keys
            return {
              id: String(config.id ?? ''),
              name: String(config.name ?? config.id ?? ''),
              // 无 keys 的条目（constant 常驻条目、ST 导入的无键条目）必须**省略**该属性：
              // 写成 `keys: undefined` 会让对象带上「值为 undefined 的自有属性」，
              // 宿主在校验 output.schema 之前先做 lossless JSON 快照，该属性会判定为非法
              // 并让整次 world_book_list 失败（schema 里 keys 本身不是 required）。
              ...(Array.isArray(keys) ? { keys: keys as string[] } : {}),
              constant: params?.constant === true,
              enabled: config.enabled !== false,
            }
          })
        return { entries }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'world_book_upsert',
      description: '新增或更新当前模块的一条世界书条目（world-book 策略配置）：按 id 更新（不存在则新增，'
        + 'id 自动生成 lore-<n>）。constant=true 常驻注入；否则命中 keys（或 secondaryKeys）任一关键字注入；'
        + '无 keys 条目按全局每次注入。note 可选：写入当前模块的持久记忆 memory.md，使用 world_book_read_memory 按需读取。写盘后立即重新装配。',
      parameters: {
        id: { type: 'string', description: '条目 id（更新时必填；world_book_list 返回）。' },
        name: { type: 'string', required: true, description: '条目名称/注释（如「气味描写」）。' },
        content: { type: 'string', required: true, description: '命中后注入的条目内容。' },
        keys: { type: 'array', items: { type: 'string' }, description: '触发关键字（命中任一即注入）。' },
        secondaryKeys: { type: 'array', items: { type: 'string' }, description: '次级关键字（与 keys 合并匹配）。' },
        constant: { type: 'boolean', description: 'true = 常驻注入，不依赖关键字。' },
        enabled: { type: 'boolean', description: '缺省保持当前值/新增默认启用。' },
        order: { type: 'integer', description: '注入顺序（同位置升序），缺省 100。' },
        note: { type: 'string', description: '可选：操作笔记，写入当前模块的 memory.md，不自动注入。' },
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
        render: (_args, value) => text(`世界书条目 ${value.id} 已保存（当前共 ${value.count} 条），生成目录已重建。`),
      },
      execute: async (args, exec) => {
        const target = host.target(exec)
        const targetId = args.id !== undefined && args.id.length > 0 ? args.id : `lore-${Date.now().toString(36)}`
        const entry = buildWorldBookEntry({
          id: targetId,
          name: args.name,
          text: args.content,
          order: typeof args.order === 'number' ? args.order : undefined,
          enabled: args.enabled === false ? false : undefined,
          constant: args.constant === true,
          keys: Array.isArray(args.keys) && args.keys.length > 0 ? args.keys : undefined,
          secondaryKeys: Array.isArray(args.secondaryKeys) && args.secondaryKeys.length > 0 ? args.secondaryKeys : undefined,
        })
        const count = upsertWorldBookEntry(target.dir, { ...entry, id: targetId })
        writeNote(target, typeof args.note === 'string' ? args.note : '')
        await refreshModuleAfterSave(host, target.id)
        return { id: targetId, count }
      },
    })))

    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'world_book_delete',
      description: '删除当前模块的一条世界书条目（world_book_list 获取 id）。'
        + 'note 可选：写入当前模块的 memory.md，使用 world_book_read_memory 按需读取。删除后立即重新装配。',
      parameters: {
        id: { type: 'string', required: true, description: '世界书条目 id（world_book_list 返回）。' },
        note: { type: 'string', description: '可选：操作笔记，写入当前模块的 memory.md，不自动注入。' },
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
        render: (_args, value) => text(`世界书条目 ${value.id} 已删除（剩余 ${value.count} 条），生成目录已重建。`),
      },
      execute: async (args, exec) => {
        const target = host.target(exec)
        const keptCount = deleteWorldBookEntry(target.dir, args.id)
        writeNote(target, typeof args.note === 'string' ? args.note : '')
        await refreshModuleAfterSave(host, target.id)
        return { id: args.id, count: keptCount }
      },
    })))
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
