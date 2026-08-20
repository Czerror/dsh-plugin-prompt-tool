/** Anchored Standard 预设模块行：按实际生效配置动态生成（模板声明什么显示什么）。 */
import type { ReactNode } from 'react'
import { ToggleRow } from './ToggleRow.tsx'
import type { Fields } from './prompt-tool-bridge.ts'
import type { SwitchKey } from './prompt-tool-store.ts'
import type { PromptConfigDraft } from './prompt-tool-types.ts'
import styles from './PromptUi.module.css'

export function BuiltinConfigRows(props: { fields: Fields; configs: PromptConfigDraft[]; disabled: boolean; onChange: (key: SwitchKey, value: boolean) => void; onEdit: (id: string) => void }): ReactNode {
  const { fields, configs, onEdit } = props
  /** 预设声明的消息批模块：id → 开关键映射；模块不存在（模板未声明）时行不渲染。 */
  const rows: Array<{ id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }> = [
    {
      id: 'near-anchor',
      label: 'near-anchor · 首句锚点',
      hint: 'strategy=first-turn-anchor · position=after-user · dedupe=session；跟随「追加任务引导」。',
      checked: fields.firstTurnAnchor,
      onChange: (value) => props.onChange('firstTurnAnchor', value),
    },
    {
      id: 'router-guide',
      label: 'router-guide · 每轮引导',
      hint: 'strategy=guide-auto · position=after-user · dedupe=batch；跟随「追加任务引导」。',
      checked: fields.firstTurnAnchor,
      onChange: (value) => props.onChange('firstTurnAnchor', value),
    },
    {
      id: 'prompt-injector',
      label: 'prompt-injector · preset.md 注入',
      hint: 'strategy=custom-fallback · position=before-all · dedupe=session；跟随「注入 preset.md」。',
      checked: fields.injectPrompt,
      onChange: (value) => props.onChange('injectPrompt', value),
    },
    {
      id: 'instruction-hint',
      label: 'instruction-hint · 指令文件提示',
      hint: 'strategy=placeholder · fill=instruction-hint · position=after-all；常开，不可在此关闭。',
      checked: true,
      onChange: () => {},
    },
  ]
  const disabled = props.disabled || !fields.writePreset
  return (
    <section className={styles.section} aria-labelledby="prompt-tool-builtin-heading">
      <div className={styles.sectionHeading}><div><h2 id="prompt-tool-builtin-heading">Anchored Standard(prompt-tool)</h2><p>预设模板（preset.yml）声明的消息批模块，按实际生效配置展示；切换模板后此处跟随模板声明。</p></div></div>
      <div className={styles.rowGroup}>
        {rows.flatMap((row) => {
          const config = configs.find((item) => item.id === row.id)
          // 模板未声明该模块（或已被删除）时不渲染；label 优先用配置名。
          if (config === undefined) return []
          const label = config.name !== undefined && config.name.length > 0 && config.name !== config.id
            ? `${config.id} · ${config.name}`
            : row.label
          return [
            <ToggleRow key={row.id} id={`pt-builtin-${row.id}`} label={label} hint={row.hint}
              checked={row.checked} disabled={disabled} onChange={row.onChange}
              extra={<button type="button" className={styles.pillButton} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(config.id) }}>编辑</button>} />,
          ]
        })}
      </div>
    </section>
  )
}
