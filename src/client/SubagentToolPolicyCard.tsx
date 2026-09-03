/** 子代理实例级工具策略（subagentToolPolicy）编辑卡。
 *  数据源 = preset.yml 顶层 subagentToolPolicy 段（/subagent-tool-policy）；
 *  保存先经 host 统一 resolver 校验再原子写盘并重建。实例解析预览走同一
 *  /subagent-tool-policy-preview seam（不复制解析算法）。既有子代理不变，
 *  策略只影响后续新实例。 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgePost } from './prompt-tool-bridge.ts'
import { TagInput } from './TagInput.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import styles from './PromptUi.module.css'

type Notice = (kind: 'ok' | 'error', message: string) => void

interface PolicyDraft {
  defaultProfile?: string
  ceiling?: { allow?: string[]; deny?: string[] }
  profiles?: Array<{ id: string; name?: string; allow?: string[]; deny?: string[]; modelSelectable?: boolean }>
  characterBindings?: Array<{ characterId: string; profile: string; modelSelectable?: boolean }>
  taskRules?: Array<{ id: string; name?: string; pattern: string; profile: string; order?: number; modelSelectable?: boolean }>
  modelExpansion?: { enabled?: boolean; allow?: string[]; maxAdditionalTools?: number; requireApproval?: boolean }
}
interface CharacterItem { id: string; name: string }

const asList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
const asBool = (value: unknown): boolean => value === true
const asNum = (value: unknown): number => Number.isSafeInteger(value) ? value as number : 0

/** 空策略骨架（首次启用的一键初始化：default 从现有 toolFilterAllow 复制）。 */
function emptyPolicy(seedAllow: string): PolicyDraft {
  return {
    defaultProfile: 'base',
    ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'].length > 0 ? ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'] : [], deny: [] },
    profiles: [{
      id: 'base',
      name: '基础',
      allow: seedAllow.split(',').map((item) => item.trim()).filter((item) => item.length > 0),
      deny: [],
      modelSelectable: false,
    }],
    characterBindings: [],
    taskRules: [],
    modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 2, requireApproval: true },
  }
}

