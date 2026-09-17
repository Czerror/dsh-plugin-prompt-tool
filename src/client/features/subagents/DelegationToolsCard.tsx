import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './subagents.module.css'

const styles = { ...sharedCss, ...featureCss }
/** 工具与深度模块卡（子代理作用域配置；参数经 params 桥扁平键，与主会话引擎模块卡同一来源）。 */
export function DelegationToolsModuleCard(props: {
  store: PromptToolStore
  t: PromptToolTranslate
}): ReactNode {
  const { store, t } = props
  const fields = store.fields
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  return (
    <EngineModuleCard name={t('policy.delegation.name')} meta={t('policy.delegation.meta')}
      defaultExpanded={store.editorDrafts?.expanded.get(`${fields.presetTemplate}:delegation`)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(`${fields.presetTemplate}:delegation`, value)}>
      <p className={styles.configFieldHint}>{t('policy.delegation.hint')}</p>
      <div className={styles.settingRowStack}>
        <div className={styles.switchGrid}>
          <HintTooltip label={t('policy.delegation.depthHint')}>
            <span className={clsx(styles.switchGridItem, styles.switchGridField)}>
              <span className={styles.switchGridLabel}>{t('param.maxDepth')}</span>
              <MenuSelect
                className={styles.configInput}
                compact
                ariaLabel={t('param.maxDepth')}
                value={fields.maxDepth}
                disabled={!fields.writePreset}
                options={maxDepthOptions.map((item) => ({ value: item, label: item === '' ? t('policy.delegation.depthUnset') : item }))}
                onChange={(value) => {
                  store.patch({ maxDepth: value })
                  void store.persistParamOverrides()
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
