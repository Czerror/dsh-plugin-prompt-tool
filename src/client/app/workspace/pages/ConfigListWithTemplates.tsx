import { memo, useCallback, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { PromptConfigList } from '../../../features/prompts/PromptConfigList.tsx'
import { TemplatePicker } from '../../../ui/TemplatePicker.tsx'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import type { InstructionPolicyFileOverride } from '../../../../shared/instructions.ts'
/** 子代理配置列表（按 scope 过滤：subagent 只列子代理可见配置）。
 *  纪律：过滤状态只由用户手动改变；新建只做「展开新卡 + 滚动定位」两件事。
 *
 *  本组件不再提供独立的「新建」按钮：创建入口统一收敛到工具栏的合并菜单
 *  （`EngineModuleActions` 的「添加模板 · 层级」/「添加工具模板…」/「添加模板变量」），
 *  避免同一列表出现两个创建入口。 */
export const ConfigListWithTemplates = memo(function ConfigListWithTemplates(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  layer?: string
  scope?: 'main' | 'subagent'
  beforeCards?: ReactNode
  /** 工具栏中的非提示词配置操作（如能力模块创建菜单）。 */
  toolbarActions?: ReactNode
  /** 模块卡（引擎能力、自定义工具）：渲染在层级配置卡之前。 */
  moduleCards?: ReactNode
  /** 受控视图过滤（页面持有）：不传时列表内部维护。 */
  onViewFilterChange?: (value: string) => void
}): ReactNode {
  const { store, t, layer, scope, beforeCards, toolbarActions, moduleCards, onViewFilterChange } = props
  const fields = usePromptToolFields(store, (value) => value)
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    return store.persistConfigs(configs)
  }, [store])
  // 指令文件卡：显式写盘与重新读取（与预设保存分流）。指令文件是主会话概念，
  // 只在主会话作用域下发，避免子代理页重复挂载产生同一文件的双编辑入口。
  const instructionScope = scope === undefined || scope === 'main'
  const saveInstructionFile = useCallback((fileId: string) => {
    void store.persistInstructionFiles([fileId])
  }, [store])
  const reloadInstructionFile = useCallback((fileId: string) => {
    void store.reloadInstructionFile(fileId)
  }, [store])
  const patchInstructionPolicy = useCallback((fileId: string, override: InstructionPolicyFileOverride) => {
    void store.updateInstructionPolicy(fileId, override)
  }, [store])
  // 当前预设模板消息批层无配置时，pre-step 层空状态追加提示（列表仍可自定义：
  // 新建配置写入激活预设 preset.yml 的 promptConfigs，随预设走、不随切换保留）。
  const preStepEmpty = store.templatePreStepCount === 0 && (layer === undefined || layer === 'pre-step')
  const templatePicker = useTemplatePicker(
    fields.promptConfigs,
    (config) => store.patch({ promptConfigs: [...store.getFields().promptConfigs, config] }),
    store.showNotice,
    t,
    scope,
  )
  return (
    <>
      <PromptConfigList
        t={t}
        meta={store.meta}
        configs={fields.promptConfigs}
        createdConfigId={templatePicker.createdConfigId}
        layer={layer}
        scope={scope}
        beforeCards={beforeCards}
        moduleCards={moduleCards}
        toolbarActions={toolbarActions}
        onViewFilterChange={onViewFilterChange}
        emptyHint={preStepEmpty ? t('configList.emptyPreStep') : undefined}
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        instructionPolicy={instructionScope ? store.instructionPolicy : undefined}
        onToggleInstructionSource={instructionScope ? store.setInstructionSourceEnabled : undefined}
        onSaveInstructionFile={instructionScope ? saveInstructionFile : undefined}
        onReloadInstructionFile={instructionScope ? reloadInstructionFile : undefined}
        onPatchInstructionPolicy={instructionScope ? patchInstructionPolicy : undefined}
        onNotice={store.showNotice}
      />
      {templatePicker.open && (
        <TemplatePicker t={t} anchorRef={templatePicker.anchorRef} templates={templatePicker.templates} layer={layer} onPick={templatePicker.pickTemplate} onClose={templatePicker.closePicker} />
      )}
    </>
  )
})