export function SubagentToolPolicyCard(props: {
  expanded: boolean
  onToggleExpanded: () => void
  onNotice: Notice
  /** 现有 toolFilterAllow（首次启用时复制为 default profile 的 allow）。 */
  seedAllow?: string
  currentSessionId?: string
}): ReactNode {
  const { expanded, onToggleExpanded, onNotice } = props
  const [policy, setPolicy] = useState<PolicyDraft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<unknown>(null)
  const [previewInput, setPreviewInput] = useState<Record<string, string | string[]>>({})
  const [childSessionId, setChildSessionId] = useState('')
  const [characters, setCharacters] = useState<CharacterItem[]>([])

  const load = useCallback(() => {
    void bridgePost<{ policy: unknown }>('/subagent-tool-policy', {}).then((result) => {
      if (result.ok && result.value.policy !== null) {
        setPolicy(result.value.policy as PolicyDraft)
      } else {
        setPolicy(null)
      }
      setLoaded(true)
    })
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    void bridgePost<{ characters: CharacterItem[] }>('/characters-list', {}).then((result) => {
      if (result.ok) setCharacters(result.value.characters)
    })
  }, [])

  const patch = (next: PolicyDraft): void => { setPolicy(next); setDirty(true) }
  const toggleEnabled = (enabled: boolean): void => {
    if (enabled) {
      if (policy === null) patch(emptyPolicy(props.seedAllow ?? ''))
      else patch(policy)
    } else {
      setPolicy(null)
      setDirty(true)
    }
  }
  const save = (): void => {
    setSaving(true)
    void bridgePost<{ policy: unknown }>('/subagent-tool-policy', { policy }).then((result) => {
      setSaving(false)
      if (result.ok) {
        setDirty(false)
        onNotice('ok', '子代理工具策略已保存并重建（既有子代理不变，仅影响新实例）')
        load()
      } else {
        onNotice('error', ('message' in result ? result.message : undefined) ?? '策略保存失败')
      }
    })
  }
  const runPreview = (): void => {
    void bridgePost<{ result: unknown }>('/subagent-tool-policy-preview', previewInput).then((result) => {
      if (result.ok) setPreview(result.value.result)
      else onNotice('error', ('message' in result ? result.message : undefined) ?? '预览失败')
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
      ...(policy.characterBindings ?? []).filter((item) => item.profile === id).map((item) => `角色 ${item.characterId}`),
      ...(policy.taskRules ?? []).filter((item) => item.profile === id).map((item) => `任务 ${item.id}`),
    ]
    if (refs.length > 0) {
      onNotice('error', `不能删除工具档 ${id}：仍被 ${refs.join('、')} 引用`)
      return
    }
    patch({ ...policy, profiles: profiles.filter((item) => item.id !== id) })
  }

  return (
    <section aria-label="子代理工具策略" style={{ marginTop: 12 }}>
      <div className={clsx(styles.sectionHeading, styles.toolHeading)}>
        <div>
          <h2>
            <button type="button" className={styles.configToggle} aria-expanded={expanded} onClick={onToggleExpanded}>
              <span className={styles.configName}>子代理工具策略<span className={styles.toolHeadingDot} aria-hidden="true" /></span>
              <IconChevronDownOutline14 className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
            </button>
          </h2>
          <p>实例级工具授权（subagentToolPolicy）· 模型只能在用户能力上限内选择与扩权</p>
        </div>
        <span className={styles.configActions}>
          {enabled && <button type="button" className={styles.pillButton} data-danger onClick={() => toggleEnabled(false)}>停用策略</button>}
          <button type="button" className={styles.pillButton} onClick={save} disabled={saving || !dirty || invalidCharacterBindings.length > 0}>
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </div>
      {expanded && (
        <div className={styles.configList} style={{ marginTop: 10 }}>
          {!loaded && <p className={styles.configFieldHint}>加载中…</p>}
          {loaded && !enabled && (
            <>
              <p className={styles.configFieldHint}>当前预设未启用实例级工具策略（使用官方 delegation 原行为）。</p>
              <button type="button" className={styles.primaryPill} onClick={() => toggleEnabled(true)}>启用策略（初始化）</button>
            </>
          )}
          {loaded && enabled && policy !== null && (
            <>
              {invalidCharacterBindings.length > 0 && <p className={styles.noticeError}>存在未选择或已失效的角色卡绑定，请删除或改绑后再保存。</p>}
              {/* 总览：default + ceiling */}
              <div className={styles.settingRowStack}>
                <span className={styles.settingCopy}>
                  <strong>默认工具档</strong>
                  <small>未命中任何 selector 时使用的 profile；须引用已存在 profile。</small>
                </span>
                <select className={styles.configInput} aria-label="默认工具档" value={policy.defaultProfile ?? ''}
                  onChange={(event) => patch({ ...policy, defaultProfile: event.target.value })}>
                  {profileIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </div>
              <TagInput id="pt-sp-ceiling-allow" label="能力上限 allow" hint="ceiling.allow：任何 profile/角色/任务/扩权都不能越界。"
                value={ceilingAllow.join(', ')} placeholder="read, write, bash" disabled={false}
                onChange={(value) => patch({ ...policy, ceiling: { ...policy.ceiling, allow: value.split(',').map((item) => item.trim()).filter((item) => item.length > 0) } })}
                onCommit={() => setDirty(true)} />
              <TagInput id="pt-sp-ceiling-deny" label="能力上限 deny" hint="ceiling.deny：永远优先，不能通过任何 selector 或 additional_tools 恢复。"
                value={asList(policy.ceiling?.deny).join(', ')} placeholder="dangerous_tool" disabled={false}
                onChange={(value) => patch({ ...policy, ceiling: { ...policy.ceiling, deny: value.split(',').map((item) => item.trim()).filter((item) => item.length > 0) } })}
                onCommit={() => setDirty(true)} />
              {/* 工具档 */}
              <p className={styles.configFieldHint}>工具档（profile）：每个档位是模型可选的授权集合；modelSelectable=false 不进模型参数 enum。</p>
              {profiles.map((profile, index) => (
                <div key={`${profile.id}-${index}`} className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input className={styles.configInput} aria-label="profile id" value={profile.id} placeholder="id" spellCheck={false}
                      onChange={(event) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} />
                    <input className={styles.configInput} aria-label="profile name" value={profile.name ?? ''} placeholder="名称" spellCheck={false}
                      onChange={(event) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
                    <label className={styles.configEnable} title="模型可选择">
                      <input type="checkbox" aria-label="模型可选择" checked={asBool(profile.modelSelectable)}
                        onChange={(event) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, modelSelectable: event.target.checked } : item) })} />
                      <span className={styles.switch} aria-hidden="true"><i /></span>
                    </label>
                    <button type="button" className={styles.pillButton} disabled={index === 0} onClick={() => moveProfile(index, -1)}>上移</button>
                    <button type="button" className={styles.pillButton} disabled={index === profiles.length - 1} onClick={() => moveProfile(index, 1)}>下移</button>
                    <button type="button" className={styles.pillButton} onClick={() => patch({ ...policy, profiles: [...profiles, { ...structuredClone(profile), id: `${profile.id}-copy`, name: `${profile.name ?? profile.id} 副本` }] })}>复制</button>
                    <button type="button" className={styles.pillButton} data-danger aria-label={`删除 profile ${profile.id || index}`}
                      onClick={() => removeProfile(profile.id)}>删除</button>
                  </span>
                  <TagInput id={`pt-sp-allow-${index}`} label="allow" hint="" value={asList(profile.allow).join(', ')} placeholder={ceilingAllow.join(', ')}
                    onChange={(value) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, allow: value.split(',').map((item2) => item2.trim()).filter((item2) => item2.length > 0) } : item) })}
                    onCommit={() => setDirty(true)} />
                  <TagInput id={`pt-sp-deny-${index}`} label="deny" hint="" value={asList(profile.deny).join(', ')} placeholder="bash"
                    onChange={(value) => patch({ ...policy, profiles: profiles.map((item, at) => at === index ? { ...item, deny: value.split(',').map((item2) => item2.trim()).filter((item2) => item2.length > 0) } : item) })}
                    onCommit={() => setDirty(true)} />
                </div>
              ))}
              <span>
                <button type="button" className={styles.pillButton} onClick={() => patch({ ...policy, profiles: [...profiles, { id: `profile-${profiles.length + 1}`, name: '', allow: [], deny: [], modelSelectable: true }] })}>添加工具档</button>
              </span>
              {/* 角色卡绑定 */}
              <p className={styles.configFieldHint}>角色卡绑定：相同角色卡在不同预设可拥有不同权限；只决定工具档，不改变 persona/世界书。</p>
              {(policy.characterBindings ?? []).map((binding, index) => (
                <div key={`${binding.characterId}-${index}`} className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <select className={styles.configInput} aria-label="角色卡 id" value={binding.characterId}
                      onChange={(event) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, characterId: event.target.value } : item) })}>
                      <option value="">（选择角色卡）</option>
                      {!characters.some((item) => item.id === binding.characterId) && binding.characterId.length > 0 && <option value={binding.characterId}>失效：{binding.characterId}</option>}
                      {characters.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
                    </select>
                    <select className={styles.configInput} aria-label="绑定 profile" value={binding.profile}
                      onChange={(event) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, profile: event.target.value } : item) })}>
                      {profileIds.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                    <label className={styles.configEnable} title="模型可选择">
                      <input type="checkbox" aria-label="模型可选择" checked={asBool(binding.modelSelectable)}
                        onChange={(event) => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).map((item, at) => at === index ? { ...item, modelSelectable: event.target.checked } : item) })} />
                      <span className={styles.switch} aria-hidden="true"><i /></span>
                    </label>
                    <button type="button" className={styles.pillButton} data-danger aria-label="删除绑定"
                      onClick={() => patch({ ...policy, characterBindings: (policy.characterBindings ?? []).filter((_, at) => at !== index) })}>删除</button>
                  </span>
                </div>
              ))}
              <span>
                <button type="button" className={styles.pillButton}
                  onClick={() => patch({ ...policy, characterBindings: [...(policy.characterBindings ?? []), { characterId: '', profile: policy.defaultProfile ?? '', modelSelectable: true }] })}>添加角色绑定</button>
              </span>
              {/* 任务规则 */}
              <p className={styles.configFieldHint}>任务规则：order 升序、首个匹配获胜；输入 = description + prompt；无匹配回落 default。</p>
              {(policy.taskRules ?? []).map((rule, index) => (
                <div key={`${rule.id}-${index}`} className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input className={styles.configInput} aria-label="任务规则 id" value={rule.id} placeholder="id" spellCheck={false}
                      onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} />
                    <input className={styles.configInput} aria-label="任务规则名" value={rule.name ?? ''} placeholder="名称" spellCheck={false}
                      onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
                    <input className={styles.configInput} aria-label="正则" value={rule.pattern} placeholder="(research|调研)" spellCheck={false}
                      onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, pattern: event.target.value } : item) })} />
                    <input className={styles.configInput} type="number" aria-label="order" value={String(rule.order ?? 100)} style={{ width: 80 }}
                      onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, order: Number(event.target.value) } : item) })} />
                    <select className={styles.configInput} aria-label="规则 profile" value={rule.profile}
                      onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, profile: event.target.value } : item) })}>
                      {profileIds.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                    <label className={styles.configEnable} title="模型可选择">
                      <input type="checkbox" aria-label="任务规则模型可选择" checked={asBool(rule.modelSelectable)}
                        onChange={(event) => patch({ ...policy, taskRules: (policy.taskRules ?? []).map((item, at) => at === index ? { ...item, modelSelectable: event.target.checked } : item) })} />
                      <span className={styles.switch} aria-hidden="true"><i /></span>
                    </label>
                    {rule.pattern.length > 0 && (() => { try { new RegExp(rule.pattern); return null } catch { return <small className={styles.noticeError}>正则无效</small> } })()}
                    <button type="button" className={styles.pillButton} data-danger aria-label="删除规则"
                      onClick={() => patch({ ...policy, taskRules: (policy.taskRules ?? []).filter((_, at) => at !== index) })}>删除</button>
                  </span>
                </div>
              ))}
              <span>
                <button type="button" className={styles.pillButton}
                  onClick={() => patch({ ...policy, taskRules: [...(policy.taskRules ?? []), { id: `rule-${(policy.taskRules ?? []).length + 1}`, name: '', pattern: '', profile: policy.defaultProfile ?? '', order: 100, modelSelectable: true }] })}>添加任务规则</button>
              </span>
              {/* 模型扩权 */}
              <p className={styles.configFieldHint}>模型扩权：additional_tools 严格限制在 expansion.allow ∩ ceiling.allow ∩ preset 可见工具内；requireApproval 时扩权前人工批准。</p>
              <label className={styles.configEnable} htmlFor="pt-sp-expand-enable">
                <input id="pt-sp-expand-enable" type="checkbox" checked={asBool(policy.modelExpansion?.enabled)}
                  onChange={(event) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, enabled: event.target.checked } })} />
                <span className={styles.switch} aria-hidden="true"><i /></span> 启用模型扩权（additional_tools）
              </label>
              <TagInput id="pt-sp-expand-allow" label="扩权 allow" hint="模型可请求的附加工具（须在 ceiling 内）。"
                value={asList(policy.modelExpansion?.allow).join(', ')} placeholder="web_search, bash"
                onChange={(value) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, allow: value.split(',').map((item) => item.trim()).filter((item) => item.length > 0) } })}
                onCommit={() => setDirty(true)} />
              <div className={styles.settingRowStack}>
                <span className={styles.settingCopy}><strong>单次最大扩权数</strong><small>maxAdditionalTools；0 = 关闭扩权参数。</small></span>
                <input className={styles.configInput} type="number" min={0} aria-label="最大扩权数" value={String(asNum(policy.modelExpansion?.maxAdditionalTools))}
                  onChange={(event) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, maxAdditionalTools: Number(event.target.value) } })} />
              </div>
              <label className={styles.configEnable} htmlFor="pt-sp-expand-approval">
                <input id="pt-sp-expand-approval" type="checkbox" checked={asBool(policy.modelExpansion?.requireApproval)}
                  onChange={(event) => patch({ ...policy, modelExpansion: { ...policy.modelExpansion, requireApproval: event.target.checked } })} />
                <span className={styles.switch} aria-hidden="true"><i /></span> 扩权需人工批准（无批准通道 fail closed）
              </label>
              {/* 实例预览 */}
              <div className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
                <span className={styles.settingCopy}><strong>实例解析预览</strong><small>输入 description/prompt 与 selector，调用 host 同一 resolve seam 预览有效工具集；只读，不创建子代理。</small></span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <select className={styles.configInput} aria-label="预览工具" value={String(previewInput.tool ?? 'subagent')}
                    onChange={(event) => setPreviewInput({ ...previewInput, tool: event.target.value })}>
                    <option value="subagent">subagent</option>
                    <option value="subagent_fork">subagent_fork</option>
                  </select>
                  <input className={styles.configInput} aria-label="预览 description" placeholder="description" value={String(previewInput.description ?? '')} spellCheck={false}
                    onChange={(event) => setPreviewInput({ ...previewInput, description: event.target.value })} />
                  <input className={styles.configInput} aria-label="预览 prompt" placeholder="prompt" value={String(previewInput.prompt ?? '')} spellCheck={false}
                    onChange={(event) => setPreviewInput({ ...previewInput, prompt: event.target.value })} />
                  <select className={styles.configInput} aria-label="预览 tool_profile" value={String(previewInput.tool_profile ?? '')}
                    onChange={(event) => setPreviewInput({ ...previewInput, tool_profile: event.target.value })}>
                    <option value="">（不指定 tool_profile）</option>
                    {profiles.filter((profile) => asBool(profile.modelSelectable)).map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}
                  </select>
                  <select className={styles.configInput} aria-label="预览 character_id" value={String(previewInput.character_id ?? '')}
                    onChange={(event) => setPreviewInput({ ...previewInput, character_id: event.target.value })}>
                    <option value="">（不指定 character_id）</option>
                    {(policy.characterBindings ?? []).filter((item) => asBool(item.modelSelectable)).map((item) => <option key={item.characterId} value={item.characterId}>{item.characterId}</option>)}
                  </select>
                  <select className={styles.configInput} aria-label="预览 task_type" value={String(previewInput.task_type ?? '')}
                    onChange={(event) => setPreviewInput({ ...previewInput, task_type: event.target.value })}>
                    <option value="">（不指定 task_type）</option>
                    {(policy.taskRules ?? []).filter((item) => asBool(item.modelSelectable)).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                  </select>
                  <TagInput id="pt-sp-preview-add" label="additional_tools" hint="" value={Array.isArray(previewInput.additional_tools) ? previewInput.additional_tools.join(', ') : ''}
                    onChange={(value) => setPreviewInput({ ...previewInput, additional_tools: value.split(',').map((item) => item.trim()).filter((item) => item.length > 0) })}
                    onCommit={() => {}} />
                  <TagInput id="pt-sp-preview-restrict" label="restrict_tools" hint="" value={Array.isArray(previewInput.restrict_tools) ? previewInput.restrict_tools.join(', ') : ''}
                    onChange={(value) => setPreviewInput({ ...previewInput, restrict_tools: value.split(',').map((item) => item.trim()).filter((item) => item.length > 0) })}
                    onCommit={() => {}} />
                  <button type="button" className={styles.primaryPill} onClick={runPreview}>预览</button>
                </span>
                {preview !== null && (
                  <pre className={styles.configFieldHint} style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview, null, 2)}</pre>
                )}
              </div>
              {/* 已运行本地子代理实际工具面（只读） */}
              <div className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
                <ToolSurfaceView sessionId={props.currentSessionId ?? ''} label="主会话" />
                <span className={styles.settingCopy}>
                  <strong>已运行子代理工具面</strong>
                  <small>输入本地子代理 session id 查询其创建时冻结的实际可见工具。</small>
                </span>
                <input className={styles.configInput} aria-label="子代理 session id" placeholder="session-…" value={childSessionId}
                  onChange={(event) => setChildSessionId(event.target.value.trim())} />
                <ToolSurfaceView sessionId={childSessionId} label="子代理" />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
