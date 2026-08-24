/**
 * 会话变量模型工具（session_var）：ST getvar/setvar 运行时语义。
 *   list                 → 当前会话全部变量
 *   get <key>            → 读取单个变量
 *   set <key> <value>    → 设置（模板 {{key}} 注入时替换；会话覆盖预设默认）
 *   clear <key> | 全部    → 清除
 * 变量挂在 session 对象（SESSION_VARS_KEY）上——与 .engine 的 executor 共享同一
 * 会话数据（模块实例不同但键字符串一致）；对应 ST 正则/STscript 更新状态变量的语义。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

/** 注册会话变量模型工具；返回 disposer（预设切换重挂用）。enabled=false 返回空操作。 */
export function registerSessionVarTools(ctx: Context): () => void {
  const fiber = ctx.inject(['tools'], (toolsCtx) => {
    const disposers: Array<() => void> = []
    disposers.push(toolsCtx.tools.register(defineTool({
      name: 'session_var',
      description: '会话变量管理（SillyTavern setvar/getvar 语义）：list 查看当前会话全部变量、'
          + 'get 读取、set 设置、clear 清除。提示词/世界书文本中的 {{变量名}} 会在注入时替换为'
          + '会话变量值（会话级覆盖预设默认值）；适合维护角色状态（如 {{心情}}、{{接受度}} 等）。'
          + '注意：会话变量仅存于当前会话（结束即失）；跨会话长期记忆请用 world_book 工具的 note 参数写入角色卡记忆（持久，跟随角色卡）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'set', 'clear'],
          required: true,
          description: '操作：list / get / set / clear',
        },
        key: {
          type: 'string',
          description: '变量名（get / set / clear 时必填；支持中文与下划线）',
        },
        value: {
          type: 'string',
          description: '变量值（set 时必填；空串表示清除该变量）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            variables: { type: 'object', additionalProperties: true },
            key: { type: 'string' },
            value: { type: 'string' },
          },
        },
        render: (_args, value) => text(JSON.stringify(value)),
      },
      execute: async (args, exec) => {
        const session = exec.agent?.session
        if (session === undefined) return { ok: false, error: 'no active session' }
        // 与 .engine 引擎实例共享同一会话数据（键字符串常量一致；模块实例不同）。
        const varsUrl = new URL('../engine/session-vars.mjs', import.meta.url)
        const { sessionVarsSnapshot, getSessionVar, setSessionVar, clearSessionVars } = await import(varsUrl.href) as {
          sessionVarsSnapshot: (session: object) => Record<string, string>
          getSessionVar: (session: object, key: string) => string | undefined
          setSessionVar: (session: object, key: string, value: string) => void
          clearSessionVars: (session: object, key?: string) => void
        }
        const record = (args ?? {}) as { action?: string; key?: string; value?: string }
        const action = typeof record.action === 'string' ? record.action : ''
        const key = typeof record.key === 'string' ? record.key : ''
        if (action === 'list') {
          return { ok: true, variables: sessionVarsSnapshot(session) }
        }
        if (action === 'get') {
          if (key.length === 0) return { ok: false, error: 'get 需要 key' }
          return { ok: true, key, value: getSessionVar(session, key) ?? '' }
        }
        if (action === 'set') {
          if (key.length === 0) return { ok: false, error: 'set 需要 key' }
          const value = typeof record.value === 'string' ? record.value : ''
          if (value.length === 0) {
            clearSessionVars(session, key)
          } else {
            setSessionVar(session, key, value)
          }
          return { ok: true, key, value }
        }
        if (action === 'clear') {
          clearSessionVars(session, key.length > 0 ? key : undefined)
          return { ok: true, key }
        }
        return { ok: false, error: `未知 action: ${action}` }
      },
    })))
    return () => { for (const dispose of disposers) dispose() }
  })
  return () => { void fiber.dispose() }
}
