/** 角色管理页：角色卡库（PNG / JSON 素材 + 转换参数独立存储）。
 *  库中角色卡不直接生成预设——点击「导入到当前预设」把角色卡参数
 *  （角色设定 / 系统提示 / 开场白 / 提示词库 / 采样参数）合并进当前激活预设，
 *  已导入的角色卡显示状态并可一键移除。 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from '../../data/bridge-client.ts'
import { previewAsset, commitAsset } from '../../data/asset-import.ts'
import { useImportPreviewFlow } from '../../data/use-import-preview-flow.ts'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { ImportDialog } from '../../ui/ImportDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './characters.module.css'

const ui = { ...sharedCss, ...featureCss }

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
  const [importOpen, setImportOpen] = useState(false)
  const [characters, setCharacters] = useState<CharacterCardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const loadSequence = useRef(0)
  const importArea = useRef<HTMLDivElement>(null)

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

  // 角色 JSON 导入复用与预设包相同的预览流程：等待确认时按钮可用，只有提交阶段禁用。
  const flow = useImportPreviewFlow({
    directoryTooLarge: t('assetImport.directoryTooLarge'),
    preview: (request) => previewAsset('charactersImport', request),
    commit: (preview) => commitAsset('charactersImport', preview),
    onCommitted: async (label) => {
      store.showNotice('ok', t('characters.notice.stored', { name: label ?? '' }))
      await loadCharacters(true)
    },
    onError: (message, stale) => {
      store.showNotice('error', t('characters.notice.submitFailed', { reason: stale ? t('importPreview.stale') : message }))
    },
  })

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
    const res = await bridgeCall('presetOpen', { id: `/.characters/${id}` })
    if (res.ok) store.showNotice('ok', t('characters.notice.opened', { path: res.value.path }))
    else store.showNotice('error', t('characters.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
  }

  return (
    <section className={ui.section} aria-label={t('characters.aria')}>
      {importOpen && <ImportDialog t={t} destination="character" {...flow} targets={characters}
        onFiles={(files, directory) => { void flow.run(files, directory ? 'package' : 'files') }} onChoices={flow.updateChoices}
        onConfirm={() => { void flow.confirm() }} onClose={() => { flow.cancel(); setImportOpen(false) }} onReset={flow.cancel}
        onSkip={flow.skip} onEnd={flow.end} onRepreview={() => { void flow.repreview() }} onRefresh={() => { void flow.retryRefresh() }}
        onUse={flow.resultLabel === undefined ? undefined : () => { void applyCard(flow.resultLabel!); flow.cancel(); setImportOpen(false) }} />}
      <div ref={importArea} className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>{t('characters.library.title')}</strong>
            <small>{t('characters.library.hint')}</small>
          </span>
          <span className={ui.inlineControls}>
            <button type="button" className={ui.primaryPill} onClick={() => setImportOpen(true)}>{t('assetImport.characterTitle')}…</button>
          </span>
        </div>
      </div>

      {loadError && <p className={ui.noticeError} role="alert">{loadError} <button type="button" className={ui.pillButton} onClick={() => void loadCharacters()}>{t('workspace.retry')}</button></p>}
      {loading && <p role="status">{t('app.loading')}</p>}
      {!loading && !loadError && characters.length === 0 ? (
        <div className={ui.emptyState}>
          <span className={ui.emptyGlyph} aria-hidden="true">⌁</span>
          <div>
            <h3>{t('characters.empty.title')}</h3>
            <p>{t('characters.empty.hint')}</p>
            <button type="button" className={ui.pillButton} onClick={() => setImportOpen(true)}>{t('assetImport.characterTitle')}…</button>
          </div>
        </div>
      ) : (
        <div className={ui.presetGrid}>
          {characters.map((card) => {
            const confirming = confirmingDelete === card.id
            return (
              <article key={card.id} className={ui.presetCard}>
                <div className={ui.presetCardBody}>
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
                    <HintTooltip label={t('characters.delete.label')}>
                      <button type="button" className={ui.presetIconButton}
                        aria-label={t('characters.delete.aria', { name: card.name })}
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
