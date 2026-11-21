/** 浏览范围的模块卡片和独立写入对话框。 */
import { memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { IconChevronDownOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '../../ui/icons.tsx'
import type { ModuleActions, ModuleActionResult } from '../../data/module-actions.ts'
import { previewAsset, commitAsset } from '../../data/asset-import.ts'
import { poolDirty } from '../../data/workspace-drafts.ts'
import type { DraftsPort, ModuleActionsPort, ModuleFactsPort, NoticePort } from '../../data/store-ports.ts'
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
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import styles from '../../ui/controls.module.css'
import css from './module-picker-cards.module.css'

function ModuleNameEditor(props: { module: ModuleSummary; actions: ModuleActions; t: PromptToolTranslate; onClose: () => void; onSaved: (publication?: { pending: boolean; error?: string }) => void }): ReactNode {
  const { module, t } = props
  const [name, setName] = useState(module.name)
  const [revision, setRevision] = useState<string>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const activeRef = useRef(true)
  const baselineRef = useRef(module.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    activeRef.current = true
    void props.actions.readName(module.id).then((result) => {
      if (!active) return
      if (result.ok) { baselineRef.current = result.value.name; setName(result.value.name); setRevision(result.value.revision); setLoaded(true) }
      else setError(result.message ?? t('moduleSwitcher.name.readFailed'))
    })
    return () => { active = false; activeRef.current = false }
  }, [module.id, props.actions, t])
  useEffect(() => { if (loaded) inputRef.current?.select() }, [loaded])
  const save = async (): Promise<void> => {
    if (!activeRef.current || revision === undefined || busyRef.current) return
    if (name.trim().length === 0) { setError(t('moduleSwitcher.name.required')); return }
    if (name.trim() === baselineRef.current) { close(); return }
    busyRef.current = true; setBusy(true); setError(undefined)
    const result = await props.actions.rename(module.id, name, revision)
    if (result.ok) {
      activeRef.current = false
      props.onSaved(result.publication ?? (result.refreshError === undefined ? undefined : { pending: true, error: t('moduleSwitcher.notice.refreshFailed') }))
    } else if (activeRef.current) {
      if (result.code === 'module-name-conflict' || result.code === 'rules-conflict') setRevision(undefined)
      setError(result.message ?? t('moduleSwitcher.name.saveFailed'))
      busyRef.current = false; setBusy(false)
    }
  }
  const reload = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const result = await props.actions.readName(module.id)
    if (!activeRef.current) return
    if (result.ok) {
      if (!loaded) setName(result.value.name)
      baselineRef.current = result.value.name
      setRevision(result.value.revision); setLoaded(true); setError(undefined)
    } else setError(result.message ?? t('moduleSwitcher.name.readFailed'))
    busyRef.current = false; setBusy(false)
  }
  const close = (): void => { if (!busyRef.current) { activeRef.current = false; props.onClose() } }
  return <DialogSurface title={t('moduleSwitcher.name.title')} closeLabel={t('moduleSwitcher.name.close')} initialFocusRef={inputRef} onClose={close}>
    <div className={styles.moduleNameEditor} aria-busy={busy || !loaded}>
    <TextInput ref={inputRef} value={name} aria-label={t('moduleSwitcher.name.label')}
      aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : errorId}
      readOnly={busy || !loaded} onChange={(event) => { setName(event.target.value); if (revision !== undefined) setError(undefined) }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        event.preventDefault()
        if (event.key === 'Escape') close()
        else void save()
      }} />
    {error !== undefined && <span id={errorId} className={styles.configFieldHint} role="alert">{error}</span>}
    <span className={styles.inlineControls}>
      {error !== undefined && revision === undefined && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void reload()}>{t('moduleSwitcher.name.reload')}</Button>}
      <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={close}>{t('moduleSwitcher.name.cancel')}</Button>
      <Button variant="primary" shape="pill" size="sm" disabled={busy || revision === undefined} onClick={() => void save()}>{t('moduleSwitcher.name.save')}</Button>
    </span>
    </div>
  </DialogSurface>
}

