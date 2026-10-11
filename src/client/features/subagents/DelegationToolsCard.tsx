import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { moduleFactsOf } from '../../data/module-subject.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './subagents.module.css'

const styles = { ...sharedCss, ...featureCss }
/** 工具与深度模块卡（子代理作用域配置；参数经 params 桥扁平键，与主会话引擎模块卡同一来源）。
 *  **主语由归属方给**：`moduleId` 是这张卡所属的模块，参数读数、草稿键与写路径全部按它取。 */
export function DelegationToolsModuleCard(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  moduleId: string
  embedded?: boolean
}): ReactNode {
  const { store, t, moduleId } = props
  const facts = moduleFactsOf(store.meta.modules, moduleId)
  const disabled = !store.fields.modulesEnabled || facts?.editable !== true
    || facts.subagentToolPolicyEnabled !== true
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  return (
    <EngineModuleCard name={t('policy.delegation.name')} meta={t('policy.delegation.meta')}
      embedded={props.embedded}
      defaultExpanded={store.editorDrafts?.expanded.get(`${moduleId}:delegation`)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(`${moduleId}:delegation`, value)}>
      <p className={styles.configFieldHint}>{t('param.maxDepth.hint')}</p>
      <div className={styles.settingRowStack}>
        <div className={styles.switchGrid}>
          <HintTooltip label={t('param.maxDepth.hint')}>
            <span className={clsx(styles.switchGridItem, styles.switchGridField)}>
              <span className={styles.switchGridLabel}>{t('param.maxDepth')}</span>
              <MenuSelect
                compact
                ariaLabel={t('param.maxDepth')}
                value={String(store.moduleParamsOf(moduleId).maxDepth ?? '')}
                disabled={disabled}
                options={maxDepthOptions.map((item) => ({ value: item, label: item === '' ? t('policy.delegation.depthUnset') : item }))}
                onChange={(value) => {
                  if (disabled) return
                  store.setModuleParam(moduleId, 'maxDepth', value)
                  void store.persistParamOverrides(moduleId)
                }}
              />
            </span>
          </HintTooltip>
        </div>
      </div>
      {/* 子代理工具策略已改为模块类型能力：编辑器住在能力卡内，此处只给出入口指引，避免双入口。 */}
      <div className={styles.configSectionTitle}>{t('policy.delegation.section')}</div>
      <p className={styles.configFieldHint}>{t('policy.delegation.policyMoved')}</p>
    </EngineModuleCard>
  )
}
