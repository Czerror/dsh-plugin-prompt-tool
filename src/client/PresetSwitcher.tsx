/** 预设切换器：切换预设模板 + 导入自定义预设（配置页与功能设置共用）。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bridgePost } from './prompt-tool-bridge.ts'
import type { PromptToolStore } from './prompt-tool-store.ts'
import styles from './PromptUi.module.css'

export function PresetSwitcher(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const [importing, setImporting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const yamlRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLSpanElement>(null)

  // 点击菜单外部或 Esc 时关闭（菜单不阻塞页面其余操作）。
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (event: MouseEvent): void => {
      if (hostRef.current !== null && !hostRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  /** 上传预设包：path 为相对路径（preset.yml 或文件夹内文件），服务端按 id 归入用户预设目录。 */
  const uploadPreset = async (entries: Array<{ path: string; content: string }>): Promise<void> => {
    if (entries.length === 0) return
    // 预判目标 id（与服务端一致：preset.yml id 优先，否则顶层目录名），同名时先确认覆盖。
    const presetYaml = entries.find((entry) => entry.path.endsWith('preset.yml'))
    const idMatch = presetYaml?.content.match(/^id:\s*([a-zA-Z0-9][a-zA-Z0-9-]*)/m)
    const topDir = presetYaml !== undefined && presetYaml.path.includes('/')
      ? presetYaml.path.slice(0, presetYaml.path.indexOf('/'))
      : ''
    const predictedId = idMatch?.[1] ?? (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(topDir) ? topDir : undefined)
    if (predictedId !== undefined && (store.meta.presets ?? []).some((preset) => preset.id === predictedId)) {
      if (!window.confirm(`预设「${predictedId}」已存在，导入将备份旧版后覆盖。继续？`)) return
    }
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

  /** 导入单个 preset.yml 配置文件。 */
  const pickPresetYaml = (file: File | undefined): void => {
    if (file === undefined) return
    void (async () => {
      await uploadPreset([{ path: 'preset.yml', content: await file.text() }])
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

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>预设模板</strong>
          <small>切换后按新模板重建生成目录；anchored 为插件默认，另有官方标准/极简/PTC/创造四套。导入预设 = 选择 preset.yml 配置文件或整个预设文件夹。</small>
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
            accept=".yml,.yaml"
            style={{ display: 'none' }}
            aria-label="选择 preset.yml 配置文件"
            onChange={(event) => { pickPresetYaml(event.target.files?.[0]); event.target.value = '' }}
          />
          <input
            ref={dirRef}
            type="file"
            // @ts-expect-error webkitdirectory 为 Chromium 扩展属性（文件夹选择）。
            webkitdirectory=""
            style={{ display: 'none' }}
            aria-label="选择预设文件夹"
            onChange={(event) => { pickPresetDir(event.target.files); event.target.value = '' }}
          />
          <span ref={hostRef} className={styles.importMenuHost}>
            <button type="button" className={styles.primaryPill} disabled={importing} onClick={() => setMenuOpen((open) => !open)}>
              {importing ? '导入中…' : '导入预设 ▾'}
            </button>
            {menuOpen && (
              <span className={styles.importMenu} role="menu" aria-label="导入预设">
                <button type="button" role="menuitem" className={styles.importMenuItem} onClick={() => { setMenuOpen(false); yamlRef.current?.click() }}>
                  选择 preset.yml 配置文件
                </button>
                <button type="button" role="menuitem" className={styles.importMenuItem} onClick={() => { setMenuOpen(false); dirRef.current?.click() }}>
                  选择预设文件夹
                </button>
              </span>
            )}
          </span>
        </span>
      </div>
    </div>
  )
}
