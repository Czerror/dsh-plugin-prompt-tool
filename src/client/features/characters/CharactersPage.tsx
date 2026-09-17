/** 角色管理页：角色卡库（PNG / JSON 素材 + 转换参数独立存储）。
 *  库中角色卡不直接生成预设——点击「导入到当前预设」把角色卡参数
 *  （角色设定 / 系统提示 / 开场白 / 提示词库 / 采样参数）合并进当前激活预设，
 *  已导入的角色卡显示状态并可一键移除。 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall, bridgeUpload, shouldStreamJsonFile } from '../../data/bridge-client.ts'
import { useImportPreviewFlow } from '../../data/use-import-preview-flow.ts'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { isPngSignature } from './character-card.ts'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import { ImportPreviewCard } from '../../ui/ImportPreviewCard.tsx'
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
  /** 文件读取/上传阶段（预览请求之前）：与预览流程的阶段分开表达。 */
  const [preparing, setPreparing] = useState(false)
  const [characters, setCharacters] = useState<CharacterCardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const loadSequence = useRef(0)
  const importArea = useRef<HTMLDivElement>(null)

  const loadCharacters = async (): Promise<void> => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setLoadError('')
    const res = await bridgeCall('charactersList')
    if (sequence !== loadSequence.current) return
    if (res.ok) setCharacters(res.value.characters)
    else setLoadError(res.message ?? t('card.operationFailed'))
    setLoading(false)
  }
  useEffect(() => {
    void loadCharacters()
    return () => { loadSequence.current += 1 }
  }, [])
  useEffect(() => { if (!loading) props.onReady?.() }, [loading, props.onReady])

  // 角色 JSON 导入复用与预设包相同的预览流程：等待确认时按钮可用，只有提交阶段禁用。
  const flow = useImportPreviewFlow({
    preview: async (files, orderCharacterId) => {
      const res = await bridgeCall('charactersImport', {
        files,
        preview: true,
        ...(orderCharacterId === undefined ? {} : { promptOrderCharacterId: orderCharacterId }),
      })
      if (!res.ok) return { kind: 'error', message: res.message ?? 'settings bridge unavailable' }
      const value = res.value
      if (value.state === 'needs-order-selection') return { kind: 'candidates', candidates: value.candidates ?? [] }
      return {
        kind: 'ready',
        ...(value.sourceDigest === undefined ? {} : { sourceDigest: value.sourceDigest }),
        ...(value.previewRevision === undefined ? {} : { previewRevision: value.previewRevision }),
        ...(value.report === undefined ? {} : { report: value.report }),
      }
    },
    commit: async (preview) => {
      const res = await bridgeCall('charactersImport', {
        files: preview.files,
        expectedSourceDigest: preview.sourceDigest,
        ...(preview.previewRevision === undefined ? {} : { expectedPreviewRevision: preview.previewRevision }),
        ...(preview.groupCharacterId === undefined ? {} : { promptOrderCharacterId: preview.groupCharacterId }),
      })
      if (res.ok) return { ok: true, ...(res.value.name === undefined ? {} : { label: res.value.name }) }
      return {
        ok: false,
        stale: res.code === 'characters-preview-stale',
        message: res.message ?? 'settings bridge unavailable',
      }
    },
    onCommitted: async (label) => {
      store.showNotice('ok', t('characters.notice.stored', { name: label ?? '' }))
      await loadCharacters()
    },
    onError: (message, stale) => {
      store.showNotice('error', t('characters.notice.submitFailed', { reason: stale ? t('importPreview.stale') : message }))
    },
  })

  /** 导入角色卡：PNG 图片按魔数识别并走原始文件流，大 JSON 也走流式端点。 */
  const importCard = async (files: File[]): Promise<void> => {
    if (files.length === 0 || preparing) return
    setPreparing(true)
    try {
      const jsonFiles: File[] = []
      for (const file of files) {
        const header = await file.slice(0, 8).arrayBuffer()
        if (isPngSignature(header)) {
          const res = await bridgeUpload(file, file.name)
          if (res.ok) store.showNotice('ok', t('characters.notice.stored', { name: res.value.name }))
          else store.showNotice('error', t('characters.notice.storeFailed', { reason: res.message ?? 'settings bridge unavailable' }))
          continue
        }
        if (!/\.json$/i.test(file.name)) {
          store.showNotice('error', t('characters.notice.unsupported', { name: file.name }))
          continue
        }
        // 大 JSON 走流式端点（无预览）；其余先预览报告，确认后才入库。
        if (shouldStreamJsonFile(file)) {
          const streamed = await bridgeUpload(file, file.name)
          if (streamed.ok) store.showNotice('ok', t('characters.notice.stored', { name: streamed.value.name }))
          else store.showNotice('error', t('characters.notice.storeFailed', { reason: streamed.message ?? 'settings bridge unavailable' }))
          continue
        }
        jsonFiles.push(file)
      }
      if (jsonFiles.length > 0) {
        const entries: Array<{ path: string; content: string }> = []
        for (const file of jsonFiles) entries.push({ path: file.name, content: await file.text() })
        await flow.run(entries, 'files')
      }
      await loadCharacters()
    } catch (error) {
      store.showNotice('error', t('characters.notice.importFailed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setPreparing(false)
    }
  }

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
      {(flow.preview !== undefined || flow.candidates !== undefined) && (
        <ImportPreviewCard
          t={t}
          preview={flow.preview}
          candidates={flow.candidates}
          busy={flow.phase === 'submitting'}
          confirmDisabled={flow.phase !== 'confirming'}
          onGroupChange={flow.chooseGroup}
          onConfirm={flow.confirm}
          onCancel={flow.cancel}
        />
      )}
      <div ref={importArea} className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>{t('characters.library.title')}</strong>
            <small>{t('characters.library.hint')}</small>
          </span>
          <span className={ui.inlineControls}>
            <ImportFileButton
              label={t('characters.importImage')}
              busyLabel={t('characters.importing')}
              busy={preparing || flow.phase !== 'idle'}
              accept=".png,image/png"
              multiple
              ariaLabel={t('characters.pickImage.aria')}
              className={ui.primaryPill}
              onFiles={(files) => void importCard(files)}
            />
            <ImportFileButton
              label={t('characters.importJson')}
              busyLabel={t('characters.importing')}
              busy={preparing || flow.phase !== 'idle'}
              accept=".json"
              multiple
              ariaLabel={t('characters.pickJson.aria')}
              className={ui.pillButton}
              onFiles={(files) => void importCard(files)}
            />
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
            <button type="button" className={ui.pillButton} onClick={() => {
              const input = importArea.current?.querySelector<HTMLInputElement>('input[type="file"]')
              input?.click()
            }}>{t('characters.importImage')}</button>
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
                      <IconFolderOpenOutline16 />
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
                        <IconTrashOutline16 />
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
