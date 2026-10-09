/** 模块切换器：模块全部在用户目录（首次启动种子化），列表点击切换；新建 = 从内置模板复制还原。 */
import { memo, useRef, useState, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { EMPTY_FIELDS } from '../../data/prompt-tool-fields.ts'
import clsx from 'clsx'
import { IconCopyOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '../../ui/icons.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import { previewAsset, commitAsset } from '../../data/asset-import.ts'
import { hasWorkspaceDrafts } from '../../data/workspace-drafts.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { ModuleSummary } from '../../../shared/bridge-contract.ts'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ImportDialog } from '../../ui/ImportDialog.tsx'
import { ModuleExportDialog } from './ModuleExportDialog.tsx'
import { useImportPreviewFlow } from '../../data/use-import-preview-flow.ts'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import sharedCss from '../../ui/controls.module.css'

const styles = sharedCss

export const ModuleSwitcher = memo(function ModuleSwitcher(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const modules = store.meta.modules ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<{ id: string; name: string }>()
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)

  // 预览流程（与角色卡 JSON 导入共用同一状态机）：确认回传来源摘要 + 预览版本。
  const flow = useImportPreviewFlow({
    directoryTooLarge: t('assetImport.directoryTooLarge'),
    preview: (request) => previewAsset('importModulePackage', request),
    commit: async (preview) => {
      if (preview.overwrite && preview.summary?.targetId === store.fields.moduleId) {
        if (hasWorkspaceDrafts(store.editorDrafts, store.fields.moduleId)) return { ok: false, message: t('assetImport.draftBlocked') }
        if (store.dirtySwitches) return { ok: false, message: t('assetImport.draftBlocked') }
      }
      return commitAsset('importModulePackage', preview)
    },
    onCommitted: async (label) => {
      store.showNotice('ok', t('moduleSwitcher.notice.imported', { id: label ?? '' }))
      if (await store.load() === EMPTY_FIELDS) throw new Error(t('card.operationFailed'))
    },
    onError: (message, stale) => {
      store.showNotice('error', t('moduleSwitcher.notice.importFailed', { reason: stale ? t('importPreview.stale') : message }))
    },
  })

  /** 删除模块（物理删除用户目录副本；插件目录模板保留，可经「新建模块」还原）。 */
  const deleteModule = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleDelete', { id })
    if (res.ok) {
      store.showNotice('ok', t('moduleSwitcher.notice.deleted', { id }))
      await store.load()
      setConfirmingDelete((current) => current === id ? undefined : current)
    } else {
      throw new Error(t('moduleSwitcher.notice.deleteFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 复制模块：用户目录完整副本，id 自动递增（<id>-copy / <id>-copy-2 / …）。 */
  const duplicateModule = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleDuplicate', { id })
    if (res.ok) {
      store.showNotice('ok', t('moduleSwitcher.notice.duplicated', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('moduleSwitcher.notice.duplicateFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 打开模块文件夹（宿主系统文件管理器；失败时提示路径）。 */
  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgeCall('moduleOpen', { id })
    if (res.ok) {
      store.showNotice('ok', t('moduleSwitcher.notice.opened', { path: res.value.path }))
    } else {
      store.showNotice('error', t('moduleSwitcher.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 新建：从插件目录模板复制到用户目录（还原/自定义起点）；自定义入口重名自动递增。 */
  const cloneModule = async (id: string, autoSuffix = false): Promise<void> => {
    const res = await bridgeCall('moduleClone', { id, autoSuffix })
    if (res.ok) {
      setPickerOpen(false)
      store.showNotice('ok', t('moduleSwitcher.notice.cloned', { id: res.value.id }))
      await store.load()
    } else {
      store.showNotice('error', t('moduleSwitcher.notice.cloneFailed', { reason: res.message ?? 'settings bridge unavailable' }))
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
        ? t('moduleSwitcher.notice.enabled', { id })
        : t('moduleSwitcher.notice.disabled', { id }))
      await store.load()
    } else {
      store.showNotice('error', t('moduleSwitcher.notice.enableFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.inlineControls}>
          <Button ref={pickerAnchorRef} shape="pill" variant="primary" size="md" onClick={() => setPickerOpen(true)}>{t('moduleSwitcher.new')}</Button>
          <Button shape="pill" variant="outline" size="md" onClick={() => setImportOpen(true)}>{t('assetImport.moduleTitle')}…</Button>
          {/* 模块运行总闸：与新建/导入同排、靠最右，说明文字在开关左侧常驻。 */}
          <span className={styles.moduleGlobalSwitch}>
            <span>{t('modules.globalSwitch')}</span>
            <Switch checked={fields.modulesEnabled} label={t('modules.globalSwitch')}
              disabled={store.moduleFacts?.editable !== true} onChange={() => store.toggle('modulesEnabled')} />
          </span>
        </span>
      </div>
      {importOpen && <ImportDialog t={t} destination="module" {...flow} targets={modules}
        onFiles={(files) => { void flow.run(files) }} onChoices={flow.updateChoices} onConfirm={() => { void flow.confirm() }}
        onClose={() => { flow.cancel(); setImportOpen(false) }} onReset={flow.cancel} onSkip={flow.skip} onEnd={flow.end}
        onRepreview={() => { void flow.repreview() }} onRefresh={() => { void flow.retryRefresh() }}
        onUse={flow.resultLabel === undefined ? undefined : () => { store.setModuleId(flow.resultLabel!); flow.cancel(); setImportOpen(false) }} />}
      {exportTarget && <ModuleExportDialog t={t} module={exportTarget} onClose={() => setExportTarget(undefined)} />}
      <div className={styles.moduleGrid}>
        {modules.length === 0 ? (
          <p className={styles.readOnly} role="status">{t('moduleSwitcher.empty')}</p>
        ) : modules.map((module) => renderCard(module))}
      </div>
      {pickerOpen && (
        <DialogSurface title={t('moduleSwitcher.dialog.title')} closeLabel={t('moduleSwitcher.dialog.close')} anchorRef={pickerAnchorRef} onClose={() => setPickerOpen(false)}>
          {templates.length === 0 && <p className={styles.configFieldHint}>{t('moduleSwitcher.dialog.noTemplates')}</p>}
          {templates.map((template) => (
            <HintTooltip key={template.id} label={t('moduleSwitcher.template.hint', { id: template.id })}>
              <button type="button" className={styles.templateModalItem} onClick={() => void cloneModule(template.id)}>
                <strong>{template.name}</strong>
                <small>{template.id}</small>
              </button>
            </HintTooltip>
          ))}
        </DialogSurface>
      )}
    </div>
  )

  function renderCard(module: ModuleSummary): ReactNode {
    const active = fields.moduleId === module.id
    const confirming = confirmingDelete === module.id
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = module.renderable === false || module.broken !== undefined
    return (
      <article key={module.id} className={clsx(styles.moduleCard, blocked && styles.moduleCardBlocked)}
        data-active={active ? '' : undefined}>
        <div className={styles.moduleCardBody}>
          <span className={styles.moduleCardHead}>
            <strong className={styles.moduleCardName}>{module.name}</strong>
            {module.enabled === true && !blocked && <StatusBadge className={styles.moduleHeadBadge} tone="success" label={t('moduleSwitcher.enabled')} />}
            {blocked && <span className={styles.moduleBlocked}>{t('moduleSwitcher.blocked')}</span>}
          </span>
          {module.description !== undefined && module.description.length > 0
            && <p className={styles.moduleCardDesc}>{module.description}</p>}
          {module.broken !== undefined && <p className={styles.moduleBlocked} role="alert">{module.broken}</p>}
          <code className={styles.moduleCardId}>{module.id}</code>
        </div>
        <span className={styles.moduleCardFooter}>
          {/* 开关与卡头徽章都表达启用状态；编辑目标独立由边框高亮（data-active）表达。 */}
          <Switch className={styles.moduleActivate}
            checked={module.enabled === true}
            disabled={blocked}
            label={blocked
              ? module.broken ?? t('moduleSwitcher.card.blocked.hint')
              : module.enabled === true
                ? t('moduleSwitcher.card.disable.hint', { name: module.name })
                : t('moduleSwitcher.card.enable.hint', { name: module.name })}
            onChange={(next) => void setModuleEnabled(module.id, next)} />
          <HintTooltip label={t('moduleSwitcher.export')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.export.aria', { name: module.name })}
              onClick={() => setExportTarget({ id: module.id, name: module.name })}>
              <IconDownloadOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('moduleSwitcher.duplicate.label')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.duplicate.aria', { name: module.name })}
              onClick={() => void duplicateModule(module.id)}>
              <IconCopyOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('moduleSwitcher.open.label')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.open.aria', { name: module.name })}
              onClick={() => void openLocation(module.id)}>
              <IconFolderOpenOutlineRegular />
            </button>
          </HintTooltip>
          {confirming && (
            <ConfirmDialog title={t('card.deleteTitle', { name: module.name })}
              description={t('moduleSwitcher.delete.description', { name: module.name })}
              confirmLabel={t('moduleSwitcher.delete.confirm')} cancelLabel={t('moduleSwitcher.delete.cancel')}
              onConfirm={() => deleteModule(module.id)} onCancel={() => setConfirmingDelete((current) => current === module.id ? undefined : current)} />
          )}
          {(
            <HintTooltip label={active ? t('moduleSwitcher.delete.hintActive') : t('moduleSwitcher.delete.hint')}>
              <button type="button" className={styles.moduleIconButton}
                aria-label={t('moduleSwitcher.delete.aria', { name: module.name })}
                disabled={active}
                onClick={() => setConfirmingDelete(module.id)}>
                <IconTrashOutlineRegular />
              </button>
            </HintTooltip>
          )}
        </span>
      </article>
    )
  }
})
