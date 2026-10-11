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
import { MODULE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, moduleCapability, engineGroupParamKeys, isEditorGroupVisible, isModuleCapabilityPresent } from '../../../../shared/engine-capabilities.ts'
import type { PromptConfigDraft } from '../../../prompt-tool-types.ts'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { canEditModule, moduleFactsOf } from '../../../data/module-subject.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../../locales.ts'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx'
import { Button } from '../../../ui/Button.tsx'
import { EngineParamFields, matchesEditorGroup } from '../../../features/modules/EngineParamFields.tsx'
import { ModuleCapabilityCreateMenu } from '../../../features/modules/EngineModuleList.tsx'
import { CurrentSessionModel } from '../../../features/models/CurrentSessionModel.tsx'
import { ModulePersonaCard } from '../../../features/persona/ModulePersonaCard.tsx'
import { DelegationToolsModuleCard } from '../../../features/subagents/DelegationToolsCard.tsx'
import { SubagentToolPolicyCard } from '../../../features/subagents/SubagentToolPolicyCard.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { TemplateVariablesModuleCard } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { CustomToolsCard } from '../../../features/tools/CustomToolsCard.tsx'
import { cssEscapeId, scrollToCreatedCard } from '../../../ui/reveal-card.ts'
import css from './layer-settings.module.css'

export { isEditorGroupVisible }

/** card → 参数分组标题词条：分组标题按 card 派生，不另抄一份参数归属。 */
const CARD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'variables': 'variables.title',
  'custom-tools': 'customTools.aria',
  'subagent-tool-policy': 'policy.title',
  'prompt-defaults': 'modules.group.prompt-defaults',
  'main-model': 'modules.group.main-model',
  'subagent-model': 'modules.group.subagent-model',
  'subagent-tools': 'modules.group.subagent-delegation',
  'str-replace-editor': 'modules.group.str-replace-editor',
  'tool-config-engine': 'modules.group.tool-config-engine',
}

/**
 * 该层在共享契约里拥有扁平参数、且**该模块**确实可编辑的编辑组：
 * 能力组要求真实装配（未装配的能力参数写了不生效，不显示假入口）；
 * 专用编辑组（提示词生成默认值等）不依赖模块装配，始终可编辑。
 * 参数键仍由 `ENGINE_PARAM_DEFINITIONS` 给出，这里不另抄键表，也不按层硬编码。
 */
export function layerParamCards(store: PromptToolStore, layer: string, moduleId: string | undefined, exclude: readonly string[] = []): readonly string[] {
  const excluded = new Set(exclude)
  const facts = moduleId === undefined ? undefined : moduleFactsOf(store.meta.modules, moduleId)
  return ENGINE_EDITOR_GROUP_MAP
    .filter((group) => group.displayLayer === layer
      && !excluded.has(group.id)
      // 已有专属编辑器的组（模型路由卡、资产卡）不再进通用分组：同一批字段只留一个编辑入口。
      && !isLayerAsset(group.id)
      && engineGroupParamKeys(group.id).length > 0
      && (moduleCapability(group.id) === undefined || isModuleCapabilityPresent(group.id, facts)))
    .map((group) => group.id)
}

/** 该层**该模块**已装配的能力（装配事实来自 `/meta` 的逐模块 facts，不是前端开关）。 */
export function layerAssembledCapabilities(store: PromptToolStore, layer: string, moduleId: string | undefined): readonly string[] {
  const facts = moduleId === undefined ? undefined : moduleFactsOf(store.meta.modules, moduleId)
  return MODULE_CAPABILITIES
    .filter(({ id, displayLayer }) => displayLayer === layer && isModuleCapabilityPresent(id, facts))
    .map(({ id }) => id)
}

