import { useState, type ReactNode } from 'react'
import { bridgePost, errorMessage } from './prompt-tool-bridge.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import styles from './PromptUi.module.css'

import type { EngineMeta, PromptConfigDraft } from './prompt-tool-types.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'
export type { ValidationErrorEntry } from './prompt-tool-types.ts'
export { Field, JsonField, PromptConfigCard, PromptConfigForm, SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './PromptConfigCard.tsx'
export type { PromptConfigCardActions } from './PromptConfigCard.tsx'

export interface PromptConfigTemplateEntry {
  file: string
  content: string
  spec: PromptConfigDraft
}

interface TemplatesResult {
  ok: boolean
  templates?: PromptConfigTemplateEntry[]
  message?: string
}

export interface PromptConfigsEditorProps {
  meta: EngineMeta
  configs: PromptConfigDraft[]
  configsDir: string
  savedConfigs: PromptConfigDraft[]
  savedConfigsDir: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onPatchConfigsDir: (dir: string) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigsDir: (dir: string) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

/** 主设置页唯一保留的区块：提示词配置（目录导入 + 模板插入 + 保存前权威校验）。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [savingDir, setSavingDir] = useState(false)

  const loadTemplates = async () => {
    try {
      const res = await bridgePost<TemplatesResult>('/templates', {})
      if (res.ok) {
        if (Array.isArray(res.value.templates)) {
          setTemplates(res.value.templates)
          return
        }
        props.onNotice('error', '读取模板库失败：模板列表为空')
        return
      }
      props.onNotice('error', '读取模板库失败：' + (res.message ?? ''))
    } catch (error) {
      props.onNotice('error', '读取模板库失败：' + errorMessage(error))
    }
  }

  const applyDir = () => {
    setSavingDir(true)
    props.onSaveConfigsDir(props.configsDir.trim())
    setSavingDir(false)
  }

  const openTemplatePicker = () => {
    setTemplatePickerOpen(true)
    if (templates.length === 0) void loadTemplates()
  }

  const pickTemplate = (entry: PromptConfigTemplateEntry) => {
    if (props.configs.some((config) => config.id === entry.spec.id)) {
      props.onNotice('error', `id 已存在：${entry.spec.id}（请先改名或删除同 id 配置）`)
      return
    }
    const clone = JSON.parse(JSON.stringify(entry.spec)) as PromptConfigDraft
    props.onPatchConfigs([...props.configs, clone])
    props.onNotice('ok', `已插入模板 ${entry.file}（id=${clone.id}）`)
    setTemplatePickerOpen(false)
  }

  return (
    <section className={styles.page} aria-label="提示词配置">
      <header className={styles.pageHeader}>
        <h1>提示词配置</h1>
        <p>统一管理六个注入层级的提示词配置：内容、层级与位置全部自定义。保存前自动做引擎权威校验；同名 id 后写入者覆盖，新 id 追加。</p>
      </header>

      <section className={styles.section} aria-labelledby="prompt-tool-directory-heading">
        <div className={styles.sectionHeading}>
          <div><h2 id="prompt-tool-directory-heading">提示词配置目录</h2><p>运行时按此目录扫描 *.yml / *.yaml / *.json（优先级低于本页 settings 数组）。</p></div>
        </div>
        <div className={styles.settingRow}>
          <div className={styles.settingCopy}>
            <strong>目录路径</strong>
            <small>留空 = 不扫描目录；保存后引擎下次重建时生效。</small>
          </div>
          <div className={styles.directoryControl}>
            <input
              className={styles.directoryInput}
              aria-label="提示词配置目录"
              value={props.configsDir}
              placeholder="留空 = 不扫描目录"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => props.onPatchConfigsDir(e.target.value)}
            />
            <button type="button" className={styles.pillButton} disabled={savingDir} onClick={applyDir}>{savingDir ? '设置中…' : '设置目录'}</button>
          </div>
        </div>
      </section>

      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        extraActions={<button type="button" className={styles.primaryPill} onClick={openTemplatePicker}>新建模板</button>}
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onNotice={props.onNotice}
      />

      {templatePickerOpen && (
        <div className={styles.modalBackdrop} onClick={() => setTemplatePickerOpen(false)}>
          <div className={styles.templateModal} role="dialog" aria-modal="true" aria-label="选择内置模板" onClick={(event) => event.stopPropagation()}>
            <div className={styles.templateModalHead}>
              <strong>选择内置模板</strong>
              <button type="button" className={styles.pillButton} aria-label="关闭模板选择" onClick={() => setTemplatePickerOpen(false)}>×</button>
            </div>
            <div className={styles.templateModalList}>
              {templates.map((template) => (
                <button key={template.file} type="button" className={styles.templateModalItem} onClick={() => pickTemplate(template)}>
                  <strong>{template.file}</strong>
                  <small>{template.spec.name ?? template.spec.id}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；目录合并优先级：默认四条 &lt; promptConfigsDir &lt; settings.promptConfigs。</p>
    </section>
  )
}
