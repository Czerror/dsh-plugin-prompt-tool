/**
 * 九层编辑面的唯一页面级装配入口。
 *
 * 归属来自 shared 契约（`ENGINE_EDITOR_GROUP_MAP` 的 `displayLayer` / `relatedLayers`），
 * 与 host `/meta` 下发的 `editorGroups` 同源；页面只声明受众视图与页面专属编排
 * （创建菜单、模板浮层、指令回调），不再各自手写层名判断。
 *
 * 展示归属只是导航：这里不新增第二份映射，也不改变任何运行时 hook、注册顺序或保存通道。
 */
import type { ReactNode } from 'react'
import { isEditorGroupVisible, type EngineLayer } from '../../../../shared/engine-capabilities.ts'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { EngineModuleCard } from '../../../ui/EngineModuleCard.tsx'
import { EngineModuleCards, EnginePromptDefaultsCard, type CapabilityEditorSlot } from '../../../features/modules/EngineModuleList.tsx'
import { EngineParamFields } from '../../../features/modules/EngineParamFields.tsx'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { PresetPersonaCard } from '../../../features/persona/PresetPersonaCard.tsx'
import { DelegationToolsModuleCard } from '../../../features/subagents/DelegationToolsCard.tsx'
import { WorldBookDiagnosticsCard } from '../../../features/prompts/WorldBookDiagnosticsCard.tsx'
import { TemplateVariablesModuleCard } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { CustomToolsCard, type ToolCreateIntent } from '../../../features/tools/CustomToolsCard.tsx'
import { LayerCard } from '../../../ui/LayerCard.tsx'
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
 */
export function ToolPipelineSettingsCard(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const expandedKey = `${store.fields.presetTemplate}:tool-pipeline-settings`
  return (
    <EngineModuleCard name={t('modules.toolPipeline.name')} meta={t('modules.toolPipeline.meta')}
      defaultExpanded={store.editorDrafts?.expanded.get(expandedKey)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(expandedKey, value)}>
      <p className={ui.configFieldHint}>{t('modules.toolPipeline.hint')}</p>
      {TOOL_PIPELINE_SETTING_GROUPS.map((group) => (
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
    </EngineModuleCard>
  )
}

export interface EngineLayerSlots {
  beforeCards: ReactNode
  commonCards: ReactNode
  moduleCards: ReactNode
}

export interface EngineLayerSlotsInput {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 当前层筛选（`all` / `world-book` / 九层之一）；过滤只影响展示，不改变保存语义。 */
  viewFilter: string
  /** 受众视图：主会话与子代理是同源视图，不改 audience，也不隐式启用 includeSubagents。 */
  audience: 'main' | 'subagent'
  /** 新建能力后的定位信号（token 递增，重复创建同一能力仍会再次展开）。 */
  focusCapability?: { id: string; token: number }
  /** 自定义工具创建意图（两页共用同一张卡，不各维护一份编辑器）。 */
  toolCreate?: ToolCreateIntent
  onToolIntentConsumed?: () => void
  /** 子代理页的模板变量卡展开态：由页面持有以便跨页恢复。 */
  variablesExpanded?: boolean
  onToggleVariables?: () => void
  /** 能力卡内的附加编辑器（页面注入，避免 feature 之间反向依赖）。 */
  renderCapabilityExtra?: (slot: CapabilityEditorSlot) => ReactNode
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
  const main = audience === 'main'
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const beforeCards = main
    ? (
      <>
        <LayerCard visible={isEditorGroupVisible('persona', viewFilter)}>
          <PresetPersonaCard t={t} presetId={store.fields.presetTemplate} disabled={!canEditPreset} onNotice={store.showNotice} drafts={store.editorDrafts} />
        </LayerCard>
        <div hidden={viewFilter !== 'world-book'}>
          <WorldBookDiagnosticsCard store={store} t={t} />
        </div>
      </>
    )
    : (
      <LayerCard visible={isEditorGroupVisible('variables', viewFilter)}>
        <TemplateVariablesModuleCard
          t={t}
          templateVariables={store.templateVariables}
          setTemplateVariables={store.setTemplateVariables}
          templateVariablesEnabled={store.templateVariablesEnabled}
          setTemplateVariablesEnabled={store.setTemplateVariablesEnabled}
          saveTemplateVariables={store.saveTemplateVariables}
          expanded={input.variablesExpanded ?? false}
          onToggleExpanded={() => input.onToggleVariables?.()}
        />
      </LayerCard>
    )
  const commonCards = (
    <div className={ui.configList}>
      {main
        ? (
          <>
            <LayerCard visible={isEditorGroupVisible('main-model', viewFilter)}>
              <ModelRouteModuleCard store={store} scope="main" />
            </LayerCard>
            <LayerCard visible={isEditorGroupVisible('prompt-defaults', viewFilter)}>
              <EnginePromptDefaultsCard store={store} t={t} />
            </LayerCard>
          </>
        )
        : (
          <>
            <LayerCard visible={isEditorGroupVisible('subagent-model', viewFilter)}>
              <ModelRouteModuleCard store={store} scope="subagent" />
            </LayerCard>
            <LayerCard visible={isEditorGroupVisible('subagent-tools', viewFilter)}>
              <DelegationToolsModuleCard store={store} t={t} />
            </LayerCard>
          </>
        )}
    </div>
  )
  const moduleCards = (
    <>
      <EngineModuleCards
        store={store}
        t={t}
        layerFilter={viewFilter}
        showActions={false}
        showPromptDefaults={false}
        showStatus={viewFilter !== 'all'}
        focusCapability={input.focusCapability}
        excludeCapabilities={input.excludeCapabilities}
        hint={input.moduleHint}
        emptyHint={input.moduleEmptyHint}
        renderCapabilityExtra={input.renderCapabilityExtra}
      />
      {main && (
        <LayerCard visible={isEditorGroupVisible('tool-filter', viewFilter)}>
          <ToolPipelineSettingsCard store={store} t={t} />
        </LayerCard>
      )}
      <LayerCard visible={isEditorGroupVisible('custom-tools', viewFilter)}>
        <CustomToolsCard
          key={store.fields.presetTemplate}
          presetId={store.fields.presetTemplate}
          t={t}
          onNotice={store.showNotice}
          drafts={store.editorDrafts}
          disabled={!canEditPreset}
          createIntent={input.toolCreate}
          onIntentConsumed={input.onToolIntentConsumed}
        />
      </LayerCard>
    </>
  )
  return { beforeCards, commonCards, moduleCards }
}
