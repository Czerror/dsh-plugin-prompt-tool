import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  bridgePost,
  type Fields,
  type PromptToolStore,
  type SwitchKey,
  usePromptToolStore,
} from './prompt-tool-store.ts'
import {
  LAYER_LABELS,
  LAYERS,
  PromptConfigCard,
  type PromptConfigDraft,
  type ValidationErrorEntry,
} from './PromptConfigsEditor.tsx'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

interface ValidateResult {
  ok: boolean
  valid: boolean
  errors?: ValidationErrorEntry[]
  message?: string
}

const layerOf = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'

const configsOfLayer = (configs: PromptConfigDraft[], layer: string): PromptConfigDraft[] =>
  configs.filter((config) => layerOf(config) === layer)

/** 与 settings-bridge /configs-validate 相同的保存前权威校验。 */
async function validateConfigs(configs: PromptConfigDraft[]): Promise<{ valid: boolean; errors: ValidationErrorEntry[] }> {
  try {
    const res = await bridgePost<ValidateResult>('/configs-validate', { promptConfigs: configs })
    if (!res.ok) return { valid: false, errors: [{ index: -1, id: '', message: res.message ?? 'settings bridge unavailable' }] }
    return { valid: res.value.valid, errors: res.value.valid ? [] : res.value.errors ?? [] }
  } catch (error) {
    return { valid: false, errors: [{ index: -1, id: '', message: error instanceof Error ? error.message : String(error) }] }
  }
}

function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }): ReactNode {
  return (
    <label className={ui.toggleRow} htmlFor={props.id}>
      <span className={ui.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span>
      <input id={props.id} type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span className={ui.switch} aria-hidden="true"><i /></span>
    </label>
  )
}

/** 设置输入行：编辑框失焦即保存（与 anchor 文本一致）。 */
function SettingInputRow(props: { id: string; label: string; hint: string; value: string; type?: 'text' | 'number'; placeholder?: string; disabled?: boolean; onInput: (value: string) => void; onCommit: () => void }): ReactNode {
  return (
    <div className={ui.rowGroup}>
      <div className={ui.settingRowStack}>
        <span className={ui.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span>
        <div className={ui.directoryControl}>
          <input
            id={props.id}
            className={ui.directoryInput}
            type={props.type ?? 'text'}
            value={props.value}
            placeholder={props.placeholder}
            disabled={props.disabled}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => props.onInput(event.target.value)}
            onBlur={props.onCommit}
          />
        </div>
      </div>
    </div>
  )
}

function PageHeader(props: { title: string; description: string; meta?: string }): ReactNode {
  return (
    <div className={ui.pageHeader}>
      <div><h2>{props.title}</h2><p>{props.description}</p></div>
      {props.meta !== undefined && <div className={css.pageHeaderMeta}><code>{props.meta}</code></div>}
    </div>
  )
}

/** 内置四条默认配置：开关由既有总开关驱动，只读展示层内接线。 */
function BuiltinConfigRows(props: { fields: Fields; disabled: boolean; onChange: (key: SwitchKey, value: boolean) => void }): ReactNode {
  const { fields } = props
  return (
    <section className={ui.section} aria-labelledby="prompt-tool-builtin-heading">
      <div className={ui.sectionHeading}><div><h2 id="prompt-tool-builtin-heading">内置消息批配置</h2><p>包内 anchored 预设的四条默认配置，由下方总开关驱动；这里只读展示层内接线。</p></div></div>
      <div className={ui.rowGroup}>
        <ToggleRow id="pt-builtin-near-anchor" label="near-anchor · 首句锚点" hint="strategy=anchor-auto · position=after-user · dedupe=session；跟随「追加任务引导」。"
          checked={fields.anchorFirstTurn} disabled={props.disabled || !fields.writePreset} onChange={(value) => props.onChange('anchorFirstTurn', value)} />
        <ToggleRow id="pt-builtin-router-guide" label="router-guide · 每轮引导" hint="strategy=guide-auto · position=after-user · dedupe=batch；跟随「追加任务引导」。"
          checked={fields.anchorFirstTurn} disabled={props.disabled || !fields.writePreset} onChange={(value) => props.onChange('anchorFirstTurn', value)} />
        <ToggleRow id="pt-builtin-prompt-injector" label="prompt-injector · preset.md 注入" hint="strategy=anchor-fallback · position=before-all · dedupe=session；跟随「注入 preset.md」。"
          checked={fields.injectPrompt} disabled={props.disabled || !fields.writePreset} onChange={(value) => props.onChange('injectPrompt', value)} />
        <ToggleRow id="pt-builtin-instruction-hint" label="instruction-hint · 指令文件提示" hint="strategy=placeholder · fill=instruction-hint · position=after-all；常开，不可在此关闭。"
          checked={true} disabled onChange={() => {}} />
      </div>
    </section>
  )
}

/** 首轮输出封顶：数字框 + 开关组成的行，挂在调用配置层。 */
function BootstrapTokensRow(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <div className={ui.rowGroup}>
      <label className={ui.toggleRow} htmlFor="pt-bootstrap-tokens">
        <span className={ui.settingCopy}><strong>首轮输出封顶</strong><small>开启后首轮请求 #1 使用右侧 maxTokens；关闭显示默认 256000（不设上限），晋升后自动剥离。</small></span>
        <span className={ui.inlineControls}>
          <input
            className={ui.bootstrapTokensInput}
            type="number"
            min={1}
            step={1}
            value={store.bootstrapTokensDraft}
            disabled={!fields.writePreset || fields.bootstrapMaxTokens === 0}
            aria-label="首轮输出封顶数值"
            onChange={(event) => store.setBootstrapTokensDraft(event.target.value)}
            onBlur={store.commitBootstrapTokensDraft}
          />
          <input id="pt-bootstrap-tokens" type="checkbox" checked={fields.bootstrapMaxTokens > 0} disabled={!fields.writePreset} aria-label="首轮输出封顶" onChange={store.toggleBootstrapMaxTokens} />
          <span className={ui.switch} aria-hidden="true"><i /></span>
        </span>
      </label>
    </div>
  )
}

