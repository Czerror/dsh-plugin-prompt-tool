import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { TagInput } from '../../ui/TagInput.tsx'
import { SubagentToolPolicyCard } from './SubagentToolPolicyCard.tsx'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import styles from '../../PromptUi.module.css'
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
      <TagInput id="pt-tool-filter-allow" label="工具集白名单" hint="toolFilter.allow：主会话常驻过滤（tool-filter 模块，作用于任意注册工具含自定义插件）+ 委派子代理 toolFilter；留空 = 不限制。"
        value={fields.toolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ toolFilterAllow: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <TagInput id="pt-tool-filter-deny" label="工具集黑名单" hint="toolFilter.deny：主会话常驻过滤（tool-filter 模块）+ 委派子代理 toolFilter；留空 = 不限制。"
        value={fields.toolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ toolFilterDeny: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <TagInput id="pt-allow-kinds" label="注入 kind 白名单" hint="context-gate allowKinds（注入门控）；例如 skill-invocation、near-anchor、router-guide；留空 = 官方默认（不过滤）。"
        value={fields.allowKinds} placeholder="skill-invocation, near-anchor, router-guide" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ allowKinds: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <div className={styles.settingRowStack}>
        <div className={styles.switchGrid}>
          <span className={clsx(styles.switchGridItem, styles.switchGridField)} title="委派 maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。">
            <span className={styles.switchGridLabel}>递归深度</span>
            <select
              className={styles.configInput}
              aria-label="递归深度"
              value={fields.maxDepth}
              disabled={!fields.writePreset}
              onChange={(event) => {
                store.patch({ maxDepth: event.target.value })
                void store.persistParamOverrides()
              }}
            >
              {maxDepthOptions.map((item) => (
                <option key={item} value={item}>{item === '' ? '（不设置）' : item}</option>
              ))}
            </select>
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
