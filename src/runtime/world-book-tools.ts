/** 世界书模型工具：维护当前预设的 worldBook 独立存储段（injectMode + entries），
 *  操作笔记（note）按条目 id 前缀归属写入角色卡库记忆（.characters/<cardId>/memory.md，
 *  跟随角色卡跨预设），非角色卡条目回退预设目录 memory.md。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, existsSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readWorldBook, writeWorldBook, type WorldBookEntry } from '../host/worldbook.ts'

export interface WorldBookToolHost {
  /** 当前激活预设目录（preset.yml 所在目录）。 */
  activeDir: () => string
  /** 预设根目录（角色卡库 .characters/<id> 所在根）。 */
  presetRoot: () => string
  /** 写盘后重建生成目录。 */
  rebuild: () => void
}

const text = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

/** 追加记忆文件（角色卡 memory.md 或预设 memory.md）。 */
function appendMemory(file: string, note: string): void {
  const content = note.trim()
  if (content.length === 0) return
  mkdirSync(join(file, '..'), { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (existsSync(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `# 本地记忆\n${line}`, 'utf8')
}

/** 从条目 id 解析来源角色卡（chara-<cardId>- 前缀，cardId 自身可含连字符：遍历库目录取最长匹配）。 */
function sourceCardId(presetRoot: string, entryId: string): string | undefined {
  const root = join(presetRoot, '.characters')
  if (!entryId.startsWith('chara-')) return undefined
  let best: string | undefined
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue
      if (entryId.startsWith(`chara-${dir.name}-`) && (best === undefined || dir.name.length > best.length)) {
        best = dir.name
      }
    }
  } catch {
    // 库不可读 = 无归属
  }
  return best
}

export function registerWorldBookTools(ctx: Context, host: WorldBookToolHost): void {
  ctx.inject(['tools'], (toolsCtx) => {
    /** note 归属写入：角色卡条目 → 卡记忆；其他 → 预设记忆。 */
    const writeNote = (entryId: string | undefined, note: string): void => {
      if (note === undefined || note.trim().length === 0) return
      const cardId = entryId !== undefined ? sourceCardId(host.presetRoot(), entryId) : undefined
      if (cardId !== undefined) {
        appendMemory(join(host.presetRoot(), '.characters', cardId, 'memory.md'), note)
      } else {
        appendMemory(join(host.activeDir(), 'memory.md'), note)
      }
    }

    toolsCtx.tools.register(defineTool({
      name: 'world_book_list',
      description: '列出当前预设的世界书条目（id / 名称 / 关键字 / 常驻 / 启用）与注入模式。'
        + '世界书 = 上下文条目：无 keys 的全局条目每次注入，有 keys 条目命中聊天内容才注入；'
        + 'injectMode=full 全部注入。增删改前先调用本工具获取 id。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            injectMode: { type: 'string', required: true },
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
        render: (_args, value) => text(JSON.stringify({ injectMode: value.injectMode, entries: value.entries })),
      },
      execute: async () => {
        const book = readWorldBook(host.activeDir())
        return {
          injectMode: book.injectMode,
          entries: book.entries.map((entry) => ({
            id: String(entry.id ?? ''),
            name: String(entry.name ?? entry.id ?? ''),
            keys: Array.isArray(entry.keys) ? entry.keys as string[] : undefined,
            constant: entry.constant === true,
            enabled: entry.enabled !== false,
          })),
        }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'world_book_upsert',
      description: '新增或更新当前预设的一条世界书条目：按 id 更新（不存在则新增，id 自动生成 lore-<n>）。'
        + 'constant=true 常驻注入；否则命中 keys（或 secondaryKeys）任一关键字即注入；无 keys 条目按全局每次注入。'
        + 'mode 可切换世界书注入模式（full=全部注入 / keyword=全局+关键词触发）。'
        + 'note 可选：写入来源角色卡的本地记忆（memory.md，条目 id 带 chara-<卡>- 前缀时）或预设记忆。'
        + '写盘后立即重建生成目录。',
      parameters: {
        id: { type: 'string', description: '条目 id（更新时必填；world_book_list 返回）。' },
        name: { type: 'string', required: true, description: '条目名称/注释（如「气味描写」）。' },
        content: { type: 'string', required: true, description: '命中后注入的条目内容。' },
        keys: { type: 'array', items: { type: 'string' }, description: '触发关键字（命中任一即注入）。' },
        secondaryKeys: { type: 'array', items: { type: 'string' }, description: '次级关键字（与 keys 合并匹配）。' },
        constant: { type: 'boolean', description: 'true = 常驻注入，不依赖关键字。' },
        enabled: { type: 'boolean', description: '缺省保持当前值/新增默认启用。' },
        order: { type: 'integer', description: '注入顺序（同位置升序），缺省 100。' },
        mode: { type: 'string', enum: ['full', 'keyword'], description: '世界书注入模式。' },
        note: { type: 'string', description: '可选：操作笔记，写入来源角色卡记忆或预设记忆。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            count: { type: 'integer', required: true },
            mode: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`世界书条目 ${value.id} 已保存（共 ${value.count} 条，模式 ${value.mode}），生成目录已重建。`),
      },
      execute: async (args) => {
        const dir = host.activeDir()
        const book = readWorldBook(dir)
        const targetId = args.id !== undefined && args.id.length > 0 ? args.id : `lore-${Date.now().toString(36)}`
        const existing = book.entries.findIndex((entry) => String(entry.id ?? '') === targetId)
        const entry: WorldBookEntry = {
          id: targetId,
          name: args.name,
          order: typeof args.order === 'number' ? args.order : 100,
          text: args.content,
          constant: args.constant === true,
          ...(Array.isArray(args.keys) && args.keys.length > 0 ? { keys: args.keys } : {}),
          ...(Array.isArray(args.secondaryKeys) && args.secondaryKeys.length > 0 ? { secondaryKeys: args.secondaryKeys } : {}),
        }
        if (args.enabled === false) entry.enabled = false
        if (existing >= 0) book.entries[existing] = entry
        else book.entries.push(entry)
        if (args.mode === 'full' || args.mode === 'keyword') book.injectMode = args.mode
        writeWorldBook(dir, book)
        writeNote(targetId, typeof args.note === 'string' ? args.note : '')
        host.rebuild()
        return { id: targetId, count: book.entries.length, mode: book.injectMode }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'world_book_mode',
      description: '切换当前预设世界书的注入模式：full = 全部启用条目每次注入；'
        + 'keyword = 无 keys 条目每次注入（全局条目）+ 有 keys 条目命中聊天内容才注入（节省上下文）。'
        + 'note 可选：写入来源角色卡记忆或预设记忆。写盘后立即重建。',
      parameters: {
        mode: { type: 'string', required: true, enum: ['full', 'keyword'], description: '注入模式。' },
        note: { type: 'string', description: '可选：操作笔记。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => text(`世界书注入模式已切换为 ${value.mode}（${value.count} 条条目），生成目录已重建。`),
      },
      execute: async (args) => {
        const dir = host.activeDir()
        const book = readWorldBook(dir)
        if (args.mode !== 'full' && args.mode !== 'keyword') throw new Error(`非法注入模式：${args.mode}`)
        book.injectMode = args.mode
        writeWorldBook(dir, book)
        writeNote(undefined, typeof args.note === 'string' ? args.note : '')
        host.rebuild()
        return { mode: book.injectMode, count: book.entries.length }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'world_book_delete',
      description: '删除当前预设的一条世界书条目（world_book_list 获取 id）。'
        + 'note 可选：写入来源角色卡记忆或预设记忆。删除后立即重建生成目录。',
      parameters: {
        id: { type: 'string', required: true, description: '世界书条目 id（world_book_list 返回）。' },
        note: { type: 'string', description: '可选：操作笔记。' },
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
      execute: async (args) => {
        const dir = host.activeDir()
        const book = readWorldBook(dir)
        const kept = book.entries.filter((entry) => String(entry.id ?? '') !== args.id)
        if (kept.length === book.entries.length) throw new Error(`世界书条目 ${args.id} 不存在`)
        book.entries = kept
        writeWorldBook(dir, book)
        writeNote(args.id, typeof args.note === 'string' ? args.note : '')
        host.rebuild()
        return { id: args.id, count: book.entries.length }
      },
    }))
  })
}
