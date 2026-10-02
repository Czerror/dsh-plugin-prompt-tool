/** 角色管理页：角色卡库（PNG / JSON 素材 + 转换参数独立存储）。
 *  库中角色卡不直接生成预设——点击「导入到当前预设」把角色卡参数
 *  （角色设定 / 系统提示 / 开场白 / 提示词库 / 采样参数）合并进当前激活预设，
 *  已导入的角色卡显示状态并可一键移除。 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '../../ui/icons.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'

const ui = sharedCss

interface CharacterCardItem {
  id: string
  name: string
  description?: string
  hasAvatar: boolean
  imported: boolean
}

export const CharactersPage = memo(function CharactersPage(props: { store: PromptToolStore; t: PromptToolTranslate; onReady?: () => void }): ReactNode {
  const { store, t } = props
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [characters, setCharacters] = useState<CharacterCardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const loadSequence = useRef(0)

  const loadCharacters = async (throwOnError = false): Promise<void> => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setLoadError('')
    const res = await bridgeCall('charactersList')
    if (sequence !== loadSequence.current) return
    if (res.ok) setCharacters(res.value.characters)
    else setLoadError(res.message ?? t('card.operationFailed'))
    setLoading(false)
    if (!res.ok && throwOnError) throw new Error(res.message ?? t('card.operationFailed'))
  }
  useEffect(() => {
    void loadCharacters()
    return () => { loadSequence.current += 1 }
  }, [])
  useEffect(() => { if (!loading) props.onReady?.() }, [loading, props.onReady])

  /** 角色卡参数导入当前预设（合并 promptConfigs + params，重建后生效）。 */
  const applyCard = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const res = await bridgeCall('charactersApply', { id })
      if (res.ok) {
        store.showNotice('ok', t('characters.notice.applied', { count: res.value.count }))
        await store.load()
        await loadCharacters()
      } else {
        store.showNotice('error', t('characters.notice.applyFailed', { reason: res.message ?? 'settings bridge unavailable' }))
      }
    } finally {
      setBusy(undefined)
    }
  }

  /** 从当前预设移除该角色卡参数。 */
  const removeCard = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const res = await bridgeCall('charactersRemove', { id })
      if (res.ok) {
        store.showNotice('ok', t('characters.notice.removed', { count: res.value.count }))
        await store.load()
        await loadCharacters()
      } else {
        store.showNotice('error', t('characters.notice.removeFailed', { reason: res.message ?? 'settings bridge unavailable' }))
      }
    } finally {
      setBusy(undefined)
    }
  }

  const deleteCard = async (id: string): Promise<void> => {
    const res = await bridgeCall('charactersDelete', { id })
    if (res.ok) {
      store.showNotice('ok', t('characters.notice.deleted', { id }))
      await loadCharacters()
      setConfirmingDelete((current) => current === id ? undefined : current)
    } else {
      throw new Error(t('characters.notice.deleteFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleOpen', { id: `/.characters/${id}` })
    if (res.ok) store.showNotice('ok', t('characters.notice.opened', { path: res.value.path }))
    else store.showNotice('error', t('characters.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
  }

  return (
    <section className={ui.section} aria-label={t('characters.aria')}>
      {loadError && <p className={ui.noticeError} role="alert">{loadError} <button type="button" className={ui.pillButton} onClick={() => void loadCharacters()}>{t('workspace.retry')}</button></p>}
      {loading && <p role="status">{t('app.loading')}</p>}
      {characters.length > 0 && (
        <div className={ui.presetGrid}>
          {characters.map((card) => {
            const confirming = confirmingDelete === card.id
            return (
              <article key={card.id} className={ui.presetCard}>
                <div className={ui.moduleCardBody}>
                  <span className={ui.presetCardHead}>
                    <strong className={ui.presetCardName}>{card.name}</strong>
                    {card.imported && <StatusBadge className={ui.presetHeadBadge} tone="success" label={t('characters.badge.imported')} />}
                  </span>
                  {card.description !== undefined && card.description.length > 0
                    && <p className={ui.presetCardDesc}>{card.description}</p>}
                  <code className={ui.presetCardId}>{card.id}</code>
                </div>
                <span className={ui.presetCardFooter}>
                  {card.imported ? (
                    <button type="button" className={ui.pillButton} data-variant="secondary" disabled={busy === card.id}
                      onClick={() => void removeCard(card.id)}>
                      {busy === card.id ? t('characters.removing') : t('characters.remove')}
                    </button>
                  ) : (
                    <button type="button" className={ui.primaryPill} disabled={busy === card.id}
                      onClick={() => void applyCard(card.id)}>
                      {busy === card.id ? t('characters.importing') : t('characters.apply')}
                    </button>
                  )}
                  <HintTooltip label={t('characters.openDir.label')}>
                    <button type="button" className={ui.presetIconButton}
                      aria-label={t('characters.openDir.aria', { name: card.name })}
                      onClick={() => void openLocation(card.id)}>
                      <IconFolderOpenOutlineRegular />
                    </button>
                  </HintTooltip>
                  {confirming && (
                    <ConfirmDialog title={t('card.deleteTitle', { name: card.name })}
                      description={t('characters.delete.description', { name: card.name })}
                      confirmLabel={t('characters.confirmDelete')} cancelLabel={t('characters.cancel')}
                      onConfirm={() => deleteCard(card.id)} onCancel={() => setConfirmingDelete((current) => current === card.id ? undefined : current)} />
                  )}
                  {(
                    <HintTooltip label={card.imported ? t('characters.delete.hintImported') : t('characters.delete.label')}>
                      <button type="button" className={ui.presetIconButton}
                        aria-label={t('characters.delete.aria', { name: card.name })}
                        disabled={card.imported}
                        onClick={() => setConfirmingDelete(card.id)}>
                        <IconTrashOutlineRegular />
                      </button>
                    </HintTooltip>
                  )}
                </span>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
})
