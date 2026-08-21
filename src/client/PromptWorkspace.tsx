import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { tabKeyHandler } from './tab-key.ts'
import {
  type PromptToolStore,
  type PromptToolSettingsTransport,
  usePromptToolStore,
} from './prompt-tool-store.ts'
import type { SkillCatalogEntry } from './prompt-tool-bridge.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import { PresetsPage } from './PresetsPage.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
import { TagInput } from './TagInput.tsx'
import { CollapsibleCard } from './CollapsibleCard.tsx'
import { SettingInputRow } from './SettingInputRow.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

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

/** 管线参数卡片（与主会话其他卡片同样式）：首轮输出封顶 + PTC 模式。
 *  两者是模块装配参数（渲染进 agent.cordis.yml 组合行 config，非提示词配置），
 *  模块库无对应可编辑项，故保留独立开关。 */
function PipelineStatusCards(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const capped = fields.bootstrapMaxTokens > 0
  return (
    <div className={ui.configCardPair}>
      <article className={ui.configCard}>
        <header className={ui.configHeader}>
          <span className={ui.configTitle}>
            <span className={ui.configName}>首轮输出封顶</span>
            <span className={ui.configMeta}>{capped ? `调用配置层 · 首轮 maxTokens ${fields.bootstrapMaxTokens}` : '调用配置层 · 默认 256000（不设上限）'}</span>
          </span>
          <span className={ui.configHeaderActions}>
            <input
              className={ui.configInput}
              type="number"
              min={1}
              step={1}
              value={store.bootstrapTokensDraft}
              disabled={!fields.writePreset || !capped}
              title="首轮请求 #1 的 maxTokens（正整数，失焦保存）"
              aria-label="首轮输出封顶数值"
              onChange={(event) => store.setBootstrapTokensDraft(event.target.value)}
              onBlur={store.commitBootstrapTokensDraft}
            />
            <label className={ui.configEnable} htmlFor="pt-bootstrap-tokens">
              <input id="pt-bootstrap-tokens" type="checkbox" checked={capped} disabled={!fields.writePreset} aria-label="首轮输出封顶" onChange={store.toggleBootstrapMaxTokens} />
              <span className={ui.switch} aria-hidden="true"><i /></span>
            </label>
          </span>
        </header>
      </article>
      <article className={ui.configCard}>
        <header className={ui.configHeader}>
          <span className={ui.configTitle}>
            <span className={ui.configName}>使用 PTC 模式</span>
            <span className={ui.configMeta}>{fields.usePtcMode ? '工具管线层 · Code Mode（run_code）' : '工具管线层 · 原生完整工具目录'}</span>
          </span>
          <span className={ui.configHeaderActions}>
            <label className={ui.configEnable} htmlFor="pt-use-ptc">
              <input id="pt-use-ptc" type="checkbox" checked={fields.usePtcMode} disabled={!fields.writePreset} aria-label="使用 PTC 模式" onChange={() => store.toggle('usePtcMode')} />
              <span className={ui.switch} aria-hidden="true"><i /></span>
            </label>
          </span>
        </header>
      </article>
    </div>
  )
}

