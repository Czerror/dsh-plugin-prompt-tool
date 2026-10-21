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
import { LAYER_ASSET_SECTIONS, layerCards as cardsOfLayer, type LayerCardKind } from '../../../data/layer-cards.ts'
import type { PromptConfigDraft } from '../../../prompt-tool-types.ts'
import type { DraftsPort, HostApiPort, ModelsPort, ModuleActionsPort, ModuleFactsPort, NoticePort, ParamsPort, VariablesPort } from '../../../data/store-ports.ts'
import { canEditModule, moduleDeclares } from '../../../data/module-subject.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../../locales.ts'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.tsx'
import { Button } from '../../../ui/Button.tsx'
import { EngineParamField, EngineParamFields, editorGroupSearchText } from '../../../features/modules/EngineParamFields.tsx'
import type { LayerCardView } from '../../../features/prompts/RulesWorkspace.tsx'
import { EngineModuleCard } from '../../../ui/EngineModuleCard.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from '../../../features/prompts/prompt-config-policy.ts'
import { ModuleCapabilityCreateMenu } from '../../../features/modules/EngineModuleList.tsx'
import { CurrentSessionModel } from '../../../features/models/CurrentSessionModel.tsx'
import { ModulePersonaCard } from '../../../features/persona/ModulePersonaCard.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { TemplateVariablesModuleCard } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { CustomToolsCard } from '../../../features/tools/CustomToolsCard.tsx'
import { cssEscapeId, scrollToCreatedCard } from '../../../ui/reveal-card.ts'
import styles from '../../../ui/controls.module.css'
import css from './layer-settings.module.css'

/** card → 参数分组标题词条：分组标题按 card 派生，不另抄一份参数归属。 */
const CARD_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'variables': 'variables.title',
  'custom-tools': 'customTools.aria',
  'prompt-defaults': 'modules.group.prompt-defaults',
  'main-model': 'modules.group.main-model',
  'subagent-model': 'modules.group.subagent-model',
  'str-replace-editor': 'modules.group.str-replace-editor',
  'tool-config-engine': 'modules.group.tool-config-engine',
  'present-as': 'modules.group.present-as',
  'run-code-env': 'modules.group.run-code-env',
  'instruction-hint': 'modules.group.instruction-hint',
  'tool-git-bash': 'modules.group.tool-git-bash',
}

/**
 * 本页三个依赖面，按「谁真正读到什么」分，不共用一个更大的并集：
 * 纯读 helper 只要 `/meta` 的装配事实；能力行多要可编辑性与自己那张卡的移除端点；
 * 页面与层设置区还要承接子卡（参数控件、模型路由、诊断卡）已声明的能力面。
 *
 * 实测（Proxy 记运行期访问）：`hasLayerSettings`／`layerCards` 运行时**只读
 * `store.meta.modules`**；本文件直接触碰 store 的 14 个成员之外，其余成员都由子卡按自己的面取用。
 * 收窄到成员级需要硬编码一长串成员名、并随子卡漂移，故仍按域相交。
 */
type CapabilityRowStore = ModuleFactsPort & ModuleActionsPort

type PanelStore = ModuleFactsPort & DraftsPort & ParamsPort & VariablesPort
  & ModuleActionsPort & NoticePort & ModelsPort & HostApiPort


