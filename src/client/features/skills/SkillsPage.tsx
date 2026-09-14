/** 技能设置页（从 PromptWorkspace 拆出）：状态筛选 + 过滤 + 拖拽排序 + 目录管理。
 *  L3 selector 化：usePromptToolFields 订阅 fields 引用变化；技能行抽 SkillRow
 *  memo 组件——开关/筛选/拖拽 hover 只重渲染受影响行，不再全列表级联。 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import { readImportFiles } from '../../data/import-files.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { tabKeyHandler } from '../../ui/tab-key.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { SettingInputRow } from '../../ui/SettingInputRow.tsx'
import { SkillRow } from './SkillRow.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { filterSkillCatalog, matchesSkillStatus, type SkillStatusTab } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

const SKILL_STATUS_TABS: Array<{ id: SkillStatusTab; labelKey: PromptToolLocaleKey }> = [
  { id: 'all', labelKey: 'skills.tabs.all' },
  { id: 'model', labelKey: 'skills.tabs.model' },
  { id: 'user', labelKey: 'skills.tabs.user' },
  { id: 'disabled', labelKey: 'skills.tabs.disabled' },
]

export const SkillsPage = memo(function SkillsPage(props: { store: PromptToolStore; api: PromptToolHostApi; t: PromptToolTranslate }): ReactNode {
  const { store, api, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const [pickingDir, setPickingDir] = useState(false)
  const [importingDir, setImportingDir] = useState(false)
  const [dragFolder, setDragFolder] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ folder: string; before: boolean } | undefined>(undefined)
  const [skillFilter, setSkillFilter] = useState('')
  const [statusTab, setStatusTab] = useState<SkillStatusTab>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removingDir, setRemovingDir] = useState<string | undefined>(undefined)
  const orderedSkills = useMemo(() => {
    const index = new Map(fields.skillOrder.map((folder, at) => [folder, at]))
    return [...fields.skillCatalog].sort((left, right) => {
      const leftAt = index.get(left.folder)
      const rightAt = index.get(right.folder)
      if (leftAt === undefined && rightAt === undefined) return left.folder.localeCompare(right.folder)
      if (leftAt === undefined) return 1
      if (rightAt === undefined) return -1
      return leftAt - rightAt
    })
  }, [fields.skillCatalog, fields.skillOrder])
  // patch 路径从不原地 mutate：引用相等即内容未变，变化时再退内容比较。
  // 启停不进脏检测：开关是磁盘事实（点一下即写盘并重载），只有顺序/目录/rank 需要保存。
  const dirty = (fields.skillOrder !== store.savedSwitches.skillOrder
      && JSON.stringify(fields.skillOrder) !== JSON.stringify(store.savedSwitches.skillOrder))
    || (fields.skillsDirs !== store.savedSwitches.skillsDirs
      && JSON.stringify(fields.skillsDirs) !== JSON.stringify(store.savedSwitches.skillsDirs))
    || store.skillsDirDraft.trim().length > 0

  const tabCounts: Record<SkillStatusTab, number> = {
    all: orderedSkills.length,
    model: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skill.folder), 'model')).length,
    user: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skill.folder), 'user')).length,
    disabled: orderedSkills.filter((skill) => matchesSkillStatus(skill, store.skillEnabled(skill.folder), 'disabled')).length,
  }

  const keyword = skillFilter.trim().toLowerCase()
  // 命中子技能时父节点保留为树容器（否则 renderOrder 从顶层展开时丢行）。
  const visibleSkills = filterSkillCatalog(orderedSkills, (skill) =>
    matchesSkillStatus(skill, store.skillEnabled(skill.folder), statusTab)
    && (keyword.length === 0
      || [skill.folder, skill.name ?? '', skill.description ?? ''].join(' ').toLowerCase().includes(keyword)))

  const selectionMode = selected.size > 0
  const toggleSelect = useCallback((folder: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])
  /** 全选目标：当前筛选后的合法技能（同名/无效技能不可批量启用）。 */
  const selectableSkills = visibleSkills.filter((skill) => skill.valid)
  const allSelected = selectionMode && selectableSkills.length > 0
    && selectableSkills.every((skill) => selected.has(skill.folder))
  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectableSkills.map((skill) => skill.folder)))
  }
  const dirSkillCount = (dir: string): number =>
    fields.skillCatalog.filter((skill) => skill.dir === dir).length
  /** 配置列表是 UI 单一来源；仅空配置时展示实际生效的默认副本。 */
  const displaySkillsDirs = fields.skillsDirs.length > 0 ? fields.skillsDirs : fields.activeSkillsDirs
  /** 空配置 = 默认副本兜底（只读，不可移除）。 */
  const isDefaultDir = (dir: string): boolean =>
    fields.skillsDirs.length === 0 && fields.activeSkillsDirs[0] === dir
  /** 嵌套技能：folder 含 /（相对路径）即子技能；渲染时父技能下递归展开。 */
  const isNestedFolder = (folder: string): boolean => folder.includes('/')
  /** 主技能序列（不嵌套）：拖拽/菜单排序只在主技能间进行，子技能跟随。 */
  const orderedPrimary = orderedSkills.filter((skill) => !isNestedFolder(skill.folder))
  const childrenByParent = new Map<string, SkillCatalogEntry[]>()
  for (const skill of visibleSkills) {
    if (!isNestedFolder(skill.folder)) continue
    const slash = skill.folder.lastIndexOf('/')
    const parent = skill.folder.slice(0, slash)
    const list = childrenByParent.get(parent) ?? []
    list.push(skill)
    childrenByParent.set(parent, list)
  }
  for (const list of childrenByParent.values()) list.sort((a, b) => a.folder.localeCompare(b.folder))
  const expandSkill = (skill: SkillCatalogEntry): SkillCatalogEntry[] =>
    [skill, ...(childrenByParent.get(skill.folder) ?? []).flatMap(expandSkill)]
  const renderOrder = visibleSkills.filter((skill) => !isNestedFolder(skill.folder)).flatMap(expandSkill)
  const depthOf = (folder: string): number => folder.split('/').length - 1

  /** 批量启停：逐个改磁盘标记（单个失败不阻断其余），结束后统一重载一次。 */
  const batchSet = (enabled: boolean) => {
    const folders = [...selected]
    void store.toggleSkills(folders, enabled)
    setSelected(new Set())
  }

  const moveSkill = useCallback((from: string, to: string) => {
    const folders = orderedSkills.map((skill) => skill.folder)
    const fromAt = folders.indexOf(from)
    const toAt = folders.indexOf(to)
    if (fromAt < 0 || toAt < 0 || fromAt === toAt) return
    const [moved] = folders.splice(fromAt, 1)
    folders.splice(toAt, 0, moved!)
    store.patch({ skillOrder: folders })
    store.persistSwitches()
  }, [orderedSkills, store])

  /** 拖拽插入：插到目标技能前/后（带放置方向指示）。 */
  const moveSkillAt = (from: string, target: string, before: boolean) => {
    const folders = orderedSkills.map((skill) => skill.folder)
    const fromAt = folders.indexOf(from)
    if (fromAt < 0) return
    let toAt = folders.indexOf(target)
    if (toAt < 0 || fromAt === toAt) return
    const [moved] = folders.splice(fromAt, 1)
    if (fromAt < toAt) toAt -= 1
    if (!before) toAt += 1
    folders.splice(toAt, 0, moved!)
    store.patch({ skillOrder: folders })
    store.persistSwitches()
  }

  /** 选择并保存宿主机绝对路径；只保存引用，不复制目录内容。 */
  const pickSkillsDir = async (): Promise<void> => {
    if (pickingDir || importingDir || store.savingSkillsDir) return
    setPickingDir(true)
    try {
      const path = await api.pickDirectory()
      if (path !== null) store.addSkillsDir(path)
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

  /** 行级稳定回调（memo 行只在自身 props 变化时重渲染）。 */
  const onDragStart = useCallback((folder: string, event: React.DragEvent<HTMLDivElement>) => {
    setDragFolder(folder)
    event.dataTransfer.effectAllowed = 'move'
  }, [])
  const onDragOver = useCallback((folder: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (dragFolder === undefined || dragFolder === folder || folder.includes('/')) return
    const rect = event.currentTarget.getBoundingClientRect()
    setDropTarget({ folder, before: event.clientY < rect.top + rect.height / 2 })
  }, [dragFolder])
  const onDrop = useCallback((folder: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const target = dropTarget
    if (dragFolder !== undefined && target !== undefined && dragFolder !== folder && !folder.includes('/')) {
      moveSkillAt(dragFolder, target.folder, target.before)
    }
    setDragFolder(undefined)
    setDropTarget(undefined)
  }, [dragFolder, dropTarget])
  const onDragEnd = useCallback(() => { setDragFolder(undefined); setDropTarget(undefined) }, [])
  const onToggleSkill = useCallback((folder: string) => store.toggleSkill(folder), [store])
  const onFix = useCallback((folder: string) => void store.fixSkill(folder), [store])
  const onMoveUp = useCallback((folder: string) => {
    const at = orderedPrimary.findIndex((skill) => skill.folder === folder)
    if (at > 0) moveSkill(folder, orderedPrimary[at - 1]!.folder)
  }, [orderedPrimary, moveSkill])
  const onMoveDown = useCallback((folder: string) => {
    const at = orderedPrimary.findIndex((skill) => skill.folder === folder)
    if (at >= 0 && at < orderedPrimary.length - 1) moveSkill(folder, orderedPrimary[at + 1]!.folder)
  }, [orderedPrimary, moveSkill])

  return (
    <section className={ui.section} aria-label={t('skills.aria')}>
      {fields.skillCatalog.length > 0 && (
        <div className={ui.skillStatsRow}>
          <div className={ui.skillStats} role="tablist" aria-label={t('skills.tabs.aria')}>
            {SKILL_STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`pt-skills-tab-${tab.id}`}
                type="button"
                role="tab"
                tabIndex={statusTab === tab.id ? 0 : -1}
                aria-selected={statusTab === tab.id}
                aria-controls="pt-skills-panel"
                data-active={statusTab === tab.id ? '' : undefined}
                onClick={() => setStatusTab(tab.id)}
                onKeyDown={tabKeyHandler(SKILL_STATUS_TABS.map((entry) => entry.id), statusTab, setStatusTab)}
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

      <CollapsibleCard id="pt-skills-dirs" title={t('skills.dirs.title')}
        meta={t('skills.dirs.meta', { count: displaySkillsDirs.length })}>
        <div className={ui.dirAddBar}>
          <HintTooltip label={t('skills.dirs.pick.hint')}>
            <button
              type="button"
              className={ui.primaryPill}
              disabled={pickingDir || importingDir || store.savingSkillsDir}
              onClick={() => void pickSkillsDir()}
            >
              {pickingDir && <span className={ui.spinner} aria-hidden="true" />}
              {pickingDir ? t('skills.dirs.picking') : t('skills.dirs.pick')}
            </button>
          </HintTooltip>
          <ImportFileButton
            label={t('skills.dirs.import')}
            busyLabel={t('skills.dirs.importing')}
            busy={importingDir}
            disabled={pickingDir || store.savingSkillsDir}
            directory
            ariaLabel={t('skills.dirs.import.aria')}
            title={t('skills.dirs.import.title')}
            className={ui.pillButton}
            onFiles={(files) => void importSkillsDir(files)}
          />
          <div className={ui.dirAddInput}>
            <input
              className={ui.directoryInput}
              aria-label={t('skills.dirs.input.aria')}
              value={store.skillsDirDraft}
              placeholder={t('skills.dirs.input.placeholder')}
              spellCheck={false}
              onChange={(event) => store.setSkillsDirDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && store.skillsDirDraft.trim().length > 0) {
                  store.addSkillsDir(store.skillsDirDraft)
                  store.setSkillsDirDraft('')
                }
              }}
            />
            <button
              type="button"
              className={ui.pillButton}
              disabled={store.savingSkillsDir || store.skillsDirDraft.trim().length === 0}
              onClick={() => {
                store.addSkillsDir(store.skillsDirDraft)
                store.setSkillsDirDraft('')
              }}
            >
              {store.savingSkillsDir && <span className={ui.spinner} aria-hidden="true" />}
              {t('skills.dirs.add')}
            </button>
          </div>
        </div>
        {displaySkillsDirs.length === 0 ? (
          <p className={ui.readOnly} role="status">{t('skills.dirs.empty')}</p>
        ) : (
          <div className={ui.dirCardList}>
            {displaySkillsDirs.map((dir, index) => {
              const exists = fields.skillsDirExists[dir] === true
              const count = dirSkillCount(dir)
              const isDefault = isDefaultDir(dir)
              return (
                <div key={dir} className={ui.dirCard} data-invalid={!exists ? '' : undefined}>
                  <HintTooltip label={t('skills.dir.rank', { index: index + 1 })}><span className={ui.skillRankBadge}>{index + 1}</span></HintTooltip>
                  <div className={ui.dirCardBody}>
                    <span className={ui.dirCardTitle}>
                      <HintTooltip label={dir}><code className={ui.dirPath}>{dir}</code></HintTooltip>
                      {isDefault && <HintTooltip label={t('skills.dir.default.hint')}><span className={ui.duplicateBadge}>{t('skills.dir.default')}</span></HintTooltip>}
                    </span>
                    <span className={ui.dirCardMeta}>
                      {exists
                        ? (count > 0 ? t('skills.dir.count', { count }) : t('skills.dir.empty'))
                        : t('skills.dir.missing')}
                      {!exists && t('skills.dir.missing.hint')}
                    </span>
                  </div>
                  <div className={ui.dirCardActions}>
                    <button type="button" className={ui.pillButton} onClick={() => void store.openSkillsDir(dir)}>{t('skills.dir.open')}</button>
                    <button type="button" className={ui.pillButton} onClick={() => void store.load()}>{t('skills.dir.rescan')}</button>
                    {!isDefault && (removingDir === dir ? (
                      <>
                        <button type="button" className={ui.pillButton} data-danger onClick={() => { store.removeSkillsDir(dir); setRemovingDir(undefined) }}>{t('skills.dir.confirmRemove')}</button>
                        <button type="button" className={ui.pillButton} data-variant="secondary" onClick={() => setRemovingDir(undefined)}>{t('skills.dir.cancel')}</button>
                      </>
                    ) : (
                      <button type="button" className={ui.pillButton} onClick={() => setRemovingDir(dir)}>{t('skills.dir.remove')}</button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className={ui.readOnly}>{t('skills.dir.footnote')}</p>
        <div className={ui.cardDivider} />
        <SettingInputRow id="pt-skill-rank-base" label={t('skills.rankBase.label')} hint={t('skills.rankBase.hint')}
          type="number" value={String(fields.skillRankBase)}
          onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>

      {fields.skillCatalog.length > 0 && (
        <div className={ui.listFilterRow}>
          <input
            className={ui.listFilter}
            value={skillFilter}
            aria-label={t('skills.filter.aria')}
            placeholder={t('skills.filter.placeholder')}
            spellCheck={false}
            onChange={(event) => setSkillFilter(event.target.value)}
          />
          {selected.size > 0 && <span className={ui.selectionCount}>{t('skills.selected', { count: selected.size })}</span>}
          {selectableSkills.length > 0 && (
            <button type="button" className={ui.pillButton} data-active={allSelected ? '' : undefined} onClick={toggleSelectAll}>
              {allSelected ? t('skills.unselectAll') : t('skills.selectAll')}
            </button>
          )}
          <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(true)}>{t('skills.batchEnable')}</button>
          <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(false)}>{t('skills.batchDisable')}</button>
        </div>
      )}

      <div
        id="pt-skills-panel"
        role="tabpanel"
        aria-labelledby={`pt-skills-tab-${statusTab}`}
        tabIndex={0}
      >
      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">◇</span><div><h3>{t('skills.empty.title')}</h3><p>{t('skills.empty.hint')}</p></div></div>
      ) : visibleSkills.length === 0 ? (
        <p className={ui.readOnly} role="status">{t('skills.noMatch')}</p>
      ) : (
        <>
          <div className={ui.skillCardList} data-dragging={dragFolder !== undefined ? '' : undefined}>
            {renderOrder.map((skill) => {
              const depth = depthOf(skill.folder)
              const primaryIndex = depth === 0 ? orderedPrimary.indexOf(skill) : 0
              return (
                <SkillRow
                  key={skill.folder}
                  skill={skill}
                  t={t}
                  depth={depth}
                  primaryIndex={primaryIndex}
                  enabled={store.skillEnabled(skill.folder)}
                  isSelected={selected.has(skill.folder)}
                  dragging={dragFolder === skill.folder}
                  dropBefore={dropTarget?.folder === skill.folder && dropTarget?.before === true}
                  dropAfter={dropTarget?.folder === skill.folder && dropTarget?.before === false}
                  fixing={store.fixingSkill === skill.folder}
                  canMoveUp={depth === 0 && primaryIndex > 0}
                  canMoveDown={depth === 0 && primaryIndex < orderedPrimary.length - 1}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  onToggleSelect={toggleSelect}
                  onToggleSkill={onToggleSkill}
                  onFix={onFix}
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
    </section>
  )
})
