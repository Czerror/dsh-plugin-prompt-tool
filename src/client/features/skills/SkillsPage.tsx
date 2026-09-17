/** 技能设置页：受管实体库（.system）+ 根链接启停 + 调用策略 + 导入 / 创建 / 回收站。
 *  L3 selector 化：usePromptToolFields 订阅 fields 引用变化；技能行抽 SkillRow
 *  memo 组件——开关/筛选/拖拽 hover 只重渲染受影响行，不再全列表级联。
 *  稳定身份：所有行操作（选择、开关、策略、修复、删除、拖拽）都传 id，不再用 folder 定位。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import { readImportFiles } from '../../data/import-files.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SettingInputRow } from '../../ui/SettingInputRow.tsx'
import { SkillRow } from './SkillRow.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import {
  buildSkillTree,
  filterSkillCatalog,
  matchesSkillStatus,
  skillIdOf,
  type SkillStatusTab,
} from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

const SKILL_STATUS_TABS: Array<{ id: SkillStatusTab; labelKey: PromptToolLocaleKey }> = [
  { id: 'all', labelKey: 'skills.tabs.all' },
  { id: 'model', labelKey: 'skills.tabs.model' },
  { id: 'user', labelKey: 'skills.tabs.user' },
  { id: 'disabled', labelKey: 'skills.tabs.disabled' },
]

/** 创建表单的本地校验：与服务端 `SKILL_NAME_RE` 同规则（kebab-case）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SkillsPage = memo(function SkillsPage(props: { store: PromptToolStore; api: PromptToolHostApi; t: PromptToolTranslate; browse?: { query: string; status: SkillStatusTab; selected: string[] } }): ReactNode {
  const { store, api, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const [pickingDir, setPickingDir] = useState(false)
  const [importingDir, setImportingDir] = useState(false)
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | undefined>(undefined)
  const [skillFilter, setSkillFilter] = useState(props.browse?.query ?? '')
  const [statusTab, setStatusTab] = useState<SkillStatusTab>(props.browse?.status ?? 'all')
  const [sourceFilter, setSourceFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(props.browse?.selected))
  const [batchBusy, setBatchBusy] = useState(false)
  const batchRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const [pendingDelete, setPendingDelete] = useState<SkillCatalogEntry | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState({ name: '', description: '', content: '' })
  /** 实体库根与实体目录（只读展示；外部目录只作为一次性导入来源）。 */
  const libraryRoot = fields.activeSkillsDirs[0]
  const entityRoot = libraryRoot === undefined ? undefined : `${libraryRoot}\\.system`
  const orderedSkills = useMemo(() => {
    const index = new Map(fields.skillOrder.map((id, at) => [id, at]))
    return [...fields.skillCatalog].sort((left, right) => {
      const leftAt = index.get(skillIdOf(left))
      const rightAt = index.get(skillIdOf(right))
      if (leftAt === undefined && rightAt === undefined) return skillIdOf(left).localeCompare(skillIdOf(right))
      if (leftAt === undefined) return 1
      if (rightAt === undefined) return -1
      return leftAt - rightAt
    })
  }, [fields.skillCatalog, fields.skillOrder])
  // 顺序与 rank 由本地保存通道写 skills.yml；启停与调用策略是磁盘/链接事实（点一下即写盘并重载）。
  const dirty = fields.skillOrder !== store.savedSwitches.skillOrder
    && JSON.stringify(fields.skillOrder) !== JSON.stringify(store.savedSwitches.skillOrder)

  const sources = useMemo(() => {
    const found = new Set<string>()
    for (const skill of orderedSkills) if (typeof skill.source === 'string' && skill.source.length > 0) found.add(skill.source)
    return [...found].sort((left, right) => left.localeCompare(right))
  }, [orderedSkills])
  const sourceOptions = useMemo(() => [
    { value: '', label: t('skills.source.all') },
    ...sources.map((source) => ({ value: source, label: source })),
  ], [sources, t])

  const matches = useCallback((skill: SkillCatalogEntry): boolean => {
    const id = skillIdOf(skill)
    const keyword = skillFilter.trim().toLowerCase()
    return matchesSkillStatus(skill, store.skillEnabled(id), statusTab)
      && (sourceFilter.length === 0 || skill.source === sourceFilter)
      && (keyword.length === 0
        || [id, skill.name ?? '', skill.description ?? ''].join(' ').toLowerCase().includes(keyword))
  }, [skillFilter, sourceFilter, statusTab, store])

  const tabCounts: Record<SkillStatusTab, number> = {
    all: orderedSkills.length,
    model: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skillIdOf(skill)), 'model')).length,
    user: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skillIdOf(skill)), 'user')).length,
    disabled: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skillIdOf(skill)), 'disabled')).length,
  }

  // 命中子技能时父节点保留为树容器（否则展开逻辑从根行出发会丢行）。
  const visibleSkills = filterSkillCatalog(orderedSkills, matches)
  const tree = useMemo(() => buildSkillTree(visibleSkills), [visibleSkills])
  const orderedPrimaryAll = useMemo(() => buildSkillTree(orderedSkills).primary, [orderedSkills])

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  /** 全选目标：当前筛选后的合法技能（无效技能不可批量启停）。 */
  const selectableSkills = visibleSkills.filter((skill) => skill.valid && matches(skill))
  const visibleSelected = selectableSkills.map(skillIdOf).filter((id) => selected.has(id))
  const selectionMode = visibleSelected.length > 0
  const selectionKey = visibleSelected.join('\0')
  useEffect(() => {
    if (selected.size !== visibleSelected.length) setSelected(new Set(visibleSelected))
    if (props.browse) Object.assign(props.browse, { query: skillFilter, status: statusTab, selected: visibleSelected })
  }, [selectionKey, selected.size, skillFilter, statusTab, props.browse])
  const allSelected = selectionMode && selectableSkills.length > 0
    && selectableSkills.every((skill) => selected.has(skillIdOf(skill)))
  const toggleSelectAll = (): void => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectableSkills.map(skillIdOf)))
  }

  /** 批量启停：逐个切换受管链接，单个失败不阻断其余；结束后统一重载一次。 */
  const batchSet = (enabled: boolean): void => {
    if (batchRef.current || !selectionMode) return
    const ids = [...visibleSelected]
    batchRef.current = true
    setBatchBusy(true)
    void store.toggleSkills(ids, enabled).then((failures) => {
      if (mounted.current) setSelected(new Set(failures))
    }).finally(() => {
      batchRef.current = false
      if (mounted.current) setBatchBusy(false)
    })
  }

  const moveSkill = useCallback((from: string, to: string) => {
    const ids = orderedSkills.map(skillIdOf)
    const fromAt = ids.indexOf(from)
    const toAt = ids.indexOf(to)
    if (fromAt < 0 || toAt < 0 || fromAt === toAt) return
    const [moved] = ids.splice(fromAt, 1)
    ids.splice(toAt, 0, moved!)
    store.patch({ skillOrder: ids })
    void store.persistSwitches()
  }, [orderedSkills, store])

  /** 拖拽插入：插到目标技能前/后（带放置方向指示）。 */
  const moveSkillAt = (from: string, target: string, before: boolean): void => {
    const ids = orderedSkills.map(skillIdOf)
    const fromAt = ids.indexOf(from)
    if (fromAt < 0) return
    let toAt = ids.indexOf(target)
    if (toAt < 0 || fromAt === toAt) return
    const [moved] = ids.splice(fromAt, 1)
    if (fromAt < toAt) toAt -= 1
    if (!before) toAt += 1
    ids.splice(toAt, 0, moved!)
    store.patch({ skillOrder: ids })
    void store.persistSwitches()
  }

  /** 选择宿主机目录并把它作为一次性导入来源（复制到实体库，不保留引用）。 */
  const pickImportDir = async (): Promise<void> => {
    if (pickingDir || importingDir || store.skillsBusy) return
    setPickingDir(true)
    try {
      const path = await api.pickDirectory()
      if (path !== null) {
        store.setSkillsDirDraft(path)
        if (await store.importSkillsDirectory(path)) store.setSkillsDirDraft('')
      }
    } catch (error) {
      store.showNotice('error', t('skills.notice.dirPickFailed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setPickingDir(false)
    }
  }

  const importSkillsDir = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setImportingDir(true)
    try {
      const res = await bridgeCall('skillsImport', { files: await readImportFiles(files, 'base64') })
      if (res.ok) {
        store.showNotice('ok', t('skills.notice.imported', { count: res.value.count, path: res.value.path }))
        await store.load()
      } else {
        store.showNotice('error', t('skills.notice.importFailed', { reason: res.message ?? 'settings bridge unavailable' }))
      }
    } catch (error) {
      store.showNotice('error', t('skills.notice.importFailed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setImportingDir(false)
    }
  }

  const submitCreate = async (): Promise<void> => {
    const name = createDraft.name.trim()
    if (!SKILL_NAME_RE.test(name) || createDraft.description.trim().length === 0) {
      store.showNotice('error', t('skills.create.invalid'))
      return
    }
    if (await store.createSkill({ name, description: createDraft.description.trim(), content: createDraft.content })) {
      setCreateDraft({ name: '', description: '', content: '' })
      setCreating(false)
    }
  }

  /** 行级稳定回调（memo 行只在自身 props 变化时重渲染）。 */
  const onDragStart = useCallback((id: string, event: React.DragEvent<HTMLDivElement>) => {
    setDragId(id)
    event.dataTransfer.effectAllowed = 'move'
  }, [])
  const onDragOver = useCallback((id: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (dragId === undefined || dragId === id) return
    const rect = event.currentTarget.getBoundingClientRect()
    setDropTarget({ id, before: event.clientY < rect.top + rect.height / 2 })
  }, [dragId])
  const onDrop = useCallback((id: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = dropTarget
    if (dragId !== undefined && target !== undefined && dragId !== id) {
      moveSkillAt(dragId, target.id, target.before)
    }
    setDragId(undefined)
    setDropTarget(undefined)
  }, [dragId, dropTarget])
  const onDragEnd = useCallback(() => { setDragId(undefined); setDropTarget(undefined) }, [])
  const onToggleSkill = useCallback((id: string) => store.toggleSkill(id), [store])
  const onTogglePolicy = useCallback((id: string, policy: { modelInvocable?: boolean; userInvocable?: boolean }) => {
    void store.setSkillPolicy(id, policy)
  }, [store])
  const onFix = useCallback((id: string) => void store.fixSkill(id), [store])
  const onDelete = useCallback((id: string) => {
    setPendingDelete(fields.skillCatalog.find((skill) => skillIdOf(skill) === id))
  }, [fields.skillCatalog])
  const onMoveUp = useCallback((id: string) => {
    const at = orderedPrimaryAll.findIndex((skill) => skillIdOf(skill) === id)
    if (at > 0) moveSkill(id, skillIdOf(orderedPrimaryAll[at - 1]!))
  }, [orderedPrimaryAll, moveSkill])
  const onMoveDown = useCallback((id: string) => {
    const at = orderedPrimaryAll.findIndex((skill) => skillIdOf(skill) === id)
    if (at >= 0 && at < orderedPrimaryAll.length - 1) moveSkill(id, skillIdOf(orderedPrimaryAll[at + 1]!))
  }, [orderedPrimaryAll, moveSkill])

  return (
    <section className={ui.section} aria-label={t('skills.aria')}>
      {fields.skillCatalog.length > 0 && (
        <div className={ui.skillStatsRow}>
          <div className={ui.skillStats} role="group" aria-label={t('skills.tabs.aria')}>
            {SKILL_STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`pt-skills-tab-${tab.id}`}
                type="button"
                aria-pressed={statusTab === tab.id}
                data-active={statusTab === tab.id ? '' : undefined}
                onClick={() => setStatusTab(tab.id)}
              >
                <i className={clsx(ui.skillStatDot,
                  tab.id === 'model' ? ui.skillStatusModel
                    : tab.id === 'user' ? ui.skillStatusUser
                      : tab.id === 'disabled' ? ui.skillStatusOff
                        : ui.skillStatAll)} aria-hidden="true" />
                <strong>{tabCounts[tab.id]}</strong>
                <small>{t(tab.labelKey)}</small>
              </button>
            ))}
          </div>
          <button type="button" className={ui.pillButton} onClick={() => void store.load()}>{t('skills.refresh')}</button>
        </div>
      )}

      <CollapsibleCard id="pt-skills-library" title={t('skills.library.title')}
        meta={t('skills.library.meta', { count: orderedSkills.length })}>
        <div className={ui.dirCard} data-invalid={entityRoot === undefined ? '' : undefined}>
          <div className={ui.dirCardBody}>
            <span className={ui.dirCardTitle}>
              <code className={ui.dirPath}>{entityRoot ?? t('skills.library.unknown')}</code>
            </span>
            <span className={ui.dirCardMeta}>{t('skills.library.hint')}</span>
          </div>
          <div className={ui.dirCardActions}>
            <button type="button" className={ui.pillButton} disabled={entityRoot === undefined}
              onClick={() => void store.openSkillsDir(entityRoot)}>{t('skills.library.open')}</button>
            <button type="button" className={ui.pillButton} onClick={() => void store.load()}>{t('skills.dir.rescan')}</button>
          </div>
        </div>
        <div className={ui.dirAddBar}>
          <HintTooltip label={t('skills.import.pick.hint')}>
            <button
              type="button"
              className={ui.primaryPill}
              disabled={pickingDir || importingDir || store.skillsBusy}
              onClick={() => void pickImportDir()}
            >
              {pickingDir && <span className={ui.spinner} aria-hidden="true" />}
              {pickingDir ? t('skills.dirs.picking') : t('skills.import.pick')}
            </button>
          </HintTooltip>
          <ImportFileButton
            label={t('skills.dirs.import')}
            busyLabel={t('skills.dirs.importing')}
            busy={importingDir}
            disabled={pickingDir || store.skillsBusy}
            directory
            ariaLabel={t('skills.dirs.import.aria')}
            title={t('skills.dirs.import.title')}
            className={ui.pillButton}
            onFiles={(files) => void importSkillsDir(files)}
          />
          <div className={ui.dirAddInput}>
            <input
              className={ui.directoryInput}
              aria-label={t('skills.import.path.aria')}
              value={store.skillsDirDraft}
              placeholder={t('skills.import.path.placeholder')}
              spellCheck={false}
              onChange={(event) => store.setSkillsDirDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && store.skillsDirDraft.trim().length > 0) {
                  void store.importSkillsDirectory(store.skillsDirDraft).then((ok) => { if (ok) store.setSkillsDirDraft('') })
                }
              }}
            />
            <button
              type="button"
              className={ui.pillButton}
              disabled={store.skillsBusy || store.skillsDirDraft.trim().length === 0}
              onClick={() => { void store.importSkillsDirectory(store.skillsDirDraft).then((ok) => { if (ok) store.setSkillsDirDraft('') }) }}
            >
              {store.skillsBusy && <span className={ui.spinner} aria-hidden="true" />}
              {t('skills.import.fromDir')}
            </button>
          </div>
        </div>
        <p className={ui.readOnly}>{t('skills.library.footnote')}</p>
        <div className={ui.cardDivider} />
        <div className={ui.dirAddBar}>
          <button type="button" className={ui.pillButton} aria-expanded={creating}
            onClick={() => setCreating((value) => !value)}>
            {creating ? t('skills.create.close') : t('skills.create.open')}
          </button>
        </div>
        {creating && (
          <div className={ui.skillCreateForm}>
            <label className={ui.skillCreateField}>
              <span>{t('skills.create.name')}</span>
              <input
                className={ui.configInput}
                value={createDraft.name}
                aria-label={t('skills.create.name')}
                aria-invalid={createDraft.name.length > 0 && !SKILL_NAME_RE.test(createDraft.name.trim())}
                placeholder={t('skills.create.namePlaceholder')}
                spellCheck={false}
                onChange={(event) => setCreateDraft((draft) => ({ ...draft, name: event.target.value }))}
              />
            </label>
            <label className={ui.skillCreateField}>
              <span>{t('skills.create.description')}</span>
              <input
                className={ui.configInput}
                value={createDraft.description}
                aria-label={t('skills.create.description')}
                placeholder={t('skills.create.descriptionPlaceholder')}
                onChange={(event) => setCreateDraft((draft) => ({ ...draft, description: event.target.value }))}
              />
            </label>
            <label className={ui.skillCreateField}>
              <span>{t('skills.create.content')}</span>
              <textarea
                className={ui.configInput}
                rows={6}
                value={createDraft.content}
                aria-label={t('skills.create.content')}
                placeholder={t('skills.create.contentPlaceholder')}
                spellCheck={false}
                onChange={(event) => setCreateDraft((draft) => ({ ...draft, content: event.target.value }))}
              />
            </label>
            <div className={ui.dirCardActions}>
              <button type="button" className={ui.primaryPill} disabled={store.skillsBusy} onClick={() => void submitCreate()}>
                {store.skillsBusy && <span className={ui.spinner} aria-hidden="true" />}
                {t('skills.create.submit')}
              </button>
              <button type="button" className={ui.pillButton} onClick={() => { setCreating(false); setCreateDraft({ name: '', description: '', content: '' }) }}>
                {t('skills.dir.cancel')}
              </button>
            </div>
            <p className={ui.configFieldHint}>{t('skills.create.hint')}</p>
          </div>
        )}
        <div className={ui.cardDivider} />
        <SettingInputRow id="pt-skill-rank-base" label={t('skills.rankBase.label')} hint={t('skills.rankBase.hint')}
          type="number" value={String(fields.skillRankBase)}
          onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
          onCommit={() => void store.persistSwitches()} />
      </CollapsibleCard>

      {fields.skillCatalog.length > 0 && (
        <div className={ui.listFilterRow}>
          <input
            type="search"
            className={ui.listFilter}
            value={skillFilter}
            aria-label={t('skills.filter.aria')}
            placeholder={t('skills.filter.placeholder')}
            spellCheck={false}
            onChange={(event) => setSkillFilter(event.target.value)}
          />
          <MenuSelect
            value={sourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            ariaLabel={t('skills.source.aria')}
            placeholder={t('skills.source.all')}
            className={ui.listFilter}
            compact
          />
          <span className={ui.selectionCount} role="status">{t('skills.selected', { count: visibleSelected.length })}</span>
          {selectableSkills.length > 0 && (
            <button type="button" className={ui.pillButton} data-active={allSelected ? '' : undefined} onClick={toggleSelectAll}>
              {allSelected ? t('skills.unselectAll') : t('skills.selectAll')}
            </button>
          )}
          <button type="button" className={ui.pillButton} disabled={!selectionMode || batchBusy} onClick={() => batchSet(true)}>{t('skills.batchEnable')}</button>
          <button type="button" className={ui.pillButton} disabled={!selectionMode || batchBusy} onClick={() => batchSet(false)}>{t('skills.batchDisable')}</button>
          {!selectionMode && <span className={ui.configFieldHint}>{t('skills.selectHint')}</span>}
        </div>
      )}

      <div
        id="pt-skills-panel"
      >
      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">◇</span><div><h3>{t('skills.empty.title')}</h3><p>{t('skills.empty.hint')}</p><button type="button" className={ui.pillButton} disabled={pickingDir} onClick={() => void pickImportDir()}>{t('skills.import.pick')}</button></div></div>
      ) : visibleSkills.length === 0 ? (
        <p className={ui.readOnly} role="status">{t('skills.noMatch')} <button type="button" className={ui.pillButton} onClick={() => { setSkillFilter(''); setStatusTab('all'); setSourceFilter('') }}>{t('configs.clearFilters')}</button></p>
      ) : (
        <>
          <div className={ui.skillCardList} data-dragging={dragId !== undefined ? '' : undefined}>
            {tree.rows.map(({ skill, depth }) => {
              const id = skillIdOf(skill)
              const primaryIndex = depth === 0 ? orderedPrimaryAll.findIndex((item) => skillIdOf(item) === id) : 0
              return (
                <SkillRow
                  key={id}
                  skill={skill}
                  t={t}
                  depth={depth}
                  primaryIndex={primaryIndex}
                  enabled={store.skillEnabled(id)}
                  isSelected={selected.has(id)}
                  selectable={selectableSkills.some((item) => skillIdOf(item) === id)}
                  dragging={dragId === id}
                  dropBefore={dropTarget?.id === id && dropTarget?.before === true}
                  dropAfter={dropTarget?.id === id && dropTarget?.before === false}
                  fixing={store.fixingSkill === id}
                  busy={store.skillsBusy}
                  canMoveUp={depth === 0 && primaryIndex > 0}
                  canMoveDown={depth === 0 && primaryIndex >= 0 && primaryIndex < orderedPrimaryAll.length - 1}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  onToggleSelect={toggleSelect}
                  onToggleSkill={onToggleSkill}
                  onTogglePolicy={onTogglePolicy}
                  onFix={onFix}
                  onDelete={onDelete}
                  onMoveUp={onMoveUp}
                  onMoveDown={onMoveDown}
                />
              )
            })}
          </div>
        </>
      )}
      </div>

      {dirty && <p className={ui.readOnly} role="status">{t('skills.dirty')}</p>}

      {pendingDelete && (
        <ConfirmDialog
          title={t('skills.delete.title', { name: pendingDelete.name || skillIdOf(pendingDelete) })}
          description={t('skills.delete.description')}
          confirmLabel={t('skills.delete.confirm')}
          cancelLabel={t('skills.dir.cancel')}
          onConfirm={async () => { await store.deleteSkill(skillIdOf(pendingDelete)) }}
          onCancel={() => setPendingDelete(undefined)}
        />
      )}
    </section>
  )
})
