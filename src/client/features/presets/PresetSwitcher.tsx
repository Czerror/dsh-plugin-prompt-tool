/** 预设切换器：预设全部在用户目录（首次启动种子化），列表点击切换；新建 = 从内置模板复制还原。 */
import { memo, useRef, useState, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import clsx from 'clsx'
import { IconCopyOutline16, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from '../../data/bridge-client.ts'
import { readImportFiles } from '../../data/import-files.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { DialogSurface } from '../../ui/DialogSurface.tsx'
import { ImportFileButton } from '../../ui/ImportFileButton.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './presets.module.css'

const styles = { ...sharedCss, ...featureCss }

export const PresetSwitcher = memo(function PresetSwitcher(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = usePromptToolFields(store, (value) => value)
  const presets = store.meta.presets ?? []
  const templates = store.meta.builtinTemplates ?? []
  const [importing, setImporting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerAnchorRef = useRef<HTMLButtonElement>(null)

  /** 上传预设包：path 为相对路径（preset.yml 或文件夹内文件），服务端按 id 归入用户预设目录。 */
  const uploadPreset = async (entries: Array<{ path: string; content: string }>): Promise<void> => {
    if (entries.length === 0) return
    setImporting(true)
    try {
      const res = await bridgeCall('importPresetPackage', { files: entries })
      if (res.ok) {
        store.showNotice('ok', `预设 ${res.value.id} 已导入，点击卡片即可切换`)
        await store.load()
      } else {
        store.showNotice('error', '导入预设失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } finally {
      setImporting(false)
    }
  }

  /** 导入单个配置文件：preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json（服务端按扩展名分流）。 */
  const pickPresetYaml = (files: File[]): void => {
    const file = files[0]
    if (file === undefined) return
    void (async () => {
      const [entry] = await readImportFiles([file], 'text')
      if (entry === undefined) return
      await uploadPreset([{ ...entry, path: /\.json$/i.test(entry.path) ? entry.path : 'preset.yml' }])
    })()
  }

  /** 导入整个预设文件夹（webkitdirectory；传原始相对路径，顶层目录段由服务端剥离）。 */
  const pickPresetDir = (files: File[]): void => {
    if (files.length === 0) return
    void (async () => {
      await uploadPreset(await readImportFiles(files, 'text'))
    })()
  }

  /** 导出当前预设为单文件配置（浏览器下载，可保存到任意目录）。 */
  const exportPreset = async (): Promise<void> => {
    const res = await bridgeCall('exportPreset', { id: fields.presetTemplate })
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

  /** 删除预设（物理删除用户目录副本；插件目录模板保留，可经「新建预设」还原）。 */
  const deletePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetDelete', { id })
    if (res.ok) {
      setConfirmingDelete(undefined)
      store.showNotice('ok', `预设 ${id} 已删除（可经「新建预设」从内置模板还原）`)
      await store.load()
    } else {
      store.showNotice('error', '删除预设失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  /** 复制预设：用户目录完整副本，id 自动递增（<id>-copy / <id>-copy-2 / …）。 */
  const duplicatePreset = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetDuplicate', { id })
    if (res.ok) {
      store.showNotice('ok', `已复制为预设 ${res.value.id}`)
      await store.load()
    } else {
      store.showNotice('error', '复制预设失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  /** 打开预设文件夹（宿主系统文件管理器；失败时提示路径）。 */
  const openLocation = async (id: string): Promise<void> => {
    const res = await bridgeCall('presetOpen', { id })
    if (res.ok) {
      store.showNotice('ok', `已打开预设文件夹：${res.value.path}`)
    } else {
      store.showNotice('error', '打开预设文件夹失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  /** 新建：从插件目录模板复制到用户目录（还原/自定义起点）；自定义入口重名自动递增。 */
  const clonePreset = async (id: string, autoSuffix = false): Promise<void> => {
    const res = await bridgeCall('presetClone', { id, autoSuffix })
    if (res.ok) {
      setPickerOpen(false)
      store.showNotice('ok', `已从内置模板新建预设 ${res.value.id}`)
      await store.load()
    } else {
      store.showNotice('error', '新建预设失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>预设模板</strong>
          <small>预设保存在用户目录（首次启动自动内置全部模板）；点击卡片即切换并按新模板重建生成目录。删除后可从内置模板「新建」还原；导入预设 = 选择 preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json 配置文件，或整个预设文件夹。</small>
        </span>
        <span className={styles.inlineControls}>
          <button ref={pickerAnchorRef} type="button" className={styles.primaryPill} onClick={() => setPickerOpen(true)}>新建预设</button>
          <ImportFileButton
            label="导入预设"
            busyLabel="导入中…"
            busy={importing}
            accept=".yml,.yaml,.json"
            ariaLabel="选择 preset.yml / SillyTavern JSON 配置文件"
            className={styles.pillButton}
            onFiles={pickPresetYaml}
          />
          <ImportFileButton
            label="导入文件夹"
            busyLabel="导入中…"
            busy={importing}
            directory
            ariaLabel="选择预设文件夹"
            className={styles.pillButton}
            onFiles={pickPresetDir}
          />
          <button type="button" className={styles.pillButton} onClick={() => void exportPreset()}>
            导出预设
          </button>
        </span>
      </div>
      <div className={styles.presetGrid}>
        {presets.length === 0 ? (
          <p className={styles.readOnly} role="status">暂无预设；点击上方「新建预设」从内置模板创建，或「导入预设」添加。</p>
        ) : presets.map((preset) => renderCard(preset))}
      </div>
      {pickerOpen && (
        <DialogSurface title="从内置模板新建预设" closeLabel="关闭新建预设" anchorRef={pickerAnchorRef} onClose={() => setPickerOpen(false)}>
          {templates.length === 0 && <p className={styles.configFieldHint}>插件目录无内置模板。</p>}
          <button type="button" className={styles.templateModalItem} data-custom
            title="新建一份所有参数为空的自定义预设（重名自动加序号）"
            onClick={() => void clonePreset('custom', true)}>
            <strong>自定义预设</strong>
            <small>custom · 所有参数为空（空白起点，重名自动加序号）</small>
          </button>
          {templates.map((template) => (
            <button key={template.id} type="button" className={styles.templateModalItem}
              title={`新建到用户目录：${template.id}`} onClick={() => void clonePreset(template.id)}>
              <strong>{template.name}</strong>
              <small>{template.id}</small>
            </button>
          ))}
        </DialogSurface>
      )}
    </div>
  )

  function renderCard(preset: { id: string; name: string; description?: string; renderable?: boolean }): ReactNode {
    const active = fields.presetTemplate === preset.id
    const confirming = confirmingDelete === preset.id
    // 不可渲染（缺 modules/组合文件，包内也无同名模板可回退）：灰显禁切换，
    // 提示还原路径——避免点击后宿主挂载失败的哑弹。
    const blocked = preset.renderable === false
    return (
      <div key={preset.id} className={clsx(styles.presetCard, blocked && styles.presetCardBlocked)}
        data-active={active ? '' : undefined}>
        <button type="button" className={styles.presetCardMain} disabled={blocked}
          title={blocked
            ? '预设不可渲染（缺模块清单/组合文件）：可删除后经「新建预设」从内置模板还原，或检查 preset.yml'
            : active ? '当前预设模板' : `切换到 ${preset.name}`}
          onClick={() => store.setPresetTemplate(preset.id)}>
          <span className={styles.presetCardHead}>
            <strong className={styles.presetCardName}>{preset.name}</strong>
            {active && <span className={styles.presetInUse}>使用中</span>}
            {blocked && <span className={styles.presetBlocked}>不可用</span>}
          </span>
          {preset.description !== undefined && preset.description.length > 0
            && <p className={styles.presetCardDesc}>{preset.description}</p>}
          <code className={styles.presetCardId}>{preset.id}</code>
        </button>
        <span className={styles.presetCardFooter}>
          <button type="button" className={styles.presetIconButton} data-tip="复制预设"
            aria-label={`复制预设：${preset.name}`}
            onClick={() => void duplicatePreset(preset.id)}>
            <IconCopyOutline16 />
          </button>
          <button type="button" className={styles.presetIconButton} data-tip="打开预设文件夹"
            aria-label={`打开预设文件夹：${preset.name}`}
            onClick={() => void openLocation(preset.id)}>
            <IconFolderOpenOutline16 />
          </button>
          {confirming ? (
            <span className={styles.presetCardActions}>
              <button type="button" className={styles.pillButton} data-danger disabled={active}
                title="删除后可从内置模板「新建」还原" onClick={() => void deletePreset(preset.id)}>确认删除</button>
              <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(undefined)}>取消</button>
            </span>
          ) : (
            <button type="button" className={styles.pillButton} data-danger disabled={active}
              title={active ? '先切换其他预设再删除' : '删除用户目录副本（内置模板保留，可新建还原）'}
              onClick={() => setConfirmingDelete(preset.id)}>删除</button>
          )}
        </span>
      </div>
    )
  }
})