/** 消息批层入口开关：只保留真正注入 pre-step 的开关。 */
function EntrySwitches(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const setSwitch = (key: SwitchKey, value: boolean) => {
    if (fields[key] !== value) store.toggle(key)
  }
  return (
    <section className={ui.section} aria-labelledby="pt-entry-heading">
      <div className={ui.sectionHeading}><div><h2 id="pt-entry-heading">消息批层入口开关</h2><p>以下开关全部作用于 agent/pre-step 消息批；预设总开关、PTC、子代理路由等已按各自层级归位。</p></div></div>
      <div className={ui.rowGroup}>
        <ToggleRow id="pt-inject-prompt" label="注入 preset.md（锚定层）" hint="prompt-injector 提示词配置：消息插入决策消息开头，每会话一次。"
          checked={fields.injectPrompt} disabled={!fields.writePreset} onChange={(value) => setSwitch('injectPrompt', value)} />
        <ToggleRow id="pt-anchor-first" label="追加任务引导" hint="near-anchor / router-guide 提示词配置：在首条真实用户消息之后追加任务引导。"
          checked={fields.anchorFirstTurn} disabled={!fields.writePreset} onChange={(value) => setSwitch('anchorFirstTurn', value)} />
        <ToggleRow id="pt-anchor-custom" label="使用自定义引导（首句）" hint="near-anchor 的 params.useCustom；关闭时按任务自动选择 we / let 引导。"
          checked={fields.anchorCustom} disabled={!fields.writePreset || !fields.anchorFirstTurn} onChange={(value) => setSwitch('anchorCustom', value)} />
        <ToggleRow id="pt-guide-custom" label="使用自定义引导（每轮）" hint="router-guide 的 params.useCustom；关闭时按任务自动选择。"
          checked={fields.guideCustom} disabled={!fields.writePreset || !fields.anchorFirstTurn} onChange={(value) => setSwitch('guideCustom', value)} />
      </div>

      <div className={clsx(ui.rowGroup, (!fields.anchorFirstTurn || !fields.anchorCustom) && ui.rowDisabled)}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>自定义引导文本（首句）</strong><small>仅在「使用自定义引导（首句）」开启时生效。</small></span>
          <textarea
            className={ui.anchorInput}
            value={fields.anchorText}
            disabled={!fields.writePreset || !fields.anchorFirstTurn || !fields.anchorCustom}
            onChange={(event) => store.patch({ anchorText: event.target.value })}
            onBlur={store.persistSwitches}
            spellCheck={false}
          />
        </label>
      </div>
      <div className={clsx(ui.rowGroup, (!fields.anchorFirstTurn || !fields.guideCustom) && ui.rowDisabled)}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>自定义引导文本（每轮）</strong><small>仅在「使用自定义引导（每轮）」开启时生效；留空则不注入。</small></span>
          <textarea
            className={ui.anchorInput}
            value={fields.guideText}
            disabled={!fields.writePreset || !fields.anchorFirstTurn || !fields.guideCustom}
            onChange={(event) => store.patch({ guideText: event.target.value })}
            onBlur={store.persistSwitches}
            spellCheck={false}
          />
        </label>
      </div>
    </section>
  )
}

