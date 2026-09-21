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
import { ENGINE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, engineCapability, engineGroupParamKeys, isEditorGroupVisible, isEngineCapabilityPresent } from '../../../../shared/engine-capabilities.ts'
import type { PromptConfigDraft } from '../../../prompt-tool-types.ts'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../../locales.ts'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx'
import { EngineParamFields, matchesEditorGroup } from '../../../features/modules/EngineParamFields.tsx'
import { EngineCapabilityCreateMenu } from '../../../features/modules/EngineModuleList.tsx'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { PresetPersonaCard } from '../../../features/persona/PresetPersonaCard.tsx'
import { DelegationToolsModuleCard } from '../../../features/subagents/DelegationToolsCard.tsx'
import { SubagentToolPolicyCard } from '../../../features/subagents/SubagentToolPolicyCard.tsx'
import { WorldBookDiagnosticsCard } from '../../../features/prompts/WorldBookDiagnosticsCard.tsx'
import { TemplateVariablesModuleCard } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { CustomToolsCard } from '../../../features/tools/CustomToolsCard.tsx'
import { cssEscapeId, scrollToCreatedCard } from '../../../ui/reveal-card.ts'
import ui from '../../../ui/controls.module.css'
import css from './layer-settings.module.css'

export { isEditorGroupVisible }

