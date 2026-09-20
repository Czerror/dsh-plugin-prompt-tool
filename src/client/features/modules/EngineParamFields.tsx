import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from '../../../shared/engine-params.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { StageDraft } from '../../data/prompt-tool-fields.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import styles from '../../ui/controls.module.css'

/**
 * 简单字段由共享定义驱动；阶段继续使用结构化编辑，不暴露任意 JSON 配置。
 *
 * 显示标签不进 shared：shared 只给参数键，UI 按 `param.<键>` 查 prompt-tool 字典
 * （键类型由 ENGINE_PARAM_KEY 的模板字面量约束，新增参数缺词条即编译失败）。
 */
export function EngineParamFields({ store, card, t }: { store: PromptToolStore; card: string; t: PromptToolTranslate }): ReactNode {
  return ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === card).map((key) => (
    <EngineParamField key={`${store.fields.presetTemplate}:${key}`} store={store} param={key} t={t} />
  ))
}

/**
 * 同一个引擎参数可以在多个位置渲染（层卡内的能力卡 + 工具管线的共享设置区）：
 * 它们绑定同一 `store.fields[param]` 与同一草稿键，天然同源，不需要同步服务；
 * `instanceId` 只用来给每个渲染点一份独立的 DOM id / aria 关联，避免镜像控件
 * 出现重复 id 与标签错配。
 */
export function EngineParamField({ store, param, t, instanceId }: { store: PromptToolStore; param: EngineParamKey; t: PromptToolTranslate; instanceId?: string }): ReactNode {
  const definition = ENGINE_PARAM_DEFINITIONS[param]
  const value = store.fields[param]
  const disabled = !store.fields.writePreset || store.moduleFacts?.editable !== true
  const draftKey = `${store.fields.presetTemplate}:param:${param}`
  const retained = store.editorDrafts?.fields.get(draftKey)
  const [numberDraft, setNumberDraft] = useState<string | undefined>(retained?.text)
  const [error, setError] = useState<string | undefined>(retained?.error || undefined)
  const save = (): void => { void store.persistParamOverrides() }
  const patch = (next: unknown): void => { store.patch({ [param]: next }) }
  // 默认渲染点沿用 `pt-param-<键>`（层卡内唯一）；镜像渲染点带实例前缀，DOM id 不重复。
  const id = instanceId === undefined ? `pt-param-${param}` : `pt-param-${instanceId}-${param}`
  const label = t(`param.${param}`)
  const hint = t('param.hint', { param, label })
  const optionLabels: Record<string, string> = {
    either: t('param.option.either'),
    'tool-call': t('param.option.tool-call'),
    'assistant-message': t('param.option.assistant-message'),
  }
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
        <strong>{label}</strong>
        <small>{t('param.stages.hint')}</small>
        {stages.map((stage, index) => (
          <div className={styles.settingRowStack} key={index}>
            <input className={styles.configInput} aria-label={t('param.stages.nameAria', { index: index + 1 })} value={stage.name} disabled={disabled}
              onChange={(event) => update(stages.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} onBlur={save} />
            <TagInput id={`pt-stage-${index}-tools`} label={t('param.stages.toolsLabel', { index: index + 1 })} hint={t('param.stages.toolsHint')} value={stage.tools} disabled={disabled}
              onChange={(tools) => update(stages.map((item, at) => at === index ? { ...item, tools } : item))} onCommit={save} />
            <div className={styles.configActions}>
              <button type="button" className={styles.pillButton} aria-label={t('param.stages.moveUpAria', { index: index + 1 })} disabled={disabled || index === 0} onClick={() => move(index, -1)}>{t('param.stages.moveUp')}</button>
              <button type="button" className={styles.pillButton} aria-label={t('param.stages.moveDownAria', { index: index + 1 })} disabled={disabled || index === stages.length - 1} onClick={() => move(index, 1)}>{t('param.stages.moveDown')}</button>
              <button type="button" className={styles.pillButton} aria-label={t('param.stages.removeAria', { index: index + 1 })} disabled={disabled} onClick={() => update(stages.filter((_, at) => at !== index), true)}>{t('param.stages.remove')}</button>
            </div>
          </div>
        ))}
        <button type="button" className={styles.pillButton} disabled={disabled} onClick={() => update([...stages, { name: '', tools: '' }])}>{t('param.stages.add')}</button>
      </div>
    )
  }
  if (definition.kind === 'string-list') {
    return <TagInput id={id} label={label} hint={hint} value={String(value ?? '')} disabled={disabled}
      onChange={patch} onCommit={save} />
  }
  let control: ReactNode
  if (definition.kind === 'string' && definition.options !== undefined) {
    control = <MenuSelect compact ariaLabel={label} value={String(value ?? '')} disabled={disabled}
      options={[{ value: '', label: t('param.inheritPresetDefault') }, ...definition.options.map((item) => ({ value: item, label: optionLabels[item] ?? item }))]}
      onChange={(next) => { patch(next); save() }} />
  } else if (definition.kind === 'boolean' && definition.defaultValue === undefined) {
    control = <MenuSelect compact ariaLabel={label} value={value === undefined ? '' : String(value)} disabled={disabled}
      options={[{ value: '', label: t('param.inheritAnchorSwitch') }, { value: 'true', label: t('param.on') }, { value: 'false', label: t('param.off') }]}
      onChange={(next) => { patch(next === '' ? undefined : next === 'true'); save() }} />
  } else if (definition.kind === 'boolean') {
    control = <Switch className={styles.configEnable} checked={value === true} disabled={disabled} label={label}
      onChange={(next) => { patch(next); save() }} />
  } else if (definition.kind === 'number') {
    control = <input id={id} className={clsx(styles.configInput, styles.configNumberInput)} inputMode="decimal" aria-label={label}
      aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-error`}
      value={numberDraft ?? String(value ?? '')} readOnly={disabled}
      onChange={(event) => {
        setNumberDraft(event.target.value)
        setError(undefined)
        store.editorDrafts?.fields.set(draftKey, { source: String(value ?? ''), text: event.target.value, error: '' })
      }}
      onBlur={() => {
        if (numberDraft === undefined || disabled) return
        const next = numberDraft.trim() === '' ? definition.defaultValue : Number(numberDraft)
        const reason = typeof next === 'number' ? definition.check(next) : undefined
        if (reason !== undefined) {
          setError(reason)
          store.editorDrafts?.fields.set(draftKey, { source: String(value ?? ''), text: numberDraft, error: reason })
          return
        }
        patch(next)
        store.editorDrafts?.fields.delete(draftKey)
        setNumberDraft(undefined)
        save()
      }} />
  } else {
    control = <textarea id={id} className={styles.configTextarea} rows={2} aria-label={label} value={String(value ?? '')}
      readOnly={disabled} onChange={(event) => patch(event.target.value)} onBlur={() => { if (!disabled) save() }} />
  }
  return <div className={styles.settingRowStack} data-param-key={param}>
    <HintTooltip label={hint}><span className={styles.settingCopy}>
      {menuField || definition.kind === 'boolean' ? <span>{label}</span> : <label htmlFor={id}>{label}</label>}
    </span></HintTooltip>
    {control}
    {error !== undefined && <small id={`${id}-error`} role="alert">{error}</small>}
  </div>
}