/** 调用配置层开关：首轮 maxTokens 与子代理固定 Flash 路由。 */
function AgentRequestSwitches(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <section className={ui.section} aria-labelledby="pt-agent-request-switches">
      <div className={ui.sectionHeading}><div><h2 id="pt-agent-request-switches">调用配置层开关</h2><p>作用于首轮请求配置与子代理调用参数，和本层提示词配置的 priority / modelScope / subagents 语义一致。</p></div></div>
      <BootstrapTokensRow store={store} />
      <div className={ui.rowGroup}>
        <ToggleRow id="pt-subagent-flash" label="子代理固定 Flash 模型" hint={fields.subagentFlash
          ? '固定 Flash 路由 + 任务分类人设 + 三锚；宿主直派子代理也会自动补 Flash 路由。'
          : store.deepseekAvailable
            ? '开启时采用 dsh-router-standard 的 Flash 子代理方案；关闭时继承主会话模型。'
            : `未检测到 DeepSeek 模型配置，此开关不可用。providers=[${store.deepseekProviders.join(', ') || '空'}]${store.deepseekError ? ' error=' + store.deepseekError : ''}`}
          checked={fields.subagentFlash} disabled={!fields.writePreset || !store.deepseekAvailable} onChange={() => store.toggle('subagentFlash')} />
      </div>
      <SettingInputRow id="pt-subagent-flash-provider" label="Flash 路由 provider" hint="调用方未显式指定 provider 时自动补入；例如 deepseek-official。"
        value={fields.subagentFlashProvider} disabled={!fields.writePreset}
        onInput={(value) => store.patch({ subagentFlashProvider: value })}
        onCommit={store.persistSwitches} />
      <SettingInputRow id="pt-subagent-flash-model" label="Flash 模型名" hint="调用方未显式指定 model 时自动补入；例如 deepseek-v4-flash。"
        value={fields.subagentFlashModel} disabled={!fields.writePreset}
        onInput={(value) => store.patch({ subagentFlashModel: value })}
        onCommit={store.persistSwitches} />
    </section>
  )
}

/** 工具管线层开关：PTC（Code Mode）工具目录。 */
function ToolPipelineSwitches(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <section className={ui.section} aria-labelledby="pt-tool-pipeline-switches">
      <div className={ui.sectionHeading}><div><h2 id="pt-tool-pipeline-switches">工具管线层开关</h2><p>晋升后的 wire 工具目录形态，与本层 tools/* 提示词配置同级。</p></div></div>
      <div className={ui.rowGroup}>
        <ToggleRow id="pt-use-ptc" label="使用 PTC 模式" hint="晋升后把 wire 切换为 Code Mode（单一 run_code），完整插件工具通过生成 SDK 调用；关闭时恢复原生完整工具目录。"
          checked={fields.usePtcMode} disabled={!fields.writePreset} onChange={() => store.toggle('usePtcMode')} />
      </div>
    </section>
  )
}

/** 功能设置：无法归属到单一注入层级的全局开关。 */
function FeatureSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <section className={ui.section} aria-labelledby="pt-feature-settings">
      <div className={ui.sectionHeading}><div><h2 id="pt-feature-settings">功能设置</h2><p>以下开关作用于整个插件装配，无法归入单一注入层级；所有修改立即写入 settings 并生效。</p></div></div>
      <div className={ui.rowGroup}>
        <ToggleRow id="pt-write-preset" label="启用锚定预设" hint="预设生成总开关，作用于全部六个层级：开启时生成并刷新 ~/.dsh/.agent-presets/prompt-tool/；关闭时移除生成目录，各层锚定开关随之失效。"
          checked={fields.writePreset} onChange={() => store.toggle('writePreset')} />
        <ToggleRow id="pt-write-agents" label="写入 ~/.dsh/AGENTS.md" hint="保持 AGENTS.md 的全局常驻注入；关闭后不再写入，已有文件保持原样。与六层注入无关，属于宿主常驻层。"
          checked={fields.writeAgents} onChange={() => store.toggle('writeAgents')} />
      </div>
      <SettingInputRow id="pt-resident-agents-path" label="AGENTS.md 常驻路径" hint="写入/移除 AGENTS.md 受管块的目标文件；修改后下一次开关保存立即切换。"
        value={fields.residentAgentsPath} placeholder={fields.residentAgentsPath || '默认 ~/.dsh/AGENTS.md'}
        onInput={(value) => store.patch({ residentAgentsPath: value })}
        onCommit={store.persistSwitches} />
      <SettingInputRow id="pt-preset-dir" label="生成 preset 目录" hint="锚定预设生成目录；修改后下次写入会生成到新目录，建议同时在宿主 agent-presets 设置里选择该目录。"
        value={fields.presetDir} placeholder={fields.presetDir || '默认 ~/.dsh/.agent-presets/prompt-tool'}
        onInput={(value) => store.patch({ presetDir: value })}
        onCommit={store.persistSwitches} />
      <SettingInputRow id="pt-preset-order" label="preset 显示顺序" hint="生成 preset.yml 的 order；数值小的 preset 在宿主列表中靠前。"
        type="number" value={String(fields.presetOrder)}
        onInput={(value) => store.patch({ presetOrder: Number(value) || 0 })}
        onCommit={store.persistSwitches} />
    </section>
  )
}

