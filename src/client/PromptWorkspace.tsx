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
import type { SkillCatalogEntry } from './prompt-tool-bridge.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import { PromptConfigsEditor, type PromptConfigDraft } from './PromptConfigsEditor.tsx'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import { PresetsPage } from './PresetsPage.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
import { ToggleRow } from './ToggleRow.tsx'
import { TagInput } from './TagInput.tsx'
import { CollapsibleCard } from './CollapsibleCard.tsx'
import { SettingInputRow } from './SettingInputRow.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

const layerOf = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'

const configsOfLayer = (configs: PromptConfigDraft[], layer: string): PromptConfigDraft[] =>
  configs.filter((config) => layerOf(config) === layer)

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

function PageHeader(props: { title: string; description: string; meta?: string }): ReactNode {
  return (
    <div className={ui.pageHeader}>
      <div><h2>{props.title}</h2><p>{props.description}</p></div>
      {props.meta !== undefined && <div className={css.pageHeaderMeta}><code>{props.meta}</code></div>}
    </div>
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
            onChange={(event) => { autoResizeTextarea(event); store.patch({ firstTurnText: event.target.value }) }}
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
            onChange={(event) => { autoResizeTextarea(event); store.patch({ guideText: event.target.value }) }}
            onBlur={() => void store.persistParamOverrides()}
            spellCheck={false}
          />
        </label>
      </div>
      <SettingInputRow id="pt-first-turn-word" label="锚定词" hint="prompt-injector 的 custom-fallback 锚定词：晋升后首个 reasoning 命中该词即注入 preset.md；直接输入任意自定义文本；留空 = 模板默认 we。失焦保存。"
        value={fields.firstTurnWord} placeholder="we（默认）" disabled={!fields.writePreset}
        onInput={(value) => store.patch({ firstTurnWord: value })}
        onCommit={() => void store.persistParamOverrides()} />
    </section>
  )
}

/** 调用配置层开关：首轮 maxTokens。 */
function AgentRequestSwitches(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <section className={ui.section} aria-labelledby="pt-agent-request-switches">
        <div className={ui.sectionHeading}><div><h2 id="pt-agent-request-switches">调用配置层开关</h2><p>作用于首轮请求配置，和本层提示词配置的 order / modelScope 语义一致。</p></div></div>
      <BootstrapTokensRow store={store} />
    </section>
  )
}

