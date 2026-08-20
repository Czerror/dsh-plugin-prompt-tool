import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  type PromptToolStore,
  type PromptToolSettingsTransport,
  type SwitchKey,
  usePromptToolStore,
} from './prompt-tool-store.ts'
import type { Fields, SkillCatalogEntry } from './prompt-tool-bridge.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import type { PromptConfigDraft } from './PromptConfigsEditor.tsx'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

const layerOf = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'

const configsOfLayer = (configs: PromptConfigDraft[], layer: string): PromptConfigDraft[] =>
  configs.filter((config) => layerOf(config) === layer)

function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; extra?: ReactNode; onChange: (value: boolean) => void }): ReactNode {
  return (
    <label className={ui.toggleRow} htmlFor={props.id}>
      <span className={ui.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span>
      {props.extra}
      <input id={props.id} type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span className={ui.switch} aria-hidden="true"><i /></span>
    </label>
  )
}

/** 技能调用状态徽章：只保留模型可调用状态，开关关闭后立即变灰。 */
function SkillStatusChips(props: { skill: SkillCatalogEntry; enabled: boolean }): ReactNode {
  const { skill, enabled } = props
  const callable = skill.valid && skill.modelInvocable && enabled
  const status = skill.valid ? (callable ? '模型可调用' : '模型不可调用') : '未注册'
  return (
    <span className={ui.skillStatusRow} aria-label={`技能调用状态：${status}`}>
      <span className={clsx(ui.skillStatusChip, skill.valid ? (callable ? ui.skillStatusModel : ui.skillStatusOff) : ui.skillStatusError)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {status}
      </span>
    </span>
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
            aria-label={props.label}
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

/** Anchored Standard 预设模块行：按实际生效配置动态生成（模板声明什么显示什么）。 */
function BuiltinConfigRows(props: { fields: Fields; configs: PromptConfigDraft[]; disabled: boolean; onChange: (key: SwitchKey, value: boolean) => void; onEdit: (id: string) => void }): ReactNode {
  const { fields, configs, onEdit } = props
  /** 预设声明的消息批模块：id → 开关键映射；模块不存在（模板未声明）时行不渲染。 */
  const rows: Array<{ id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }> = [
    {
      id: 'near-anchor',
      label: 'near-anchor · 首句锚点',
      hint: 'strategy=first-turn-anchor · position=after-user · dedupe=session；跟随「追加任务引导」。',
      checked: fields.firstTurnAnchor,
      onChange: (value) => props.onChange('firstTurnAnchor', value),
    },
    {
      id: 'router-guide',
      label: 'router-guide · 每轮引导',
      hint: 'strategy=guide-auto · position=after-user · dedupe=batch；跟随「追加任务引导」。',
      checked: fields.firstTurnAnchor,
      onChange: (value) => props.onChange('firstTurnAnchor', value),
    },
    {
      id: 'prompt-injector',
      label: 'prompt-injector · preset.md 注入',
      hint: 'strategy=custom-fallback · position=before-all · dedupe=session；跟随「注入 preset.md」。',
      checked: fields.injectPrompt,
      onChange: (value) => props.onChange('injectPrompt', value),
    },
    {
      id: 'instruction-hint',
      label: 'instruction-hint · 指令文件提示',
      hint: 'strategy=placeholder · fill=instruction-hint · position=after-all；常开，不可在此关闭。',
      checked: true,
      onChange: () => {},
    },
  ]
  const disabled = props.disabled || !fields.writePreset
  return (
    <section className={ui.section} aria-labelledby="prompt-tool-builtin-heading">
      <div className={ui.sectionHeading}><div><h2 id="prompt-tool-builtin-heading">Anchored Standard(prompt-tool)</h2><p>预设模板（preset.yml）声明的消息批模块，按实际生效配置展示；切换模板后此处跟随模板声明。</p></div></div>
      <div className={ui.rowGroup}>
        {rows.flatMap((row) => {
          const config = configs.find((item) => item.id === row.id)
          // 模板未声明该模块（或已被删除）时不渲染；label 优先用配置名。
          if (config === undefined) return []
          const label = config.name !== undefined && config.name.length > 0 && config.name !== config.id
            ? `${config.id} · ${config.name}`
            : row.label
          return [
            <ToggleRow key={row.id} id={`pt-builtin-${row.id}`} label={label} hint={row.hint}
              checked={row.checked} disabled={disabled} onChange={row.onChange}
              extra={<button type="button" className={ui.pillButton} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(config.id) }}>编辑</button>} />,
          ]
        })}
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
          checked={fields.firstTurnAnchor} disabled={!fields.writePreset} onChange={(value) => setSwitch('firstTurnAnchor', value)} />
        <ToggleRow id="pt-anchor-custom" label="使用自定义引导（首句）" hint="near-anchor 的 params.useCustom；关闭时按任务自动选择 we / let 引导。"
          checked={fields.firstTurnCustom} disabled={!fields.writePreset || !fields.firstTurnAnchor} onChange={(value) => setSwitch('firstTurnCustom', value)} />
        <ToggleRow id="pt-guide-custom" label="使用自定义引导（每轮）" hint="router-guide 的 params.useCustom；关闭时按任务自动选择。"
          checked={fields.guideCustom} disabled={!fields.writePreset || !fields.firstTurnAnchor} onChange={(value) => setSwitch('guideCustom', value)} />
      </div>

      <div className={clsx(ui.rowGroup, (!fields.writePreset || !fields.firstTurnAnchor || !fields.firstTurnCustom) && ui.rowDisabled)}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>自定义引导文本（首句）</strong><small>仅在「使用自定义引导（首句）」开启时生效。</small></span>
          <textarea
            className={ui.firstTurnInput}
            value={fields.firstTurnText}
            disabled={!fields.writePreset || !fields.firstTurnAnchor || !fields.firstTurnCustom}
            onChange={(event) => store.patch({ firstTurnText: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
            spellCheck={false}
          />
        </label>
      </div>
      <div className={clsx(ui.rowGroup, (!fields.writePreset || !fields.firstTurnAnchor || !fields.guideCustom) && ui.rowDisabled)}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>自定义引导文本（每轮）</strong><small>仅在「使用自定义引导（每轮）」开启时生效；留空则不注入。</small></span>
          <textarea
            className={ui.firstTurnInput}
            value={fields.guideText}
            disabled={!fields.writePreset || !fields.firstTurnAnchor || !fields.guideCustom}
            onChange={(event) => store.patch({ guideText: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
            spellCheck={false}
          />
        </label>
      </div>
    </section>
  )
}

/** 调用配置层开关：首轮 maxTokens。 */
function AgentRequestSwitches(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <section className={ui.section} aria-labelledby="pt-agent-request-switches">
      <div className={ui.sectionHeading}><div><h2 id="pt-agent-request-switches">调用配置层开关</h2><p>作用于首轮请求配置，和本层提示词配置的 priority / modelScope 语义一致。</p></div></div>
      <BootstrapTokensRow store={store} />
    </section>
  )
}

/** 子代理设置：模型服务商 + 模型名下拉；任一为空 = 子代理继承主会话模型。 */
function SubagentSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const providerOptions = ['', ...store.deepseekProviders, 'deepseek-official']
  const modelOptions = ['', 'deepseek-v4-flash', 'deepseek-v4-pro']
  const withCurrent = (options: string[], current: string): string[] =>
    current.length > 0 && !options.includes(current) ? [...options, current] : options
  const active = fields.subagentFlashProvider.length > 0 && fields.subagentFlashModel.length > 0
  return (
    <section className={ui.section} aria-labelledby="pt-subagent-settings">
      <div className={ui.sectionHeading}><div><h2 id="pt-subagent-settings">子代理设置</h2><p>模型服务商与模型名同时设置时，子代理与宿主直派子代理自动使用该固定模型；任一为空 = 子代理继承主会话模型。</p></div></div>
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>模型服务商</strong>
            <small>调用方未显式指定 provider 时自动补入；例如 deepseek-official。{store.deepseekProviders.length > 0 ? `当前检测到：${store.deepseekProviders.join('、')}` : '未检测到模型路由，可手动选择 deepseek-official。'}</small>
          </span>
          <select
            className={ui.configInput}
            aria-label="模型服务商"
            value={fields.subagentFlashProvider}
            disabled={!fields.writePreset}
            onChange={(event) => {
              store.patch({ subagentFlashProvider: event.target.value })
              void store.persistParamOverrides()
            }}
          >
            {withCurrent(providerOptions, fields.subagentFlashProvider).map((item) => (
              <option key={item} value={item}>{item.length > 0 ? item : '（不设置）'}</option>
            ))}
          </select>
        </div>
      </div>
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>模型名</strong>
            <small>调用方未显式指定 model 时自动补入；例如 deepseek-v4-flash。</small>
          </span>
          <select
            className={ui.configInput}
            aria-label="模型名"
            value={fields.subagentFlashModel}
            disabled={!fields.writePreset}
            onChange={(event) => {
              store.patch({ subagentFlashModel: event.target.value })
              void store.persistParamOverrides()
            }}
          >
            {withCurrent(modelOptions, fields.subagentFlashModel).map((item) => (
              <option key={item} value={item}>{item.length > 0 ? item : '（不设置）'}</option>
            ))}
          </select>
        </div>
      </div>
      {!active && <p className={ui.readOnly} role="status">未设置：子代理将继承主会话模型路由。</p>}
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
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}>
            <strong>预设模板</strong>
            <small>切换后按新模板重建生成目录；anchored 为插件默认模板，另有官方标准/极简/PTC/创造四套。</small>
          </span>
          <select
            className={ui.configInput}
            aria-label="预设模板"
            value={fields.presetTemplate}
            disabled={!fields.writePreset}
            onChange={(event) => store.setPresetTemplate(event.target.value)}
          >
            {(store.meta.presets ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.id} · {preset.name}</option>
            ))}
          </select>
        </div>
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
      <SubagentSettings store={store} />
    </section>
  )
}

function FileEditor(props: { store: PromptToolStore; scope: 'preset' | 'agents' }): ReactNode {
  const { store, scope } = props
  const fields = store.fields
  const isPreset = scope === 'preset'
  const text = isPreset ? fields.promptText : fields.agentsText
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const title = isPreset ? 'Preset 预设' : 'AGENTS 设置'
  const desc = isPreset
    ? 'preset.md 内容存于生成目录（.agent-presets/<模板>/preset.md），由 prompt-injector 提示词配置注入；主设置通过「导入配置文件」写入，不再内嵌在 settings.yaml。生成总开关在「功能设置」。'
    : 'AGENTS.md 内容存于生成目录 agents.md；主设置通过「导入配置文件」写入；注入开关在「消息批层入口」。'
  const pickFile = (file: File | undefined): void => {
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result ?? '')
      setImporting(true)
      void store.importPreset(scope, content).finally(() => setImporting(false))
    }
    reader.readAsText(file)
  }
  return (
    <section className={ui.section} aria-labelledby={`pt-${scope}-heading`}>
      <div className={ui.sectionHeading}>
        <div><h2 id={`pt-${scope}-heading`}>{title}</h2><p>{desc}</p></div>
        <div className={ui.sectionActions}>
          <input ref={fileRef} type="file" accept=".md,.markdown,.txt" style={{ display: 'none' }} aria-label="选择配置文件"
            onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = '' }} />
          <button type="button" className={ui.primaryPill} disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? '导入中…' : '导入配置文件'}
          </button>
        </div>
      </div>
      {!isPreset && (
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-inject-agents" label="注入 AGENTS.md" hint="经 pre-step 的 instruction-hint 提示词配置注入：消息追加在决策消息末尾，每会话一次。"
            checked={fields.injectAgentsPrompt} disabled={!fields.writePreset} onChange={() => store.toggle('injectAgentsPrompt')} />
        </div>
      )}
      <div className={ui.rowGroup}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>当前内容（只读预览）</strong><small>导入文件后自动刷新；内容存于生成目录，不写入 settings.yaml。</small></span>
          <textarea className={ui.firstTurnInput} value={text} readOnly spellCheck={false} aria-label={`${title}当前内容`} />
        </label>
      </div>
      {isPreset && (
        <div className={ui.rowGroup}>
          <label className={ui.textBlock}>
            <span className={ui.settingCopy}><strong>缺省文本（preset.md 缺失时使用）</strong><small>仅当包内 preset.md 不存在或不可读时生效；修改后失焦保存。</small></span>
            <textarea
              className={ui.firstTurnInput}
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

function LayerConfigList(props: { store: PromptToolStore; layer: string; focusId?: string; focusTick?: number }): ReactNode {
  const { store, layer, focusId, focusTick } = props
  return (
    <PromptConfigList
      meta={store.meta}
      configs={store.fields.promptConfigs}
      savedConfigs={store.savedConfigs}
      layer={layer}
      focusId={focusId}
      focusTick={focusTick}
      onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
      onSaveConfigs={(configs) => store.persistConfigs(configs)}
      onNotice={store.showNotice}
    />
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
        <div className={ui.sectionActions}>
          <button type="button" className={ui.pillButton} onClick={() => void store.load()}>刷新技能列表</button>
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
            const hint = `skills/${skill.folder}${skill.description ? ` · ${skill.description}` : ''}`
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
                <div className={ui.skillEntryBody}>
                  <ToggleRow
                    id={`pt-skill-${skill.folder}`}
                    label={`${index + 1}. ${skill.name || skill.folder}`}
                    hint={hint}
                    checked={store.skillEnabled(skill.folder)}
                    disabled={!skill.valid}
                    extra={<SkillStatusChips skill={skill} enabled={store.skillEnabled(skill.folder)} />}
                    onChange={() => store.toggleSkill(skill.folder)}
                  />
                  {!skill.valid && (
                    <p className={ui.skillIssue} role="note">{skill.issue ?? '技能不合法'}</p>
                  )}
                </div>
                {skill.valid && (
                  <span className={ui.skillOrderButtons}>
                    <button
                      type="button"
                      className={ui.pillButton}
                      aria-label={`上移 ${skill.name || skill.folder}`}
                      title="上移（键盘排序）"
                      disabled={index === 0}
                      onClick={() => moveSkill(skill.folder, orderedSkills[index - 1]!.folder)}
                    >↑</button>
                    <button
                      type="button"
                      className={ui.pillButton}
                      aria-label={`下移 ${skill.name || skill.folder}`}
                      title="下移（键盘排序）"
                      disabled={index >= orderedSkills.length - 1}
                      onClick={() => moveSkill(skill.folder, orderedSkills[index + 1]!.folder)}
                    >↓</button>
                  </span>
                )}
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
  settings: PromptToolSettingsTransport
  controller: PromptToolWorkspaceController
  onClose: () => void
}

type WorkspacePage = string
type EntryPage = 'switches' | 'preset' | 'agents' | 'configs'

const ENTRY_PAGES: Array<{ id: EntryPage; label: string }> = [
  { id: 'switches', label: '入口开关' },
  { id: 'preset', label: 'Preset 预设' },
  { id: 'agents', label: 'AGENTS 设置' },
  { id: 'configs', label: '消息批配置' },
]

/** ARIA tabs 键盘导航：左右切换、Home/End 跳首尾。 */
function tabKeyHandler<T>(
  items: readonly T[],
  current: T,
  onSelect: (item: T) => void,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    const index = items.indexOf(current)
    if (index < 0) return
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === undefined) return
    event.preventDefault()
    onSelect(items[next]!)
  }
}

/** /meta 尚未加载或失败时的 UI 兜底层列表，保证 Skills 页仍可返回注入层。 */
const FALLBACK_LAYERS = ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline']
const FALLBACK_LAYER_LABELS: Record<string, { title: string; detail: string }> = {
  'pre-step': { title: '消息批层', detail: '官方默认层：agent/pre-step 消息批。' },
  'system-section': { title: '系统段层', detail: 'system-section 静态层。' },
  'runtime-context': { title: '运行上下文', detail: 'runtime-context 层。' },
  'agent-request': { title: '调用配置层', detail: 'agent-request 层。' },
  'llm-stream': { title: '模型流层', detail: 'llm/stream 层。' },
  'tool-pipeline': { title: '工具管线层', detail: 'tools/* 层。' },
}

/** 侧边栏独立工作台：顶部六个层级标签 + Skills 设置。 */
export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api, props.settings)
  const layers = store.meta.layers.length > 0 ? store.meta.layers : FALLBACK_LAYERS
  const [page, setPage] = useState<WorkspacePage>('pre-step')
  const [entryPage, setEntryPage] = useState<EntryPage>('switches')
  const [configFocus, setConfigFocus] = useState<{ id: string; tick: number } | undefined>(undefined)
  const requestConfigEdit = (id: string): void => {
    setConfigFocus((current) => ({ id, tick: (current?.tick ?? 0) + 1 }))
  }
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
  const isAnchoredTemplate = store.fields.presetTemplate === 'anchored'
  const layerMeta = page === 'skills'
    ? `${store.fields.skillCatalog.length} 技能`
    : page === 'features'
      ? '全局'
      : `${configsOfLayer(store.fields.promptConfigs, page).length} 配置`
  const layerLabel = page !== 'skills' && page !== 'features'
    ? (store.meta.layerLabels[page] ?? FALLBACK_LAYER_LABELS[page])
    : undefined
  const pageTitle = page === 'skills' ? 'Skills 设置' : page === 'features' ? '功能设置' : (layerLabel?.title ?? page)
  const pageDetail = page === 'skills'
    ? '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。'
    : page === 'features'
      ? '无法明确归属到单一注入层级的全局功能开关。'
      : (layerLabel?.detail ?? '')

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
        <button type="button" className={css.backButton} onClick={props.onClose}>返回对话</button>
      </header>

      <div className={css.topNavigation}>
        <div className={css.nav} role="tablist" aria-label="提示词工具层级">
          {layers.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={page === item} data-active={page === item ? '' : undefined} onClick={() => setPage(item)} onKeyDown={tabKeyHandler([...layers, 'skills', 'features'], page, setPage)}>
              <span><strong>{store.meta.layerLabels[item]?.title ?? FALLBACK_LAYER_LABELS[item]?.title ?? item}</strong><small>{item}</small></span>
            </button>
          ))}
          <button type="button" role="tab" aria-selected={page === 'skills'} data-active={page === 'skills' ? '' : undefined} onClick={() => setPage('skills')} onKeyDown={tabKeyHandler([...layers, 'skills', 'features'], page, setPage)}>
            <span><strong>Skills 设置</strong><small>skills</small></span>
          </button>
          <button type="button" role="tab" aria-selected={page === 'features'} data-active={page === 'features' ? '' : undefined} onClick={() => setPage('features')} onKeyDown={tabKeyHandler([...layers, 'skills', 'features'], page, setPage)}>
            <span><strong>功能设置</strong><small>features</small></span>
          </button>
        </div>
      </div>

      {page === 'pre-step' && (
        <div className={css.memoryNavigation}>
          <div className={css.memoryTabs} role="tablist" aria-label="消息批层子页">
            {ENTRY_PAGES.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={entryPage === item.id} data-active={entryPage === item.id ? '' : undefined} onClick={() => setEntryPage(item.id)} onKeyDown={tabKeyHandler(ENTRY_PAGES.map((entry) => entry.id), entryPage, setEntryPage)}>{item.label}</button>
            ))}
          </div>
        </div>
      )}

      <main className={css.canvas}>
        <div>
          <PageHeader title={pageTitle} description={pageDetail} meta={layerMeta} />

          {page === 'skills' ? <SkillsSettings store={store} api={props.api} /> : (
            <>
              {page === 'pre-step' && entryPage === 'switches' && (isAnchoredTemplate
                ? <EntrySwitches store={store} />
                : <p className={ui.readOnly} role="status">当前预设模板非 anchored，anchored 专属入口开关已隐藏。</p>)}
              {page === 'pre-step' && entryPage === 'preset' && <FileEditor store={store} scope="preset" />}
              {page === 'pre-step' && entryPage === 'agents' && <FileEditor store={store} scope="agents" />}
              {page === 'pre-step' && entryPage === 'configs' && (
                <>
                  {isAnchoredTemplate && <BuiltinConfigRows fields={store.fields} configs={store.fields.promptConfigs} disabled={store.loading} onChange={(key, value) => {
                    if (store.fields[key] !== value) store.toggle(key)
                  }} onEdit={requestConfigEdit} />}
                  <LayerConfigList store={store} layer="pre-step" focusId={configFocus?.id} focusTick={configFocus?.tick} />
                </>
              )}
              {page === 'features' && <FeatureSettings store={store} />}
              {page !== 'pre-step' && page !== 'features' && (
                <>
                  {page === 'agent-request' && (isAnchoredTemplate
                    ? <AgentRequestSwitches store={store} />
                    : <p className={ui.readOnly} role="status">当前预设模板非 anchored，调用配置层 anchored 专属开关已隐藏。</p>)}
                  {page === 'tool-pipeline' && (isAnchoredTemplate
                    ? <ToolPipelineSwitches store={store} />
                    : <p className={ui.readOnly} role="status">当前预设模板非 anchored，工具管线层 anchored 专属开关已隐藏。</p>)}
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