export const ModulePickerCards = memo(function ModulePickerCards(props: {
  store: ModuleActionsPort & ModuleFactsPort & NoticePort & DraftsPort
  t: PromptToolTranslate
  open: boolean
  query: string
  scope: string
  editingModule?: string
  onBrowse: (moduleId: string, ruleKey?: string) => void
}): ReactNode {
  const { store, t, open } = props
  const modulesEnabled = usePromptToolFields(store, value => value.modulesEnabled)
  const { subscribeEnable, getEnableState } = store.moduleActions
  const enableState = useSyncExternalStore(subscribeEnable, getEnableState, getEnableState)
  const modules = store.meta.modules ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [confirmingDelete, setConfirmingDelete] = useState<ModuleSummary>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<{ id: string; name: string }>()
  const [nameTarget, setNameTarget] = useState<ModuleSummary | undefined>()
  const [status, setStatus] = useState('all')
  const [expandedModule, setExpandedModule] = useState<string>()
  const query = props.query.trim().toLowerCase()
  const visibleModules = useMemo(() => {
    if (!open) return []
    if (!query && status === 'all') return modules
    return modules.filter(module => (!query || `${module.id} ${module.name} ${module.description ?? ''}`.toLowerCase().includes(query))
      && (status === 'all' || (module.enabled === true) === (status === 'on')))
  }, [modules, open, query, status])
  const [creating, setCreating] = useState(false)
  const [publicationRetry, setPublicationRetry] = useState<{ error?: string; run: () => Promise<ModuleActionResult<unknown>> }>()
  const creatingRef = useRef(false)
  const filtersRef = useRef<HTMLDivElement>(null)
  const report = (result: ModuleActionResult<unknown>, success: string, failure: string, retry?: () => Promise<ModuleActionResult<unknown>>): void => {
    if (!result.ok) { store.showNotice('error', failure); return }
    if (result.publication?.pending) {
      setPublicationRetry(retry === undefined ? undefined : { error: result.publication.error, run: retry })
      store.showNotice('error', result.publication.error ?? t('publication.pending'))
      return
    }
    store.showNotice(result.refreshError === undefined ? 'ok' : 'error', result.refreshError === undefined ? success : t('moduleSwitcher.notice.refreshFailed'))
  }

  // 预览流程（与角色卡 JSON 导入共用同一状态机）：确认回传来源摘要 + 预览版本。
  const flow = useImportPreviewFlow({
    directoryTooLarge: t('assetImport.directoryTooLarge'),
    preview: (request) => previewAsset('importModulePackage', request),
    commit: async (preview) => {
      // 覆盖导入会替换目标模块的定义：该模块自己的草稿还在时先拦住（不问任何会话级目标）。
      const targetId = preview.summary?.targetId
      if (preview.overwrite && targetId !== undefined) {
        if (poolDirty(store.editorDrafts, targetId)) return { ok: false, message: t('assetImport.draftBlocked') }
        if (store.dirtySwitches) return { ok: false, message: t('assetImport.draftBlocked') }
      }
      return commitAsset('importModulePackage', preview)
    },
    onCommitted: async (label) => {
      if (!await store.moduleActions.refresh()) throw new Error(t('moduleSwitcher.notice.refreshFailed'))
      store.showNotice('ok', t('moduleSwitcher.notice.imported', { id: label ?? '' }))
    },
    onError: (message, stale) => {
      store.showNotice('error', t('moduleSwitcher.notice.importFailed', { reason: stale ? t('importPreview.stale') : message }))
    },
  })

  /** 删除模块（物理删除用户目录副本；插件目录模板保留，可经「新建模块」还原）。 */
  const deleteModule = async (id: string): Promise<void> => {
    // 没有会话级「在用模块」：不带主语即无声明（「在用」保护在人设引用那一侧，服务端另有判据）。
    const res = await store.moduleActions.remove(id)
    if (res.ok) {
      if (res.publication?.pending) {
        setPublicationRetry({ error: res.publication.error, run: () => store.moduleActions.retryDelete(id) })
        store.showNotice('error', res.publication.error ?? t('publication.pending'))
        setConfirmingDelete((current) => current?.id === id ? undefined : current)
        return
      }
      const backupPath = res.value.backupPath
      // 服务端刷新失败也回 200（删除已提交）；客户端 refresh 失败则用顶层 refreshError。
      const refreshError = res.refreshError
      if (backupPath !== undefined || refreshError !== undefined) {
        const message = backupPath === undefined
          ? t('moduleSwitcher.notice.deleted', { id })
          : t('moduleSwitcher.notice.deletedWithBackup', { id, path: backupPath })
        store.showNotice(refreshError === undefined ? 'ok' : 'error',
          refreshError === undefined ? message : `${t('moduleSwitcher.notice.refreshFailed')} ${message}`)
      } else {
        report(res, t('moduleSwitcher.notice.deleted', { id }), '')
      }
      setConfirmingDelete((current) => current?.id === id ? undefined : current)
    } else {
      throw new Error(t('moduleSwitcher.notice.deleteFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 复制模块：用户目录完整副本，id 自动递增（<id>-copy / <id>-copy-2 / …）。 */
  const duplicateModule = async (id: string): Promise<void> => {
    const res = await store.moduleActions.duplicate(id)
    report(res, res.ok ? t('moduleSwitcher.notice.duplicated', { id: res.value.id }) : '',
      res.ok ? '' : t('moduleSwitcher.notice.duplicateFailed', { reason: res.message ?? 'settings bridge unavailable' }),
      () => store.moduleActions.retryDuplicate(id))
  }

  /** 打开模块文件夹（宿主系统文件管理器；失败时提示路径）。 */
  const openLocation = async (id: string): Promise<void> => {
    const res = await store.moduleActions.open(id)
    if (res.ok) {
      store.showNotice('ok', t('moduleSwitcher.notice.opened', { path: res.value.path }))
    } else {
      store.showNotice('error', t('moduleSwitcher.notice.openFailed', { reason: res.message ?? 'settings bridge unavailable' }))
    }
  }

  /** 新建：从插件目录模板复制到用户目录（还原/自定义起点）；自定义入口重名自动递增。 */
  const cloneModule = async (id: string, autoSuffix = false): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true; setCreating(true)
    try {
      const res = await store.moduleActions.clone(id, autoSuffix)
      if (res.ok) setPickerOpen(false)
      report(res, res.ok ? t('moduleSwitcher.notice.cloned', { id: res.value.id }) : '',
        res.ok ? '' : t('moduleSwitcher.notice.cloneFailed', { reason: res.message ?? 'settings bridge unavailable' }),
        () => store.moduleActions.retryClone(res.ok ? res.value.id : id))
    } finally { creatingRef.current = false; setCreating(false) }
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
   * 贡献自己的配置与参数，互不合并。
   */
  const setModuleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const { busy, refreshFailed } = getEnableState()
    if (busy || refreshFailed) return
    const action = document.activeElement
    const res = await store.moduleActions.enable(id, enabled)
    if (res.ok && !res.refreshError && !res.publication?.pending) {
      store.showNotice('ok', t(enabled ? 'moduleSwitcher.notice.enabled' : 'moduleSwitcher.notice.disabled', { id }))
    }
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body || !(action instanceof HTMLElement)) return
      if (action.getClientRects().length) action.focus({ preventScroll: true })
      else if (!action.isConnected) filtersRef.current?.querySelector<HTMLElement>('button[aria-pressed=true]')?.focus({ preventScroll: true })
    })
  }

  const deleteTarget = confirmingDelete
  return (
    <>
      {open && <div className={css.collection}>
      {store.meta.moduleWarnings?.map(message => <p key={message} role="alert" className={css.warning}>{message}</p>)}
      {publicationRetry && <PublicationNotice publication={{ pending: true, error: publicationRetry.error }}
        pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
        onRetry={() => { void publicationRetry.run().then((result) => {
          if (result.ok && result.publication?.pending !== true) {
            setPublicationRetry(undefined)
            store.showNotice('ok', t('publication.done'))
            return
          }
          const error = result.ok ? result.publication?.error : result.message
          setPublicationRetry({ error, run: publicationRetry.run })
          store.showNotice('error', error ?? t('publication.pending'))
        }) }} />}
      <label className={css.globalSwitch}>
        <span>{t('modules.globalSwitch')}</span>
        <Switch checked={modulesEnabled} label={t('modules.globalSwitch')} onChange={() => store.toggle()} />
      </label>
      {!modulesEnabled && <p className={css.warning}>{t('configs.readOnly.disabled')}</p>}
      <div ref={filtersRef} className={css.filters} role="group" aria-label={t('rules.moduleFilter')}>
        {[
          { value: 'all', label: t('rules.moduleAll') }, { value: 'on', label: t('moduleSwitcher.enabled') }, { value: 'off', label: t('rules.moduleDisabled') },
        ].map(option => <Button key={option.value} shape="pill" variant="outline" size="sm"
          aria-pressed={option.value === status} onClick={() => setStatus(option.value)}>{option.label}</Button>)}
      </div>
      <div className={css.toolbar}>
        <Button shape="pill" variant="primary" size="sm" aria-label={t('moduleSwitcher.new')} title={t('moduleSwitcher.new')} onClick={() => setPickerOpen(true)}>{t('configList.create')}</Button>
        <Button shape="pill" variant="outline" size="sm" aria-label={t('assetImport.moduleTitle')} title={t('assetImport.moduleTitle')} onClick={() => setImportOpen(true)}>{t('canvas.import')}</Button>
      </div>
      <div className={css.cards}>
        {visibleModules.length === 0
          ? <p className={styles.readOnly} role="status">{t('moduleSwitcher.empty')}</p>
          : visibleModules.map(renderCard)}
      </div>
      </div>}
      {importOpen && <ImportDialog t={t} {...flow} targets={modules}
        onFiles={(files) => { void flow.run(files) }} onChoices={flow.updateChoices} onConfirm={() => { void flow.confirm() }}
        onClose={() => { flow.cancel(); setImportOpen(false) }} onReset={flow.cancel} onSkip={flow.skip} onEnd={flow.end}
        onRepreview={() => { void flow.repreview() }} onRefresh={() => { void flow.retryRefresh() }}
        publication={flow.publication} onRetryPublication={() => { void flow.retryPublication() }}
        onUse={flow.resultLabel === undefined ? undefined : () => {
          if (flow.resultLabel !== undefined) props.onBrowse(flow.resultLabel)
          flow.cancel()
          setImportOpen(false)
        }} />}
      {exportTarget && <ModuleExportDialog t={t} module={exportTarget} onClose={() => setExportTarget(undefined)} />}
      {deleteTarget && <ConfirmDialog title={t('card.deleteTitle', { name: deleteTarget.name || deleteTarget.id })}
        description={t('moduleSwitcher.delete.description', { name: deleteTarget.name || deleteTarget.id })}
        confirmLabel={t('moduleSwitcher.delete.confirm')} cancelLabel={t('moduleSwitcher.delete.cancel')}
        onConfirm={() => deleteModule(deleteTarget.id)} onCancel={() => setConfirmingDelete(undefined)} />}
      {nameTarget && <ModuleNameEditor key={nameTarget.id} module={nameTarget} actions={store.moduleActions} t={t}
        onClose={() => setNameTarget(undefined)} onSaved={publication => {
          const { id } = nameTarget
          setNameTarget(undefined)
          if (publication?.pending) {
            setPublicationRetry({ error: publication.error, run: () => store.moduleActions.retryName(id) })
            store.showNotice('error', publication.error ?? t('publication.pending'))
          } else store.showNotice('ok', t('moduleSwitcher.name.saved'))
        }} />}
      {pickerOpen && (
        <DialogSurface title={t('moduleSwitcher.dialog.title')} closeLabel={t('moduleSwitcher.dialog.close')} onClose={() => { if (!creatingRef.current) setPickerOpen(false) }}>
          <button type="button" className={styles.templateModalItem} disabled={creating} onClick={() => void createBlankModule()}>
            <strong>{t('moduleSwitcher.custom.title')}</strong>
            <small>{t('moduleSwitcher.custom.detail')}</small>
          </button>
          {templates.length === 0 && <p className={styles.configFieldHint}>{t('moduleSwitcher.dialog.noTemplates')}</p>}
          {templates.map((template) => (
            <HintTooltip key={template.id} label={t('moduleSwitcher.template.hint', { id: template.id })}>
              <button type="button" className={styles.templateModalItem} disabled={creating} onClick={() => void cloneModule(template.id)}>
                <strong>{template.name}</strong>
                <small>{template.id}</small>
              </button>
            </HintTooltip>
          ))}
        </DialogSurface>
      )}
    </>
  )

  function renderCard(module: ModuleSummary): ReactNode {
    const expanded = expandedModule === module.id
    const draft = expanded ? store.editorDrafts.rules.get(module.id) : undefined
    const rules = draft?.loaded ? draft.entries.filter(entry => !entry.deleted) : undefined
    const name = module.name || module.id
    const enabled = module.enabled === true
    const current = props.scope === `module:${module.id}`
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = module.renderable === false || module.broken !== undefined
    return (
      <article key={module.id} className={css.card} data-active={current || undefined}>
        <div className={css.row}>
          <button className={css.name} type="button" data-module-browse={module.id}
            title={name === module.id ? name : `${name} · ${module.id}`} aria-current={current || undefined} disabled={blocked}
            onClick={() => props.onBrowse(module.id)}>
            <strong>{name}</strong>
          </button>
          <div className={css.switchLabel}>
            <Switch checked={enabled} disabled={blocked || enableState.busy || enableState.refreshFailed}
              label={t('rules.moduleSwitchLabel', { name })} onChange={next => void setModuleEnabled(module.id, next)} />
          </div>
          <Button icon aria-label={t('moduleSwitcher.moreAria', { name })} aria-expanded={expanded}
            onClick={() => setExpandedModule(expanded ? undefined : module.id)}>
            <IconChevronDownOutlineRegular />
          </Button>
        </div>
        {blocked && <p className={css.warning}>{module.broken ?? t('moduleSwitcher.card.blocked.hint')}</p>}
        {expanded && <div className={css.details}>
          {module.description && <p>{module.description}</p>}
          <p>{rules ? t('rules.moduleRuleCount', { count: rules.length }) : t('rules.moduleRulesOnOpen')}</p>
          {rules !== undefined && rules.length > 0 && <ul className={css.rules}>{rules.slice(0, 3).map(entry =>
            <li key={entry.key}><button type="button" disabled={blocked} title={entry.value.name || entry.value.id}
              onClick={() => props.onBrowse(module.id, entry.key)}>{entry.value.name || entry.value.id}</button></li>)}</ul>}
          <div className={css.toolbar}>
          <Button variant="outline" shape="pill" size="sm" disabled={blocked || module.user !== true || module.facts?.editable !== true}
            onClick={() => setNameTarget(module)}>{t('moduleSwitcher.name.edit')}</Button>
          <HintTooltip label={t('moduleSwitcher.export')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.export.aria', { name })}
              onClick={() => setExportTarget({ id: module.id, name })}>
              <IconDownloadOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('moduleSwitcher.duplicate.label')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.duplicate.aria', { name })}
              onClick={() => void duplicateModule(module.id)}>
              <IconCopyOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('moduleSwitcher.open.label')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.open.aria', { name })}
              onClick={() => void openLocation(module.id)}>
              <IconFolderOpenOutlineRegular />
            </button>
          </HintTooltip>
          <HintTooltip label={t('moduleSwitcher.delete.hint')}>
            <button type="button" className={styles.moduleIconButton}
              aria-label={t('moduleSwitcher.delete.aria', { name })}
              onClick={() => setConfirmingDelete(module)}>
              <IconTrashOutlineRegular />
            </button>
          </HintTooltip>
          </div>
        </div>}
      </article>
    )
  }
})
