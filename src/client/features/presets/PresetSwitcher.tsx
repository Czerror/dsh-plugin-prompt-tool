/** 预设切换器：预设全部在用户目录（首次启动种子化），列表点击切换；新建 = 从内置模板复制还原。 */
import { memo, useRef, useState, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { EMPTY_FIELDS } from '../../data/prompt-tool-fields.ts'
import clsx from 'clsx'
import { IconCopyOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '../../ui/icons.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import { previewAsset, commitAsset } from '../../data/asset-import.ts'
import { hasWorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { deepEqual } from '../../data/dirty-state.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PresetSummary } from '../../../shared/bridge-contract.ts'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ImportDialog } from '../../ui/ImportDialog.tsx'
import { PresetExportDialog } from './PresetExportDialog.tsx'
import { useImportPreviewFlow } from '../../data/use-import-preview-flow.ts'
import { Switch } from '../../ui/Switch.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './presets.module.css'

const styles = { ...sharedCss, ...featureCss }

export const PresetSwitcher = memo(function PresetSwitcher(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const presets = store.meta.presets ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<{ id: string; name: string }>()
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)

  // 预览流程（与角色卡 JSON 导入共用同一状态机）：确认回传来源摘要 + 预览版本。
  const flow = useImportPreviewFlow({
    directoryTooLarge: t('assetImport.directoryTooLarge'),
    preview: (request) => previewAsset('importPresetPackage', request),
    commit: async (preview) => {
      if (preview.overwrite && preview.summary?.targetId === store.fields.presetTemplate) {
        if (hasWorkspaceDrafts(store.editorDrafts, store.fields.presetTemplate)) return { ok: false, message: t('assetImport.draftBlocked') }
        const presetConfigs = store.fields.promptConfigs.filter((config) => config.origin?.kind !== 'instruction-file')
        const savedConfigs = store.savedConfigs.filter((config) => config.origin?.kind !== 'instruction-file')
        if (!deepEqual(presetConfigs, savedConfigs)) {
          if (!await store.persistConfigs(store.fields.promptConfigs, { includeInstructions: false, reload: false, rebuild: false })) return { ok: false, message: t('assetImport.draftBlocked') }
          return { ok: false, stale: true, message: t('importPreview.stale') }
        }
        if (store.dirtySwitches) return { ok: false, message: t('assetImport.draftBlocked') }
      }
      return commitAsset('importPresetPackage', preview)
    },
    onCommitted: async (label) => {
      store.showNotice('ok', t('presetSwitcher.notice.imported', { id: label ?? '' }))
      if (await store.load() === EMPTY_FIELDS) throw new Error(t('card.operationFailed'))
    },
    onError: (message, stale) => {
      store.showNotice('error', t('presetSwitcher.notice.importFailed', { reason: stale ? t('importPreview.stale') : message }))
    },
  })

  /** 删除预设（物理删除用户目录副本；插件目录模板保留，可经「新建预设」还原）。 */
  const deletePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleDelete', { id })
    if (res.ok) {
      store.showNotice('ok', t('presetSwitcher.notice.deleted', { id }))
      await store.load()
      setConfirmingDelete((current) => current === id ? undefined : current)
    } else {
      throw new Error(t('presetSwitcher.notice.deleteFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 复制预设：用户目录完整副本，id 自动递增（<id>-copy / <id>-copy-2 / …）。 */
  const duplicatePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleDuplicate', { id })
    if (res.ok) {
      store.showNotice('ok', t('presetSwitcher.notice.duplicated', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.duplicateFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 打开预设文件夹（宿主系统文件管理器；失败时提示路径）。 */
  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleOpen', { id })
    if (res.ok) {
      store.showNotice('ok', t('presetSwitcher.notice.opened', { path: res.value.path }))
    } else {
      store.showNotice('error', t('presetSwitcher.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 新建：从插件目录模板复制到用户目录（还原/自定义起点）；自定义入口重名自动递增。 */
  const clonePreset = async (id: string, autoSuffix = false): Promise<void> => {
    const res = await bridgeCall('moduleClone', { id, autoSuffix })
    if (res.ok) {
      setPickerOpen(false)
      store.showNotice('ok', t('presetSwitcher.notice.cloned', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.cloneFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /**
   * 启用/停用模块 = 改存储根 `config.yml` 的启用表。
   *
   * 启用即配装：打开 A、再打开 B 就是 A+B 的组合，追加 C 就是 A+B+C——每个模块各自
   * 贡献自己的配置与参数，互不合并。这是模块页唯一改变装配范围的动作。
   */
  const setModuleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const res = await bridgeCall('moduleEnable', { id, enabled })
    if (res.ok) {
      store.showNotice('ok', enabled
        ? t('presetSwitcher.notice.enabled', { id })
        : t('presetSwitcher.notice.disabled', { id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.enableFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>{t('presetSwitcher.title')}</strong>
          <small>{t('presetSwitcher.hint')}</small>
        </span>
        <span className={styles.inlineControls}>
          <button ref={pickerAnchorRef} type="button" className={styles.primaryPill} onClick={() => setPickerOpen(true)}>{t('presetSwitcher.new')}</button>
          <button type="button" className={styles.pillButton} onClick={() => setImportOpen(true)}>{t('assetImport.presetTitle')}…</button>
        </span>
      </div>
      {importOpen && <ImportDialog t={t} destination="preset" {...flow} targets={presets}
        onFiles={(files) => { void flow.run(files) }} onChoices={flow.updateChoices} onConfirm={() => { void flow.confirm() }}
        onClose={() => { flow.cancel(); setImportOpen(false) }} onReset={flow.cancel} onSkip={flow.skip} onEnd={flow.end}
        onRepreview={() => { void flow.repreview() }} onRefresh={() => { void flow.retryRefresh() }}
        onUse={flow.resultLabel === undefined ? undefined : () => { store.setPresetTemplate(flow.resultLabel!); flow.cancel(); setImportOpen(false) }} />}
      {exportTarget && <PresetExportDialog t={t} preset={exportTarget} onClose={() => setExportTarget(undefined)} />}
      <div className={styles.presetGrid}>
        {presets.length === 0 ? (
          <p className={styles.readOnly} role="status">{t('presetSwitcher.empty')}</p>
        ) : presets.map((preset) => renderCard(preset))}
      </div>
      {pickerOpen && (
        <DialogSurface title={t('presetSwitcher.dialog.title')} closeLabel={t('presetSwitcher.dialog.close')} anchorRef={pickerAnchorRef} onClose={() => setPickerOpen(false)}>
          {templates.length === 0 && <p className={styles.configFieldHint}>{t('presetSwitcher.dialog.noTemplates')}</p>}
          {templates.map((template) => (
            <HintTooltip key={template.id} label={t('presetSwitcher.template.hint', { id: template.id })}>
              <button type="button" className={styles.templateModalItem} onClick={() => void clonePreset(template.id)}>
                <strong>{template.name}</strong>
                <small>{template.id}</small>
              </button>
            </HintTooltip>
          ))}
        </DialogSurface>
      )}
    </div>
  )

  function renderCard(preset: PresetSummary): ReactNode {
    const active = fields.presetTemplate === preset.id
    const confirming = confirmingDelete === preset.id
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = preset.renderable === false || preset.broken !== undefined
    return (
      <article key={preset.id} className={clsx(styles.presetCard, blocked && styles.presetCardBlocked)}
        data-active={active ? '' : undefined}>
        <div className={styles.moduleCardBody}>
          <span className={styles.presetCardHead}>
            <strong className={styles.presetCardName}>{preset.name}</strong>
            {blocked && <span className={styles.presetBlocked}>{t('presetSwitcher.blocked')}</span>}
          </span>
          {preset.description !== undefined && preset.description.length > 0
            && <p className={styles.presetCardDesc}>{preset.description}</p>}
          {preset.broken !== undefined && <p className={styles.presetBlocked} role="alert">{preset.broken}</p>}
          <code className={styles.presetCardId}>{preset.id}</code>
        </div>
        <span className={styles.presetCardFooter}>
          {/* 滑动开关 = 启用表成员：开即参与运行时装配（N 个模块各贡献一份，互不合并）。
              卡头不再放「使用中」徽章；编辑目标只由卡片边框高亮（data-active）表达。 */}
          <Switch className={styles.presetActivate}
            checked={preset.enabled === true}
            disabled={blocked}
            label={blocked
              ? preset.broken ?? t('presetSwitcher.card.blocked.hint')
              : preset.enabled === true
                ? t('presetSwitcher.card.disable.hint', { name: preset.name })
                : t('presetSwitcher.card.enable.hint', { name: preset.name })}
            onChange={(next) => void setModuleEnabled(preset.id, next)} />
          <HintTooltip label={t('presetSwitcher.export')}>
            <button type="button" className={styles.presetIconButton}
              aria-label={t('presetSwitcher.export.aria', { name: preset.name })}
              onClick={() => setExportTarget({ id: preset.id, name: preset.name })}>
              <IconDownloadOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('presetSwitcher.duplicate.label')}>
            <button type="button" className={styles.presetIconButton}
              aria-label={t('presetSwitcher.duplicate.aria', { name: preset.name })}
              onClick={() => void duplicatePreset(preset.id)}>
              <IconCopyOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('presetSwitcher.open.label')}>
            <button type="button" className={styles.presetIconButton}
              aria-label={t('presetSwitcher.open.aria', { name: preset.name })}
              onClick={() => void openLocation(preset.id)}>
              <IconFolderOpenOutlineRegular />
            </button>
          </HintTooltip>
          {confirming && (
            <ConfirmDialog title={t('card.deleteTitle', { name: preset.name })}
              description={t('presetSwitcher.delete.description', { name: preset.name })}
              confirmLabel={t('presetSwitcher.delete.confirm')} cancelLabel={t('presetSwitcher.delete.cancel')}
              onConfirm={() => deletePreset(preset.id)} onCancel={() => setConfirmingDelete((current) => current === preset.id ? undefined : current)} />
          )}
          {(
            <HintTooltip label={active ? t('presetSwitcher.delete.hintActive') : t('presetSwitcher.delete.hint')}>
              <button type="button" className={styles.presetIconButton}
                aria-label={t('presetSwitcher.delete.aria', { name: preset.name })}
                disabled={active}
                onClick={() => setConfirmingDelete(preset.id)}>
                <IconTrashOutlineRegular />
              </button>
            </HintTooltip>
          )}
        </span>
      </article>
    )
  }
})
