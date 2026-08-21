/** 世界书管理：当前预设的 worldBook 段（injectMode + 条目卡片）。
 *  与模型工具共用 host/worldbook.ts 读写；条目按（constant, order）排序显示。 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgePost } from './prompt-tool-bridge.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'
import ui from './PromptUi.module.css'

interface WorldBookEntry {
  id: string
  name: string
  text: string
  keys?: string[]
  secondaryKeys?: string[]
  constant?: boolean
  enabled?: boolean
  order?: number
}

interface WorldBook {
  injectMode: 'full' | 'keyword'
  entries: WorldBookEntry[]
}

const EMPTY_BOOK: WorldBook = { injectMode: 'keyword', entries: [] }

export function WorldBookSection(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const [book, setBook] = useState<WorldBook>(EMPTY_BOOK)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Partial<WorldBookEntry> | undefined>(undefined)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)

  const load = async (): Promise<void> => {
    const res = await bridgePost<WorldBook>('/worldbook-list', {})
    if (res.ok) setBook(res.value)
  }
  useEffect(() => {
    void load()
  }, [])

  const setMode = async (mode: 'full' | 'keyword'): Promise<void> => {
    setBusy(true)
    try {
      const res = await bridgePost<{ mode: 'full' | 'keyword'; count: number }>('/worldbook-mode', { mode })
      if (res.ok) {
        setBook((current) => ({ ...current, injectMode: res.value.mode }))
        store.showNotice('ok', `世界书注入模式已切换为 ${res.value.mode}`)
        await store.load()
      } else {
        store.showNotice('error', '切换失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setBusy(false)
    }
  }

  const saveEntry = async (): Promise<void> => {
    if (editing === undefined) return
    const name = (editing.name ?? '').trim()
    const text = (editing.text ?? '').trim()
    if (name.length === 0 || text.length === 0) {
      store.showNotice('error', '名称与内容不能为空')
      return
    }
    setBusy(true)
    try {
      const res = await bridgePost<{ id: string; count: number }>('/worldbook-upsert', {
        entry: {
          id: editing.id ?? '',
          name,
          text,
          keys: editing.keys,
          secondaryKeys: editing.secondaryKeys,
          constant: editing.constant === true,
          enabled: editing.enabled !== false,
          order: typeof editing.order === 'number' ? editing.order : 100,
        },
      })
      if (res.ok) {
        setEditing(undefined)
        store.showNotice('ok', `世界书条目 ${res.value.id} 已保存`)
        await load()
        await store.load()
      } else {
        store.showNotice('error', '保存失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setBusy(false)
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    const res = await bridgePost<{ id: string }>('/worldbook-delete', { id })
    if (res.ok) {
      setConfirmingDelete(undefined)
      store.showNotice('ok', `世界书条目 ${id} 已删除`)
      await load()
      await store.load()
    } else {
      store.showNotice('error', '删除失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  const sorted = useMemo(() => [...book.entries].sort((a, b) => {
    const orderA = typeof a.order === 'number' ? a.order : 100
    const orderB = typeof b.order === 'number' ? b.order : 100
    return orderA - orderB
  }), [book.entries])

  const keysText = (entry: WorldBookEntry): string =>
    [...(entry.keys ?? []), ...(entry.secondaryKeys ?? [])].join('、')

  return (
    <section className={ui.section} aria-label="世界书">
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>世界书</strong>
            <small>按关键字触发的上下文条目：无 keys 的全局条目每次注入，有 keys 条目命中聊天内容才注入。角色卡导入的世界书与角色记忆自动并入本预设。</small>
          </span>
          <span className={ui.inlineControls}>
            <select className={ui.configInput} value={book.injectMode} disabled={busy} aria-label="世界书注入模式"
              onChange={(event) => void setMode(event.target.value as 'full' | 'keyword')}>
              <option value="keyword">关键词触发（省上下文）</option>
              <option value="full">全文注入</option>
            </select>
            <button type="button" className={ui.primaryPill} disabled={busy} onClick={() => setEditing({ constant: false, enabled: true, order: 100 })}>
              新增条目
            </button>
          </span>
        </div>
      </div>

      {book.entries.length === 0 && editing === undefined ? (
        <div className={ui.emptyState}>
          <span className={ui.emptyGlyph} aria-hidden="true">⌁</span>
          <div>
            <h3>本预设还没有世界书</h3>
            <p>从「角色管理」导入角色卡（世界书自动并入），或点「新增条目」手动添加。</p>
          </div>
        </div>
      ) : (
        <div className={ui.dirCardList}>
          {editing !== undefined && (
            <div className={ui.dirCard}>
              <div className={ui.dirCardBody}>
                <div className={ui.dirCardTitle}>
                  <strong>{editing.id !== undefined && editing.id.length > 0 ? `编辑 ${editing.id}` : '新增世界书条目'}</strong>
                </div>
                <label className={ui.settingCopy}>
                  <small>名称</small>
                  <input className={ui.configInput} value={editing.name ?? ''} spellCheck={false}
                    placeholder="条目名称（如「气味描写」）"
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                </label>
                <label className={ui.settingCopy}>
                  <small>触发关键字（逗号分隔；留空 = 全局条目每次注入）</small>
                  <input className={ui.configInput} value={(editing.keys ?? []).join(', ')} spellCheck={false}
                    placeholder="气味, 体味"
                    onChange={(event) => setEditing({
                      ...editing,
                      keys: event.target.value.split(',').map((item) => item.trim()).filter((item) => item.length > 0),
                    })} />
                </label>
                <label className={ui.settingCopy}>
                  <small>内容</small>
                  <textarea className={ui.textarea} value={editing.text ?? ''} spellCheck={false}
                    placeholder="命中后注入的条目内容"
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                </label>
                <label className={ui.configEnable} title="常驻注入（不依赖关键字）">
                  <span className={ui.configFieldLabel}>constant（常驻注入）</span>
                  <input type="checkbox" checked={editing.constant === true}
                    onChange={(event) => setEditing({ ...editing, constant: event.target.checked })} />
                  <span className={ui.switch} aria-hidden="true"><i /></span>
                </label>
                <span className={ui.inlineControls}>
                  <button type="button" className={ui.primaryPill} disabled={busy} onClick={() => void saveEntry()}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                  <button type="button" className={ui.pillButton} onClick={() => setEditing(undefined)}>取消</button>
                </span>
              </div>
            </div>
          )}
          {sorted.map((entry) => {
            const confirming = confirmingDelete === entry.id
            return (
              <div key={entry.id} className={ui.dirCard}>
                <div className={ui.dirCardBody}>
                  <div className={ui.dirCardTitle}>
                    <strong>{entry.name}</strong>
                    {entry.constant === true
                      ? <span className={ui.presetInUse}>常驻</span>
                      : <span className={ui.skillStatusChip} data-chip="off">关键词触发</span>}
                    {entry.enabled === false && <span className={ui.readOnly}>已禁用</span>}
                    <code className={ui.readOnly}>{entry.id}</code>
                  </div>
                  {keysText(entry).length > 0 && <p className={ui.readOnly}>触发词：{keysText(entry)}</p>}
                  <p className={ui.readOnly}>{entry.text.slice(0, 120)}{entry.text.length > 120 ? '…' : ''}</p>
                </div>
                <span className={ui.inlineControls}>
                  <button type="button" className={ui.pillButton} onClick={() => setEditing({ ...entry })}>编辑</button>
                  {confirming ? (
                    <>
                      <button type="button" className={ui.pillButton} data-danger
                        onClick={() => void removeEntry(entry.id)}>确认删除</button>
                      <button type="button" className={ui.pillButton} data-variant="secondary"
                        onClick={() => setConfirmingDelete(undefined)}>取消</button>
                    </>
                  ) : (
                    <button type="button" className={ui.presetIconButton} data-tip="删除条目"
                      aria-label={`删除世界书条目：${entry.name}`}
                      onClick={() => setConfirmingDelete(entry.id)}>
                      <IconTrashOutline16 />
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
