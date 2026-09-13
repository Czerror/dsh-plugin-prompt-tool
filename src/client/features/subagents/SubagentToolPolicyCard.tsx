/** 子代理实例级工具策略（subagentToolPolicy）编辑区。
 *  数据源 = preset.yml 顶层 subagentToolPolicy 段（/subagent-tool-policy）；
 *  保存先经 host 统一 resolver 校验再原子写盘并重建。实例解析预览走同一
 *  /subagent-tool-policy-preview seam（不复制解析算法）。既有子代理不变，
 *  策略只影响后续新实例。布局 = 工作台合并行范式（sessionModelRow /
 *  switchGridItem 内联标签），与所属「工具与深度」模块卡同折叠、同风格。 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { asBool, asList, asNum, createEmptyPolicy, splitList, type PolicyDraft } from './subagent-policy-draft.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './subagents.module.css'

const styles = { ...sharedCss, ...featureCss }

type Notice = (kind: 'ok' | 'error', message: string) => void
interface CharacterItem { id: string; name: string }

export function SubagentToolPolicyCard(props: {
  t: PromptToolTranslate
  onNotice: Notice
  /** 现有 toolFilterAllow（首次启用时复制为 default profile 的 allow）。 */
  seedAllow?: string
  presetId?: string
}): ReactNode {
  const { onNotice, t } = props
  const [policy, setPolicy] = useState<PolicyDraft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<unknown>(null)
  const [previewInput, setPreviewInput] = useState<Record<string, string | string[]>>({})
  const [characters, setCharacters] = useState<CharacterItem[]>([])

  const load = useCallback(() => {
    void bridgeCall('subagentToolPolicy', { expectedPresetId: props.presetId }).then((result) => {
      if (result.ok && result.value.policy !== null) {
        setPolicy(result.value.policy as PolicyDraft)
      } else {
        setPolicy(null)
      }
      setLoaded(true)
    })
  }, [props.presetId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    void bridgeCall('charactersList').then((result) => {
      if (result.ok) setCharacters(result.value.characters)
    })
  }, [])

  const patch = (next: PolicyDraft): void => { setPolicy(next); setDirty(true) }
  const toggleEnabled = (enabled: boolean): void => {
    if (enabled) {
      if (policy === null) patch(createEmptyPolicy(props.seedAllow ?? ''))
      else patch(policy)
    } else {
      setPolicy(null)
      setDirty(true)
    }
  }
  const save = (): void => {
    setSaving(true)
    void bridgeCall('subagentToolPolicy', { policy, expectedPresetId: props.presetId }).then((result) => {
      setSaving(false)
      if (result.ok) {
        setDirty(false)
        onNotice('ok', t('policy.notice.saved'))
        load()
      } else {
        onNotice('error', ('message' in result ? result.message : undefined) ?? t('policy.notice.saveFailed'))
      }
    })
  }
  const runPreview = (): void => {
    void bridgeCall('subagentToolPolicyPreview', previewInput).then((result) => {
      if (result.ok) setPreview(result.value.result)
      else onNotice('error', ('message' in result ? result.message : undefined) ?? t('policy.notice.previewFailed'))
    })
  }
  const enabled = policy !== null
  const profiles = useMemo(() => policy?.profiles ?? [], [policy])
  const profileIds = profiles.map((profile) => profile.id)
  const ceilingAllow = asList(policy?.ceiling?.allow)
  const invalidCharacterBindings = (policy?.characterBindings ?? []).filter((binding) =>
    binding.characterId.length === 0 || !characters.some((item) => item.id === binding.characterId))
  const moveProfile = (index: number, offset: -1 | 1): void => {
    if (policy === null) return
    const next = [...profiles]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    patch({ ...policy, profiles: next })
  }
  const removeProfile = (id: string): void => {
    if (policy === null) return
    const refs = [
      ...(policy.defaultProfile === id ? ['defaultProfile'] : []),
      ...(policy.characterBindings ?? []).filter((item) => item.profile === id).map((item) => t('policy.ref.character', { id: item.characterId })),
      ...(policy.taskRules ?? []).filter((item) => item.profile === id).map((item) => t('policy.ref.task', { id: item.id })),
    ]
    if (refs.length > 0) {
      onNotice('error', t('policy.removeBlocked', { id, refs: refs.join(t('policy.ref.separator')) }))
      return
    }
    patch({ ...policy, profiles: profiles.filter((item) => item.id !== id) })
  }

  // 密集行内联项：标签 + 开关/控件同一 flex 项（与本插件工作台合并行范式一致）。
  const policyChip = (label: string, hint: string, checked: boolean, onToggle: (next: boolean) => void, ariaLabel?: string): ReactNode => (
    <HintTooltip label={hint}>
      <span className={styles.switchGridItem}>
        <span className={styles.switchGridLabel}>{label}</span>
        <label className={styles.configEnable}>
          <input type="checkbox" checked={checked} aria-label={ariaLabel ?? label} onChange={(event) => onToggle(event.target.checked)} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
      </span>
    </HintTooltip>
  )
  const inlineField = (label: string, hint: string, control: ReactNode, wide = false): ReactNode => (
    <HintTooltip key={label} label={hint}>
      <span className={clsx(styles.switchGridItem, wide && styles.sessionModelRowWide)}>
        <span className={styles.switchGridLabel}>{label}</span>
        {control}
      </span>
    </HintTooltip>
  )

  return (
    <>
      <div className={styles.settingRowStack}>
        <div className={styles.sessionModelRow}>
          <HintTooltip label={t('policy.titleHint')}>
            <span className={clsx(styles.switchGridItem, styles.sessionModelRowWide)}>
              <span className={styles.switchGridLabel}>
                <strong>{t('policy.title')}</strong>
                {loaded && (
                  <small className={styles.switchGridHint}>{enabled ? t('policy.status.enabled', { count: profiles.length }) : t('policy.status.disabled')}</small>
                )}
              </span>
            </span>
          </HintTooltip>
          {enabled && <button type="button" className={styles.pillButton} data-danger onClick={() => toggleEnabled(false)}>{t('policy.disable')}</button>}
          <button type="button" className={styles.pillButton} onClick={save} disabled={saving || !dirty || invalidCharacterBindings.length > 0}>
            {saving ? t('policy.saving') : t('policy.save')}
          </button>
        </div>
      </div>
      {!loaded && <p className={styles.configFieldHint}>{t('policy.loading')}</p>}
      {loaded && !enabled && (
        <div className={styles.settingRowStack}>
          <p className={styles.configFieldHint}>{t('policy.disabledHint')}</p>
          <span className={styles.configActions}>
            <button type="button" className={styles.primaryPill} onClick={() => toggleEnabled(true)}>{t('policy.enable')}</button>
          </span>
        </div>
      )}
      {loaded && enabled && policy !== null && (
        <>
          {invalidCharacterBindings.length > 0 && <p className={styles.noticeError}>{t('policy.invalidBindings')}</p>}
          {/* 总览：default + ceiling */}
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {inlineField(t('policy.defaultProfile.label'), t('policy.defaultProfile.hint'), (
                  <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.defaultProfile.label')} placeholder={t('policy.menu.empty')} value={policy.defaultProfile ?? ''}
                  options={profileIds.map((id) => ({ value: id, label: id }))}
                  onChange={(value) => patch({ ...policy, defaultProfile: value })} />
              ))}
            </div>
          </div>
          <TagInput id="pt-sp-ceiling-allow" label={t('policy.ceiling.allow.label')} hint={t('policy.ceiling.allow.hint')}
            value={ceilingAllow.join(', ')} placeholder="read, write, bash" disabled={false}
            onChange={(value) => patch({ ...policy, ceiling: { ...policy.ceiling, allow: splitList(value) } })}
            onCommit={() => setDirty(true)} />
          <TagInput id="pt-sp-ceiling-deny" label={t('policy.ceiling.deny.label')} hint={t('policy.ceiling.deny.hint')}
            value={asList(policy.ceiling?.deny).join(', ')} placeholder="dangerous_tool" disabled={false}
            onChange={(value) => patch({ ...policy, ceiling: { ...policy.ceiling, deny: splitList(value) } })}
            onCommit={() => setDirty(true)} />
          {/* 工具档 */}
          <p className={styles.configFieldHint}>{t('policy.profiles.hint')}</p>
          {profiles.map((profile, index) => (
            <div key={`${profile.id}-${index}`} className={styles.policyGroup}>
              <div className={styles.sessionModelRow}>
                {inlineField('id', t('policy.profile.id.hint'), (
                  <input className={styles.configInput} aria-label="profile id" value={profile.id} placeholder="id" spellCheck={false}
                    onChange={(event) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} />
                ))}
                {inlineField(t('policy.profile.name'), t('policy.profile.name.hint'), (
                  <input className={styles.configInput} aria-label="profile name" value={profile.name ?? ''} placeholder={t('policy.profile.namePlaceholder')} spellCheck={false}
                    onChange={(event) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
                ))}
                {policyChip(t('policy.profile.modelSelectable'), t('policy.profile.modelSelectable.hint'), asBool(profile.modelSelectable), (next) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, modelSelectable: next } : item) }))}
                <span className={styles.configActions}>
                  <HintTooltip label={t('policy.moveUp')}><button type="button" className={styles.pillButton} aria-label={t('policy.moveUp')} disabled={index === 0} onClick={() => moveProfile(index, -1)}>↑</button></HintTooltip>
                  <HintTooltip label={t('policy.moveDown')}><button type="button" className={styles.pillButton} aria-label={t('policy.moveDown')} disabled={index === profiles.length - 1} onClick={() => moveProfile(index, 1)}>↓</button></HintTooltip>
                  <HintTooltip label={t('policy.duplicate')}><button type="button" className={styles.pillButton} aria-label={t('policy.duplicate')} onClick={() => patch({ ...policy, profiles: [...profiles, { ...structuredClone(profile), id: `${profile.id}-copy`, name: t('policy.profile.copySuffix', { name: profile.name ?? profile.id }) }] })}>⧉</button></HintTooltip>
                  <HintTooltip label={t('policy.remove')}><button type="button" className={styles.pillButton} data-danger aria-label={t('policy.profile.removeAria', { id: profile.id || index })}
                    onClick={() => removeProfile(profile.id)}>×</button></HintTooltip>
                </span>
              </div>
              <TagInput id={`pt-sp-allow-${index}`} label="allow" hint="" value={asList(profile.allow).join(', ')} placeholder={ceilingAllow.join(', ') || t('policy.tagPlaceholder')}
                onChange={(value) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, allow: splitList(value) } : item) })}
                onCommit={() => setDirty(true)} />
              <TagInput id={`pt-sp-deny-${index}`} label="deny" hint="" value={asList(profile.deny).join(', ')} placeholder="bash"
                onChange={(value) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, deny: splitList(value) } : item) })}
                onCommit={() => setDirty(true)} />
            </div>
          ))}
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} onClick={() => patch({ ...policy, profiles: [...profiles, { id: `profile-${profiles.length + 1}`, name: '', allow: [], deny: [], modelSelectable: true }] })}>{t('policy.addProfile')}</button>
          </span>
          {/* 角色卡绑定 */}
          <p className={styles.configFieldHint}>{t('policy.bindings.hint')}</p>
          {(policy.characterBindings ?? []).map((binding, index) => (
            <div key={`${binding.characterId}-${index}`} className={styles.policyGroup}>
              <div className={styles.sessionModelRow}>
                {inlineField(t('policy.binding.character'), t('policy.binding.character.hint'), (
                  <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.binding.characterAria')} placeholder={t('policy.menu.empty')} value={binding.characterId}
                    options={[
                      { value: '', label: t('policy.binding.empty') },
                      ...(!characters.some((item) => item.id === binding.characterId) && binding.characterId.length > 0
                        ? [{ value: binding.characterId, label: t('policy.binding.missing', { id: binding.characterId }) }]
                        : []),
                      ...characters.map((item) => ({ value: item.id, label: t('policy.binding.option', { name: item.name, id: item.id }) })),
                    ]}
                    onChange={(value) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, characterId: value } : item) })} />
                ), true)}
                {inlineField(t('policy.binding.profile'), t('policy.binding.profile.hint'), (
                  <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.binding.profileAria')} placeholder={t('policy.menu.empty')} value={binding.profile}
                    options={profileIds.map((id) => ({ value: id, label: id }))}
                    onChange={(value) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, profile: value } : item) })} />
                ))}
                {policyChip(t('policy.profile.modelSelectable'), t('policy.binding.modelSelectable.hint'), asBool(binding.modelSelectable), (next) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, modelSelectable: next } : item) }), t('policy.binding.modelSelectableAria'))}
                <HintTooltip label={t('policy.remove')}><button type="button" className={styles.pillButton} data-danger aria-label={t('policy.binding.removeAria')}
                  onClick={() => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).filter((_, at) => at !== index) })}>×</button></HintTooltip>
              </div>
            </div>
          ))}
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton}
              onClick={() => patch({ ...policy, characterBindings: [...(policy.characterBindings ?? []), { characterId: '', profile: policy.defaultProfile ?? '', modelSelectable: true }] })}>{t('policy.addBinding')}</button>
          </span>
          {/* 任务规则 */}
          <p className={styles.configFieldHint}>{t('policy.rules.hint')}</p>
          {(policy.taskRules ?? []).map((rule, index) => (
            <div key={`${rule.id}-${index}`} className={styles.policyGroup}>
              <div className={styles.sessionModelRow}>
                {inlineField('id', t('policy.rule.id.hint'), (
                  <input className={styles.configInput} aria-label={t('policy.rule.idAria')} value={rule.id} placeholder="id" spellCheck={false}
                    onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} />
                ))}
                {inlineField(t('policy.rule.name'), t('policy.rule.name.hint'), (
                  <input className={styles.configInput} aria-label={t('policy.rule.nameAria')} value={rule.name ?? ''} placeholder={t('policy.rule.name')} spellCheck={false}
                    onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
                ))}
                {inlineField(t('policy.rule.pattern'), t('policy.rule.pattern.hint'), (
                  <input className={styles.configInput} aria-label={t('policy.rule.patternAria')} value={rule.pattern} placeholder={t('policy.rule.patternPlaceholder')} spellCheck={false}
                    onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, pattern: event.target.value } : item) })} />
                ))}
                {inlineField('order', t('policy.rule.order.hint'), (
                  <input className={styles.configInput} type="number" aria-label="order" value={String(rule.order ?? 100)}
                    onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, order: Number(event.target.value) } : item) })} />
                ))}
                {inlineField(t('policy.rule.profile'), t('policy.rule.profile.hint'), (
                  <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.rule.profileAria')} placeholder={t('policy.menu.empty')} value={rule.profile}
                    options={profileIds.map((id) => ({ value: id, label: id }))}
                    onChange={(value) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, profile: value } : item) })} />
                ))}
                {policyChip(t('policy.profile.modelSelectable'), t('policy.rule.modelSelectable.hint'), asBool(rule.modelSelectable), (next) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, modelSelectable: next } : item) }), t('policy.rule.modelSelectableAria'))}
                {rule.pattern.length > 0 && (() => { try { new RegExp(rule.pattern); return null } catch { return <small className={styles.noticeError}>{t('policy.rule.invalidPattern')}</small> } })()}
                <HintTooltip label={t('policy.remove')}><button type="button" className={styles.pillButton} data-danger aria-label={t('policy.rule.removeAria')}
                  onClick={() => patch({ ...policy, taskRules: (policy.taskRules ?? []).filter((_, at) => at !== index) })}>×</button></HintTooltip>
              </div>
            </div>
          ))}
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton}
              onClick={() => patch({ ...policy, taskRules: [...(policy.taskRules ?? []), { id: `rule-${(policy.taskRules ?? []).length + 1}`, name: '', pattern: '', profile: policy.defaultProfile ?? '', order: 100, modelSelectable: true }] })}>{t('policy.addRule')}</button>
          </span>
          {/* 模型扩权 */}
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {policyChip(t('policy.expansion.enabled'), t('policy.expansion.enabled.hint'), asBool(policy.modelExpansion?.enabled), (next) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, enabled: next } }), t('policy.expansion.enabledAria'))}
              {policyChip(t('policy.expansion.approval'), t('policy.expansion.approval.hint'), asBool(policy.modelExpansion?.requireApproval), (next) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, requireApproval: next } }))}
              {inlineField(t('policy.expansion.max'), t('policy.expansion.max.hint'), (
                <input className={styles.configInput} type="number" min={0} aria-label={t('policy.expansion.maxAria')} value={String(asNum(policy.modelExpansion?.maxAdditionalTools))}
                  onChange={(event) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, maxAdditionalTools: Number(event.target.value) } })} />
              ))}
            </div>
          </div>
          <TagInput id="pt-sp-expand-allow" label={t('policy.expansion.allow.label')} hint={t('policy.expansion.allow.hint')}
            value={asList(policy.modelExpansion?.allow).join(', ')} placeholder="web_search, bash"
            onChange={(value) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, allow: splitList(value) } })}
            onCommit={() => setDirty(true)} />
          {/* 实例预览 */}
          <div className={styles.policyGroup}>
            <span className={styles.settingCopy}><strong>{t('policy.preview.title')}</strong><small>{t('policy.preview.hint')}</small></span>
            <div className={styles.sessionModelRow}>
              <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.preview.toolAria')} value={String(previewInput.tool ?? 'subagent')}
                options={[
                  { value: 'subagent', label: 'subagent' },
                  { value: 'subagent_fork', label: 'subagent_fork' },
                ]}
                onChange={(value) => setPreviewInput({ ...previewInput, tool: value })} />
              <input className={styles.configInput} aria-label={t('policy.preview.descriptionAria')} placeholder="description" value={String(previewInput.description ?? '')} spellCheck={false}
                onChange={(event) => setPreviewInput({ ...previewInput, description: event.target.value })} />
              <input className={styles.configInput} aria-label={t('policy.preview.promptAria')} placeholder="prompt" value={String(previewInput.prompt ?? '')} spellCheck={false}
                onChange={(event) => setPreviewInput({ ...previewInput, prompt: event.target.value })} />
              <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.preview.profileAria')} value={String(previewInput.tool_profile ?? '')}
                options={[
                  { value: '', label: t('policy.preview.profileEmpty') },
                  ...profiles.filter((profile) => asBool(profile.modelSelectable)).map((profile) => ({ value: profile.id, label: profile.id })),
                ]}
                onChange={(value) => setPreviewInput({ ...previewInput, tool_profile: value })} />
              <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.preview.characterAria')} value={String(previewInput.character_id ?? '')}
                options={[
                  { value: '', label: t('policy.preview.characterEmpty') },
                  ...(policy.characterBindings ?? []).filter((item) => asBool(item.modelSelectable)).map((item) => ({ value: item.characterId, label: item.characterId })),
                ]}
                onChange={(value) => setPreviewInput({ ...previewInput, character_id: value })} />
              <MenuSelect className={styles.configInput} compact ariaLabel={t('policy.preview.taskAria')} value={String(previewInput.task_type ?? '')}
                options={[
                  { value: '', label: t('policy.preview.taskEmpty') },
                  ...(policy.taskRules ?? []).filter((item) => asBool(item.modelSelectable)).map((item) => ({ value: item.id, label: item.id })),
                ]}
                onChange={(value) => setPreviewInput({ ...previewInput, task_type: value })} />
              <TagInput id="pt-sp-preview-add" label="additional_tools" hint="" placeholder={t('policy.tagPlaceholder')} value={Array.isArray(previewInput.additional_tools) ? previewInput.additional_tools.join(', ') : ''}
                onChange={(value) => setPreviewInput({ ...previewInput, additional_tools: splitList(value) })}
                onCommit={() => {}} />
              <TagInput id="pt-sp-preview-restrict" label="restrict_tools" hint="" placeholder={t('policy.tagPlaceholder')} value={Array.isArray(previewInput.restrict_tools) ? previewInput.restrict_tools.join(', ') : ''}
                onChange={(value) => setPreviewInput({ ...previewInput, restrict_tools: splitList(value) })}
                onCommit={() => {}} />
              <button type="button" className={styles.primaryPill} onClick={runPreview}>{t('policy.preview.run')}</button>
            </div>
            {preview !== null && (
              <pre className={styles.configFieldHint} style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview, null, 2)}</pre>
            )}
          </div>
        </>
      )}
    </>
  )
}
