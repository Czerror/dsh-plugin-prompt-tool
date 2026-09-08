import { useState, type ReactNode } from 'react'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from '../../../shared/engine-params.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { StageDraft } from '../../data/prompt-tool-fields.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import styles from '../../ui/controls.module.css'

/** 简单字段由共享定义驱动；阶段继续使用结构化编辑，不暴露任意 JSON 配置。 */
export function EngineParamFields({ store, card }: { store: PromptToolStore; card: string }): ReactNode {
  return ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === card).map((key) => (
    <EngineParamField key={`${store.fields.presetTemplate}:${key}`} store={store} param={key} />
  ))
}

function EngineParamField({ store, param }: { store: PromptToolStore; param: EngineParamKey }): ReactNode {
  const definition = ENGINE_PARAM_DEFINITIONS[param]
  const value = store.fields[param]
  const disabled = !store.fields.writePreset || store.moduleFacts?.editable !== true
  const [numberDraft, setNumberDraft] = useState<string | undefined>()
  const [error, setError] = useState<string>()
  const save = (): void => { void store.persistParamOverrides() }
  const patch = (next: unknown): void => { store.patch({ [param]: next }) }
  const id = `pt-param-${param}`
  const hint = `${param}：${definition.label}。空文本/列表回落预设默认；保存后用于后续 generation。`
  const optionLabels: Record<string, string> = { either: '工具调用或助手消息', 'tool-call': '工具调用', 'assistant-message': '助手消息' }
  const menuField = (definition.kind === 'string' && definition.options !== undefined)
    || (definition.kind === 'boolean' && definition.defaultValue === undefined)
  if (definition.kind === 'stages') {
    const stages = store.fields.stages
    const update = (next: StageDraft[], persist = false): void => {
      store.patch({ stages: next })
      if (persist) save()
    }
    const move = (index: number, delta: number): void => {
      const next = [...stages]
      ;[next[index], next[index + delta]] = [next[index + delta]!, next[index]!]
      update(next, true)
    }
    return (
      <div className={styles.settingRowStack} data-param-key={param}>
        <strong>{definition.label}</strong>
        <small>阶段非空时启用渐进披露。未填完的草稿保留；清空全部阶段恢复两相模式。</small>
        {stages.map((stage, index) => (
          <div className={styles.settingRowStack} key={index}>
            <input className={styles.configInput} aria-label={`阶段 ${index + 1} 名称`} value={stage.name} disabled={disabled}
              onChange={(event) => update(stages.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} onBlur={save} />
            <TagInput id={`pt-stage-${index}-tools`} label={`阶段 ${index + 1} 工具集`} hint="回车或逗号添加工具名。" value={stage.tools} disabled={disabled}
              onChange={(tools) => update(stages.map((item, at) => at === index ? { ...item, tools } : item))} onCommit={save} />
            <div className={styles.configActions}>
              <button type="button" className={styles.pillButton} aria-label={`上移阶段 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>上移</button>
              <button type="button" className={styles.pillButton} aria-label={`下移阶段 ${index + 1}`} disabled={disabled || index === stages.length - 1} onClick={() => move(index, 1)}>下移</button>
              <button type="button" className={styles.pillButton} aria-label={`删除阶段 ${index + 1}`} disabled={disabled} onClick={() => update(stages.filter((_, at) => at !== index), true)}>删除</button>
            </div>
          </div>
        ))}
        <button type="button" className={styles.pillButton} disabled={disabled} onClick={() => update([...stages, { name: '', tools: '' }])}>添加阶段</button>
      </div>
    )
  }
  if (definition.kind === 'string-list') {
    return <TagInput id={id} label={definition.label} hint={hint} value={String(value ?? '')} disabled={disabled}
      onChange={patch} onCommit={save} />
  }
  let control: ReactNode
  if (definition.kind === 'string' && definition.options !== undefined) {
    control = <MenuSelect compact ariaLabel={definition.label} value={String(value ?? '')} disabled={disabled}
      options={[{ value: '', label: '继承预设默认' }, ...definition.options.map((item) => ({ value: item, label: optionLabels[item] ?? item }))]}
      onChange={(next) => { patch(next); save() }} />
  } else if (definition.kind === 'boolean' && definition.defaultValue === undefined) {
    control = <MenuSelect compact ariaLabel={definition.label} value={value === undefined ? '' : String(value)} disabled={disabled}
      options={[{ value: '', label: '继承锚定开关' }, { value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]}
      onChange={(next) => { patch(next === '' ? undefined : next === 'true'); save() }} />
  } else if (definition.kind === 'boolean') {
    control = <label className={styles.configEnable} htmlFor={id}>
      <input id={id} type="checkbox" checked={value === true} disabled={disabled} aria-label={definition.label}
        onChange={(event) => { patch(event.target.checked); save() }} />
      <span className={styles.switch} aria-hidden="true"><i /></span>
    </label>
  } else if (definition.kind === 'number') {
    control = <input id={id} className={styles.configInput} type="number" step="any" aria-label={definition.label}
      aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-error`}
      value={numberDraft ?? String(value ?? '')} disabled={disabled}
      onChange={(event) => { setNumberDraft(event.target.value); setError(undefined) }}
      onBlur={() => {
        if (numberDraft === undefined) return
        const next = numberDraft.trim() === '' ? definition.defaultValue : Number(numberDraft)
        const reason = typeof next === 'number' ? definition.check(next) : undefined
        if (reason !== undefined) { setError(reason); return }
        patch(next)
        setNumberDraft(undefined)
        save()
      }} />
  } else {
    control = <textarea id={id} className={styles.configTextarea} rows={2} aria-label={definition.label} value={String(value ?? '')}
      disabled={disabled} onChange={(event) => patch(event.target.value)} onBlur={save} />
  }
  return <div className={styles.settingRowStack} data-param-key={param}>
    <HintTooltip label={hint}><span className={styles.settingCopy}>
      {menuField ? <span>{definition.label}</span> : <label htmlFor={id}>{definition.label}</label>}
      <small>{param}</small>
    </span></HintTooltip>
    {control}
    {error !== undefined && <small id={`${id}-error`} role="alert">{error}</small>}
  </div>
}