function FileEditor(props: { store: PromptToolStore; scope: 'preset' | 'agents' }): ReactNode {
  const { store, scope } = props
  const fields = store.fields
  const isPreset = scope === 'preset'
  const text = isPreset ? fields.promptText : fields.agentsText
  const saved = isPreset ? store.savedPromptText : store.savedAgentsText
  const dirty = text !== saved
  const saving = isPreset ? store.savingPrompt : store.savingAgents
  const title = isPreset ? 'Preset 预设' : 'AGENTS 设置'
  const desc = isPreset
    ? 'preset.md 内容写入 settings.promptText；由消息批层的 prompt-injector 提示词配置注入。生成总开关在「功能设置」。'
    : 'AGENTS.md 内容写入 settings.agentsText；下方开关决定是否经 instruction-hint 注入，常驻写入开关在「功能设置」。'
  return (
    <section className={ui.section} aria-labelledby={`pt-${scope}-heading`}>
      <div className={ui.sectionHeading}>
        <div><h2 id={`pt-${scope}-heading`}>{title}{dirty ? ' · 未保存' : ''}</h2><p>{desc}</p></div>
        <div className={css.sectionActions}>
          <button type="button" className={ui.primaryPill} disabled={saving || !dirty} onClick={isPreset ? store.savePrompt : store.saveAgents}>{saving ? '保存中…' : '校验并保存'}</button>
          <button type="button" className={ui.pillButton} disabled={!dirty} onClick={isPreset ? store.discardPrompt : store.discardAgents}>放弃修改</button>
        </div>
      </div>
      {!isPreset && (
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-inject-agents" label="注入 AGENTS.md" hint="经 pre-step 的 instruction-hint 提示词配置注入：消息追加在决策消息末尾，每会话一次。"
            checked={fields.injectAgentsPrompt} disabled={!fields.writePreset} onChange={() => store.toggle('injectAgentsPrompt')} />
        </div>
      )}
      <textarea
        className={ui.textarea}
        aria-label={`${title}内容`}
        value={text}
        onChange={(event) => store.patch(isPreset ? { promptText: event.target.value } : { agentsText: event.target.value })}
        spellCheck={false}
      />
      {isPreset && (
        <div className={ui.rowGroup}>
          <label className={ui.textBlock}>
            <span className={ui.settingCopy}><strong>缺省文本（preset.md 缺失时使用）</strong><small>仅当包内 preset.md 不存在或不可读时生效；修改后失焦保存。</small></span>
            <textarea
              className={ui.anchorInput}
              value={fields.fallbackText}
              onChange={(event) => store.patch({ fallbackText: event.target.value })}
              onBlur={store.persistSwitches}
              spellCheck={false}
            />
          </label>
        </div>
      )}
    </section>
  )
}

