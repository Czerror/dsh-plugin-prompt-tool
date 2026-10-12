import { useSyncExternalStore, type ReactNode } from 'react'
import { Switch } from '../../ui/Switch.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { ENGINE_PARAM_DEFINITIONS } from '../../../shared/engine-params.ts'
import { SHARED_PARAM_KEYS, type SharedParamKey } from '../../data/prompt-tool-fields.ts'
import { engineGroupParamKeys } from '../../../shared/engine-capabilities.ts'
import { moduleFactsOf } from '../../data/module-subject.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import styles from '../../ui/controls.module.css'

/** 未提供草稿通道的 store（单测桩）退化订阅：不广播，字段仍按当前草稿读一次。 */
const subscribeNothing = (): (() => void) => () => {}
const getZero = (): number => 0

/**
 * 编辑组 / 能力卡的搜索文本：能力 id（技术键）+ 该组参数键 + 参数中文标签。
 * 参数键来自 shared 派生（`engineGroupParamKeys`），中文标签来自 `param.<键>` 字典；
 * 与配置实例的搜索共用「中文名 + 技术键」口径，都只影响展示过滤，不改变写通道。
 */
export function editorGroupSearchText(id: string, t: PromptToolTranslate): string {
  const keys = engineGroupParamKeys(id)
  return [id, ...keys.flatMap((key) => [key, t(`param.${key}`)])].join(' ')
}

/** 该编辑组是否命中搜索词（没有登记扁平参数的能力按能力 id 匹配）。 */
export function matchesEditorGroup(id: string, keyword: string, t: PromptToolTranslate): boolean {
  return keyword.length === 0 || editorGroupSearchText(id, t).toLowerCase().includes(keyword)
}

/**
 * 简单字段由共享定义驱动；阶段继续使用结构化编辑，不暴露任意 JSON 配置。
 *
 * 显示标签不进 shared：shared 只给参数键，UI 按 `param.<键>` 查 prompt-tool 字典
 * （键类型由 ENGINE_PARAM_KEY 的模板字面量约束，新增参数缺词条即编译失败）。
 */
export function EngineParamFields({ store, moduleId, card, t, instanceId }: { store: PromptToolStore; moduleId: string; card: string; t: PromptToolTranslate; instanceId?: string }): ReactNode {
  const keys = SHARED_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === card)
  const primary = keys.find((key) => ENGINE_PARAM_DEFINITIONS[key].module?.key === 'enabled')
  const subagents = keys.find((key) => ENGINE_PARAM_DEFINITIONS[key].module?.key === 'includeSubagents')
  const paired = primary !== undefined && subagents !== undefined ? [primary, subagents] : []
  const renderField = (key: SharedParamKey): ReactNode => (
    <EngineParamField key={`${moduleId}:${key}`} store={store} moduleId={moduleId} param={key} t={t} instanceId={instanceId} />
  )
  return <>
    {paired.length > 0 && <fieldset data-param-pair={primary} aria-label={t(`param.${primary!}`)}>{paired.map(renderField)}</fieldset>}
    {keys.filter((key) => !paired.includes(key)).map(renderField)}
  </>
}

/** 参数控件的主语：**全局层**（固定卡指令卡）或**某个模块**，二选一必填。 */
export type EngineParamSubject =
  | { moduleId: string; global?: false }
  | { global: true; moduleId?: never }

/**
 * 同一个引擎参数可以在多个位置渲染（层卡内的能力卡 + 工具管线的共享设置区，含跨层相关设置）：
 * **同一模块**的这些渲染点绑定同一份 `store.moduleParamsOf(moduleId)[param]` 与同一草稿键
 * （键里带模块 id），天然同源，不需要同步服务；不同模块的同名参数互不影响。
 * `instanceId` 只用来给每个渲染点一份独立的 DOM id / aria 关联，避免镜像控件
 * 出现重复 id 与标签错配。
 *
 * `global` = **全局层主语**（存储根 `config.yml` 的 `layerSettings`）：固定卡（指令卡）是全局段、
 * 不属于任何模块，它的设置区用这一态；读数、草稿键、写通道全部走全局，与模块主语互斥。
 *
 * 未完成的数字输入与字段错误也属于这份共享草稿：渲染点订阅同一草稿修订号后一起重渲染，
 * 因此一个渲染点里的半成品输入或错误提示会立即出现在其他渲染点，且不各留一份本地 state。
 */
