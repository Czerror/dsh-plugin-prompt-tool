import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { PromptConfigList } from './PromptConfigList.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
import { VariablesEditor } from './PromptConfigCard.tsx'
import { EngineModuleCards, ModelRouteModuleCard } from './EngineModuleCards.tsx'
import { bridgePost } from './prompt-tool-bridge.ts'
import styles from './PromptUi.module.css'

import type { EngineMeta, PromptConfigDraft } from './prompt-tool-types.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'
export type { ValidationErrorEntry } from './prompt-tool-types.ts'
export { Field, JsonField, PromptConfigCard, PromptConfigForm, SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './PromptConfigCard.tsx'
export type { PromptConfigCardActions } from './PromptConfigCard.tsx'
export type { PromptConfigTemplateEntry } from './prompt-tool-types.ts'

export interface PromptConfigsEditorProps {
  meta: EngineMeta
  configs: PromptConfigDraft[]
  savedConfigs: PromptConfigDraft[]
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
  /** 预设级模板变量（preset.yml 顶层 variables 段；编辑入口与模块列表统一）。 */
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>) => Promise<void>
  /** 引擎模块配置（tool-bootstrap 等组合行 config 卡片，同模块列表形态）。 */
  store: PromptToolStore
}

/** 预设级模板变量模块卡片（归类于配置列表下）：{{key}} 插值源，非 promptConfig——
 *  不进配置保存路径，保存走 /preset-variables 写 preset.yml 顶层 variables 段。
 *  可折叠（chevron）/ 可删除（清空全部变量，两段式确认）/ 可新建（VariablesEditor 添加变量）。 */
function TemplateVariablesModuleCard(props: {
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>) => Promise<void>
  expanded: boolean
  onToggleExpanded: () => void
}): ReactNode {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const count = Object.keys(props.templateVariables).length
  const enabled = props.templateVariablesEnabled
  // 无变量时不显示卡片（模块列表恢复干净；「新建 → Variables」添加空行后自动出现）。
  if (count === 0) return null
  const clearAll = (): void => {
    props.setTemplateVariables({})
    void props.saveTemplateVariables({})
    setConfirmingDelete(false)
    if (props.expanded) props.onToggleExpanded()
  }
  /** 失焦自动保存：焦点离开卡片容器（含收起/切换开关/点击删除）即持久化。 */
  const autoSaveOnBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    if (next === null || !cardRef.current?.contains(next as Node)) {
      void props.saveTemplateVariables()
    }
  }
  return (
    <article ref={cardRef} className={styles.configCard} onBlur={autoSaveOnBlur}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>模板变量</span>
            <span className={styles.configMeta}>{`预设级 {{key}} 插值 · ${count} 个变量`}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <label className={styles.configEnable} title={enabled ? '点击停用模板变量插值' : '点击启用模板变量插值'}>
            <input
              type="checkbox"
              aria-label="启用模板变量插值"
              checked={enabled}
              onChange={(e) => {
                props.setTemplateVariablesEnabled(e.target.checked)
                void props.saveTemplateVariables()
              }}
            />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <span className={styles.configActions}>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={clearAll}>确认清空</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>删除</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          {!enabled && <p className={styles.configFieldHint}>{'模板变量插值已停用：{{key}} 将不再被替换（预设级变量文件不生成）。'}</p>}
          <VariablesEditor value={props.templateVariables} onChange={(next) => props.setTemplateVariables(next ?? {})} />
        </div>
      )}
    </article>
  )
}

/** 自定义工具模块卡片（归类于配置列表下）：preset.yml 顶层 customTools 段。
 *  自管理读写（/custom-tools）：展开时加载，JSON 编辑整个定义数组后保存，
 *  写盘触发重建（tool-config-engine 渲染 custom-tools/ 并运行时注册）。 */
