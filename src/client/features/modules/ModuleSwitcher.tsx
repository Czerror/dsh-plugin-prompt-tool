/** 模块管理：名称与创建归模块页；规则编辑仍归主会话／子代理。 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
import { TextInput } from '../../ui/TextInput.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import sharedCss from '../../ui/controls.module.css'

const styles = sharedCss

function ModuleNameEditor(props: { module: ModuleSummary; t: PromptToolTranslate; onClose: () => void; onSaved: (publicationError?: string) => Promise<void> }): ReactNode {
  const { module, t } = props
  const [name, setName] = useState(module.name)
  const [revision, setRevision] = useState<string>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const activeRef = useRef(true)
  const baselineRef = useRef(module.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLSpanElement>(null)
  const errorId = useId()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    activeRef.current = true
    void bridgeCall('moduleName', {}, module.id).then((result) => {
      if (!active) return
      if (result.ok) { baselineRef.current = result.value.name; setName(result.value.name); setRevision(result.value.revision); setLoaded(true) }
      else setError(result.message ?? t('moduleSwitcher.name.readFailed'))
    })
    return () => { active = false; activeRef.current = false }
  }, [module.id, t])
  useEffect(() => { if (loaded) inputRef.current?.select() }, [loaded])
  const save = async (): Promise<void> => {
    if (!activeRef.current || revision === undefined || busyRef.current) return
    if (name.trim().length === 0) { setError(t('moduleSwitcher.name.required')); return }
    if (name.trim() === baselineRef.current) { close(); return }
    busyRef.current = true; setBusy(true); setError(undefined)
    const result = await bridgeCall('moduleName', { name, expectedRevision: revision, expectedModuleId: module.id }, module.id)
    if (result.ok) {
      activeRef.current = false
      await props.onSaved(result.value.publicationError)
    } else if (activeRef.current) {
      if (result.code === 'module-name-conflict' || result.code === 'rules-conflict') setRevision(undefined)
      setError(result.message ?? t('moduleSwitcher.name.saveFailed'))
      busyRef.current = false; setBusy(false)
    }
  }
  const reload = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const result = await bridgeCall('moduleName', {}, module.id)
    if (!activeRef.current) return
    if (result.ok) {
      if (!loaded) setName(result.value.name)
      baselineRef.current = result.value.name
      setRevision(result.value.revision); setLoaded(true); setError(undefined)
    } else setError(result.message ?? t('moduleSwitcher.name.readFailed'))
    busyRef.current = false; setBusy(false)
  }
  const close = (): void => { if (!busyRef.current) { activeRef.current = false; props.onClose() } }
  return <span ref={editorRef} className={styles.moduleNameEditor} aria-busy={busy || !loaded}>
    <TextInput ref={inputRef} value={name} autoFocus aria-label={t('moduleSwitcher.name.label')}
      aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : errorId}
      readOnly={busy || !loaded} onChange={(event) => { setName(event.target.value); if (revision !== undefined) setError(undefined) }}
      onBlur={(event) => {
        if (editorRef.current?.contains(event.relatedTarget)) return
        if (error === undefined) void save()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        event.preventDefault()
        if (event.key === 'Escape') close()
        else void save()
      }} />
    {error !== undefined && <span id={errorId} className={styles.configFieldHint} role="alert">{error}</span>}
    {error !== undefined && <span className={styles.inlineControls}>
      {revision === undefined && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void reload()}>{t('moduleSwitcher.name.reload')}</Button>}
      <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={close}>{t('moduleSwitcher.name.cancel')}</Button>
    </span>}
  </span>
}

export const ModuleSwitcher = memo(function ModuleSwitcher(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const modules = store.meta.modules ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<{ id: string; name: string }>()
  const [nameTarget, setNameTarget] = useState<ModuleSummary | undefined>()
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)

  // 预览流程（与角色卡 JSON 导入共用同一状态机）：确认回传来源摘要 + 预览版本。
  const flow = useImportPreviewFlow({
    directoryTooLarge: t('assetImport.directoryTooLarge'),
    preview: (request) => previewAsset('importModulePackage', request),
    commit: async (preview) => {
      // 覆盖导入会替换目标模块的定义：该模块自己的草稿还在时先拦住（不问任何会话级目标）。
      const targetId = preview.summary?.targetId
      if (preview.overwrite && targetId !== undefined) {
        if (hasWorkspaceDrafts(store.editorDrafts, targetId)) return { ok: false, message: t('assetImport.draftBlocked') }
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
    // 没有会话级「在用模块」：不带主语即无声明（「在用」保护在人设引用那一侧，服务端另有判据）。
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

  const createBlankModule = async (): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true; setCreating(true)
    try {
      const id = await store.createModule()
      if (id !== undefined) setPickerOpen(false)
    } finally { creatingRef.current = false; setCreating(false) }
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
          {/* 模块运行总闸：与新建/导入同排、靠最右，说明文字在开关左侧常驻。全局设置，无模块主语。 */}
          <span className={styles.moduleGlobalSwitch}>
            <span>{t('modules.globalSwitch')}</span>
            <Switch checked={fields.modulesEnabled} label={t('modules.globalSwitch')}
              onChange={() => store.toggle()} />
          </span>
        </span>
      </div>
      {importOpen && <ImportDialog t={t} destination="module" {...flow} targets={modules}
        onFiles={(files) => { void flow.run(files) }} onChoices={flow.updateChoices} onConfirm={() => { void flow.confirm() }}
        onClose={() => { flow.cancel(); setImportOpen(false) }} onReset={flow.cancel} onSkip={flow.skip} onEnd={flow.end}
        onRepreview={() => { void flow.repreview() }} onRefresh={() => { void flow.retryRefresh() }}
        onUse={flow.resultLabel === undefined ? undefined : () => { void setModuleEnabled(flow.resultLabel!, true); flow.cancel(); setImportOpen(false) }} />}
      {exportTarget && <ModuleExportDialog t={t} module={exportTarget} onClose={() => setExportTarget(undefined)} />}
      <div className={styles.moduleGrid}>
        {modules.length === 0 ? (
          <p className={styles.readOnly} role="status">{t('moduleSwitcher.empty')}</p>
        ) : modules.map((module) => renderCard(module))}
      </div>
      {pickerOpen && (
        <DialogSurface title={t('moduleSwitcher.dialog.title')} closeLabel={t('moduleSwitcher.dialog.close')} anchorRef={pickerAnchorRef} onClose={() => setPickerOpen(false)}>
          <button type="button" className={styles.templateModalItem} disabled={creating} onClick={() => void createBlankModule()}>
            <strong>{t('moduleSwitcher.custom.title')}</strong>
            <small>{t('moduleSwitcher.custom.detail')}</small>
          </button>
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
    const confirming = confirmingDelete === module.id
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = module.renderable === false || module.broken !== undefined
    return (
      <article key={module.id} className={clsx(styles.moduleCard, blocked && styles.moduleCardBlocked)}>
        <div className={styles.moduleCardBody}>
          <span className={styles.moduleCardHead}>
            {nameTarget?.id === module.id ? <ModuleNameEditor key={module.id} module={nameTarget} t={t}
              onClose={() => setNameTarget(current => current?.id === module.id ? undefined : current)} onSaved={async (publicationError) => {
                setNameTarget(current => current?.id === module.id ? undefined : current)
                const refreshed = await store.load({ silent: true })
                if (publicationError !== undefined) store.showNotice('error', t('moduleSwitcher.name.savedPending', { reason: publicationError }))
                else if (refreshed !== EMPTY_FIELDS) store.showNotice('ok', t('moduleSwitcher.name.saved'))
              }} /> : <button type="button" className={clsx(styles.moduleCardName, styles.moduleNameTrigger)}
              disabled={nameTarget !== undefined || blocked || module.user !== true || module.facts?.editable !== true}
              aria-label={t('moduleSwitcher.name.editAria', { name: module.name })} onClick={() => setNameTarget(module)}>{module.name}</button>}
            {module.enabled === true && !blocked && <StatusBadge className={styles.moduleHeadBadge} tone="success" label={t('moduleSwitcher.enabled')} />}
            {blocked && <span className={styles.moduleBlocked}>{t('moduleSwitcher.blocked')}</span>}
          </span>
          {module.description !== undefined && module.description.length > 0
            && <p className={styles.moduleCardDesc}>{module.description}</p>}
          {module.broken !== undefined && <p className={styles.moduleBlocked} role="alert">{module.broken}</p>}
          <code className={styles.moduleCardId}>{module.id}</code>
        </div>
        <span className={styles.moduleCardFooter}>
          {/* 开关与卡头徽章都表达启用状态；模块页只回答「谁参与装配」，没有「当前模块」高亮。 */}
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
            <HintTooltip label={t('moduleSwitcher.delete.hint')}>
              <button type="button" className={styles.moduleIconButton}
                aria-label={t('moduleSwitcher.delete.aria', { name: module.name })}
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
