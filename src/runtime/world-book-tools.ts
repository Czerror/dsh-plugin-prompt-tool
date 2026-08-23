/** 世界书模型工具：维护当前预设的 world-book 策略配置（promptConfigs 模块体系，
 *  与模块卡片同一存储/编辑）。list/upsert/delete 保留；injectMode 批量模式已废弃
 *  （keyword 语义由逐条 constant/keys 表达）。note 按条目 id 前缀归属写入角色卡
 *  记忆（.characters/<cardId>/memory.md，跟随角色卡跨预设），无前缀回退预设 memory.md。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, existsSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'

export interface WorldBookToolHost {
  /** 当前激活预设目录（preset.yml 所在目录）。 */
  activeDir: () => string
  /** 预设根目录（角色卡库 .characters/<id> 所在根）。 */
  presetRoot: () => string
  /** 写盘后重建生成目录。 */
  rebuild: () => void
}

const text = (text: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text }]

function readConfigs(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, 'preset.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  const current = doc.toJS() as { promptConfigs?: unknown[] }
  return Array.isArray(current.promptConfigs) ? current.promptConfigs as Array<Record<string, unknown>> : []
}

function writeConfigs(dir: string, configs: Array<Record<string, unknown>>): void {
  const file = join(dir, 'preset.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  doc.setIn(['promptConfigs'], configs)
  writeFileSync(file, doc.toString(), 'utf8')
}

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

/** 从条目 id 解析来源角色卡（chara-<cardId>- 前缀，cardId 可含连字符：遍历库目录取最长匹配）。 */
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
      description: '列出当前预设的世界书条目（world-book 策略配置：id / 名称 / 关键字 / 常驻 / 启用）。'
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
      execute: async () => {
        const entries = readConfigs(host.activeDir())
          .filter((config) => config.strategy === 'world-book')
          .map((config) => ({
            id: String(config.id ?? ''),
            name: String(config.name ?? config.id ?? ''),
            keys: Array.isArray(config.params && (config.params as Record<string, unknown>).keys)
              ? (config.params as Record<string, unknown>).keys as string[] : undefined,
            constant: (config.params && (config.params as Record<string, unknown>).constant) === true,
            enabled: config.enabled !== false,
          }))
        return { entries }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'world_book_upsert',
      description: '新增或更新当前预设的一条世界书条目（world-book 策略配置）：按 id 更新（不存在则新增，'
        + 'id 自动生成 lore-<n>）。constant=true 常驻注入；否则命中 keys（或 secondaryKeys）任一关键字注入；'
        + '无 keys 条目按全局每次注入。note 可选：写入来源角色卡的持久记忆（memory.md，条目 id 带 chara-<卡>- 前缀时）'
        + '或预设记忆——持久记忆跨会话跟随角色卡（与 session_var 会话变量的临时状态不同，适合长期关系记录）。写盘后立即重建生成目录。',
      parameters: {
        id: { type: 'string', description: '条目 id（更新时必填；world_book_list 返回）。' },
        name: { type: 'string', required: true, description: '条目名称/注释（如「气味描写」）。' },
        content: { type: 'string', required: true, description: '命中后注入的条目内容。' },
        keys: { type: 'array', items: { type: 'string' }, description: '触发关键字（命中任一即注入）。' },
        secondaryKeys: { type: 'array', items: { type: 'string' }, description: '次级关键字（与 keys 合并匹配）。' },
        constant: { type: 'boolean', description: 'true = 常驻注入，不依赖关键字。' },
        enabled: { type: 'boolean', description: '缺省保持当前值/新增默认启用。' },
        order: { type: 'integer', description: '注入顺序（同位置升序），缺省 100。' },
        note: { type: 'string', description: '可选：操作笔记，写入来源角色卡持久记忆（memory.md，跨会话跟随角色卡）或预设记忆。' },
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
      execute: async (args) => {
        const dir = host.activeDir()
        const configs = readConfigs(dir)
        const targetId = args.id !== undefined && args.id.length > 0 ? args.id : `lore-${Date.now().toString(36)}`
        const params: Record<string, unknown> = {
          constant: args.constant === true,
          ...(Array.isArray(args.keys) && args.keys.length > 0 ? { keys: args.keys } : {}),
          ...(Array.isArray(args.secondaryKeys) && args.secondaryKeys.length > 0 ? { secondaryKeys: args.secondaryKeys } : {}),
        }
        const entry: Record<string, unknown> = {
          id: targetId,
          name: args.name,
          strategy: 'world-book',
          order: typeof args.order === 'number' ? args.order : 100,
          text: args.content,
          layer: 'pre-step',
          position: 'before-all',
          params,
        }
        if (args.enabled === false) entry.enabled = false
        const existing = configs.findIndex((config) => String(config.id ?? '') === targetId)
        if (existing >= 0) configs[existing] = entry
        else configs.push(entry)
        writeConfigs(dir, configs)
        writeNote(targetId, typeof args.note === 'string' ? args.note : '')
        host.rebuild()
        return { id: targetId, count: configs.filter((config) => config.strategy === 'world-book').length }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'world_book_delete',
      description: '删除当前预设的一条世界书条目（world_book_list 获取 id）。'
        + 'note 可选：写入来源角色卡持久记忆（memory.md，跨会话跟随角色卡）或预设记忆。删除后立即重建生成目录。',
      parameters: {
        id: { type: 'string', required: true, description: '世界书条目 id（world_book_list 返回）。' },
        note: { type: 'string', description: '可选：操作笔记，写入来源角色卡持久记忆（memory.md）或预设记忆。' },
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
        const configs = readConfigs(dir)
        const kept = configs.filter((config) => !(config.strategy === 'world-book' && String(config.id ?? '') === args.id))
        if (kept.length === configs.length) throw new Error(`世界书条目 ${args.id} 不存在`)
        writeConfigs(dir, kept)
        writeNote(args.id, typeof args.note === 'string' ? args.note : '')
        host.rebuild()
        return { id: args.id, count: kept.filter((config) => config.strategy === 'world-book').length }
      },
    }))
  })
}