function CustomToolsModuleCard(props: {
  expanded: boolean
  onToggleExpanded: () => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}): ReactNode {
  const [customTools, setCustomTools] = useState<unknown[]>([])
  const [draft, setDraft] = useState('')
  const [builtinTools, setBuiltinTools] = useState<Record<string, unknown>>({})
  const [builtinDraft, setBuiltinDraft] = useState('{}')
  const [toolTemplates, setToolTemplates] = useState<Array<{ file: string; spec: Record<string, unknown> }>>([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (loaded || !props.expanded) return
    void (async () => {
      const [customResult, builtinResult, templatesResult] = await Promise.all([
        bridgePost<{ customTools?: unknown[] }>('/custom-tools', {}),
        bridgePost<{ builtinTools?: Record<string, unknown> }>('/builtin-tools', {}),
        bridgePost<{ toolTemplates?: Array<{ file: string; spec: Record<string, unknown> }> }>('/templates', {}),
      ])
      const list = customResult.ok ? customResult.value?.customTools ?? [] : []
      const builtin = builtinResult.ok ? builtinResult.value?.builtinTools ?? {} : {}
      const templates = templatesResult.ok ? templatesResult.value?.toolTemplates ?? [] : []
      setCustomTools(list)
      setDraft(JSON.stringify(list, null, 2))
      setBuiltinTools(builtin)
      setBuiltinDraft(JSON.stringify(builtin, null, 2))
      setToolTemplates(templates)
      setLoaded(true)
    })()
  }, [props.expanded, loaded])
  const count = customTools.length
  const builtinCount = Object.keys(builtinTools).length
  const save = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (error) {
      props.onNotice('error', `自定义工具 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!Array.isArray(parsed)) {
      props.onNotice('error', '自定义工具必须是数组')
      return
    }
    let builtinParsed: unknown
    try {
      builtinParsed = JSON.parse(builtinDraft)
    } catch (error) {
      props.onNotice('error', `内置工具配置 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (builtinParsed === null || typeof builtinParsed !== 'object' || Array.isArray(builtinParsed)) {
      props.onNotice('error', '内置工具配置必须是对象')
      return
    }
    setSaving(true)
    void Promise.all([
      bridgePost<{ customTools?: unknown[] }>('/custom-tools', { customTools: parsed }),
      bridgePost<{ builtinTools?: Record<string, unknown> }>('/builtin-tools', { builtinTools: builtinParsed }),
    ]).then(([customResult, builtinResult]) => {
      setSaving(false)
      if (customResult.ok && builtinResult.ok) {
        setCustomTools(parsed)
        setBuiltinTools(builtinParsed as Record<string, unknown>)
        props.onNotice('ok', `已保存 ${parsed.length} 个自定义工具 + 内置工具配置（已重建）`)
      } else {
        const failed = customResult.ok ? builtinResult : customResult
        props.onNotice('error', ('message' in failed ? failed.message : undefined) ?? '保存失败')
      }
    })
  }
  const insertTemplate = (spec: Record<string, unknown>): void => {
    try {
      const current = JSON.parse(draft) as unknown[]
      if (!Array.isArray(current)) {
        props.onNotice('error', '当前自定义工具不是数组，无法插入模板')
        return
      }
      if (current.some((entry) => (entry as { id?: unknown } | null)?.id === spec.id)) {
        props.onNotice('error', `工具 id 已存在：${String(spec.id)}`)
        return
      }
      const clone = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>
      setDraft(JSON.stringify([...current, clone], null, 2))
      props.onNotice('ok', `已插入工具模板 ${spec.id}（保存后生效）`)
      setShowTemplates(false)
    } catch (error) {
      props.onNotice('error', `插入模板失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <article className={styles.configCard}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>自定义工具</span>
            <span className={styles.configMeta}>{`${count} 个自定义 · ${builtinCount} 组内置`}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          <p className={styles.configFieldHint}>
            {'preset.yml 顶层 customTools 段；执行器 shell / http / delegate / fs / ask-user，参数引用 {{args.x}}。坏定义引擎跳过并告警。'}
          </p>
          <textarea
            className={styles.configTextarea}
            rows={12}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="自定义工具定义 JSON"
            spellCheck={false}
          />
          <div className={styles.configActions}>
            <button type="button" className={styles.pillButton} onClick={() => setShowTemplates(!showTemplates)}>
              从模板新建
            </button>
            <button type="button" className={styles.primaryPill} disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
          {showTemplates && (
            <ul className={styles.configActions} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              {toolTemplates.length === 0 && <li className={styles.configFieldHint}>模板库为空</li>}
              {toolTemplates.map((template) => (
                <li key={template.file}>
                  <button type="button" className={styles.pillButton} onClick={() => insertTemplate(template.spec)}>
                    {template.file.replace(/\.ya?ml$/i, '')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.configFieldHint}>{'内置工具注册配置（preset.yml builtinTools 段）：'}</p>
          <textarea
            className={styles.configTextarea}
            rows={5}
            value={builtinDraft}
            onChange={(event) => setBuiltinDraft(event.target.value)}
            aria-label="内置工具注册配置 JSON"
            spellCheck={false}
          />
          <p className={styles.configFieldHint}>
            {'内置工具：character（角色卡 5 工具）/ world_book（世界书 3 工具）/ session_var（1 工具）。'}
            {'enabled=false 不注册；name 覆盖组前缀（character_list → <name>_list）；description 覆盖整组描述。'}
          </p>
        </div>
      )}
    </article>
  )
}

/** 提示词配置编辑器：配置列表（层级/策略过滤已并入列表）+ 模板插入 + 保存前权威校验。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const [templateVarsExpanded, setTemplateVarsExpanded] = useState(false)
  const [customToolsExpanded, setCustomToolsExpanded] = useState(false)
  /** 层筛选状态（模块列表下拉联动引擎模块卡：选中层只显示该层引擎模块）。 */
  const [layerFilter, setLayerFilter] = useState('all')
  const templatePicker = useTemplatePicker(
    props.configs,
    (config) => props.onPatchConfigs([...props.configs, config]),
    props.onNotice,
  )
  /** 「新建 → Variables」：展开模板变量卡片并添加一个待编辑空行。 */
  const pickVariables = (): void => {
    props.setTemplateVariables({ ...props.templateVariables, '': '' })
    setTemplateVarsExpanded(true)
    templatePicker.closePicker()
  }
  return (
    <section className={styles.page} aria-label="提示词配置">
      <div className={styles.configList}>
        <ModelRouteModuleCard store={props.store} scope="main" />
        <EngineModuleCards store={props.store} layerFilter={layerFilter} />
      </div>
      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        viewFilter={layerFilter}
        onViewFilterChange={setLayerFilter}
        extraActions={<button type="button" className={styles.primaryPill} onClick={templatePicker.openPicker}>新建</button>}
        beforeCards={
          <>
            <CustomToolsModuleCard
              expanded={customToolsExpanded}
              onToggleExpanded={() => setCustomToolsExpanded(!customToolsExpanded)}
              onNotice={props.onNotice}
            />
            <TemplateVariablesModuleCard
              templateVariables={props.templateVariables}
              setTemplateVariables={props.setTemplateVariables}
              templateVariablesEnabled={props.templateVariablesEnabled}
              setTemplateVariablesEnabled={props.setTemplateVariablesEnabled}
              saveTemplateVariables={props.saveTemplateVariables}
              expanded={templateVarsExpanded}
              onToggleExpanded={() => setTemplateVarsExpanded(!templateVarsExpanded)}
            />
          </>
        }
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onNotice={props.onNotice}
      />

      {templatePicker.open && (
        <TemplatePicker
          templates={templatePicker.templates}
          onPick={templatePicker.pickTemplate}
          onPickVariables={pickVariables}
          onClose={templatePicker.closePicker}
        />
      )}

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；外部提示词配置可经「预设配置 → 导入预设」引入。</p>
    </section>
  )
}