/** 子代理参数卡片（模型 + 工具与深度）：主对话页与子代理页共用（全链路同一配置源）。 */
function SubagentCards(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const providerOptions = ['', ...store.deepseekProviders, 'deepseek-official']
  const modelOptions = ['', 'deepseek-v4-flash', 'deepseek-v4-pro']
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  const withCurrent = (options: string[], current: string): string[] =>
    current.length > 0 && !options.includes(current) ? [...options, current] : options
  const active = fields.subagentModelProvider.length > 0 && fields.subagentModelName.length > 0
  return (
    <>
      <CollapsibleCard id="pt-subagent-model" title="子代理模型" meta={active ? '固定模型路由已设置' : '未设置：继承主会话模型'}>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>模型服务商</strong>
              <small>调用方未显式指定 provider 时自动补入；检测到 DeepSeek 路由时可直接选择，未检测到可手动选择 deepseek-official。</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="模型服务商"
              value={fields.subagentModelProvider}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch({ subagentModelProvider: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {withCurrent(providerOptions, fields.subagentModelProvider).map((item) => (
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
              value={fields.subagentModelName}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch({ subagentModelName: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {withCurrent(modelOptions, fields.subagentModelName).map((item) => (
                <option key={item} value={item}>{item.length > 0 ? item : '（不设置）'}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={ui.rowGroup}>
          <label className={ui.textBlock}>
            <span className={ui.settingCopy}><strong>子代理独立人设</strong><small>子代理 persona（per-child shadow）；留空 = 固定模型路由时回退主对话快速模型人设，两者都空 = 继承主会话。失焦保存。</small></span>
            <textarea
              className={ui.firstTurnInput}
              value={fields.subagentPersona}
              disabled={!fields.writePreset}
              onChange={(event) => { autoResizeTextarea(event); store.patch({ subagentPersona: event.target.value }) }}
              onBlur={() => void store.persistParamOverrides()}
              spellCheck={false}
            />
          </label>
        </div>
      </CollapsibleCard>
      <CollapsibleCard id="pt-subagent-tools" title="子代理工具与深度" meta="工具集白名单/黑名单 + 递归深度">
        <TagInput id="pt-subagent-tool-allow" label="子代理工具集白名单" hint="toolFilter.allow；回车或逗号添加标签，× 移除；留空 = 不限制。每次增删立即保存。"
          value={fields.subagentToolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ subagentToolFilterAllow: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-subagent-tool-deny" label="子代理工具集黑名单" hint="toolFilter.deny；回车或逗号添加标签，× 移除；留空 = 不限制。每次增删立即保存。"
          value={fields.subagentToolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ subagentToolFilterDeny: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>子代理递归深度</strong>
              <small>maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="子代理递归深度"
              value={fields.subagentMaxDepth}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch({ subagentMaxDepth: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {maxDepthOptions.map((item) => (
                <option key={item} value={item}>{item === '' ? '（不设置）' : item}</option>
              ))}
            </select>
          </div>
        </div>
      </CollapsibleCard>
    </>
  )
}

/** 子代理设置页：路由状态 + 子代理参数卡片（模型 / 工具与深度）。 */
function SubagentSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const detected = store.deepseekProviders.length > 0
  return (
    <section className={ui.section} aria-label="子代理设置">
      <div className={ui.skillStatusRow} aria-label="子代理路由状态">
        <span className={clsx(ui.skillStatusChip, detected ? ui.skillStatusModel : ui.skillStatusOff)}>
          <i className={ui.skillStatusDot} aria-hidden="true" />
          {detected ? `已检测到模型路由：${store.deepseekProviders.join('、')}` : '未检测到模型路由'}
        </span>
      </div>
      <SubagentCards store={store} />
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

/** 主对话与全局：主对话参数（快速模型人设 / kind 白名单）+ 全局开关。 */
function FeatureSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <section className={ui.section} aria-label="主对话与全局">
      <div className={ui.rowGroup}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>主对话快速模型人设</strong><small>主对话命中快速模型（Flash 档）时替换人设；子代理固定模型路由未显式人设时回退使用。留空 = 模板默认；失焦保存。</small></span>
          <textarea
            className={ui.firstTurnInput}
            value={fields.fastModelPersona}
            disabled={!fields.writePreset}
            onChange={(event) => { autoResizeTextarea(event); store.patch({ fastModelPersona: event.target.value }) }}
            onBlur={() => void store.persistParamOverrides()}
            spellCheck={false}
          />
        </label>
      </div>
      <TagInput id="pt-allow-kinds" label="注入 kind 白名单" hint="context-gate allowKinds；回车或逗号添加标签，× 移除，例如 skill-invocation、near-anchor、router-guide；留空 = 官方默认（不过滤）。每次增删立即保存。"
        value={fields.allowKinds} placeholder="skill-invocation, near-anchor, router-guide" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ allowKinds: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <SubagentCards store={store} />
      <PromptConfigsEditor
        meta={store.meta}
        configs={fields.promptConfigs}
        configsDir={fields.promptConfigsDir}
        savedConfigs={store.savedConfigs}
        savedConfigsDir={store.savedConfigsDir}
        onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
        onPatchConfigsDir={(dir) => store.patch({ promptConfigsDir: dir })}
        onSaveConfigs={(configs) => store.persistConfigs(configs)}
        onSaveConfigsDir={(dir) => store.persistConfigsDir(dir)}
        onNotice={store.showNotice}
      />
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
    ? 'preset.md 内容存于生成目录（.agent-presets/<模板>/preset.md），由 prompt-injector 提示词配置注入；直接编辑、失焦自动保存，或通过「导入」写入；不再内嵌在 settings.yaml。生成总开关在「主对话与全局」。'
    : 'AGENTS.md 内容存于生成目录 agents.md；直接编辑、失焦自动保存，或通过「导入」写入；注入开关在「消息批层入口」。'
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
            {importing && <span className={ui.spinner} aria-hidden="true" />}
            {importing ? '导入中…' : '导入'}
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
          <span className={ui.settingCopy}><strong>当前内容</strong><small>直接编辑、失焦自动保存到生成目录；导入文件后自动刷新；不写入 settings.yaml。</small></span>
          <textarea
            className={ui.firstTurnInput}
            value={text}
            disabled={!fields.writePreset}
            spellCheck={false}
            aria-label={`${title}当前内容`}
            onChange={(event) => {
              autoResizeTextarea(event)
              if (isPreset) store.patch({ promptText: event.target.value })
              else store.patch({ agentsText: event.target.value })
            }}
            onBlur={() => void store.importPreset(scope, isPreset ? fields.promptText : fields.agentsText, false)}
          />
        </label>
      </div>
      {isPreset && (
        <div className={ui.rowGroup}>
          <label className={ui.textBlock}>
            <span className={ui.settingCopy}><strong>缺省文本（preset.md 缺失时使用）</strong><small>仅当包内 preset.md 不存在或不可读时生效；修改后失焦保存。</small></span>
            <textarea
              className={ui.firstTurnInput}
              value={fields.fallbackText}
              onChange={(event) => { autoResizeTextarea(event); store.patch({ fallbackText: event.target.value }) }}
              onBlur={store.persistSwitches}
              spellCheck={false}
            />
          </label>
        </div>
      )}
    </section>
  )
}

/** 配置列表 + 新建模板：六层页按 layer 过滤，子代理页按 scope 过滤（subagent 只列子代理可见模板）。 */
function ConfigListWithTemplates(props: { store: PromptToolStore; layer?: string; scope?: 'main' | 'subagent' }): ReactNode {
  const { store, layer, scope } = props
  const templatePicker = useTemplatePicker(
    store.fields.promptConfigs,
    (config) => store.patch({ promptConfigs: [...store.fields.promptConfigs, config] }),
    store.showNotice,
  )
  return (
    <>
      <PromptConfigList
        meta={store.meta}
        configs={store.fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        layer={layer}
        scope={scope}
        extraActions={
          <button type="button" className={ui.primaryPill} onClick={templatePicker.openPicker}>新建</button>
        }
        onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
        onSaveConfigs={(configs) => store.persistConfigs(configs)}
        onNotice={store.showNotice}
      />
      {templatePicker.open && (
        <TemplatePicker templates={templatePicker.templates} layer={layer} onPick={templatePicker.pickTemplate} onClose={templatePicker.closePicker} />
      )}
    </>
  )
}

/** 子代理设置页：子代理参数 + 子代理提示词配置（audience != main，即公用或仅子代理）。 */
function SubagentPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <>
      <SubagentSettings store={store} />
      <ConfigListWithTemplates store={store} scope="subagent" />
    </>
  )
}

/** 技能状态筛选维度（统计条与列表联动）。 */
type SkillStatusTab = 'all' | 'callable' | 'invalid'

const SKILL_STATUS_TABS: Array<{ id: SkillStatusTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'callable', label: '模型可调用' },
  { id: 'invalid', label: '未注册' },
]

function SkillsSettings(props: { store: PromptToolStore; api: IApiClient }): ReactNode {
  const { store, api } = props
  const fields = store.fields
  const [pickingDir, setPickingDir] = useState(false)
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
  const dirty = JSON.stringify(fields.skillSwitches) !== JSON.stringify(store.savedSwitches.skillSwitches)
    || JSON.stringify(fields.skillOrder) !== JSON.stringify(store.savedSwitches.skillOrder)
    || JSON.stringify(fields.skillsDirs) !== JSON.stringify(store.savedSwitches.skillsDirs)
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
  const toggleSelect = (folder: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }
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
      store.addSkillsDir(path)
    } catch (error) {
      store.showNotice('error', '选择目录失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setPickingDir(false)
    }
  }

  const renderCard = (skill: SkillCatalogEntry, depth: number, primaryIndex: number): ReactNode => {
    const hint = `${skill.dir ?? 'skills'}/${skill.folder}${skill.description ? ` · ${skill.description}` : ''}`
    const enabled = store.skillEnabled(skill.folder)
    const nested = depth > 0
    const isSelected = selected.has(skill.folder)
    return (
      <div
        key={skill.folder}
        className={clsx(ui.skillCard, !skill.valid && ui.skillRowInvalid)}
        data-nested={nested ? '' : undefined}
        data-selected={selected.has(skill.folder) ? '' : undefined}
        data-dragging={dragFolder === skill.folder ? '' : undefined}
        data-drop-before={dropTarget?.folder === skill.folder && dropTarget.before ? '' : undefined}
        data-drop-after={dropTarget?.folder === skill.folder && !dropTarget.before ? '' : undefined}
        draggable={skill.valid && !nested}
        onDragStart={(event) => {
          setDragFolder(skill.folder)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (dragFolder === undefined || dragFolder === skill.folder || nested) return
          const rect = event.currentTarget.getBoundingClientRect()
          setDropTarget({ folder: skill.folder, before: event.clientY < rect.top + rect.height / 2 })
        }}
        onDrop={(event) => {
          event.preventDefault()
          const target = dropTarget
          if (dragFolder !== undefined && target !== undefined && dragFolder !== skill.folder && !nested) {
            moveSkillAt(dragFolder, target.folder, target.before)
          }
          setDragFolder(undefined)
          setDropTarget(undefined)
        }}
        onDragEnd={() => { setDragFolder(undefined); setDropTarget(undefined) }}
      >
        {/* 勾选框：只选择（职责分离——开关状态由行内 Switch 与上方批量按钮控制）。 */}
        <label className={ui.skillSelect} aria-label={`选择 ${skill.name || skill.folder}`}>
          <input type="checkbox" checked={isSelected} disabled={!skill.valid} onChange={() => toggleSelect(skill.folder)} />
        </label>
        {nested
          ? <span className={ui.skillNestedMark} aria-hidden="true" title="嵌套子技能（跟随主技能，不参与拖拽排序）">▸</span>
          : (
            <>
              <span className={ui.dragHandle} title={`第 ${primaryIndex + 1} 位，拖动调整顺序`} aria-hidden="true">⠿</span>
              <span className={ui.skillRankBadge} title={`第 ${primaryIndex + 1} 位`}>{primaryIndex + 1}</span>
            </>
          )}
        <div className={ui.skillCardBody}>
          <span className={ui.skillCardTitleRow}>
            <strong>{skill.name || skill.folder}</strong>
            {skill.duplicate === true && <span className={ui.duplicateBadge} title={`同名技能：来源目录 ${skill.dir ?? '未知'}`}>同名</span>}
            <SkillStatusChips skill={skill} enabled={enabled} />
          </span>
          <small className={ui.skillCardMeta}>{hint}</small>
          {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
        </div>
        {/* Switch：独立切换技能开关。 */}
        <label className={ui.skillSwitch} htmlFor={`pt-skill-${skill.folder}`}>
          <input id={`pt-skill-${skill.folder}`} type="checkbox" checked={enabled} disabled={!skill.valid} aria-label={`启用 ${skill.name || skill.folder}`} onChange={() => store.toggleSkill(skill.folder)} />
          <span className={ui.switch} aria-hidden="true"><i /></span>
        </label>
        {!skill.valid ? (
          <button type="button" className={ui.pillButton} disabled={store.fixingSkill === skill.folder} onClick={() => void store.fixSkill(skill.folder)}>
            {store.fixingSkill === skill.folder && <span className={ui.spinner} aria-hidden="true" />}
            {store.fixingSkill === skill.folder ? '修复中…' : '修复'}
          </button>
        ) : !nested ? (
          <span className={ui.skillOrderButtons}>
            <button type="button" className={ui.pillButton} aria-label={`上移 ${skill.name || skill.folder}`} title="上移（键盘排序）" disabled={primaryIndex === 0} onClick={() => moveSkill(skill.folder, orderedPrimary[primaryIndex - 1]!.folder)}>↑</button>
            <button type="button" className={ui.pillButton} aria-label={`下移 ${skill.name || skill.folder}`} title="下移（键盘排序）" disabled={primaryIndex >= orderedPrimary.length - 1} onClick={() => moveSkill(skill.folder, orderedPrimary[primaryIndex + 1]!.folder)}>↓</button>
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <section className={ui.section} aria-label="Skills 设置">
      <div className={ui.sectionHeading}>
        <div className={ui.sectionActions}>
          <button type="button" className={ui.pillButton} onClick={() => void store.load()}>刷新技能列表</button>
        </div>
      </div>

      {fields.skillCatalog.length > 0 && (
        <>
          <div className={ui.skillStats} role="tablist" aria-label="技能状态筛选">
            {SKILL_STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={statusTab === tab.id}
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
              <button type="button" className={ui.pillButton} onClick={toggleSelectAll}>
                {allSelected ? '取消全选' : '全选'}
              </button>
            )}
            <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(true)}>批量启用</button>
            <button type="button" className={ui.pillButton} disabled={!selectionMode} onClick={() => batchSet(false)}>批量禁用</button>
          </div>
        </>
      )}

      {fields.skillCatalog.length === 0 ? (
        <div className={ui.emptyState}><span className={ui.emptyGlyph} aria-hidden="true">◇</span><div><h3>skills 目录下没有技能</h3><p>展开下方「目录与来源」选择目录导入，或确认技能目录路径后重新打开工作台。</p></div></div>
      ) : visibleSkills.length === 0 ? (
        <p className={ui.readOnly} role="status">没有匹配当前筛选的技能。</p>
      ) : (
        <>
          <div className={ui.skillCardList} data-dragging={dragFolder !== undefined ? '' : undefined}>
            {renderOrder.map((skill) => {
              const depth = depthOf(skill.folder)
              const primaryIndex = depth === 0 ? orderedPrimary.indexOf(skill) : 0
              return renderCard(skill, depth, primaryIndex)
            })}
          </div>
        </>
      )}

      <details className={ui.disclosure}>
        <summary><span>目录与来源</span><small>{fields.activeSkillsDirs.length} 个目录 · 添加 / 移除引用</small></summary>
        <div className={ui.disclosureBody}>
          <div className={ui.dirAddBar}>
            <button type="button" className={ui.primaryPill} disabled={pickingDir} onClick={() => void pickSkillsDir()}>
              {pickingDir && <span className={ui.spinner} aria-hidden="true" />}
              {pickingDir ? '选择中…' : '从文件夹选择器添加'}
            </button>
            <div className={ui.dirAddInput}>
              <input
                className={ui.directoryInput}
                aria-label="按路径添加技能目录"
                value={store.skillsDirDraft}
                placeholder="或输入目录路径后添加"
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
          {fields.activeSkillsDirs.length === 0 ? (
            <p className={ui.readOnly} role="status">技能目录列表为空。</p>
          ) : (
            <div className={ui.dirCardList}>
              {fields.activeSkillsDirs.map((dir, index) => {
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
        </div>
      </details>

      <details className={ui.disclosure}>
        <summary><span>高级</span><small>技能排序基数</small></summary>
        <div className={ui.disclosureBody}>
          <SettingInputRow id="pt-skill-rank-base" label="技能排序基数" hint="每个技能实际 rank = 基数 + 拖拽序号；默认 250。数值过小会让本项目技能抢占其他插件技能的位置，但不会影响任何提示词消息注入。"
            type="number" value={String(fields.skillRankBase)}
            onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
            onCommit={store.persistSwitches} />
        </div>
      </details>

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

/** 顶层页面：六层折叠为「注入层级」，内部用 layerPage 切换。 */
type WorkspacePage = 'layers' | 'subagent' | 'skills' | 'features' | 'presets'
type EntryPage = 'switches' | 'preset' | 'agents'

const ENTRY_PAGES: Array<{ id: EntryPage; label: string }> = [
  { id: 'switches', label: '入口开关' },
  { id: 'preset', label: 'Preset 预设' },
  { id: 'agents', label: 'AGENTS 设置' },
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

const TOP_PAGES: Array<{ id: WorkspacePage; label: string }> = [
  { id: 'layers', label: '注入层级' },
  { id: 'subagent', label: '子代理设置' },
  { id: 'skills', label: 'Skills 设置' },
  { id: 'features', label: '主对话' },
  { id: 'presets', label: '预设和配置' },
]

/** 侧边栏独立工作台：顶层 5 页 +「注入层级」内部六层子导航。 */
export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api, props.settings)
  const layers = store.meta.layers.length > 0 ? store.meta.layers : FALLBACK_LAYERS
  const [page, setPage] = useState<WorkspacePage>('layers')
  const [layerPage, setLayerPage] = useState<string>('pre-step')
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
  const layerMeta = page === 'layers'
    ? `${configsOfLayer(store.fields.promptConfigs, layerPage).length} 配置`
    : page === 'skills'
    ? `${store.fields.skillCatalog.length} 技能`
    : page === 'features'
      ? '全局'
      : page === 'presets'
        ? '预设与配置'
        : '子代理'
  const layerLabel = page === 'layers'
    ? (store.meta.layerLabels[layerPage] ?? FALLBACK_LAYER_LABELS[layerPage])
    : undefined
  const pageTitle = page === 'layers' ? (layerLabel?.title ?? '注入层级')
    : page === 'skills' ? 'Skills 设置'
      : page === 'features' ? '主对话'
        : page === 'presets' ? '预设和配置'
          : '子代理设置'
  const pageDetail = page === 'layers'
    ? (layerLabel?.detail ?? '')
    : page === 'skills'
    ? '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。'
    : page === 'features'
      ? '主对话参数（快速模型人设、注入 kind 白名单）与提示词配置模块列表。'
      : page === 'presets'
        ? '统一管理预设模板（切换/导入）与提示词配置（六层列表/模板插入/配置目录）。'
        : '子代理作用域参数（模型/人设/工具集/深度）与子代理提示词配置（audience 非仅主会话）。'

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
        <div className={css.nav} role="tablist" aria-label="提示词工具页面">
          {TOP_PAGES.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={page === item.id} data-active={page === item.id ? '' : undefined} onClick={() => setPage(item.id)} onKeyDown={tabKeyHandler(TOP_PAGES.map((entry) => entry.id), page, setPage)}>
              <span><strong>{item.label}</strong></span>
            </button>
          ))}
        </div>
      </div>

      {page === 'layers' && (
        <div className={css.memoryNavigation}>
          <div className={css.memoryTabs} role="tablist" aria-label="注入层级">
            {layers.map((item) => (
              <button key={item} type="button" role="tab" aria-selected={layerPage === item} data-active={layerPage === item ? '' : undefined} onClick={() => setLayerPage(item)} onKeyDown={tabKeyHandler(layers, layerPage, setLayerPage)}>
                {store.meta.layerLabels[item]?.title ?? FALLBACK_LAYER_LABELS[item]?.title ?? item}
              </button>
            ))}
          </div>
        </div>
      )}

      {page === 'layers' && layerPage === 'pre-step' && (
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

          {store.loading ? (
            <div className={ui.skeletonStack} aria-hidden="true">
              {[0, 1, 2, 3].map((item) => <div key={item} className={ui.skeletonRow} />)}
            </div>
          ) : page === 'skills' ? <SkillsSettings store={store} api={props.api} /> : (
            <>
              {page === 'layers' && (
                <>
                  {layerPage === 'pre-step' && entryPage === 'switches' && <EntrySwitches store={store} />}
                  {layerPage === 'pre-step' && entryPage === 'preset' && <FileEditor store={store} scope="preset" />}
                  {layerPage === 'pre-step' && entryPage === 'agents' && <FileEditor store={store} scope="agents" />}
                  {layerPage !== 'pre-step' && (
                    <>
                      {layerPage === 'agent-request' && <AgentRequestSwitches store={store} />}
                      {layerPage === 'tool-pipeline' && <ToolPipelineSwitches store={store} />}
                      <ConfigListWithTemplates store={store} layer={layerPage} />
                    </>
                  )}
                </>
              )}
              {page === 'features' && <FeatureSettings store={store} />}
              {page === 'presets' && <PresetsPage store={store} />}
              {page === 'subagent' && <SubagentPage store={store} />}
            </>
          )}

          {store.notice && <p className={clsx(ui.notice, store.noticeKind === 'error' && ui.noticeError)} role="status">{store.notice}</p>}
        </div>
      </main>
    </div>
  )
}