/** 单个已装配能力：装配状态 + 移除入口（二次确认沿用统一对话框）。主语＝该卡的归属模块。 */
function LayerCapabilityRow(props: { store: PromptToolStore; t: PromptToolTranslate; moduleId: string; capabilityId: string }): ReactNode {
  const { store, t, moduleId, capabilityId } = props
  const [confirming, setConfirming] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const editable = canEditModule(store.fields, store.meta.modules, moduleId)
  return (
    <li className={css.capabilityRow} data-layer-capability={capabilityId}>
      <span>{t('modules.layer.capability', { id: capabilityId })}</span>
      {editable && (
        <Button ref={buttonRef} shape="pill" variant="outline" size="md" data-danger aria-label={t('modules.layer.removeTitle', { id: capabilityId })} onClick={() => setConfirming(true)}>
          {t('modules.layer.remove')}
        </Button>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('modules.layer.removeTitle', { id: capabilityId })}
          description={t('modules.layer.removeDesc')}
          confirmLabel={t('toolEditor.confirmRemove')}
          cancelLabel={t('toolEditor.cancel')}
          failureMessage={t('card.operationFailed')}
          returnFocusRef={buttonRef}
          onConfirm={async () => { if (!await store.removeModuleCapability(moduleId, capabilityId)) throw new Error(t('card.operationFailed')) }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

/**
 * 结构化资产编辑器按主归属层渲染（模板变量、模型路由、委派深度、自定义工具、子代理策略）：
 * 层归属来自共享契约，不在这里硬编码层名；每个资产复用各自专用编辑器、草稿池与写端点。
 */
const LAYER_ASSET_IDS = ['variables', 'main-model', 'subagent-model', 'subagent-tools', 'custom-tools', 'subagent-tool-policy'] as const

/** 该组已有专属编辑器（模型路由卡、资产编辑器）：参数不再走通用控件渲染，避免同一批字段两遍。 */
function isLayerAsset(id: string): boolean {
  return (LAYER_ASSET_IDS as readonly string[]).includes(id)
}

function layerAssets(layer: string, excluded: readonly string[]): string[] {
  return ENGINE_EDITOR_GROUP_MAP.filter((group) => group.displayLayer === layer
    && group.id !== 'subagent-model'
    && !excluded.includes(group.id) && (LAYER_ASSET_IDS as readonly string[]).includes(group.id)).map((group) => group.id)
}

function matchesLayerGroup(id: string, keyword: string, t: PromptToolTranslate): boolean {
  return matchesEditorGroup(id, keyword, t)
    || (CARD_LABEL_KEYS[id] !== undefined && t(CARD_LABEL_KEYS[id]).toLowerCase().includes(keyword))
}

/**
 * 本层引擎设置内容：参数分组（按共享契约派生）+ 已装配能力的装配状态与移除入口 +
 * 该层归属的结构化资产编辑器。由 `injectionPointSlots` 注入到每张本层实例卡的折叠区
 * 中；**主语＝该实例卡所属模块**（`moduleId`）：事实、参数读数、变量与写路径全部按它取，
 * 没有模块就没有卡（不进入「先渲染再禁用」的分支）。
 */
export function LayerSettingsContent(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  layer: string
  /** 资产卡的归属模块＝主语；缺席即装配集合为空，整块不渲染。 */
  moduleId?: string
  configId?: string
  excludeCapabilities?: readonly string[]
  toolEditor?: ReactNode
  onCreated?: (capabilityId: string) => void
  keyword?: string
}): ReactNode {
  const { store, t, layer } = props
  const moduleId = props.moduleId
  const excluded = props.excludeCapabilities ?? []
  const cards = moduleId === undefined ? [] : layerParamCards(store, layer, moduleId, excluded)
  const capabilities = moduleId === undefined ? [] : layerAssembledCapabilities(store, layer, moduleId).filter((id) => !excluded.includes(id))
  const assets = moduleId === undefined ? [] : layerAssets(layer, excluded)
  // 同层每张实例卡各渲染一份设置内容：instanceId 带上卡身份，DOM id 才不会互相冲突。
  const instanceId = `layer-${layer}-${props.configId ?? 'standalone'}`
  const canEdit = moduleId !== undefined && canEditModule(store.fields, store.meta.modules, moduleId)
  const keyword = (props.keyword ?? '').trim().toLowerCase()
  const matches = (id: string): boolean => matchesLayerGroup(id, keyword, t)
  // 参数与变量按主语读一次（每模块每轮加载一次，同模块的层卡共享同一份）。
  const wantsVariables = assets.includes('variables')
  useEffect(() => {
    if (moduleId === undefined) return
    store.ensureModuleParams(moduleId)
    if (wantsVariables) store.ensureModuleVariables(moduleId)
  }, [store, moduleId, wantsVariables])
  if (moduleId === undefined) return null
  if (cards.length === 0 && capabilities.length === 0 && assets.length === 0) return null
  const variables = wantsVariables ? store.moduleVariables(moduleId) : undefined
  return (
    <div className={css.settings} data-layer-settings-content={layer}>
      <div className={css.actions}>
        <ModuleCapabilityCreateMenu store={store} t={t} layer={layer} moduleId={moduleId} excludeCapabilities={excluded} onCreated={props.onCreated} />
      </div>
      {cards.map((card) => (
        <section key={card} hidden={!matches(card)} className={css.group} data-layer-param-group={card}
          aria-label={t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}>
          <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}</h4>
          <div className={css.paramFields} data-layer-param-fields={card}>
            <EngineParamFields store={store} moduleId={moduleId} card={card} t={t} instanceId={`${instanceId}-${card}`} />
          </div>
        </section>
      ))}
      {capabilities.some(matches) && (
        <section className={css.group} data-layer-capabilities={layer} aria-label={t('modules.layer.assembled')}>
          <h4 className={css.groupTitle}>{t('modules.layer.assembled')}</h4>
          <ul className={css.capabilities}>{capabilities.filter(matches).map((id) => <LayerCapabilityRow key={id} store={store} t={t} moduleId={moduleId} capabilityId={id} />)}</ul>
        </section>
      )}
      {assets.map((id) => (
        <section key={id} hidden={!matches(id)} className={css.asset} data-layer-asset={id} aria-label={t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}>
          {id === 'variables' && variables !== undefined && (
            <TemplateVariablesModuleCard
              t={t}
              scope={variables.scope}
              onScopeChange={scope => store.setModuleVariablesScope(moduleId, scope)}
              inheritedVariables={variables.inherited}
              loading={variables.loading}
              error={variables.error}
              templateVariables={variables.values}
              setTemplateVariables={value => store.setModuleVariables(moduleId, value)}
              templateVariablesEnabled={variables.enabled}
              setTemplateVariablesEnabled={value => store.setModuleVariablesEnabled(moduleId, value)}
              saveTemplateVariables={(next, enabled) => store.saveModuleVariables(moduleId, next, enabled)}
              publicationPending={variables.publicationPending}
              retryPublication={() => store.retryModuleVariablesPublication(moduleId)}
              embedded
              disabled={!canEdit}
            />
          )}
          {id === 'main-model' && <CurrentSessionModel store={store} t={t} />}
          {id === 'subagent-tools' && <DelegationToolsModuleCard store={store} t={t} moduleId={moduleId} embedded />}
          {(id === 'custom-tools' || id === 'subagent-tool-policy') && <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}</h4>}
          {id === 'custom-tools' && (props.toolEditor ?? (
            <CustomToolsCard key={moduleId} moduleId={moduleId} t={t} onNotice={store.showNotice}
              drafts={store.editorDrafts} disabled={!canEdit} />
          ))}
          {id === 'subagent-tool-policy' && (
            <SubagentToolPolicyCard key={moduleId} moduleId={moduleId} modules={store.meta.modules ?? []} disabled={!canEdit} t={t} onNotice={store.showNotice} drafts={store.editorDrafts} />
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

export interface InjectionPointSlots {
  beforeCards: ReactNode
  /** 本层引擎设置内容，只由真实实例卡内的设置区承载；主语＝该实例卡的模块。 */
  renderLayerSettings: (layer: string, config: PromptConfigDraft, moduleId: string) => ReactNode
  /** 该层**该模块**是否有可编辑设置，控制真实实例卡内的设置区。 */
  hasLayerSettings: (layer: string, moduleId: string) => boolean
  matchesLayerSettings: (layer: string, keyword: string, moduleId: string) => boolean
}

export interface InjectionPointSlotsInput {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 当前层筛选（`all` / `context-activation` / 九层之一）；过滤只影响展示，不改变保存语义。 */
  viewFilter: string
  /** 统一搜索词：同时过滤配置实例、能力卡、共享设置区与单例卡（只影响展示）。 */
  keyword?: string
  /** 受众视图：主会话与子代理是同源视图，不改 audience，也不隐式启用 includeSubagents。 */
  audience: 'main' | 'subagent'
  /** 新建能力后的定位信号（token 递增；layer 用于滚动到该层实例卡内的设置区）。 */
  focusCapability?: { id: string; token: number; layer?: string }
  onCreated?: (capabilityId: string) => void
  /** 本页既不创建也不渲染的能力（受众视图差异，如仅主对话生效的能力）。 */
  excludeCapabilities?: readonly string[]
}

/** 按受众视图装配人设卡、层内设置和诊断。 */
export function injectionPointSlots(input: InjectionPointSlotsInput): InjectionPointSlots {
  const { store, t, viewFilter, audience } = input
  const excluded = input.excludeCapabilities ?? []
  // 人设来源跨模块且不依赖规则实例，按页面受众独立装配：人设卡的主语来自它自己读到的来源
  // （`personaSources` 的 main／subagent 指向哪个模块），页面不给它兜底主语。
  const beforeCards = (
    <>
      <ModulePersonaCard t={t} audience={audience}
        disabled={!store.fields.modulesEnabled}
        canEditModule={moduleId => canEditModule(store.fields, store.meta.modules, moduleId)}
        onNotice={store.showNotice} drafts={store.editorDrafts} />
      {audience === 'main' && <div hidden={viewFilter !== 'context-activation'}><ContextActivationDiagnosticsCard store={store} t={t} /></div>}
      <LayerSettingsFocus layer={input.focusCapability?.layer} token={input.focusCapability?.token ?? 0} />
    </>
  )
  return {
    beforeCards,
    renderLayerSettings: (layer: string, config: PromptConfigDraft, moduleId: string) => (
      <LayerSettingsContent
        key={`${moduleId}:${config.id}`}
        store={store}
        t={t}
        layer={layer}
        moduleId={moduleId}
        configId={config?.id}
        excludeCapabilities={input.excludeCapabilities}
        onCreated={input.onCreated}
        keyword={input.keyword}
      />
    ),
    hasLayerSettings: (layer: string, moduleId: string) => layerParamCards(store, layer, moduleId, excluded).length > 0
      || layerAssembledCapabilities(store, layer, moduleId).some((id) => !excluded.includes(id))
      || layerAssets(layer, excluded).length > 0,
    matchesLayerSettings: (layer, keyword, moduleId) => [
      ...layerParamCards(store, layer, moduleId, excluded),
      ...layerAssembledCapabilities(store, layer, moduleId).filter((id) => !excluded.includes(id)),
      ...layerAssets(layer, excluded),
    ].some((id) => matchesLayerGroup(id, keyword, t)),
  }
}
