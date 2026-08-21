/** 角色管理页：角色卡库（PNG / JSON 素材 + 转换参数独立存储）。
 *  库中角色卡不直接生成预设——点击「导入到当前预设」把角色卡参数
 *  （角色设定 / 系统提示 / 开场白 / 提示词库 / 采样参数）合并进当前激活预设，
 *  已导入的角色卡显示状态并可一键移除。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgePost } from './prompt-tool-bridge.ts'
import { parseCharacterCardPng } from './character-card.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'
import ui from './PromptUi.module.css'

interface CharacterCardItem {
  id: string
  name: string
  description?: string
  hasAvatar: boolean
  imported: boolean
}

export function CharactersPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const [importing, setImporting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [characters, setCharacters] = useState<CharacterCardItem[]>([])
  const pngRef = useRef<HTMLInputElement>(null)
  const jsonRef = useRef<HTMLInputElement>(null)

  const loadCharacters = async (): Promise<void> => {
    const res = await bridgePost<{ characters: CharacterCardItem[] }>('/characters-list', {})
    if (res.ok) setCharacters(res.value.characters)
  }
  useEffect(() => {
    void loadCharacters()
  }, [])

  /** 导入角色卡入库（PNG 解析出 JSON + 原图，JSON 直传）。 */
  const importCard = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setImporting(true)
    try {
      for (const file of Array.from(files)) {
        if (/\.png$/i.test(file.name)) {
          const buffer = await file.arrayBuffer()
          const card = parseCharacterCardPng(buffer, file.name)
          const res = await bridgePost<{ id: string; name: string }>('/characters-import', {
            files: [
              { path: 'avatar.png', content: card.imageBase64 },
              { path: `${card.name}.json`, content: card.jsonText },
            ],
          })
          if (res.ok) store.showNotice('ok', `角色卡「${res.value.name}」已入库`)
          else store.showNotice('error', '角色卡入库失败：' + (res.message ?? 'settings bridge unavailable'))
        } else if (/\.json$/i.test(file.name)) {
          const res = await bridgePost<{ id: string; name: string }>('/characters-import', {
            files: [{ path: file.name, content: await file.text() }],
          })
          if (res.ok) store.showNotice('ok', `角色卡「${res.value.name}」已入库`)
          else store.showNotice('error', '角色卡入库失败：' + (res.message ?? 'settings bridge unavailable'))
        } else {
          store.showNotice('error', `不支持的文件类型：${file.name}（仅 .png / .json）`)
        }
      }
      await loadCharacters()
    } catch (error) {
      store.showNotice('error', `角色卡导入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setImporting(false)
    }
  }

  /** 角色卡参数导入当前预设（合并 promptConfigs + params，重建后生效）。 */
  const applyCard = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const res = await bridgePost<{ id: string; count: number }>('/characters-apply', { id })
      if (res.ok) {
        store.showNotice('ok', `已导入到当前预设（${res.value.count} 条配置）`)
        await store.load()
        await loadCharacters()
      } else {
        store.showNotice('error', '导入到当前预设失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setBusy(undefined)
    }
  }

  /** 从当前预设移除该角色卡参数。 */
  const removeCard = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const res = await bridgePost<{ id: string; count: number }>('/characters-remove', { id })
      if (res.ok) {
        store.showNotice('ok', `已从当前预设移除（${res.value.count} 条配置）`)
        await store.load()
        await loadCharacters()
      } else {
        store.showNotice('error', '移除失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setBusy(undefined)
    }
  }

  const deleteCard = async (id: string): Promise<void> => {
    const res = await bridgePost<{ id: string }>('/characters-delete', { id })
    if (res.ok) {
      setConfirmingDelete(undefined)
      store.showNotice('ok', `角色卡 ${id} 已删除（已导入当前预设的参数不受影响）`)
      await loadCharacters()
    } else {
      store.showNotice('error', '删除失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgePost<{ path: string }>('/preset-open', { id: `/.characters/${id}` })
    if (res.ok) store.showNotice('ok', `已打开角色卡目录：${res.value.path}`)
    else store.showNotice('error', '打开目录失败：' + (res.message ?? 'settings bridge unavailable'))
  }

  return (
    <section className={ui.section} aria-label="角色管理">
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>角色卡库</strong>
            <small>导入 SillyTavern 角色卡（PNG tEXt chunk：ccv3 / chara，或 chara_card JSON）到独立库。角色卡参数不直接生成预设——点击「导入到当前预设」把角色设定 / 系统提示 / 开场白 / 提示词库合并进当前激活预设，可随时移除。</small>
          </span>
          <span className={ui.inlineControls}>
            <input
              ref={pngRef}
              type="file"
              accept=".png"
              multiple
              className={ui.visuallyHidden}
              aria-label="选择 SillyTavern 角色卡 PNG"
              onChange={(event) => { void importCard(event.target.files); event.target.value = '' }}
            />
            <input
              ref={jsonRef}
              type="file"
              accept=".json"
              multiple
              className={ui.visuallyHidden}
              aria-label="选择角色卡 JSON"
              onChange={(event) => { void importCard(event.target.files); event.target.value = '' }}
            />
            <button type="button" className={ui.primaryPill} disabled={importing} onClick={() => pngRef.current?.click()}>
              {importing ? '导入中…' : '导入角色卡 PNG'}
            </button>
            <button type="button" className={ui.pillButton} disabled={importing} onClick={() => jsonRef.current?.click()}>
              导入角色卡 JSON
            </button>
          </span>
        </div>
      </div>

      {characters.length === 0 ? (
        <div className={ui.emptyState}>
          <span className={ui.emptyGlyph} aria-hidden="true">⌁</span>
          <div>
            <h3>角色卡库为空</h3>
            <p>从上方导入 SillyTavern 角色卡（PNG / JSON），然后点击「导入到当前预设」应用到正在使用的预设。</p>
          </div>
        </div>
      ) : (
        <div className={ui.presetGrid}>
          {characters.map((card) => {
            const confirming = confirmingDelete === card.id
            return (
              <div key={card.id} className={ui.presetCard}>
                <div className={ui.presetCardBody}>
                  <span className={ui.presetCardHead}>
                    <strong className={ui.presetCardName}>{card.name}</strong>
                    {card.imported && <span className={ui.presetInUse}>已导入当前预设</span>}
                  </span>
                  {card.description !== undefined && card.description.length > 0
                    && <p className={ui.presetCardDesc}>{card.description}</p>}
                  <code className={ui.presetCardId}>{card.id}</code>
                </div>
                <span className={ui.presetCardFooter}>
                  {card.imported ? (
                    <button type="button" className={ui.pillButton} data-variant="secondary" disabled={busy === card.id}
                      onClick={() => void removeCard(card.id)}>
                      {busy === card.id ? '移除中…' : '从当前预设移除'}
                    </button>
                  ) : (
                    <button type="button" className={ui.primaryPill} disabled={busy === card.id}
                      onClick={() => void applyCard(card.id)}>
                      {busy === card.id ? '导入中…' : '导入到当前预设'}
                    </button>
                  )}
                  <button type="button" className={ui.presetIconButton} data-tip="打开角色卡目录"
                    aria-label={`打开角色卡目录：${card.name}`}
                    onClick={() => void openLocation(card.id)}>
                    <IconFolderOpenOutline16 />
                  </button>
                  {confirming ? (
                    <>
                      <button type="button" className={ui.pillButton} data-danger
                        onClick={() => void deleteCard(card.id)}>确认删除</button>
                      <button type="button" className={ui.pillButton} data-variant="secondary"
                        onClick={() => setConfirmingDelete(undefined)}>取消</button>
                    </>
                  ) : (
                    <button type="button" className={ui.presetIconButton} data-tip="删除角色卡"
                      aria-label={`删除角色卡：${card.name}`}
                      onClick={() => setConfirmingDelete(card.id)}>
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
