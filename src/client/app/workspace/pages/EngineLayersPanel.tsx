/**
 * 九层编辑面的唯一页面级装配入口。
 *
 * 归属来自 shared 契约（`ENGINE_EDITOR_GROUP_MAP` 的 `displayLayer` / `relatedLayers`），
 * 与 host `/meta` 下发的 `editorGroups` 同源；页面只声明受众视图与页面专属编排
 * （创建菜单、模板浮层、指令回调），不再各自手写层名判断。
 *
 * 展示归属只是导航：这里不新增第二份映射，也不改变任何运行时 hook、注册顺序或保存通道。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ENGINE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, engineCapability, engineGroupParamKeys, isEditorGroupVisible, isEngineCapabilityPresent, type EngineLayer } from '../../../../shared/engine-capabilities.ts'
import type { PromptConfigDraft } from '../../../prompt-tool-types.ts'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../../locales.ts'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx'
import { EngineModuleCard } from '../../../ui/EngineModuleCard.tsx'
import { EngineParamFields, matchesEditorGroup } from '../../../features/modules/EngineParamFields.tsx'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { PresetPersonaCard } from '../../../features/persona/PresetPersonaCard.tsx'
import { DelegationToolsModuleCard } from '../../../features/subagents/DelegationToolsCard.tsx'
import { SubagentToolPolicyCard } from '../../../features/subagents/SubagentToolPolicyCard.tsx'
import { WorldBookDiagnosticsCard } from '../../../features/prompts/WorldBookDiagnosticsCard.tsx'
import { TemplateVariablesModuleCard } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { CustomToolsCard, type ToolCreateIntent } from '../../../features/tools/CustomToolsCard.tsx'
import { cssEscapeId, scrollToCreatedCard } from '../../../ui/reveal-card.ts'
import ui from '../../../ui/controls.module.css'

export { isEditorGroupVisible }

export const TOOL_PIPELINE_SETTING_GROUP_IDS = [
  'tool-filter',
  'promoted-code-mode',
  'str-replace-editor',
  'deliberation-gate',
  'progress-reminder',
  'tool-config-engine',
  'bootstrap-tools',
  'subagent-delegation',
] as const
export type ToolPipelineSettingGroupId = typeof TOOL_PIPELINE_SETTING_GROUP_IDS[number]

export interface ToolPipelineSettingGroup {
  id: ToolPipelineSettingGroupId
  /** 该组参数的真实能力 card：参数键仍由 shared `ENGINE_PARAM_DEFINITIONS` 派生，不另抄一份键表。 */
  card: string
  /** 真实主归属在别的层时登记相关层；只读说明用，不改变写通道。 */
  relatedLayer?: EngineLayer
}

/**
 * 工具管线层的能力参数分组：前六组的主归属就在本层，后两组是登记过的跨层相关设置
 * （首阶段工具目录主归属 system-section、子代理授权主归属 subagent-start）。
 * 同一参数在能力卡与这里各渲染一次，绑定同一 `store.fields[键]` 与同一草稿键。
 */
export const TOOL_PIPELINE_SETTING_GROUPS: readonly ToolPipelineSettingGroup[] = [
  { id: 'tool-filter', card: 'tool-filter' },
  { id: 'promoted-code-mode', card: 'promoted-code-mode' },
  { id: 'str-replace-editor', card: 'str-replace-editor' },
  { id: 'deliberation-gate', card: 'deliberation-gate' },
  { id: 'progress-reminder', card: 'progress-reminder' },
  { id: 'tool-config-engine', card: 'tool-config-engine' },
  { id: 'bootstrap-tools', card: 'tool-bootstrap', relatedLayer: 'system-section' },
  { id: 'subagent-delegation', card: 'subagent-tools', relatedLayer: 'subagent-start' },
]

/**
 * tool-pipeline 层的共享能力设置区：这里的控件与对应能力卡绑定同一 `store.fields` 字段
 * 和同一草稿键，是同一份参数的第二处编辑点；`instanceId` 只区分 DOM id 与 aria 关联，
 * 不引入第二份状态、同步服务或事件总线，卡片本身仍由能力卡负责装配与删除。
 *
 * `keyword` 是同一搜索词：分组标题、组内参数键与参数中文标签都参与匹配，
 * 只影响展示（不匹配的分组隐藏），不改写任何预设数据。
 */
