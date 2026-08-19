import { useState, type ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { bridgePost, errorMessage, type BridgeSettingsView } from './prompt-tool-bridge.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import styles from './PromptUi.module.css'

import type { EngineMeta, PromptConfigDraft, ValidationErrorEntry } from './prompt-tool-types.ts'

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

type ImportValue = BridgeSettingsView

type ImportResult = { ok: true; value: ImportValue; importedCount?: number; mergedCount?: number }
  | { ok: false; code?: string; message?: string; errors?: ValidationErrorEntry[] }

export interface PromptConfigsEditorProps {
  api: IApiClient
  meta: EngineMeta
  configs: PromptConfigDraft[]
  configsDir: string
  savedConfigs: PromptConfigDraft[]
  savedConfigsDir: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onPatchConfigsDir: (dir: string) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigsDir: (dir: string) => void
  onReload: () => Promise<unknown>
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

/** 主设置页唯一保留的区块：提示词配置（目录导入 + 模板插入 + 保存前权威校验）。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [templateFile, setTemplateFile] = useState('')
  const [savingDir, setSavingDir] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importErrors, setImportErrors] = useState<ValidationErrorEntry[]>([])

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

  const importFromDirectory = async () => {
    if (importing) return
    setImporting(true)
    setImportErrors([])
    try {
      const picked = await props.api.host.pickDirectory({})
      if (!picked.result.ok) {
        props.onNotice('error', '选择目录失败：' + (picked.result.error?.message ?? 'host.pickDirectory 不可用'))
        return
      }
      const dir = picked.result.value?.path
      if (!dir) return
      const res = await bridgePost<ImportValue>('/import-directory', { dir }) as unknown as ImportResult
      if (!res.ok) {
        setImportErrors(res.errors ?? [])
        props.onNotice('error', `导入失败：${res.message ?? ''}${(res.errors?.length ?? 0) > 0 ? `（${res.errors!.length} 个错误）` : ''}`)
        return
      }
      await props.onReload()
      props.onNotice('ok', `已从目录导入 ${res.importedCount ?? 0} 条提示词配置并保存（合并后 ${res.mergedCount ?? props.configs.length} 条）`)
    } catch (error) {
      props.onNotice('error', '导入失败：' + errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  const insertTemplate = () => {
    const entry = templates.find((item) => item.file === templateFile)
    if (entry === undefined) {
      props.onNotice('error', '请先选择模板')
      return
    }
    if (props.configs.some((config) => config.id === entry.spec.id)) {
      props.onNotice('error', `id 已存在：${entry.spec.id}（请先改名或删除同 id 配置）`)
      return
    }
    const clone = JSON.parse(JSON.stringify(entry.spec)) as PromptConfigDraft
    props.onPatchConfigs([...props.configs, clone])
    props.onNotice('ok', `已插入模板 ${entry.file}（id=${clone.id}）`)
  }

  return (
    <section className={styles.page} aria-label="提示词配置">
      <header className={styles.pageHeader}>
        <h1>提示词配置</h1>
        <p>统一管理六个注入层级的提示词配置：内容、层级与位置全部自定义。保存前自动做引擎权威校验；同名 id 后写入者覆盖，新 id 追加。</p>
      </header>

      <section className={styles.section} aria-labelledby="prompt-tool-import-heading">
        <div className={styles.sectionHeading}>
          <div><h2 id="prompt-tool-import-heading">导入提示词配置</h2><p>从本地目录批量导入 *.yml / *.yaml / *.json 配置；同名 id 覆盖现有配置，新 id 追加到末尾。</p></div>
        </div>
        <div className={styles.importBar}>
          <div><strong>从目录导入</strong><small>目录内每个文件必须是单条提示词配置对象，且 id 为非空字符串。</small></div>
          <button type="button" className={styles.primaryPill} disabled={importing} onClick={() => void importFromDirectory()}>{importing ? '导入中…' : '选择目录并导入'}</button>
        </div>
        {importErrors.length > 0 && (
          <div className={styles.configErrorBox}>
            {importErrors.map((error, index) => (
              <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>
            ))}
          </div>
        )}
        <div className={styles.importBar}>
          <div><strong>内置模板</strong><small>templates/ 覆盖六层与 placeholder 数据源，插入后按需修改。</small></div>
          <select className={styles.configInput} value={templateFile} onChange={(e) => setTemplateFile(e.target.value)} onFocus={() => { if (templates.length === 0) void loadTemplates() }} aria-label="选择提示词配置模板">
            <option value="">选择模板插入…</option>
            {templates.map((template) => <option key={template.file} value={template.file}>{template.file} · {template.spec.name ?? template.spec.id}</option>)}
          </select>
          <button type="button" className={styles.pillButton} onClick={insertTemplate}>插入模板</button>
        </div>
      </section>

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
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onNotice={props.onNotice}
      />

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；目录合并优先级：默认四条 &lt; promptConfigsDir &lt; settings.promptConfigs。</p>
    </section>
  )
}