function LayerConfigList(props: { store: PromptToolStore; layer: string }): ReactNode {
  const { store, layer } = props
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [subTab, setSubTab] = useState<string>('list')
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [saving, setSaving] = useState(false)
  const configs = useMemo(() => configsOfLayer(store.fields.promptConfigs, layer), [store.fields.promptConfigs, layer])
  const dirty = JSON.stringify(store.fields.promptConfigs) !== JSON.stringify(store.savedConfigs)
  const activeTab = subTab !== 'list' && configs.some((config) => config.id === subTab) ? subTab : 'list'
  const focusedConfig = activeTab === 'list' ? undefined : configs.find((config) => config.id === activeTab)

  const save = async () => {
    setSaving(true)
    const result = await validateConfigs(store.fields.promptConfigs)
    if (result.valid) {
      setErrors([])
      store.persistConfigs(store.fields.promptConfigs)
      store.showNotice('ok', `提示词配置已校验并保存（${store.fields.promptConfigs.length} 条）`)
    } else {
      setErrors(result.errors)
      store.showNotice('error', `校验失败：${result.errors.length} 个错误`)
    }
    setSaving(false)
  }

  const discard = () => {
    store.patch({ promptConfigs: store.savedConfigs })
    setErrors([])
  }

  const patchAt = (globalIndex: number, patch: Partial<PromptConfigDraft>) => {
    store.patch({
      promptConfigs: store.fields.promptConfigs.map((config, index) => index === globalIndex ? { ...config, ...patch } : config),
    })
  }

  const duplicateAt = (globalIndex: number) => {
    const source = store.fields.promptConfigs[globalIndex]
    if (source === undefined) return
    let id = `${source.id}-copy`
    let suffix = 2
    while (store.fields.promptConfigs.some((config) => config.id === id)) {
      id = `${source.id}-copy${suffix}`
      suffix += 1
    }
    const clone = JSON.parse(JSON.stringify(source)) as PromptConfigDraft
    clone.id = id
    store.patch({ promptConfigs: [...store.fields.promptConfigs, clone] })
    setExpanded(id)
    setSubTab(id)
  }

  const removeAt = (globalIndex: number) => {
    const next = store.fields.promptConfigs.filter((_, index) => index !== globalIndex)
    const removedId = store.fields.promptConfigs[globalIndex]?.id
    store.patch({ promptConfigs: next })
    if (expanded === removedId) setExpanded(undefined)
    if (subTab === removedId) setSubTab('list')
  }

  /** 上移/下移只在本层级内交换：其他层级顺序保持稳定。 */
  const moveWithinLayer = (globalIndex: number, delta: -1 | 1) => {
    const all = store.fields.promptConfigs
    const indices = all.flatMap((config, index) => layerOf(config) === layer ? [index] : [])
    const position = indices.indexOf(globalIndex)
    const target = position + delta
    if (position < 0 || target < 0 || target >= indices.length) return
    const targetIndex = indices[target]!
    const next = [...all]
    const current = next[globalIndex]
    next[globalIndex] = next[targetIndex]!
    next[targetIndex] = current!
    store.patch({ promptConfigs: next })
  }

  const renderCard = (config: PromptConfigDraft, forceOpen: boolean) => {
    const globalIndex = store.fields.promptConfigs.indexOf(config)
    const layerIndices = store.fields.promptConfigs.flatMap((candidate, index) => layerOf(candidate) === layer ? [index] : [])
    const position = layerIndices.indexOf(globalIndex)
    const isOpen = forceOpen || expanded === config.id
    return (
      <PromptConfigCard
        key={config.id}
        config={config}
        expanded={isOpen}
        onToggleExpanded={() => {
          if (forceOpen) return
          setExpanded(isOpen ? undefined : config.id)
        }}
        onToggleEnabled={(enabled) => patchAt(globalIndex, { enabled })}
        onPatch={(patch) => patchAt(globalIndex, patch)}
        actions={{
          canMoveUp: position > 0,
          canMoveDown: position >= 0 && position < layerIndices.length - 1,
          onMoveUp: () => moveWithinLayer(globalIndex, -1),
          onMoveDown: () => moveWithinLayer(globalIndex, 1),
          onDuplicate: () => duplicateAt(globalIndex),
          onDelete: () => removeAt(globalIndex),
        }}
      />
    )
  }

  return (
    <section className={ui.section} aria-labelledby="pt-layer-configs-heading">
      <div className={ui.sectionHeading}>
        <div><h2 id="pt-layer-configs-heading">本层提示词配置</h2><p>{configs.length} 条自定义配置 · {configs.filter((config) => config.enabled !== false).length} 条启用；上下移动控制同层顺序，priority 小者更靠近锚点。</p></div>
        <div className={css.sectionActions}>
          <button type="button" className={ui.primaryPill} disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '校验并保存'}</button>
          <button type="button" className={ui.pillButton} disabled={!dirty} onClick={discard}>放弃修改</button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className={ui.configErrorBox}>
          {errors.map((error, index) => <div key={`${error.index}-${index}`} className={ui.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>)}
        </div>
      )}

      {configs.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">⌁</span><div><h3>本层还没有自定义配置</h3><p>请到主设置「提示词配置」从模板插入或从目录导入。</p></div></div>
      ) : (
        <>
          {configs.length > 1 && (
            <div className={css.memoryNavigation} data-nested>
              <div className={css.memoryTabs} role="tablist" aria-label={`${LAYER_LABELS[layer as typeof LAYERS[number]]?.title ?? layer}配置分页`}>
                <button type="button" role="tab" aria-selected={activeTab === 'list'} data-active={activeTab === 'list' ? '' : undefined} onClick={() => setSubTab('list')}>全部（{configs.length}）</button>
                {configs.map((config) => (
                  <button key={config.id} type="button" role="tab" aria-selected={activeTab === config.id} data-active={activeTab === config.id ? '' : undefined} onClick={() => setSubTab(config.id)}>
                    {config.name && config.name !== config.id ? `${config.name}` : config.id}
                  </button>
                ))}
              </div>
            </div>
          )}

          {focusedConfig === undefined
            ? <div className={ui.configList}>{configs.map((config) => renderCard(config, false))}</div>
            : <div className={ui.configList}>{renderCard(focusedConfig, true)}</div>}
        </>
      )}
    </section>
  )
}