export function ToolPipelineSettingsCard(props: { store: PromptToolStore; t: PromptToolTranslate; keyword?: string }): ReactNode {
  const { store, t } = props
  const search = (props.keyword ?? '').trim().toLowerCase()
  const expandedKey = `${store.fields.presetTemplate}:tool-pipeline-settings`
  const groups = TOOL_PIPELINE_SETTING_GROUPS.filter((group) => search.length === 0
    || t(`modules.group.${group.id}`).toLowerCase().includes(search)
    || matchesEditorGroup(group.card, search, t))
  return (
    <EngineModuleCard name={t('modules.toolPipeline.name')} meta={t('modules.toolPipeline.meta')}
      defaultExpanded={store.editorDrafts?.expanded.get(expandedKey)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(expandedKey, value)}>
      <p className={ui.configFieldHint}>{t('modules.toolPipeline.hint')}</p>
      {groups.map((group) => (
        <section key={group.id} className={ui.settingRowStack} data-pipeline-group={group.id} aria-label={t(`modules.group.${group.id}`)}>
          <strong>{t(`modules.group.${group.id}`)}</strong>
          <small className={ui.configFieldHint}>
            {group.relatedLayer === undefined
              ? t('modules.group.sharedHint')
              : t('modules.group.relatedHint', { layer: t(`layer.${group.relatedLayer}`) })}
          </small>
          <EngineParamFields store={store} card={group.card} t={t} instanceId={`tool-pipeline-${group.id}`} />
        </section>
      ))}
      {groups.length === 0 && <p className={ui.configFieldHint} role="status">{t('modules.status.emptySearch', { keyword: props.keyword ?? '' })}</p>}
    </EngineModuleCard>
  )
}

/** card → 参数分组标题词条：分组标题按 card 派生，不另抄一份参数归属。 */
const CARD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'prompt-defaults': 'modules.group.prompt-defaults',
  'context-gate': 'modules.group.context-gate',
  'anchor-turn': 'modules.group.anchor-turn',
  'tool-bootstrap': 'modules.group.bootstrap-tools',
  'main-model': 'modules.group.main-model',
  'subagent-model': 'modules.group.subagent-model',
  'subagent-tools': 'modules.group.subagent-delegation',
  'tool-filter': 'modules.group.tool-filter',
  'promoted-code-mode': 'modules.group.promoted-code-mode',
  'str-replace-editor': 'modules.group.str-replace-editor',
  'deliberation-gate': 'modules.group.deliberation-gate',
  'progress-reminder': 'modules.group.progress-reminder',
  'tool-config-engine': 'modules.group.tool-config-engine',
}

/**
 * 该层在共享契约里拥有扁平参数、且当前确实可编辑的编辑组：
 * 能力组要求真实装配（未装配的能力参数写了不生效，不显示假入口）；
 * 专用编辑组（提示词生成默认值等）不依赖模块装配，始终可编辑。
 * 参数键仍由 `ENGINE_PARAM_DEFINITIONS` 给出，这里不另抄键表，也不按层硬编码。
 */
export function layerParamCards(store: PromptToolStore, layer: string, exclude: readonly string[] = []): readonly string[] {
  const excluded = new Set(exclude)
  return ENGINE_EDITOR_GROUP_MAP
    .filter((group) => group.displayLayer === layer
      && !excluded.has(group.id)
      && engineGroupParamKeys(group.id).length > 0
      && (engineCapability(group.id) === undefined || isEngineCapabilityPresent(group.id, store.moduleFacts)))
    .map((group) => group.id)
}

/** 该层已装配的能力（装配事实来自 `store.moduleFacts`，不是前端开关）。 */
export function layerAssembledCapabilities(store: PromptToolStore, layer: string): readonly string[] {
  return ENGINE_CAPABILITIES
    .filter(({ id, displayLayer }) => displayLayer === layer && isEngineCapabilityPresent(id, store.moduleFacts))
    .map(({ id }) => id)
}

/** 该层是否有可编辑的引擎设置：参数组或已装配能力任一存在即为真。 */
export function layerHasSettings(store: PromptToolStore, layer: string): boolean {
  return layerParamCards(store, layer).length > 0 || layerAssembledCapabilities(store, layer).length > 0
}

