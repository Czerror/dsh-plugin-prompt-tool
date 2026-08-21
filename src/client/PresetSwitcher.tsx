/** 预设切换器：切换预设模板 + 导入自定义预设（配置页与功能设置共用）。 */
import { useRef, useState, type ReactNode } from 'react'
import { bridgePost } from './prompt-tool-bridge.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'
import styles from './PromptUi.module.css'

export function PresetSwitcher(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const [importing, setImporting] = useState(false)
  const yamlRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  /** 上传预设包：path 为相对路径（preset.yml 或文件夹内文件），服务端按 id 归入用户预设目录。 */
  const uploadPreset = async (entries: Array<{ path: string; content: string }>): Promise<void> => {
    if (entries.length === 0) return
    // 同名覆盖由服务端备份旧版保护（宿主 webview 禁 window.confirm，不做原生弹窗确认）。
    setImporting(true)
    try {
      const res = await bridgePost<{ id: string }>('/import-preset-package', { files: entries })
      if (res.ok) {
        store.showNotice('ok', `预设 ${res.value.id} 已导入，可在上方切换`)
        await store.load()
      } else {
        store.showNotice('error', '导入预设失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setImporting(false)
    }
  }

  /** 导入单个配置文件：preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json（服务端按扩展名分流）。 */
  const pickPresetYaml = (file: File | undefined): void => {
    if (file === undefined) return
    void (async () => {
      const path = /\.json$/i.test(file.name) ? file.name : 'preset.yml'
      await uploadPreset([{ path, content: await file.text() }])
    })()
  }

  /** 导入整个预设文件夹（webkitdirectory；传原始相对路径，顶层目录段由服务端剥离）。 */
  const pickPresetDir = (files: FileList | null): void => {
    if (files === null || files.length === 0) return
    void (async () => {
      const entries: Array<{ path: string; content: string }> = []
      for (const file of Array.from(files)) {
        entries.push({ path: file.webkitRelativePath || file.name, content: await file.text() })
      }
      await uploadPreset(entries)
    })()
  }

  /** 导出当前预设为单文件配置（浏览器下载，可保存到任意目录）。 */
  const exportPreset = async (): Promise<void> => {
    const res = await bridgePost<{ id: string; name: string; content: string }>('/export-preset', { id: fields.presetTemplate })
    if (!res.ok) {
      store.showNotice('error', '导出预设失败：' + (res.message ?? 'settings bridge unavailable'))
      return
    }
    const blob = new Blob([res.value.content], { type: 'application/yaml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${res.value.id}.preset.yml`
    anchor.click()
    URL.revokeObjectURL(url)
    store.showNotice('ok', `已导出 ${res.value.id}.preset.yml（单文件配置，可保存到任意目录）`)
  }

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>预设模板</strong>
          <small>切换后按新模板重建生成目录；anchored 为插件默认，另有官方标准/极简/PTC/创造四套。导入预设 = 选择 preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json 配置文件，或整个预设文件夹。</small>
        </span>
        <span className={styles.inlineControls}>
          <select
            className={styles.configInput}
            aria-label="预设模板"
            value={fields.presetTemplate}
            disabled={!fields.writePreset}
            onChange={(event) => store.setPresetTemplate(event.target.value)}
          >
            {(store.meta.presets ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.id} · {preset.name}</option>
            ))}
          </select>
          <input
            ref={yamlRef}
            type="file"
            accept=".yml,.yaml,.json"
            className={styles.visuallyHidden}
            aria-label="选择 preset.yml / SillyTavern JSON 配置文件"
            onChange={(event) => { pickPresetYaml(event.target.files?.[0]); event.target.value = '' }}
          />
          <input
            ref={dirRef}
            type="file"
            // @ts-expect-error webkitdirectory 为 Chromium 扩展属性（文件夹选择）。
            webkitdirectory=""
            className={styles.visuallyHidden}
            aria-label="选择预设文件夹"
            onChange={(event) => { pickPresetDir(event.target.files); event.target.value = '' }}
          />
          <button type="button" className={styles.primaryPill} disabled={importing} onClick={() => yamlRef.current?.click()}>
            {importing ? '导入中…' : '导入预设'}
          </button>
          <button type="button" className={styles.pillButton} disabled={importing} onClick={() => dirRef.current?.click()}>
            导入文件夹
          </button>
          <button type="button" className={styles.pillButton} onClick={() => void exportPreset()}>
            导出预设
          </button>
        </span>
      </div>
    </div>
  )
}