function SkillsSettings(props: { store: PromptToolStore; api: IApiClient }): ReactNode {
  const { store, api } = props
  const fields = store.fields
  const [pickingDir, setPickingDir] = useState(false)
  const [dragFolder, setDragFolder] = useState<string | undefined>(undefined)
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
  const dirty = JSON.stringify(fields.skillSwitches) !== JSON.stringify(store.savedSwitches.skillSwitches)
    || JSON.stringify(fields.skillOrder) !== JSON.stringify(store.savedSwitches.skillOrder)
    || fields.skillsDir !== store.savedSwitches.skillsDir
    || store.skillsDirDraft.trim() !== fields.skillsDir

  const moveSkill = (from: string, to: string) => {
    const folders = orderedSkills.map((skill) => skill.folder)
    const fromAt = folders.indexOf(from)
    const toAt = folders.indexOf(to)
    if (fromAt < 0 || toAt < 0 || fromAt === toAt) return
    const [moved] = folders.splice(fromAt, 1)
    folders.splice(toAt, 0, moved!)
    store.patch({ skillOrder: folders })
    store.persistSwitches()
  }

  const pickSkillsDir = async () => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const picked = await api.host.pickDirectory({})
      if (!picked.result.ok) {
        store.showNotice('error', '选择目录失败：' + (picked.result.error?.message ?? 'host.pickDirectory 不可用'))
        return
      }
      const path = picked.result.value?.path
      if (!path) return
      store.setSkillsDirDraft(path)
      store.applySkillsDirValue(path)
    } catch (error) {
      store.showNotice('error', '选择目录失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setPickingDir(false)
    }
  }

  return (
    <section className={ui.section} aria-labelledby="pt-skills-heading">
      <div className={ui.sectionHeading}>
        <div><h2 id="pt-skills-heading">Skills 设置</h2><p>{fields.skillCatalog.length} 个技能；拖动 ⠿ 排序即模型看到的先后顺序，排第一的技能最先被看到。关闭后立即注销，开启即恢复。</p></div>
        <div className={css.sectionActions}>
          <button type="button" className={ui.pillButton} disabled={!fields.activeSkillsDir && !fields.skillsDir} onClick={() => void store.openSkillsDir()}>打开技能目录</button>
        </div>
      </div>

      <div className={ui.importBar}>
        <div><strong>从目录导入技能目录</strong><small>打开系统文件管理器选择目录；选中路径写入下方编辑框并立即保存生效。每个子文件夹应含 SKILL.md。</small></div>
        <button type="button" className={ui.primaryPill} disabled={pickingDir} onClick={() => void pickSkillsDir()}>{pickingDir ? '选择中…' : '选择目录并导入'}</button>
      </div>

      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>技能目录</strong>
            <small>编辑框可直接输入路径；留空 = 当前 profile 下的 skills/ 副本，设置后立即重新扫描。</small>
            <code className={ui.activePath} title={fields.activeSkillsDir}>{fields.activeSkillsDir || '（路径未知，请重新打开工作台）'}</code>
          </span>
          <div className={ui.directoryControl}>
            <input
              className={ui.directoryInput}
              aria-label="用户自定义技能目录"
              value={store.skillsDirDraft}
              placeholder="留空 = 自动使用当前生效目录"
              title={`当前生效：${fields.activeSkillsDir || '未知'}`}
              spellCheck={false}
              onChange={(event) => store.setSkillsDirDraft(event.target.value)}
            />
            <button type="button" className={ui.pillButton} disabled={store.savingSkillsDir || store.skillsDirDraft.trim() === fields.skillsDir} onClick={store.applySkillsDir}>
              {store.savingSkillsDir ? '设置中…' : '设置目录'}
            </button>
          </div>
        </div>
      </div>

      <SettingInputRow id="pt-skill-rank-base" label="技能排序基数" hint="每个技能实际 rank = 基数 + 拖拽序号；默认 250。数值过小会让本项目技能抢占其他插件技能的位置，但不会影响任何提示词消息注入。"
        type="number" value={String(fields.skillRankBase)}
        onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
        onCommit={store.persistSwitches} />

      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">◇</span><div><h3>skills 目录下没有技能</h3><p>从上方选择目录导入，或确认技能目录路径后重新打开工作台。</p></div></div>
      ) : (
        <div className={ui.rowGroup}>
          {orderedSkills.map((skill, index) => {
            const invocationHint = skill.valid
              ? `${skill.modelInvocable ? '模型' : '非模型'} · ${skill.userInvocable ? '用户' : '非用户'}可调用`
              : `未注册给模型：${skill.issue ?? '技能不合法'}`
            return (
              <div
                key={skill.folder}
                className={clsx(ui.skillDragRow, !skill.valid && ui.skillRowInvalid)}
                data-dragging={dragFolder === skill.folder ? '' : undefined}
                draggable={skill.valid}
                onDragStart={(event) => {
                  setDragFolder(skill.folder)
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragFolder !== undefined && dragFolder !== skill.folder) moveSkill(dragFolder, skill.folder)
                  setDragFolder(undefined)
                }}
                onDragEnd={() => setDragFolder(undefined)}
              >
                <span className={ui.dragHandle} title={`第 ${index + 1} 位，拖动调整`} aria-hidden="true">⠿</span>
                <ToggleRow
                  id={`pt-skill-${skill.folder}`}
                  label={`${index + 1}. ${skill.name || skill.folder}`}
                  hint={`skills/${skill.folder}${skill.description ? ` · ${skill.description}` : ''} · ${invocationHint}`}
                  checked={store.skillEnabled(skill.folder)}
                  disabled={!skill.valid}
                  onChange={() => store.toggleSkill(skill.folder)}
                />
                {!skill.valid && (
                  <button
                    type="button"
                    className={ui.pillButton}
                    disabled={store.fixingSkill === skill.folder}
                    onClick={() => void store.fixSkill(skill.folder)}
                  >
                    {store.fixingSkill === skill.folder ? '修复中…' : '一键修复'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {dirty && <p className={ui.readOnly} role="status">Skills 开关与目录修改立即保存；如上方按钮仍在写入，请稍候。</p>}
    </section>
  )
}

export interface PromptWorkspaceProps {
  api: IApiClient
  controller: PromptToolWorkspaceController
  onClose: () => void
}

type WorkspacePage = typeof LAYERS[number] | 'skills' | 'features'
type EntryPage = 'switches' | 'preset' | 'agents' | 'configs'

const ENTRY_PAGES: Array<{ id: EntryPage; label: string }> = [
  { id: 'switches', label: '入口开关' },
  { id: 'preset', label: 'Preset 预设' },
  { id: 'agents', label: 'AGENTS 设置' },
  { id: 'configs', label: '消息批配置' },
]

/** 侧边栏独立工作台：顶部六个层级标签 + Skills 设置。 */
export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api)
  const [page, setPage] = useState<WorkspacePage>('pre-step')
  const [entryPage, setEntryPage] = useState<EntryPage>('switches')
  const open = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  ).open

  useEffect(() => {
    // 每次打开工作台都重新同步 settings（其他客户端可能已修改）。
    if (open) void store.load()
  }, [open, store.load])


  const enabledCount = store.fields.promptConfigs.filter((config) => config.enabled !== false).length
  const layerMeta = page === 'skills'
    ? `${store.fields.skillCatalog.length} 技能`
    : page === 'features'
      ? '全局'
      : `${configsOfLayer(store.fields.promptConfigs, page).length} 配置`
  const pageTitle = page === 'skills' ? 'Skills 设置' : page === 'features' ? '功能设置' : LAYER_LABELS[page].title
  const pageDetail = page === 'skills'
    ? '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。'
    : page === 'features'
      ? '无法明确归属到单一注入层级的全局功能开关。'
      : LAYER_LABELS[page].detail

  return (
    <div className={css.shell}>
      <header className={css.masthead}>
        <div className={css.brand}>
          <span className={css.brandLogo} aria-hidden="true">⌁</span>
          <h1>提示词工具</h1>
        </div>
        <div className={css.statusCluster}>
          <span className={css.statusDot} data-state={store.loading ? 'checking' : 'online'} aria-hidden="true" />
          <span>{store.loading ? '读取中' : `${store.fields.promptConfigs.length} 配置 · ${enabledCount} 启用`}</span>
        </div>
        <button type="button" className={css.iconButton} onClick={props.onClose} aria-label="关闭工作台">×</button>
      </header>

      <div className={css.topNavigation}>
        <div className={css.nav} role="tablist" aria-label="提示词工具层级">
          {LAYERS.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={page === item} data-active={page === item ? '' : undefined} onClick={() => setPage(item)}>
              <span><strong>{LAYER_LABELS[item].title}</strong><small>{item}</small></span>
            </button>
          ))}
          <button type="button" role="tab" aria-selected={page === 'skills'} data-active={page === 'skills' ? '' : undefined} onClick={() => setPage('skills')}>
            <span><strong>Skills 设置</strong><small>skills</small></span>
          </button>
          <button type="button" role="tab" aria-selected={page === 'features'} data-active={page === 'features' ? '' : undefined} onClick={() => setPage('features')}>
            <span><strong>功能设置</strong><small>features</small></span>
          </button>
        </div>
      </div>

      {page === 'pre-step' && (
        <div className={css.memoryNavigation}>
          <div className={css.memoryTabs} role="tablist" aria-label="消息批层子页">
            {ENTRY_PAGES.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={entryPage === item.id} data-active={entryPage === item.id ? '' : undefined} onClick={() => setEntryPage(item.id)}>{item.label}</button>
            ))}
          </div>
        </div>
      )}

      <main className={css.canvas}>
        <div>
          <PageHeader title={pageTitle} description={pageDetail} meta={layerMeta} />

          {page === 'skills' ? <SkillsSettings store={store} api={props.api} /> : (
            <>
              {page === 'pre-step' && entryPage === 'switches' && <EntrySwitches store={store} />}
              {page === 'pre-step' && entryPage === 'preset' && <FileEditor store={store} scope="preset" />}
              {page === 'pre-step' && entryPage === 'agents' && <FileEditor store={store} scope="agents" />}
              {page === 'pre-step' && entryPage === 'configs' && (
                <>
                  <BuiltinConfigRows fields={store.fields} disabled={store.loading} onChange={(key, value) => {
                    if (store.fields[key] !== value) store.toggle(key)
                  }} />
                  <LayerConfigList store={store} layer="pre-step" />
                </>
              )}
              {page === 'features' && <FeatureSettings store={store} />}
              {page !== 'pre-step' && page !== 'features' && (
                <>
                  {page === 'agent-request' && <AgentRequestSwitches store={store} />}
                  {page === 'tool-pipeline' && <ToolPipelineSwitches store={store} />}
                  <LayerConfigList store={store} layer={page} />
                </>
              )}
            </>
          )}

          {store.notice && <p className={clsx(ui.notice, store.noticeKind === 'error' && ui.noticeError)} role="status">{store.notice}</p>}
        </div>
      </main>
    </div>
  )
}
