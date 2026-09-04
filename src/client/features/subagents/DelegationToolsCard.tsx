import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SubagentToolPolicyCard } from './SubagentToolPolicyCard.tsx'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './subagents.module.css'

const styles = { ...sharedCss, ...featureCss }
/** 工具与深度模块卡（子代理作用域配置；参数经 params 桥扁平键，与主会话引擎模块卡同一来源）。 */
export function DelegationToolsModuleCard(props: {
  store: PromptToolStore
  renderToolSurface: (sessionId: string, label: string) => ReactNode
}): ReactNode {
  const { store } = props
  const fields = store.fields
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  return (
    <EngineModuleCard name="工具与深度" meta="工具集白名单/黑名单 + 注入 kind 白名单 + 递归深度 + 子代理工具策略">
      <p className={styles.configFieldHint}>工具过滤与注入 kind 白名单由主会话的 `tool-filter` / `context-gate` 能力卡统一维护；此处只保留子代理深度和实例策略。</p>
      <div className={styles.settingRowStack}>
        <div className={styles.switchGrid}>
          <span className={clsx(styles.switchGridItem, styles.switchGridField)} title="委派 maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。">
            <span className={styles.switchGridLabel}>递归深度</span>
            <MenuSelect
              className={styles.configInput}
              compact
              ariaLabel="递归深度"
              value={fields.maxDepth}
              disabled={!fields.writePreset}
              options={maxDepthOptions.map((item) => ({ value: item, label: item === '' ? '（不设置）' : item }))}
              onChange={(value) => {
                store.patch({ maxDepth: value })
                void store.persistParamOverrides()
              }}
            />
          </span>
        </div>
      </div>
      <div className={styles.configSectionTitle}>子代理工具策略（subagentToolPolicy · 实例级授权）</div>
      <SubagentToolPolicyCard
        onNotice={(kind, message) => store.showNotice(kind, message)}
        seedAllow={fields.toolFilterAllow}
        currentSessionId={store.api.currentSessionId()}
        renderToolSurface={props.renderToolSurface}
      />
    </EngineModuleCard>
  )
}