/** 单个已装配能力：装配状态 + 移除入口（二次确认沿用统一对话框）。 */
function LayerCapabilityRow(props: { store: PromptToolStore; t: PromptToolTranslate; capabilityId: string }): ReactNode {
  const { store, t, capabilityId } = props
  const [confirming, setConfirming] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  return (
    <li data-layer-capability={capabilityId}>
      <span>{t('modules.layer.capability', { id: capabilityId })}</span>
      {editable && (
        <button ref={buttonRef} type="button" className={ui.pillButton} data-danger onClick={() => setConfirming(true)}>
          {t('modules.layer.remove')}
        </button>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('modules.layer.removeTitle', { id: capabilityId })}
          description={t('modules.layer.removeDesc')}
          confirmLabel={t('toolEditor.confirmRemove')}
          cancelLabel={t('toolEditor.cancel')}
          failureMessage={t('card.operationFailed')}
          returnFocusRef={buttonRef}
          onConfirm={async () => { if (!await store.removeEngineCapability(capabilityId)) throw new Error(t('card.operationFailed')) }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

/**
 * 结构化资产编辑器按主归属层渲染（人设、模板变量、模型路由、委派深度、自定义工具、子代理策略）：
 * 层归属来自共享契约，不在这里硬编码层名；每个资产复用各自专用编辑器、草稿池与写端点。
 */
const LAYER_ASSET_IDS = ['persona', 'variables', 'main-model', 'subagent-model', 'subagent-tools', 'custom-tools', 'subagent-tool-policy'] as const

/**
 * 本层引擎设置内容：参数分组（按共享契约派生）+ 已装配能力的装配状态与移除入口 +
 * 该层归属的结构化资产编辑器。由 `engineLayerSlots` 注入到每张本层实例卡的折叠区
 * （以及无实例卡时的兜底容器）；同层多处渲染共用同一 `store.fields` 与同一草稿键。
 */
export function LayerSettingsContent(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  layer: string
  configId?: string
  excludeCapabilities?: readonly string[]
  toolCreate?: ToolCreateIntent
  onToolIntentConsumed?: () => void
}): ReactNode {
  const { store, t, layer } = props
  const excluded = props.excludeCapabilities ?? []
  const cards = layerParamCards(store, layer, excluded)
  const capabilities = layerAssembledCapabilities(store, layer).filter((id) => !excluded.includes(id))
  // 同层每张实例卡各渲染一份设置内容：instanceId 带上卡身份，DOM id 才不会互相冲突。
  const instanceId = `layer-${layer}-${props.configId ?? 'standalone'}`
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const presetId = store.fields.presetTemplate
  const assets = ENGINE_EDITOR_GROUP_MAP
    .filter((group) => group.displayLayer === layer
      && !excluded.includes(group.id)
      && (LAYER_ASSET_IDS as readonly string[]).includes(group.id))
    .map((group) => group.id)
  if (cards.length === 0 && capabilities.length === 0 && assets.length === 0) return null
  // 变量编辑器在层设置区里默认展开（用户已主动展开设置区，不必再点一层）；折叠过就记住。
  const variablesExpandedKey = `${presetId}:layer-variables-${props.configId ?? 'standalone'}`
  const variablesExpanded = store.editorDrafts?.expanded.get(variablesExpandedKey) ?? true
  return (
    <>
      {cards.map((card) => (
        <section key={card} className={ui.settingRowStack} data-layer-param-group={card}
          aria-label={t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}>
          <strong>{t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}</strong>
          <EngineParamFields store={store} card={card} t={t} instanceId={`${instanceId}-${card}`} />
        </section>
      ))}
      {capabilities.length > 0 && (
        <section className={ui.settingRowStack} data-layer-capabilities={layer} aria-label={t('modules.layer.assembled')}>
          <strong>{t('modules.layer.assembled')}</strong>
          <ul>{capabilities.map((id) => <LayerCapabilityRow key={id} store={store} t={t} capabilityId={id} />)}</ul>
        </section>
      )}
      {assets.map((id) => (
        <section key={id} className={ui.settingRowStack} data-layer-asset={id} aria-label={t('modules.layer.asset')}>
          <strong>{t('modules.layer.asset')}</strong>
          {id === 'persona' && <PresetPersonaCard t={t} presetId={presetId} disabled={!canEditPreset} onNotice={store.showNotice} drafts={store.editorDrafts} />}
          {id === 'variables' && (
            <TemplateVariablesModuleCard
              t={t}
              templateVariables={store.templateVariables}
              setTemplateVariables={store.setTemplateVariables}
              templateVariablesEnabled={store.templateVariablesEnabled}
              setTemplateVariablesEnabled={store.setTemplateVariablesEnabled}
              saveTemplateVariables={store.saveTemplateVariables}
              expanded={variablesExpanded}
              onToggleExpanded={() => store.editorDrafts?.expanded.set(variablesExpandedKey, !variablesExpanded)}
            />
          )}
          {id === 'main-model' && <ModelRouteModuleCard store={store} scope="main" />}
          {id === 'subagent-model' && <ModelRouteModuleCard store={store} scope="subagent" />}
          {id === 'subagent-tools' && <DelegationToolsModuleCard store={store} t={t} />}
          {id === 'custom-tools' && (
            <CustomToolsCard
              key={presetId}
              presetId={presetId}
              t={t}
              onNotice={store.showNotice}
              drafts={store.editorDrafts}
              disabled={!canEditPreset}
              createIntent={props.toolCreate}
              onIntentConsumed={props.onToolIntentConsumed}
            />
          )}
          {id === 'subagent-tool-policy' && (
            <SubagentToolPolicyCard key={presetId} presetId={presetId} disabled={!canEditPreset} t={t} onNotice={store.showNotice} drafts={store.editorDrafts} />
          )}
        </section>
      ))}
    </>
  )
}

/** 新建能力后的定位：滚动到该层实例卡内的设置折叠区（能力卡已退场，锚点改在设置区）。 */
function LayerSettingsFocus(props: { layer?: string; token: number }): ReactNode {
  const { layer, token } = props
  useEffect(() => {
    if (layer === undefined) return
    return scrollToCreatedCard(`[data-layer-settings="${cssEscapeId(layer)}"]`)
  }, [layer, token])
  return null
}

export interface EngineLayerSlots {
  beforeCards: ReactNode
  commonCards: ReactNode
  moduleCards: ReactNode
  /** 本层引擎设置内容（注入到每张本层实例卡的折叠区；兜底容器传 `__layer-settings__`）。 */
  renderLayerSettings: (layer: string, config: PromptConfigDraft) => ReactNode
  /** 该层是否有可编辑设置：决定「本层无配置卡」时是否渲染兜底容器。 */
  hasLayerSettings: (layer: string) => boolean
}

export interface EngineLayerSlotsInput {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 当前层筛选（`all` / `world-book` / 九层之一）；过滤只影响展示，不改变保存语义。 */
  viewFilter: string
  /** 统一搜索词：同时过滤配置实例、能力卡、共享设置区与单例卡（只影响展示）。 */
  keyword?: string
  /** 受众视图：主会话与子代理是同源视图，不改 audience，也不隐式启用 includeSubagents。 */
  audience: 'main' | 'subagent'
  /** 新建能力后的定位信号（token 递增；layer 用于滚动到该层实例卡内的设置区）。 */
  focusCapability?: { id: string; token: number; layer?: string }
  /** 自定义工具创建意图（两页共用同一份编辑器，不各维护一套）。 */
  toolCreate?: ToolCreateIntent
  onToolIntentConsumed?: () => void
  /** 本页既不创建也不渲染的能力（如子代理页的 tool-filter）。 */
  excludeCapabilities?: readonly string[]
  moduleHint?: string
  moduleEmptyHint?: string
}

/**
 * 按受众视图装配层内卡片：主归属与 `relatedLayers` 命中的层才显示，
 * 不可见的卡用 `LayerCard` 的 `hidden` 隐藏而不卸载，所以切层不丢草稿、不重跑读取。
 */
export function engineLayerSlots(input: EngineLayerSlotsInput): EngineLayerSlots {
  const { store, t, viewFilter, audience } = input
  // 主会话页保留世界书只读诊断卡（策略视图）；其余单例卡与资产编辑器都进本层设置区。
  const beforeCards = audience === 'main'
    ? <div hidden={viewFilter !== 'world-book'}><WorldBookDiagnosticsCard store={store} t={t} /></div>
    : null
  const commonCards = null
  const moduleCards = (
    <>
      {/* 独立卡片（能力卡、单例参数卡与资产卡）已全部退场：参数、装配状态、资产编辑器
          都由本层实例卡内的设置区承载。页面级提示仍在这里渲染，不进工具栏按钮行。 */}
      {input.moduleHint !== undefined && <p className={ui.configFieldHint}>{input.moduleHint}</p>}
      {input.moduleEmptyHint !== undefined && !ENGINE_CAPABILITIES.some(({ id }) => !(input.excludeCapabilities ?? []).includes(id) && isEngineCapabilityPresent(id, store.moduleFacts))
        && <p className={ui.configFieldHint} role="status">{input.moduleEmptyHint}</p>}
      <LayerSettingsFocus layer={input.focusCapability?.layer} token={input.focusCapability?.token ?? 0} />
    </>
  )
  return {
    beforeCards,
    commonCards,
    moduleCards,
    renderLayerSettings: (layer: string, config: PromptConfigDraft) => (
      <LayerSettingsContent
        store={store}
        t={t}
        layer={layer}
        configId={config?.id}
        excludeCapabilities={input.excludeCapabilities}
        toolCreate={input.toolCreate}
        onToolIntentConsumed={input.onToolIntentConsumed}
      />
    ),
    hasLayerSettings: (layer: string) => layerParamCards(store, layer, input.excludeCapabilities ?? []).length > 0
      || layerAssembledCapabilities(store, layer).some((id) => !(input.excludeCapabilities ?? []).includes(id))
      || ENGINE_EDITOR_GROUP_MAP.some((group) => group.displayLayer === layer
        && !(input.excludeCapabilities ?? []).includes(group.id)
        && (LAYER_ASSET_IDS as readonly string[]).includes(group.id)),
  }
}