/** 模型与委派参数卡片（模型设置 + 工具与深度）：主对话页与子代理页共用同一配置源（缺省继承宿主默认）；模型路由与人设按作用域完全分离（main=主对话模型、subagent=子代理模型，参数各自独立），工具与深度两页通用。 */
function ModelToolCards(props: { store: PromptToolStore; scope: 'main' | 'subagent' }): ReactNode {
  const { store } = props
  const fields = store.fields
  const host = store.hostDefaultModel
  // 宿主默认模型回显：插件参数未设置（空 = 继承宿主）时，下拉可见宿主当前
  // agent-default-model 的可选项（模型目录查询失败/未公布时也能选择与回显）。
  const providerOptions = [...new Set([...store.providers, ...(host?.provider !== undefined && host.provider.length > 0 ? [host.provider] : [])])]
  const provider = props.scope === 'main' ? fields.modelProvider : fields.subagentModelProvider
  const modelName = props.scope === 'main' ? fields.modelName : fields.subagentModelName
  const modelOptions = [...new Set([
    ...(store.modelCatalog[provider] ?? []),
    ...(host?.model !== undefined && host.model.length > 0 ? [host.model] : []),
  ])]
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  const reasoningEffortOptions = ['', 'off', 'low', 'high', 'max']
  // 宿主默认思维程度回显（agent-default-model settings reasoningEffort；官方档位同源）。
  const hostEffort = host?.reasoningEffort !== undefined && host.reasoningEffort.length > 0
    ? host.reasoningEffort
    : undefined
  const withCurrent = (options: string[], current: string): string[] =>
    current.length > 0 && !options.includes(current) ? [...options, current] : options
  const active = provider.length > 0 && modelName.length > 0
  const reasoningEffort = props.scope === 'main' ? fields.modelReasoningEffort : fields.subagentReasoningEffort
  const temperature = props.scope === 'main' ? fields.modelTemperature : fields.subagentTemperature
  const maxTokens = props.scope === 'main' ? fields.modelMaxTokens : fields.subagentMaxTokens
  const patchModelParam = (key: 'modelReasoningEffort' | 'modelTemperature' | 'modelMaxTokens' | 'subagentReasoningEffort' | 'subagentTemperature' | 'subagentMaxTokens', value: string): void => {
    store.patch({ [key]: value } as Partial<typeof fields>)
    void store.persistParamOverrides()
  }
  const scopeMeta = props.scope === 'main'
    ? { title: '主对话模型', idle: '未设置：继承宿主默认模型', active: '固定模型路由已设置（新会话默认模型）' }
    : { title: '子代理模型', idle: '未设置：继承主会话模型', active: '子代理固定模型路由已设置' }
  // 主对话卡片：宿主默认模型名回显（子代理默认继承主会话，不回显宿主）。
  const idleMeta = props.scope === 'main' && host?.model !== undefined && host.model.length > 0
    ? `未设置：继承宿主默认（${host.model}）`
    : scopeMeta.idle
  return (
    <>
      <CollapsibleCard id={props.scope === 'main' ? 'pt-main-model' : 'pt-subagent-model'} title={scopeMeta.title} meta={active ? scopeMeta.active : idleMeta}>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>模型服务商</strong>
              <small>{props.scope === 'main'
                ? '主对话新会话默认模型（agent-default-model）；调用方未显式指定时自动补入。检测到的服务商可直接选择。'
                : '子代理固定模型路由（agentOptions 注入 tool-subagent，经预设参数传递）；调用方显式模型优先。检测到的服务商可直接选择。'}</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="模型服务商"
              value={provider}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch(props.scope === 'main' ? { modelProvider: event.target.value } : { subagentModelProvider: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {withCurrent(providerOptions, provider).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>模型名</strong>
              <small>{props.scope === 'main'
                ? '与模型服务商同时非空时生效（主对话新会话默认模型），例如 deepseek-v4-flash。'
                : '与子代理模型服务商同时非空时生效（子代理固定路由），例如 deepseek-v4-flash。'}</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="模型名"
              value={modelName}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch(props.scope === 'main' ? { modelName: event.target.value } : { subagentModelName: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {withCurrent(modelOptions, modelName).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>思维程度</strong>
              <small>reasoningEffort（agent-request patch）；官方档位 off / low / high / max；{reasoningEffort.length === 0 && hostEffort !== undefined
                ? `留空 = 继承宿主默认（${hostEffort}）。`
                : '留空 = 不设置（模型默认）。'}选择即保存。</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="思维程度"
              value={reasoningEffort}
              disabled={!fields.writePreset}
              onChange={(event) => patchModelParam(
                props.scope === 'main' ? 'modelReasoningEffort' : 'subagentReasoningEffort',
                event.target.value,
              )}
            >
              {withCurrent(hostEffort !== undefined ? [...new Set([...reasoningEffortOptions, hostEffort])] : reasoningEffortOptions, reasoningEffort).map((item) => (
                <option key={item} value={item}>{item.length === 0 ? '（不设置）' : item}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>采样温度</strong>
              <small>temperature（agent-request patch）；数字 0–2，留空 = 不设置（模型默认）。失焦保存。</small>
            </span>
            <input
              className={ui.configInput}
              type="number"
              min={0}
              max={2}
              step={0.1}
              aria-label="采样温度"
              value={temperature}
              disabled={!fields.writePreset}
              placeholder="不设置"
              onChange={(event) => patchModelParam(
                props.scope === 'main' ? 'modelTemperature' : 'subagentTemperature',
                event.target.value,
              )}
              onBlur={() => void store.persistParamOverrides()}
            />
          </div>
        </div>
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>输出上限</strong>
              <small>maxTokens（agent-request patch）；正整数，留空 = 不设置（模型默认）。失焦保存。</small>
            </span>
            <input
              className={ui.configInput}
              type="number"
              min={1}
              step={1}
              aria-label="输出上限"
              value={maxTokens}
              disabled={!fields.writePreset}
              placeholder="不设置"
              onChange={(event) => patchModelParam(
                props.scope === 'main' ? 'modelMaxTokens' : 'subagentMaxTokens',
                event.target.value,
              )}
              onBlur={() => void store.persistParamOverrides()}
            />
          </div>
        </div>
        {props.scope === 'main' && (
          <div className={ui.rowGroup}>
            <label className={ui.textBlock}>
              <span className={ui.settingCopy}><strong>主对话自定义模型人设</strong><small>主对话命中快速模型（Flash 档）时替换人设（router-first-turn）；子代理未单独设置时回退使用。留空 = 模板默认；失焦保存。</small></span>
              <textarea
                className={ui.firstTurnInput}
                value={fields.mainPersona}
                disabled={!fields.writePreset}
                onChange={(event) => { autoResizeTextarea(event); store.patch({ mainPersona: event.target.value }) }}
                onBlur={() => void store.persistParamOverrides()}
                spellCheck={false}
              />
            </label>
          </div>
        )}
        {props.scope === 'subagent' && (
          <div className={ui.rowGroup}>
            <label className={ui.textBlock}>
              <span className={ui.settingCopy}><strong>子代理自定义模型人设</strong><small>subagentPersona（per-child shadow）；留空 = 固定模型路由时回退主对话自定义模型人设，两者都空 = 继承主会话。失焦保存。</small></span>
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
        )}
      </CollapsibleCard>
<CollapsibleCard id="pt-delegation-tools" title="工具与深度" meta="工具集白名单/黑名单（主会话+子代理） + 注入 kind 白名单 + 递归深度">
<TagInput id="pt-tool-filter-allow" label="工具集白名单" hint="toolFilter.allow：主会话常驻过滤（tool-filter 模块，作用于任意注册工具含自定义插件）+ 委派子代理 toolFilter；回车或逗号添加标签，× 移除；留空 = 不限制。每次增删立即保存。"
          value={fields.toolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ toolFilterAllow: value })}
          onCommit={() => void store.persistParamOverrides()} />
<TagInput id="pt-tool-filter-deny" label="工具集黑名单" hint="toolFilter.deny：主会话常驻过滤（tool-filter 模块）+ 委派子代理 toolFilter；回车或逗号添加标签，× 移除；留空 = 不限制。每次增删立即保存。"
          value={fields.toolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ toolFilterDeny: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-allow-kinds" label="注入 kind 白名单" hint="context-gate allowKinds（注入门控）；回车或逗号添加标签，× 移除，例如 skill-invocation、near-anchor、router-guide；留空 = 官方默认（不过滤）。每次增删立即保存。"
          value={fields.allowKinds} placeholder="skill-invocation, near-anchor, router-guide" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ allowKinds: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <div className={ui.rowGroup}>
          <div className={ui.settingRowStack}>
            <span className={ui.settingCopy}>
              <strong>递归深度</strong>
              <small>委派 maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。</small>
            </span>
            <select
              className={ui.configInput}
              aria-label="递归深度"
              value={fields.maxDepth}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch({ maxDepth: event.target.value })
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

/** 模型路由状态 chip：主对话页与子代理页共用（检测到 DeepSeek 路由时展示 provider 列表）。 */
function ModelRouteStatus(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const detected = store.providers.length > 0
  const catalog = store.modelCatalog
  const catalogEntries = Object.entries(catalog)
  const hostModel = store.hostDefaultModel?.model
  return (
    <div className={ui.skillStatusRow} aria-label="模型服务商状态">
      <span className={clsx(ui.skillStatusChip, detected ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {detected ? `已检测到模型服务商：${store.providers.join('、')}` : '未检测到模型服务商'}
      </span>
      <span className={clsx(ui.skillStatusChip, catalogEntries.length > 0 ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {catalogEntries.length > 0
          ? `已检测到模型名：${catalogEntries.map(([provider, models]) => `${provider} → ${models.join('、')}`).join('；')}`
          : hostModel !== undefined && hostModel.length > 0
            ? `模型名：继承宿主默认（${hostModel}）`
            : '未检测到模型名'}
      </span>
    </div>
  )
}

/** 子代理设置页：路由状态 + 子代理参数卡片（模型 / 工具与深度）。 */
function SubagentSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <section className={ui.section} aria-label="子代理">
      <ModelRouteStatus store={store} />
      <ModelToolCards store={store} scope="subagent" />
    </section>
  )
}

/** 主会话页：主对话参数 + Preset/AGENTS 内容 + 管线状态卡 + 模块库（层筛选）。
 *  注入层 tab 已并入本页（层专属开关与内容资产卡片），模块库按层级下拉筛选浏览。 */
function FeatureSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  return (
    <section className={ui.section} aria-label="主会话与全局">
      <ModelRouteStatus store={store} />
      <ModelToolCards store={store} scope="main" />
      <PipelineStatusCards store={store} />
      <PromptConfigsEditor
        meta={store.meta}
        configs={fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
        onSaveConfigs={(configs) => store.persistConfigs(configs)}
        onNotice={store.showNotice}
      />
    </section>
  )
}

/** 配置列表 + 新建模板：六层页按 layer 过滤，子代理页按 scope 过滤（subagent 只列子代理可见模板）。 */
function ConfigListWithTemplates(props: { store: PromptToolStore; layer?: string; scope?: 'main' | 'subagent' }): ReactNode {
  const { store, layer, scope } = props
  // 当前预设模板消息批层无配置时，pre-step 层空状态追加提示（列表仍可自定义：
  // 新建配置作为 settings 覆盖层保存，切换预设后保留）。
  const preStepEmpty = store.templatePreStepCount === 0 && (layer === undefined || layer === 'pre-step')
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
        emptyHint={preStepEmpty ? '当前预设模板消息批层无配置；可新建自定义配置（作为 settings 覆盖层，切换预设后仍保留）。' : undefined}
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
      <div className={ui.subagentConfigs}>
        <ConfigListWithTemplates store={store} scope="subagent" />
      </div>
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
    <section className={ui.section} aria-label="技能设置">
      {fields.skillCatalog.length > 0 && (
        <>
          <div className={ui.skillStatsRow}>
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

      <CollapsibleCard id="pt-skills-dirs" title="目录与来源"
        meta={`${fields.activeSkillsDirs.length} 个目录 · 添加 / 移除引用`}>
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
        <div className={ui.cardDivider} />
        <SettingInputRow id="pt-skill-rank-base" label="技能排序基数" hint="每个技能实际 rank = 基数 + 拖拽序号；默认 250。数值过小会让本项目技能抢占其他插件技能的位置，但不会影响任何提示词消息注入。"
          type="number" value={String(fields.skillRankBase)}
          onInput={(value) => store.patch({ skillRankBase: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>

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

/** 顶层页面：注入层已并入主会话页（层专属开关 + 内容资产卡片 + 模块库层筛选）。 */
type WorkspacePage = 'subagent' | 'skills' | 'features' | 'presets'

const TOP_PAGES: Array<{ id: WorkspacePage; label: string }> = [
  { id: 'features', label: '主会话' },
  { id: 'subagent', label: '子代理' },
  { id: 'skills', label: '技能设置' },
  { id: 'presets', label: '预设配置' },
]

/** 侧边栏独立工作台：顶层 4 页（注入层并入主会话）。 */
export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api, props.settings)
  const [page, setPage] = useState<WorkspacePage>('features')
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
      : page === 'presets'
        ? '预设配置'
        : '子代理'
  const pageTitle = page === 'skills' ? '技能设置'
    : page === 'features' ? '主会话'
      : page === 'presets' ? '预设配置'
        : '子代理'
  const pageDetail = page === 'skills'
    ? '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。'
    : page === 'features'
      ? '主会话参数（模型设置、工具与深度）、消息批层入口开关、Preset/AGENTS 内容与提示词配置模块库（按层级筛选）。'
      : page === 'presets'
        ? '统一管理预设模板（切换/导入）与提示词配置（六层列表/模板插入/配置目录）。'
        : '子代理作用域参数（模型/人设/工具集/深度）与子代理提示词配置（audience 非仅主会话）。'
  // 已加载过数据时保留旧内容（顶部状态点显示「读取中」），避免切换/保存触发整区骨架屏闪烁。
  const hasData = store.meta.layers.length > 0
    || store.fields.skillCatalog.length > 0
    || store.fields.promptConfigs.length > 0

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

      <main className={css.canvas}>
        <div>
          <PageHeader title={pageTitle} description={pageDetail} meta={layerMeta} />

          {store.loading && !hasData ? (
            <div className={ui.skeletonStack} aria-hidden="true">
              {[0, 1, 2, 3].map((item) => <div key={item} className={ui.skeletonRow} />)}
            </div>
          ) : page === 'skills' ? <SkillsSettings store={store} api={props.api} /> : (
            <>
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
