/**
 * 九层编辑面的页面级装配：把 tool-pipeline 层的共享能力设置区与
 * 卡片层可见性判断的入口收敛到一处，页面只声明受众视图与卡片内容。
 *
 * 归属来自 shared 契约（`ENGINE_EDITOR_GROUP_MAP` 的 `displayLayer` / `relatedLayers`），
 * 与 host `/meta` 下发的 `editorGroups` 同源；这里不新增第二份映射，
 * 也不改变任何运行时 hook、注册顺序或保存通道。展示归属只是导航。
 */
import type { ReactNode } from 'react'
import { isEditorGroupVisible } from '../../../../shared/engine-capabilities.ts'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { EngineModuleCard } from '../../../ui/EngineModuleCard.tsx'
import { EngineParamField } from '../../../features/modules/EngineParamFields.tsx'
import styles from '../../../ui/controls.module.css'

export { isEditorGroupVisible }

/**
 * tool-pipeline 层的共享能力设置区：这里的工具过滤控件与 `tool-filter` 能力卡
 * 绑定同一 `store.fields` 字段与同一草稿键，是同一份参数的第二处编辑点；
 * `instanceId` 只区分 DOM id，不引入第二份状态、同步服务或事件总线。
 */
export function ToolPipelineSettingsCard(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const expandedKey = `${store.fields.presetTemplate}:tool-pipeline-settings`
  return (
    <EngineModuleCard name={t('modules.toolPipeline.name')} meta={t('modules.toolPipeline.meta')}
      defaultExpanded={store.editorDrafts?.expanded.get(expandedKey)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(expandedKey, value)}>
      <p className={styles.configFieldHint}>{t('modules.toolPipeline.hint')}</p>
      <EngineParamField store={store} param="toolFilterAllow" t={t} instanceId="tool-pipeline" />
      <EngineParamField store={store} param="toolFilterDeny" t={t} instanceId="tool-pipeline" />
    </EngineModuleCard>
  )
}
