/** 预设切换器：预设全部在用户目录（首次启动种子化），列表点击切换；新建 = 从内置模板复制还原。 */
import { memo, useRef, useState, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import clsx from 'clsx'
import { IconCopyOutline16, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from '../../data/bridge-client.ts'
import { readImportFiles } from '../../data/import-files.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './presets.module.css'

const styles = { ...sharedCss, ...featureCss }

export const PresetSwitcher = memo(function PresetSwitcher(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const presets = store.meta.presets ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [importing, setImporting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)

  /** 上传预设包：path 为相对路径（preset.yml 或文件夹内文件），服务端按 id 归入用户预设目录。 */
  const uploadPreset = async (entries: Array<{ path: string; content: string }>): Promise<void> => {
    if (entries.length === 0) return
    setImporting(true)
    try {
      const res = await bridgeCall('importPresetPackage', { files: entries })
      if (res.ok) {
        store.showNotice('ok', t('presetSwitcher.notice.imported', { id: res.value.id }))
        await store.load()
      } else {
        store.showNotice('error', t('presetSwitcher.notice.importFailed', { reason: res.message ?? 'settings bridge unavailable' }))
      }
    } finally {
      setImporting(false)
    }
  }

  /** 导入单个配置文件：preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json（服务端按扩展名分流）。 */
  const pickPresetYaml = (files: File[]): void => {
    const file = files[0]
    if (file === undefined) return
    void (async () => {
      const [entry] = await readImportFiles([file], 'text')
      if (entry === undefined) return
      await uploadPreset([{ ...entry, path: /\.json$/i.test(entry.path) ? entry.path : 'preset.yml' }])
    })()
  }

  /** 导入整个预设文件夹（webkitdirectory；传原始相对路径，顶层目录段由服务端剥离）。 */
  const pickPresetDir = (files: File[]): void => {
    if (files.length === 0) return
    void (async () => {
      await uploadPreset(await readImportFiles(files, 'text'))
    })()
  }

  /** 导出当前预设为单文件配置（浏览器下载，可保存到任意目录）。 */
  const exportPreset = async (): Promise<void> => {
    const res = await bridgeCall('exportPreset', { id: fields.presetTemplate })
    if (!res.ok) {
      store.showNotice('error', t('presetSwitcher.notice.exportFailed', { reason: res.message ?? 'settings bridge unavailable' }))
      return
    }
    const blob = new Blob([res.value.content], { type: 'application/yaml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${res.value.id}.preset.yml`
    anchor.click()
    URL.revokeObjectURL(url)
    store.showNotice('ok', t('presetSwitcher.notice.exported', { file: `${res.value.id}.preset.yml` }))
  }

  /** 删除预设（物理删除用户目录副本；插件目录模板保留，可经「新建预设」还原）。 */
  const deletePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetDelete', { id })
    if (res.ok) {
      setConfirmingDelete(undefined)
      store.showNotice('ok', t('presetSwitcher.notice.deleted', { id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.deleteFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 复制预设：用户目录完整副本，id 自动递增（<id>-copy / <id>-copy-2 / …）。 */
  const duplicatePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetDuplicate', { id })
    if (res.ok) {
      store.showNotice('ok', t('presetSwitcher.notice.duplicated', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.duplicateFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 打开预设文件夹（宿主系统文件管理器；失败时提示路径）。 */
  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetOpen', { id })
    if (res.ok) {
      store.showNotice('ok', t('presetSwitcher.notice.opened', { path: res.value.path }))
    } else {
      store.showNotice('error', t('presetSwitcher.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 新建：从插件目录模板复制到用户目录（还原/自定义起点）；自定义入口重名自动递增。 */
  const clonePreset = async (id: string, autoSuffix = false): Promise<void> => {
    const res = await bridgeCall('presetClone', { id, autoSuffix })
    if (res.ok) {
      setPickerOpen(false)
      store.showNotice('ok', t('presetSwitcher.notice.cloned', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('presetSwitcher.notice.cloneFailed', { reason: res.message ?? 'settings bridge unavailable' }))
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
          <ImportFileButton
            label={t('presetSwitcher.import')}
            busyLabel={t('presetSwitcher.importing')}
            busy={importing}
            accept=".yml,.yaml,.json"
            ariaLabel={t('presetSwitcher.import.aria')}
            className={styles.pillButton}
            onFiles={pickPresetYaml}
          />
          <ImportFileButton
            label={t('presetSwitcher.importDir')}
            busyLabel={t('presetSwitcher.importing')}
            busy={importing}
            directory
            ariaLabel={t('presetSwitcher.importDir.aria')}
            className={styles.pillButton}
            onFiles={pickPresetDir}
          />
          <button type="button" className={styles.pillButton} onClick={() => void exportPreset()}>
            {t('presetSwitcher.export')}
          </button>
        </span>
      </div>
      <div className={styles.presetGrid}>
        {presets.length === 0 ? (
          <p className={styles.readOnly} role="status">{t('presetSwitcher.empty')}</p>
        ) : presets.map((preset) => renderCard(preset))}
      </div>
      {pickerOpen && (
        <DialogSurface title={t('presetSwitcher.dialog.title')} closeLabel={t('presetSwitcher.dialog.close')} anchorRef={pickerAnchorRef} onClose={() => setPickerOpen(false)}>
          {templates.length === 0 && <p className={styles.configFieldHint}>{t('presetSwitcher.dialog.noTemplates')}</p>}
          <HintTooltip label={t('presetSwitcher.custom.hint')}>
            <button type="button" className={styles.templateModalItem} data-custom
              onClick={() => void clonePreset('custom', true)}>
              <strong>{t('presetSwitcher.custom.title')}</strong>
              <small>{t('presetSwitcher.custom.detail')}</small>
            </button>
          </HintTooltip>
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

  function renderCard(preset: { id: string; name: string; description?: string; renderable?: boolean }): ReactNode {
    const active = fields.presetTemplate === preset.id
    const confirming = confirmingDelete === preset.id
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = preset.renderable === false
    return (
      <div key={preset.id} className={clsx(styles.presetCard, blocked && styles.presetCardBlocked)}
        data-active={active ? '' : undefined}>
        <HintTooltip label={blocked
            ? t('presetSwitcher.card.blocked.hint')
            : active ? t('presetSwitcher.card.active.hint') : t('presetSwitcher.card.switch.hint', { name: preset.name })}>
          <button type="button" className={styles.presetCardMain} disabled={blocked}
            onClick={() => store.setPresetTemplate(preset.id)}>
            <span className={styles.presetCardHead}>
              <strong className={styles.presetCardName}>{preset.name}</strong>
              {active && <StatusBadge className={styles.presetHeadBadge} tone="success" label={t('presetSwitcher.badge.active')} />}
              {blocked && <span className={styles.presetBlocked}>{t('presetSwitcher.blocked')}</span>}
            </span>
            {preset.description !== undefined && preset.description.length > 0
              && <p className={styles.presetCardDesc}>{preset.description}</p>}
            <code className={styles.presetCardId}>{preset.id}</code>
          </button>
        </HintTooltip>
        <span className={styles.presetCardFooter}>
          <HintTooltip label={t('presetSwitcher.duplicate.label')}>
            <button type="button" className={styles.presetIconButton}
              aria-label={t('presetSwitcher.duplicate.aria', { name: preset.name })}
              onClick={() => void duplicatePreset(preset.id)}>
              <IconCopyOutline16 />
            </button>
          </HintTooltip>
          <HintTooltip label={t('presetSwitcher.open.label')}>
            <button type="button" className={styles.presetIconButton}
              aria-label={t('presetSwitcher.open.aria', { name: preset.name })}
              onClick={() => void openLocation(preset.id)}>
              <IconFolderOpenOutline16 />
            </button>
          </HintTooltip>
          {confirming ? (
            <span className={styles.presetCardActions}>
              <HintTooltip label={t('presetSwitcher.delete.confirmHint')}>
                <button type="button" className={styles.pillButton} data-danger disabled={active}
                  onClick={() => void deletePreset(preset.id)}>{t('presetSwitcher.delete.confirm')}</button>
              </HintTooltip>
              <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(undefined)}>{t('presetSwitcher.delete.cancel')}</button>
            </span>
          ) : (
            <HintTooltip label={active ? t('presetSwitcher.delete.hintActive') : t('presetSwitcher.delete.hint')}>
              <button type="button" className={styles.pillButton} data-danger disabled={active}
                onClick={() => setConfirmingDelete(preset.id)}>{t('presetSwitcher.delete')}</button>
            </HintTooltip>
          )}
        </span>
      </div>
    )
  }
})
