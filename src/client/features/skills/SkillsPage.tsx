/** 技能设置页（从 PromptWorkspace 拆出）：状态筛选 + 过滤 + 拖拽排序 + 目录管理。
 *  L3 selector 化：usePromptToolFields 订阅 fields 引用变化；技能行抽 SkillRow
 *  memo 组件——开关/筛选/拖拽 hover 只重渲染受影响行，不再全列表级联。 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import { readImportFiles } from '../../data/import-files.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { tabKeyHandler } from '../../ui/tab-key.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { SettingInputRow } from '../../ui/SettingInputRow.tsx'
import { SkillRow } from './SkillRow.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'

const ui = { ...sharedCss, ...featureCss }

type SkillStatusTab = 'all' | 'callable' | 'invalid'

const SKILL_STATUS_TABS: Array<{ id: SkillStatusTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'callable', label: '模型可调用' },
  { id: 'invalid', label: '未注册' },
]

export const SkillsPage = memo(function SkillsPage(props: { store: PromptToolStore; api: PromptToolHostApi }): ReactNode {
  const { store, api } = props
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
  const dirty = (fields.skillSwitches !== store.savedSwitches.skillSwitches
      && JSON.stringify(fields.skillSwitches) !== JSON.stringify(store.savedSwitches.skillSwitches))
    || (fields.skillOrder !== store.savedSwitches.skillOrder
      && JSON.stringify(fields.skillOrder) !== JSON.stringify(store.savedSwitches.skillOrder))
    || (fields.skillsDirs !== store.savedSwitches.skillsDirs
      && JSON.stringify(fields.skillsDirs) !== JSON.stringify(store.savedSwitches.skillsDirs))
    || store.skillsDirDraft.trim().length > 0

  const callableCount = orderedSkills.filter((skill) => skill.valid && skill.modelInvocable && store.skillEnabled(skill.folder)).length
  const invalidCount = orderedSkills.filter((skill) => !skill.valid).length
  const tabCounts: Record<SkillStatusTab, number> = {
    all: orderedSkills.length,
    callable: callableCount,
    invalid: invalidCount,
  }

  const keyword = skillFilter.trim().toLowerCase()
  const visibleSkills = orderedSkills.filter((skill) => {
    if (statusTab === 'callable' && !(skill.valid && skill.modelInvocable && store.skillEnabled(skill.folder))) return false
    if (statusTab === 'invalid' && skill.valid) return false
    return keyword.length === 0
      || [skill.folder, skill.name ?? '', skill.description ?? ''].join(' ').toLowerCase().includes(keyword)
  })

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

  /** 批量启用/禁用：一次 patch + 一次保存（避免逐项写 N 次）。 */
  const batchSet = (enabled: boolean) => {
    const next = { ...fields.skillSwitches }
    for (const folder of selected) next[folder] = enabled
    store.patch({ skillSwitches: next })
    store.persistSwitches()
    store.showNotice('ok', `已${enabled ? '启用' : '禁用'} ${selected.size} 个技能`)
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
      store.showNotice('error', '选择目录失败：' + (error instanceof Error ? error.message : String(error)))
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
        store.showNotice('ok', `已导入 ${res.value.count} 个技能文件到 ${res.value.path}`)
        await store.load()
      } else {
        store.showNotice('error', '导入技能目录失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } catch (error) {
      store.showNotice('error', '导入技能目录失败：' + (error instanceof Error ? error.message : String(error)))
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
    <section className={ui.section} aria-label="技能设置">
      {fields.skillCatalog.length > 0 && (
        <>
          <div className={ui.skillStatsRow}>
            <div className={ui.skillStats} role="tablist" aria-label="技能状态筛选">
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
                    tab.id === 'invalid' ? ui.skillStatusError
                      : tab.id === 'callable' ? ui.skillStatusModel
                        : ui.skillStatAll)} aria-hidden="true" />
                  <strong>{tabCounts[tab.id]}</strong>
                  <small>{tab.label}</small>
                </button>
              ))}
            </div>
            <button type="button" className={ui.pillButton} onClick={() => void store.load()}>刷新技能列表</button>
          </div>
          <div className={ui.listFilterRow}>
            <input
              className={ui.listFilter}
              value={skillFilter}
              aria-label="过滤技能列表"
              placeholder="过滤技能：名称 / 目录 / 描述…"
              spellCheck={false}
              onChange={(event) => setSkillFilter(event.target.value)}
            />
            {selected.size > 0 && <span className={ui.selectionCount}>已选 {selected.size}</span>}
            {selectableSkills.length > 0 && (
              <button type="button" className={ui.pillButton} data-active={allSelected ? '' : undefined} onClick={toggleSelectAll}>
                {allSelected ? '取消全选' : '全选'}
              </button>
            )}
            <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(true)}>批量启用</button>
            <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(false)}>批量禁用</button>
          </div>
        </>
      )}

      <div
        id="pt-skills-panel"
        role="tabpanel"
        aria-labelledby={`pt-skills-tab-${statusTab}`}
        tabIndex={0}
      >
      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">◇</span><div><h3>skills 目录下没有技能</h3><p>展开下方「目录与来源」选择目录并添加引用，或导入文件夹内容；也可确认技能目录路径后重新打开工作台。</p></div></div>
      ) : visibleSkills.length === 0 ? (
        <p className={ui.readOnly} role="status">没有匹配当前筛选的技能。</p>
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

      <CollapsibleCard id="pt-skills-dirs" title="目录与来源"
        meta={`${displaySkillsDirs.length} 个目录 · 选择引用 / 导入 / 移除`}>
        <div className={ui.dirAddBar}>
          <button
            type="button"
            className={ui.primaryPill}
            disabled={pickingDir || importingDir || store.savingSkillsDir}
            title="选择宿主机目录并保存绝对路径引用，不会复制文件"
            onClick={() => void pickSkillsDir()}
          >
            {pickingDir && <span className={ui.spinner} aria-hidden="true" />}
            {pickingDir ? '选择中…' : '选择目录并添加引用'}
          </button>
          <ImportFileButton
            label="导入文件夹内容"
            busyLabel="导入中…"
            busy={importingDir}
            disabled={pickingDir || store.savingSkillsDir}
            directory
            ariaLabel="选择包含技能子目录的文件夹"
            title="读取文件夹内容并复制到第一个当前生效技能目录"
            className={ui.pillButton}
            onFiles={(files) => void importSkillsDir(files)}
          />
          <div className={ui.dirAddInput}>
            <input
              className={ui.directoryInput}
              aria-label="按路径添加技能目录"
              value={store.skillsDirDraft}
              placeholder="或直接输入目录路径"
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
              添加
            </button>
          </div>
        </div>
        {displaySkillsDirs.length === 0 ? (
          <p className={ui.readOnly} role="status">技能目录列表为空。</p>
        ) : (
          <div className={ui.dirCardList}>
            {displaySkillsDirs.map((dir, index) => {
              const exists = fields.skillsDirExists[dir] === true
              const count = dirSkillCount(dir)
              const isDefault = isDefaultDir(dir)
              return (
                <div key={dir} className={ui.dirCard} data-invalid={!exists ? '' : undefined}>
                  <span className={ui.skillRankBadge} title={`第 ${index + 1} 个目录`}>{index + 1}</span>
                  <div className={ui.dirCardBody}>
                    <span className={ui.dirCardTitle}>
                      <code className={ui.dirPath} title={dir}>{dir}</code>
                      {isDefault && <span className={ui.duplicateBadge} title="未配置自定义目录时使用的 profile skills 副本">默认副本</span>}
                    </span>
                    <span className={ui.dirCardMeta}>
                      {exists
                        ? (count > 0 ? `${count} 个技能` : '空目录')
                        : '目录不存在'}
                      {!exists && ' · 可移除后重新添加'}
                    </span>
                  </div>
                  <div className={ui.dirCardActions}>
                    <button type="button" className={ui.pillButton} onClick={() => void store.openSkillsDir(dir)}>打开</button>
                    <button type="button" className={ui.pillButton} onClick={() => void store.load()}>重扫</button>
                    {!isDefault && (removingDir === dir ? (
                      <>
                        <button type="button" className={ui.pillButton} data-danger onClick={() => { store.removeSkillsDir(dir); setRemovingDir(undefined) }}>确认移除</button>
                        <button type="button" className={ui.pillButton} data-variant="secondary" onClick={() => setRemovingDir(undefined)}>取消</button>
                      </>
                    ) : (
                      <button type="button" className={ui.pillButton} onClick={() => setRemovingDir(dir)}>移除</button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className={ui.readOnly}>目录顺序即添加顺序；同名技能全部保留并标注「同名」，模型注册只取首个目录。移除目录只删除引用，不删除原文件。</p>
        <div className={ui.cardDivider} />
        <SettingInputRow id="pt-skill-rank-base" label="技能排序基数" hint="每个技能实际 rank = 基数 + 拖拽序号；默认 250。数值过小会让本项目技能抢占其他插件技能的位置，但不会影响任何提示词消息注入。"
          type="number" value={String(fields.skillRankBase)}
          onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>

      {dirty && <p className={ui.readOnly} role="status">Skills 开关与目录修改立即保存；如上方按钮仍在写入，请稍候。</p>}
    </section>
  )
})