export function EngineParamField({ store, param, t, instanceId, ...subject }: {
  store: PromptToolStore; param: SharedParamKey; t: PromptToolTranslate; instanceId?: string
} & EngineParamSubject): ReactNode {
  // 主语**二选一必填**（判别联合）：`moduleId`（某个模块）或 `global: true`（全局层）。
  // 「都不传」在类型层不可能——否则将来新增调用点会经 `optional` 策略静默写到全局层。
  const moduleId = subject.global === true ? undefined : subject.moduleId
  const isGlobal = subject.global === true
  const definition = ENGINE_PARAM_DEFINITIONS[param]
  const facts = isGlobal || moduleId === undefined ? undefined : moduleFactsOf(store.meta.modules, moduleId)
  // 读数与写路径都按主语：不同模块的同名参数互不影响，草稿键也带上主语。
  const value = isGlobal ? store.globalParams[param] : store.moduleParamsOf(moduleId ?? '')[param]
  const disabled = !store.fields.modulesEnabled
    || (isGlobal ? store.globalParamsLoaded !== true : facts?.editable !== true)
    || (param === 'maxDepth' && facts?.subagentToolPolicyEnabled !== true)
  const draftKey = `${isGlobal ? 'global' : moduleId}:param:${param}`
  const getDraftRevision = store.getDraftRevision ?? getZero
  useSyncExternalStore(store.subscribeDrafts ?? subscribeNothing, getDraftRevision, getDraftRevision)
  const draft = store.editorDrafts?.fields.get(draftKey)
  const draftText = draft?.text
  const error = draft !== undefined && draft.error.length > 0 ? draft.error : undefined
  const writeDraft = (next: FieldDraft | undefined): void => {
    if (next === undefined) store.editorDrafts?.fields.delete(draftKey)
    else store.editorDrafts?.fields.set(draftKey, next)
    store.publishDrafts?.()
  }
  const save = (): void => { void (isGlobal ? store.persistGlobalParams() : store.persistParamOverrides(moduleId ?? '')) }
  const patch = (next: unknown): void => {
    if (isGlobal) store.setGlobalParam(param, next)
    else store.setModuleParam(moduleId ?? '', param, next)
  }
  // 默认渲染点沿用 `pt-param-<键>`（层卡内唯一）；镜像渲染点带实例前缀，DOM id 不重复。
  const id = instanceId === undefined ? `pt-param-${param}` : `pt-param-${instanceId}-${param}`
  const label = t(`param.${param}`)
  const hint = param === 'maxDepth' ? t('param.maxDepth.hint') : param === 'instructionHint' ? t('param.instructionHint.hint') : t('param.hint', { param, label })
  const optionLabels: Record<string, string> = {
    either: t('param.option.either'),
    'tool-call': t('param.option.tool-call'),
    'assistant-message': t('param.option.assistant-message'),
  }
  const menuField = definition.kind === 'string' && definition.options !== undefined
  if (definition.kind === 'string-list') {
    return <div data-param-key={param} data-param-kind={definition.kind} data-control="list">
      <TagInput id={id} label={label} hint={hint} value={String(value ?? '')} disabled={disabled}
        onChange={patch} onCommit={save} />
    </div>
  }
  let control: ReactNode
  if (definition.kind === 'string' && definition.options !== undefined) {
    control = <MenuSelect compact ariaLabel={label} value={String(value ?? '')} disabled={disabled}
      options={[{ value: '', label: t('param.inheritPresetDefault') }, ...definition.options.map((item) => ({ value: item, label: optionLabels[item] ?? item }))]}
      onChange={(next) => { patch(next); save() }} />
  } else if (definition.kind === 'boolean') {
    control = <Switch className={styles.configEnable} checked={value === true} disabled={disabled} label={label}
      onChange={(next) => { patch(next); save() }} />
  } else if (definition.kind === 'number') {
    control = <TextInput id={id} inputMode="decimal" aria-label={label}
      aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-error`}
      value={draftText ?? String(value ?? '')} readOnly={disabled}
      onChange={(event) => writeDraft({ source: String(value ?? ''), text: event.target.value, error: '' })}
      onBlur={() => {
        if (draftText === undefined || disabled) return
        const next = draftText.trim() === '' ? definition.defaultValue : Number(draftText)
        const reason = typeof next === 'number' ? definition.check(next) : undefined
        if (reason !== undefined) {
          writeDraft({ source: String(value ?? ''), text: draftText, error: reason })
          return
        }
        patch(next)
        writeDraft(undefined)
        save()
      }} />
  } else {
    control = <textarea id={id} className={styles.configTextarea} rows={2} aria-label={label} value={String(value ?? '')}
      readOnly={disabled} onChange={(event) => patch(event.target.value)} onBlur={() => { if (!disabled) save() }} />
  }
  return <div className={styles.settingRowStack} data-param-key={param} data-param-kind={definition.kind}
    data-control={menuField ? 'select' : definition.kind === 'boolean' ? 'switch' : definition.kind === 'number' ? 'number' : 'text'}>
    <HintTooltip label={hint}><span className={styles.settingCopy}>
      <span>{label}</span>
    </span></HintTooltip>
    {control}
    {error !== undefined && <small id={`${id}-error`} role="alert">{error}</small>}
  </div>
}