/** card → 参数分组标题词条：分组标题按 card 派生，不另抄一份参数归属。 */
const CARD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'persona': 'persona.name',
  'variables': 'variables.title',
  'custom-tools': 'customTools.aria',
  'subagent-tool-policy': 'policy.title',
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
      // 已有专属编辑器的组（模型路由卡、资产卡）不再进通用分组：同一批字段只留一个编辑入口。
      && !isLayerAsset(group.id)
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
    <li className={css.capabilityRow} data-layer-capability={capabilityId}>
      <span>{t('modules.layer.capability', { id: capabilityId })}</span>
      {editable && (
        <button ref={buttonRef} type="button" className={ui.pillButton} data-danger aria-label={t('modules.layer.removeTitle', { id: capabilityId })} onClick={() => setConfirming(true)}>
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

/** 该组已有专属编辑器（模型路由卡、资产编辑器）：参数不再走通用控件渲染，避免同一批字段两遍。 */
function isLayerAsset(id: string): boolean {
  return (LAYER_ASSET_IDS as readonly string[]).includes(id)
}

function layerAssets(layer: string, excluded: readonly string[]): string[] {
  return ENGINE_EDITOR_GROUP_MAP.filter((group) => group.displayLayer === layer
    && !excluded.includes(group.id) && (LAYER_ASSET_IDS as readonly string[]).includes(group.id)).map((group) => group.id)
}

function matchesLayerGroup(id: string, keyword: string, t: PromptToolTranslate): boolean {
  return matchesEditorGroup(id, keyword, t)
    || (CARD_LABEL_KEYS[id] !== undefined && t(CARD_LABEL_KEYS[id]).toLowerCase().includes(keyword))
}

/**
 * 本层引擎设置内容：参数分组（按共享契约派生）+ 已装配能力的装配状态与移除入口 +
 * 该层归属的结构化资产编辑器。由 `engineLayerSlots` 注入到每张本层实例卡的折叠区
 * （无实例时由自动生成的层级配置卡承载）；同层多处渲染共用同一 `store.fields` 与同一草稿键。
 */
export function LayerSettingsContent(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  layer: string
  configId?: string
  excludeCapabilities?: readonly string[]
  toolEditor?: ReactNode
  onCreated?: (capabilityId: string) => void
  /** 层内「插入本层模板」入口：由页面注入浮层打开动作（缺省不渲染该入口）。 */
  onInsertTemplate?: (layer: string) => void
  keyword?: string
}): ReactNode {
  const { store, t, layer } = props
  const excluded = props.excludeCapabilities ?? []
  const cards = layerParamCards(store, layer, excluded)
  const capabilities = layerAssembledCapabilities(store, layer).filter((id) => !excluded.includes(id))
  // 同层每张实例卡各渲染一份设置内容：instanceId 带上卡身份，DOM id 才不会互相冲突。
  const instanceId = `layer-${layer}-${props.configId ?? 'standalone'}`
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const presetId = store.fields.presetTemplate
  const assets = layerAssets(layer, excluded)
  const keyword = (props.keyword ?? '').trim().toLowerCase()
  const matches = (id: string): boolean => matchesLayerGroup(id, keyword, t)
  // 变量折叠保留到草稿池，并由当前设置实例触发渲染。
  const variablesExpandedKey = `${presetId}:layer-variables-${props.configId ?? 'standalone'}`
  const [variablesExpanded, setVariablesExpanded] = useState(() => store.editorDrafts?.expanded.get(variablesExpandedKey) ?? true)
  if (cards.length === 0 && capabilities.length === 0 && assets.length === 0) return null
  return (
    <div className={css.settings} data-layer-settings-content={layer}>
      <EngineCapabilityCreateMenu store={store} t={t} layer={layer} excludeCapabilities={excluded} onCreated={props.onCreated} />
      {props.onInsertTemplate !== undefined && (
        <button type="button" className={ui.pillButton} data-layer-insert-template={layer} onClick={() => props.onInsertTemplate?.(layer)}>
          {t('modules.layer.insertTemplate')}
        </button>
      )}
      {cards.map((card) => (
        <section key={card} hidden={!matches(card)} className={css.group} data-layer-param-group={card}
          aria-label={t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}>
          <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}</h4>
          <div className={css.paramFields} data-layer-param-fields={card}>
            <EngineParamFields store={store} card={card} t={t} instanceId={`${instanceId}-${card}`} />
          </div>
        </section>
      ))}
      {capabilities.some(matches) && (
        <section className={css.group} data-layer-capabilities={layer} aria-label={t('modules.layer.assembled')}>
          <h4 className={css.groupTitle}>{t('modules.layer.assembled')}</h4>
          <ul className={css.capabilities}>{capabilities.filter(matches).map((id) => <LayerCapabilityRow key={id} store={store} t={t} capabilityId={id} />)}</ul>
        </section>
      )}
      {assets.map((id) => (
        <section key={id} hidden={!matches(id)} className={css.asset} data-layer-asset={id} aria-label={t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}>
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
              disabled={!canEditPreset}
              onToggleExpanded={() => {
                store.editorDrafts?.expanded.set(variablesExpandedKey, !variablesExpanded)
                setVariablesExpanded(!variablesExpanded)
              }}
            />
          )}
          {id === 'main-model' && <ModelRouteModuleCard store={store} scope="main" />}
          {id === 'subagent-model' && <ModelRouteModuleCard store={store} scope="subagent" />}
          {id === 'subagent-tools' && <DelegationToolsModuleCard store={store} t={t} />}
          {id === 'custom-tools' && (props.toolEditor ?? (
            <CustomToolsCard key={presetId} presetId={presetId} t={t} onNotice={store.showNotice}
              drafts={store.editorDrafts} disabled={!canEditPreset} />
          ))}
          {id === 'subagent-tool-policy' && (
            <SubagentToolPolicyCard key={presetId} presetId={presetId} disabled={!canEditPreset} t={t} onNotice={store.showNotice} drafts={store.editorDrafts} />
          )}
        </section>
      ))}
    </div>
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
  /** 本层引擎设置内容，由实例卡或自动生成的层级配置卡承载。 */
  renderLayerSettings: (layer: string, config: PromptConfigDraft) => ReactNode
  /** 该层有可编辑设置且无实例卡时，自动生成层级配置卡。 */
  hasLayerSettings: (layer: string) => boolean
  matchesLayerSettings: (layer: string, keyword: string) => boolean
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
  /** 自定义工具由常驻页面持有，设置区只渲染。 */
  toolEditor?: ReactNode
  onCreated?: (capabilityId: string) => void
  /** 本页既不创建也不渲染的能力（如子代理页的 tool-filter）。 */
  excludeCapabilities?: readonly string[]
  /** 层设置区「插入本层模板」入口：页面注入模板浮层打开动作（缺省不渲染该入口）。 */
  onInsertTemplate?: (layer: string) => void
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
        key={`${store.fields.presetTemplate}:${config.id}`}
        store={store}
        t={t}
        layer={layer}
        configId={config?.id}
        excludeCapabilities={input.excludeCapabilities}
        toolEditor={input.toolEditor}
        onCreated={input.onCreated}
        onInsertTemplate={input.onInsertTemplate}
        keyword={input.keyword}
      />
    ),
    hasLayerSettings: (layer: string) => layerParamCards(store, layer, input.excludeCapabilities ?? []).length > 0
      || layerAssembledCapabilities(store, layer).some((id) => !(input.excludeCapabilities ?? []).includes(id))
      || layerAssets(layer, input.excludeCapabilities ?? []).length > 0,
    matchesLayerSettings: (layer, keyword) => [
      ...layerParamCards(store, layer, input.excludeCapabilities ?? []),
      ...layerAssembledCapabilities(store, layer).filter((id) => !(input.excludeCapabilities ?? []).includes(id)),
      ...layerAssets(layer, input.excludeCapabilities ?? []),
    ].some((id) => matchesLayerGroup(id, keyword, t)),
  }
}
