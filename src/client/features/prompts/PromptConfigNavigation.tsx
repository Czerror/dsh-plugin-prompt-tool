import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import { nextTabIndex } from '../../ui/tab-key.ts'
import styles from './prompts.module.css'

/** 本卡的编辑视图；普通面板保持挂载，层共享设置在首次进入后保留。 */
export function PromptConfigNavigation(props: {
  t: PromptToolTranslate
  children: ReactNode
  layer: string
  /** 上方没有可分隔的身份区（指令文件卡）时去掉分区横线与顶部留白。 */
  flat?: boolean
  renderLayerSettings?: () => ReactNode
}): ReactNode {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState('conditions')
  const [visitedSettings, setVisitedSettings] = useState<string>()
  const [horizontal, setHorizontal] = useState(false)
  const [invalid, setInvalid] = useState<string[]>([])
  /**
   * 页签名取自各面板元素自己的 `aria-label`：面板 section 用它声明自己的名字，导航据此取页签文字。
   * 它是页签文字的唯一来源——删掉面板的 aria-label，页签会渲染成空胶囊（真实回归，见 .ai-memory/20260927）。
   * 面板内因此不再渲染同名可见标题，界面上只有页签一处名字。
   */
  const panels = Children.toArray(props.children).filter(isValidElement<{ 'data-config-panel': string; 'aria-label': string }>).map(child => ({
    key: child.props['data-config-panel'], label: child.props['aria-label'], content: child,
  }))
  if (props.renderLayerSettings !== undefined) panels.push({ key: 'settings', label: props.t('form.navigation.settings'), content: <></> })
  const active = panels.some(panel => panel.key === selected) ? selected : panels[0]?.key
  const refreshInvalid = () => {
    const next = [...root.current?.querySelectorAll<HTMLElement>('[data-config-view]') ?? []]
      .filter(panel => panel.querySelector('[aria-invalid="true"], [role="alert"]') !== null)
      .map(panel => panel.dataset.configView!)
    setInvalid(previous => previous.join() === next.join() ? previous : next)
  }
  useEffect(refreshInvalid)
  useEffect(() => {
    if (root.current === null) return
    const observer = new ResizeObserver(([entry]) => setHorizontal((entry?.contentRect.width ?? 0) <= 620))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (active === 'settings') setVisitedSettings(props.layer)
  }, [active, props.layer])
  const select = (key: string) => {
    refreshInvalid()
    if (key === 'settings') setVisitedSettings(props.layer)
    setSelected(key)
  }
  return <div ref={root} className={props.flat === true ? `${styles.configNavigation} ${styles.configNavigationFlat}` : styles.configNavigation}>
    <div role="tablist" aria-label={props.t('form.navigation.label')} aria-orientation={horizontal ? 'horizontal' : 'vertical'} className={styles.configTabs}>
      {panels.map((panel, index) => <button key={panel.key} type="button" role="tab" id={`${id}-tab-${panel.key}`}
        data-config-tab={panel.key} aria-controls={`${id}-panel-${panel.key}`} aria-selected={active === panel.key}
        tabIndex={active === panel.key ? 0 : -1} className={styles.configTab}
        onClick={() => select(panel.key)} onKeyDown={event => {
          const key = event.key === 'ArrowDown' ? 'ArrowRight' : event.key === 'ArrowUp' ? 'ArrowLeft' : event.key
          const next = nextTabIndex(panels.length, index, key)
          if (next === undefined) return
          event.preventDefault()
          select(panels[next]!.key)
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
        {panel.label}{invalid.includes(panel.key) && <span className={styles.configTabError} aria-label={props.t('form.navigation.invalid')}>!</span>}
      </button>)}
    </div>
    <div className={styles.configPanels}>
      {panels.map(panel => <div key={panel.key} role="tabpanel" id={`${id}-panel-${panel.key}`}
        aria-labelledby={`${id}-tab-${panel.key}`} hidden={active !== panel.key} tabIndex={0}
        data-config-view={panel.key} data-layer-settings={panel.key === 'settings' ? props.layer : undefined} className={styles.configPanel}>
        {panel.key === 'settings'
          ? (active === 'settings' || visitedSettings === props.layer) && props.renderLayerSettings?.()
          : panel.content}
      </div>)}
    </div>
  </div>
}
