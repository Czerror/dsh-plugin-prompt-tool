/** 技能设置页：文件层调用策略。
 *  技能实体留在官方各自的技能根里；本页只做三件事——列清单（按来源分组）、
 *  改写技能文件 frontmatter 的两个官方调用策略键（正文与其余字段不动）、以及把技能复制进用户技能根。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { SkillPolicyChange } from '../../../shared/skills.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SkillRow } from './SkillRow.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { groupBySource, matchesSkillStatus, type SkillStatusTab } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

const SKILL_STATUS_TABS: Array<{ id: SkillStatusTab; labelKey: PromptToolLocaleKey }> = [
  { id: 'all', labelKey: 'skills.tabs.all' },
  { id: 'model', labelKey: 'skills.tabs.model' },
  { id: 'user', labelKey: 'skills.tabs.user' },
  { id: 'blocked', labelKey: 'skills.tabs.blocked' },
]

/** 创建表单的本地校验：与官方 `SKILL_NAME` 同规则（kebab-case）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SkillsPage = memo(function SkillsPage(props: { store: PromptToolStore; api: PromptToolHostApi; t: PromptToolTranslate; browse?: { query: string; status: SkillStatusTab } }): ReactNode {
  const { store, api, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const [skillFilter, setSkillFilter] = useState(props.browse?.query ?? '')
  const [statusTab, setStatusTab] = useState<SkillStatusTab>(props.browse?.status ?? 'all')
  const [sourceFilter, setSourceFilter] = useState('')
  const [pickingDir, setPickingDir] = useState(false)
  const [importingDir, setImportingDir] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState({ name: '', description: '', content: '' })
  const [folderDraft, setFolderDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SkillCatalogEntry | undefined>(undefined)
  const [overwriteNames, setOverwriteNames] = useState<string[]>()
  const overwriteDecision = useRef<((confirmed: boolean) => void) | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      overwriteDecision.current?.(false)
      overwriteDecision.current = undefined
    }
  }, [])
  const confirmOverwrite = useCallback((names: string[]): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false)
    overwriteDecision.current?.(false)
    setOverwriteNames(names)
    return new Promise((resolve) => { overwriteDecision.current = resolve })
  }, [])
  const settleOverwrite = (confirmed: boolean): void => {
    const decide = overwriteDecision.current
    overwriteDecision.current = undefined
    setOverwriteNames(undefined)
    decide?.(confirmed)
  }

  const keyword = skillFilter.trim().toLowerCase()
  const visible = useMemo(() => fields.skillCatalog.filter((skill) => {
    if (!matchesSkillStatus(skill, statusTab)) return false
    if (sourceFilter.length > 0 && skill.source !== sourceFilter) return false
    if (keyword.length === 0) return true
    return [skill.name, skill.folder, skill.description, skill.dir].join(' ').toLowerCase().includes(keyword)
  }), [fields.skillCatalog, statusTab, sourceFilter, keyword])
  const groups = useMemo(() => groupBySource(visible), [visible])
  const counts: Record<SkillStatusTab, number> = {
    all: fields.skillCatalog.length,
    model: fields.skillCatalog.filter((skill) => matchesSkillStatus(skill, 'model')).length,
    user: fields.skillCatalog.filter((skill) => matchesSkillStatus(skill, 'user')).length,
    blocked: fields.skillCatalog.filter((skill) => matchesSkillStatus(skill, 'blocked')).length,
  }
  const sourceOptions = useMemo(() => {
    const present = groupBySource(fields.skillCatalog).map((group) => group.source)
    return [
      { value: '', label: t('skills.source.all') },
      ...present.map((source) => ({ value: source, label: t(`skills.source.${source}` as never) })),
    ]
  }, [fields.skillCatalog, t])
  useEffect(() => {
    if (props.browse) Object.assign(props.browse, { query: skillFilter, status: statusTab })
  }, [skillFilter, statusTab, props.browse])

  const onSetPolicy = useCallback((name: string, path: string, change: SkillPolicyChange) => {
    void store.setSkillPolicy(name, path, change)
  }, [store])
  const onDelete = useCallback((skill: SkillCatalogEntry) => { setPendingDelete(skill) }, [])

  /** 选择宿主机目录并复制进用户技能根。 */
  const pickAndCopyDir = async (): Promise<void> => {
    if (pickingDir || importingDir || store.skillsBusy) return
    setPickingDir(true)
    try {
      const path = await api.pickDirectory()
      if (path !== null && await store.importSkillsDirectory(path, confirmOverwrite)) store.setSkillsDirDraft('')
    } catch (error) {
      store.showNotice('error', t('skills.notice.dirPickFailed', { reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (mounted.current) setPickingDir(false)
    }
  }

  /** 浏览器文件夹上传：复制进用户技能根。 */
  const importSkillsDir = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setImportingDir(true)
    try {
      await store.importSkillsFiles(files, confirmOverwrite)
    } finally {
      if (mounted.current) setImportingDir(false)
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

  const addFolder = async (): Promise<void> => {
    const path = folderDraft.trim()
    if (path.length === 0) return
    if (fields.skillFolders.includes(path)) {
      store.showNotice('error', t('skills.folders.duplicate'))
      return
    }
    if (await store.patchSkillFolders([...fields.skillFolders, path])) setFolderDraft('')
  }

  return (
    <section className={ui.section} aria-label={t('skills.aria')}>
      {!fields.skillsComplete && <p className={ui.readOnly} role="status">{t('skills.incomplete')}</p>}
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
                      : tab.id === 'blocked' ? ui.skillStatusOff
                        : ui.skillStatAll)} aria-hidden="true" />
                <strong>{counts[tab.id]}</strong>
                <small>{t(tab.labelKey)}</small>
              </button>
            ))}
          </div>
          <button type="button" className={ui.pillButton} disabled={store.skillsBusy} onClick={() => void store.refreshSkills()}>{t('skills.refresh')}</button>
        </div>
      )}

      <CollapsibleCard id="pt-skills-library" title={t('skills.library.title')}
        meta={t('skills.library.meta', { count: fields.skillCatalog.length })}>
        <div className={ui.dirCard} data-invalid={fields.skillsRoot.length === 0 ? '' : undefined}>
          <div className={ui.dirCardBody}>
            <span className={ui.dirCardTitle}>
              <code className={ui.dirPath}>{fields.skillsRoot || t('skills.library.unknown')}</code>
            </span>
            <span className={ui.dirCardMeta}>{t('skills.library.hint')}</span>
          </div>
          <div className={ui.dirCardActions}>
            <button type="button" className={ui.pillButton} disabled={fields.skillsRoot.length === 0}
              onClick={() => void store.openSkillsDir()}>{t('skills.library.open')}</button>
            <button type="button" className={ui.pillButton} disabled={store.skillsBusy} onClick={() => void store.refreshSkills()}>{t('skills.dir.rescan')}</button>
          </div>
        </div>
        <div className={ui.dirAddBar}>
          <HintTooltip label={t('skills.import.pick.hint')}>
            <button
              type="button"
              className={ui.primaryPill}
              disabled={pickingDir || importingDir || store.skillsBusy}
              onClick={() => void pickAndCopyDir()}
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
                if (event.key !== 'Enter' || store.skillsDirDraft.trim().length === 0) return
                void store.importSkillsDirectory(store.skillsDirDraft, confirmOverwrite).then((ok) => { if (ok) store.setSkillsDirDraft('') })
              }}
            />
            <button
              type="button"
              className={ui.pillButton}
              disabled={store.skillsBusy || store.skillsDirDraft.trim().length === 0}
              onClick={() => { void store.importSkillsDirectory(store.skillsDirDraft, confirmOverwrite).then((ok) => { if (ok) store.setSkillsDirDraft('') }) }}
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
        <div className={ui.dirAddBar}>
          <span className={ui.configFieldLabel}>{t('skills.folders.label')}</span>
          <input
            className={ui.directoryInput}
            aria-label={t('skills.folders.aria')}
            value={folderDraft}
            placeholder={t('skills.folders.placeholder')}
            spellCheck={false}
            onChange={(event) => setFolderDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addFolder() }}
          />
          <button type="button" className={ui.pillButton} disabled={store.skillsBusy || folderDraft.trim().length === 0}
            onClick={() => void addFolder()}>
            {t('skills.folders.add')}
          </button>
        </div>
        {fields.skillFolders.length === 0
          ? <p className={ui.readOnly}>{t('skills.folders.empty')}</p>
          : (
            <div className={ui.dirCardList}>
              {fields.skillFolders.map((path) => (
                <div key={path} className={ui.dirCard}>
                  <div className={ui.dirCardBody}><code className={ui.dirPath}>{path}</code></div>
                  <div className={ui.dirCardActions}>
                    <button type="button" className={ui.pillButton} disabled={store.skillsBusy}
                      onClick={() => void store.patchSkillFolders(fields.skillFolders.filter((item) => item !== path))}>
                      {t('skills.folders.remove')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        <p className={ui.configFieldHint}>{t('skills.folders.hint')}</p>
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
          <span className={ui.selectionCount} role="status">{t('skills.visible', { count: visible.length })}</span>
        </div>
      )}

      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}>
          <span className={ui.emptyGlyph} aria-hidden="true">◇</span>
          <div>
            <h3>{t(fields.skillsComplete ? 'skills.empty.title' : 'skills.status.unknown')}</h3>
            <p>{t('skills.empty.hint')}</p>
            <button type="button" className={ui.pillButton} disabled={pickingDir} onClick={() => void pickAndCopyDir()}>{t('skills.import.pick')}</button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <p className={ui.readOnly} role="status">
          {t('skills.noMatch')}
          <button type="button" className={ui.pillButton} onClick={() => { setSkillFilter(''); setStatusTab('all'); setSourceFilter('') }}>{t('configs.clearFilters')}</button>
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.source} className={ui.skillGroup} aria-label={t(`skills.source.${group.source}` as never)}>
            <header className={ui.skillGroupHead}>
              <strong>{t(`skills.source.${group.source}` as never)}</strong>
              <span className={ui.configFieldHint}>{t('skills.group.meta', { count: group.skills.length, rank: group.rank })}</span>
            </header>
            <div className={ui.skillCardList}>
              {group.skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  t={t}
                  busy={store.skillsBusy}
                  onSetPolicy={onSetPolicy}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {overwriteNames !== undefined && (
        <ConfirmDialog
          title={t('skills.overwrite.title')}
          description={t('skills.overwrite.description', { names: overwriteNames.join('、') })}
          confirmLabel={t('skills.overwrite.confirm')}
          cancelLabel={t('skills.dir.cancel')}
          onConfirm={() => settleOverwrite(true)}
          onCancel={() => settleOverwrite(false)}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={t('skills.delete.title', { name: pendingDelete.name })}
          description={t('skills.delete.description', { path: pendingDelete.path ?? pendingDelete.dir })}
          confirmLabel={t('skills.delete.confirm')}
          cancelLabel={t('skills.dir.cancel')}
          onConfirm={async () => { if (!await store.deleteSkill(pendingDelete)) throw new Error(t('skills.delete.failed')) }}
          onCancel={() => setPendingDelete(undefined)}
        />
      )}
    </section>
  )
})