/** 单个已声明能力及移除入口（二次确认沿用统一对话框）。主语＝该卡的归属模块。 */
function LayerCapabilityRow(props: { store: CapabilityRowStore; t: PromptToolTranslate; moduleId: string; capabilityId: string }): ReactNode {
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

/** 卡片搜索文本：编辑组的技术键与参数中文标签 + 卡片标题；已小写，搜索直接 includes。 */
function layerCardSearchText(id: string, t: PromptToolTranslate): string {
  const label = CARD_LABEL_KEYS[id]
  return [editorGroupSearchText(id, t), label === undefined ? '' : t(label)].join(' ').toLowerCase()
}

/**
 * 本层引擎设置内容：参数分组（按共享契约派生）+ 已声明能力与移除入口 +
 * 该层归属的结构化资产编辑器。规则实例与能力补卡共用此实现；补卡只呈现能力内容，
 * 中；**主语＝该实例卡所属模块**（`moduleId`）：事实、参数读数、变量与写路径全部按它取，
 * 没有模块就没有卡（不进入「先渲染再禁用」的分支）。
 */
export function LayerSettingsContent(props: {
  store: PanelStore
  t: PromptToolTranslate
  layer: string
  /** 资产卡的归属模块＝主语；缺席即装配集合为空，整块不渲染。 */
  moduleId?: string
  configId?: string
  excludeCapabilities?: readonly string[]
  toolEditor?: ReactNode
  /** 卡内「添加工具模板…」入口：主语＝该卡所属模块（未声明 customTools 的创建模式也必须有它）。 */
  onChooseToolTemplate?: (moduleId: string, anchor: HTMLButtonElement) => void
  onCreated?: (capabilityId: string) => void
  keyword?: string
  /** 初始创建模式（外部装配／测试用；生产路径由「添加」按钮驱动）。参数组是固定设置区，不在此列。 */
  creatingSections?: readonly string[]
  audience?: 'main' | 'subagent'
  /** 只渲染这些 kind（能力补卡传 ['capability']）；省略＝全部。 */
  kinds?: readonly LayerCardKind[]
}): ReactNode {
  const { store, t, layer } = props
  const moduleId = props.moduleId
  const excluded = props.excludeCapabilities ?? []
  /** 已点「添加」的通用资产节：只记「用户开了这个节的创建模式」，不记「声明已建立」。 */
  const [creating, setCreating] = useState<readonly string[]>(() => (props.creatingSections ?? []).map(id => `${String(moduleId)}:${id}`))
  const creatingKey = (id: string): string => `${String(moduleId)}:${id}`
  const creatingSection = (id: string): boolean => creating.includes(creatingKey(id))
  /** 该节要读写的 `module.yml` 节（通用资产节；参数组不走这门控）。 */
  const sectionsOf = (id: string): readonly string[] | undefined => LAYER_ASSET_SECTIONS[id]
  /** 该节此刻**仍**没声明——取自实时的 `/meta` 快照，不粘连；未知（未下发）不当作未声明。 */
  const undeclaredNow = (id: string): boolean => {
    if (moduleId === undefined) return false
    const sections = sectionsOf(id)
    return sections !== undefined && moduleDeclares(store.meta.modules, moduleId, ...sections) === false
  }
  /** 创建模式＝「点了添加」且「此刻仍未声明」：写成功后快照刷新，创建模式自动退出，卡片恢复回读与正常形态。 */
  const inCreateMode = (id: string): boolean => creatingSection(id) && undeclaredNow(id)
  // 卡片一次算清，下面只按 kind 分组；kinds 只收窄渲染范围（能力补卡）。
  const allCards = moduleId === undefined ? [] : cardsOfLayer(store.meta.modules, layer, moduleId, excluded)
  const cards = props.kinds === undefined ? allCards : allCards.filter((card) => props.kinds!.includes(card.kind))
  const params = cards.filter((card) => card.kind === 'param').map((card) => card.id)
  const capabilities = cards.filter((card) => card.kind === 'capability').map((card) => card.id)
  // 未声明的节只在用户点了添加后出卡；未登记声明面的（模型路由等）不受影响。
  const assets = cards.filter((card) => card.kind === 'asset' || (card.kind === 'add' && inCreateMode(card.id))).map((card) => card.id)
  const pendingAdds = cards.filter((card) => card.kind === 'add' && !creatingSection(card.id)).map((card) => card.id)
  // 同层每张实例卡各渲染一份设置内容：instanceId 带上卡身份，DOM id 才不会互相冲突。
  const instanceId = `layer-${moduleId}-${layer}-${props.configId ?? 'standalone'}`
  const canEdit = moduleId !== undefined && canEditModule(store.fields, store.meta.modules, moduleId)
  const keyword = (props.keyword ?? '').trim().toLowerCase()
  const matches = (id: string): boolean => layerCardSearchText(id, t).includes(keyword)
  // 参数与变量按主语读一次（每模块每轮加载一次，同模块的层卡共享同一份）；
  // store 侧按 `/meta` 的声明面跳过未声明的读，这里不重复判一次。
  const wantsVariables = assets.includes('variables')
  useEffect(() => {
    if (moduleId === undefined) return
    store.ensureModuleParams(moduleId)
    if (wantsVariables) store.ensureModuleVariables(moduleId)
  }, [store, moduleId, wantsVariables])
  if (moduleId === undefined) return null
  if (params.length === 0 && capabilities.length === 0 && assets.length === 0 && pendingAdds.length === 0) return null
  const variables = wantsVariables ? store.moduleVariables(moduleId) : undefined
  /** 创建模式下的第一次成功写盘＝服务端建立声明：重读 `/meta`，卡片随即按正常形态出现。 */
  const afterDeclared = (): void => { void store.load({ silent: true }) }
  return (
    <div className={css.settings} data-layer-settings-content={layer}>
      {props.kinds === undefined && <div className={css.actions}>
        <ModuleCapabilityCreateMenu store={store} t={t} layer={layer} moduleId={moduleId} excludeCapabilities={excluded} onCreated={props.onCreated} />
      </div>}
      {pendingAdds.map((id) => (
        <section key={id} className={css.asset} data-layer-asset-add={id} aria-label={t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}>
          <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}</h4>
          <p className={styles.configFieldHint}>{t('declare.createHint')}</p>
          <Button shape="pill" size="sm" variant="outline" type="button" disabled={!canEdit}
            data-declare-section={LAYER_ASSET_SECTIONS[id]?.[0] ?? id}
            aria-label={`${t('declare.add', { name: t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset') })} · ${t('rules.source', { module: moduleId })}`}
            onClick={() => setCreating(current => [...current, creatingKey(id)])}>
            {t('declare.add', { name: t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset') })}
          </Button>
        </section>
      ))}
      {params.map((card) => (
        <section key={card} hidden={!matches(card)} className={css.group} data-layer-param-group={card}
          aria-label={t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}>
          <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[card] ?? 'modules.group.other')}</h4>
          <div className={css.paramFields} data-layer-param-fields={card}>
            <EngineParamFields store={store} moduleId={moduleId} card={card} t={t} audience={props.audience} instanceId={`${instanceId}-${props.audience ?? 'shared'}-${card}`} />
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
              saveTemplateVariables={async (next, enabled) => {
                const saved = await store.saveModuleVariables(moduleId, next, enabled)
                if (saved && inCreateMode('variables')) afterDeclared()
                return saved
              }}
              publicationPending={variables.publicationPending}
              retryPublication={() => store.retryModuleVariablesPublication(moduleId)}
              embedded
              disabled={!canEdit}
            />
          )}
          {id === 'main-model' && <CurrentSessionModel store={store} t={t} />}
          {id === 'custom-tools' && <h4 className={css.groupTitle}>{t(CARD_LABEL_KEYS[id] ?? 'modules.layer.asset')}</h4>}
          {id === 'custom-tools' && (props.toolEditor ?? (
            <CustomToolsCard key={moduleId} moduleId={moduleId} t={t} onNotice={store.showNotice}
              drafts={store.editorDrafts} disabled={!canEdit}
              onChooseTemplate={props.onChooseToolTemplate === undefined ? undefined : (anchor) => props.onChooseToolTemplate!(moduleId, anchor)}
              undeclared={inCreateMode('custom-tools')} onDeclared={inCreateMode('custom-tools') ? afterDeclared : undefined} />
          ))}
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
  /** 本层引擎设置内容，只由真实实例卡内的设置区承载；主语＝该实例卡的模块。
   *  第四参＝卡内「添加工具模板…」入口的绑定（由 `injectionPointSlots` 装配进本层的卡）。 */
  renderLayerSettings: (layer: string, config: PromptConfigDraft, moduleId: string, onChooseToolTemplate: (moduleId: string, anchor: HTMLButtonElement) => void) => ReactNode
  /** 该层**该模块**是否有可编辑设置，控制真实实例卡内的设置区。 */
  hasLayerSettings: (layer: string, moduleId: string) => boolean
  /** 指令文件卡的设置区：卡是全局段、没有归属模块，主语＝**全局层**（存储根 `config.yml`）。 */
  renderInstructionSettings?: (config: PromptConfigDraft) => ReactNode
  /** 某层某模块的卡片（不含 add 与 missingCapability）：规则卡与能力补卡的搜索共用，不再传谓词。 */
  layerCards: (layer: string, moduleId: string) => readonly LayerCardView[]
  renderModuleSettings: (moduleId: string, layers: readonly string[]) => ReactNode
}

export interface InjectionPointSlotsInput {
  store: PanelStore
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
        modules={store.meta.modules}
        canEditModule={moduleId => canEditModule(store.fields, store.meta.modules, moduleId)}
        onDeclared={() => { void store.load({ silent: true }) }}
        onNotice={store.showNotice} drafts={store.editorDrafts} />
      {audience === 'main' && <div hidden={viewFilter !== 'context-activation'}><ContextActivationDiagnosticsCard store={store} t={t} /></div>}
      <LayerSettingsFocus layer={input.focusCapability?.layer} token={input.focusCapability?.token ?? 0} />
    </>
  )
  return {
    beforeCards,
    renderLayerSettings: (layer: string, config: PromptConfigDraft, moduleId: string, onChooseToolTemplate: (moduleId: string, anchor: HTMLButtonElement) => void) => (
      <LayerSettingsContent
        key={`${moduleId}:${config.id}`}
        store={store}
        t={t}
        layer={layer}
        moduleId={moduleId}
        configId={config?.id}
        excludeCapabilities={input.excludeCapabilities}
        onChooseToolTemplate={onChooseToolTemplate}
        onCreated={input.onCreated}
        keyword={input.keyword}
        audience={audience}
      />
    ),
    renderModuleSettings: (moduleId, layers) => (
      <>
        {layers.map(layer => {
          const key = `${moduleId}:module-settings:${audience}:${layer}`
          const module = store.meta.modules?.find(item => item.id === moduleId)
          const query = (input.keyword ?? '').trim().toLowerCase()
          const matchesModule = `${module?.name ?? ''} ${moduleId}`.toLowerCase().includes(query)
          return <EngineModuleCard key={key} name={module?.name ?? moduleId}
            layer={translateLabel(t, LAYER_LABEL_KEYS, layer)} meta={`${t('rules.source', { module: moduleId })} · ${t(`audience.${audience}`)}`}
            defaultExpanded={store.editorDrafts.expanded.get(key) === true}
            onExpandedChange={next => { store.editorDrafts.expanded.set(key, next); store.publishDrafts() }}>
            <LayerSettingsContent store={store} t={t} layer={layer} moduleId={moduleId} configId={`module-${audience}-${layer}`}
              excludeCapabilities={excluded} keyword={matchesModule ? '' : input.keyword} audience={audience} kinds={['param', 'capability']} />
          </EngineModuleCard>
        })}
      </>
    ),
    // 本层有可渲染内容就要有设置入口：参数组（固定设置区）不依赖声明面；
    // 通用资产节的「添加」只是它的创建入口，不是本层唯一的编辑器通路。
    // 未声明能力只是创建入口，不算「有设置」。
    hasLayerSettings: (layer: string, moduleId: string) => cardsOfLayer(store.meta.modules, layer, moduleId, excluded)
      .some((card) => card.kind !== 'missingCapability'),
    // 指令卡是全局段：设置区主语＝全局层（存储根 config.yml 的 layerSettings），一个开关。
    // 与启用模块数量无关——模块自己写了该参数时，模块值仍然优先（存在即覆盖，服务端判定）。
    renderInstructionSettings: (config: PromptConfigDraft) => (
      <div className={css.settings}>
        <EngineParamField store={store} param="instructionHint" t={t} instanceId={`instruction-${audience}-${config.id}`} global />
      </div>
    ),
    layerCards: (layer: string, moduleId: string) => cardsOfLayer(store.meta.modules, layer, moduleId, excluded)
      .filter((card) => card.kind !== 'add' && card.kind !== 'missingCapability')
      .map((card) => ({ ...card, searchText: layerCardSearchText(card.id, t) })),
  }
}
