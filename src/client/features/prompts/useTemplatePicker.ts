/** 模板库加载 + 插入共享逻辑：主会话合并创建菜单与各配置列表页（子代理）共用。 */
import { useRef, useState, type RefObject } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import type { PromptConfigDraft, PromptConfigTemplateEntry } from '../../prompt-tool-types.ts'

/** 自定义工具模板条目：与提示词模板同一次 /templates 返回。 */
export type ToolTemplateEntry = { file: string; spec: Record<string, unknown> }

export function useTemplatePicker(
  configs: PromptConfigDraft[],
  onPickConfig: (config: PromptConfigDraft) => void,
  onNotice: (kind: 'ok' | 'error', message: string) => void,
): {
  anchorRef: RefObject<HTMLButtonElement>
  templates: PromptConfigTemplateEntry[]
  toolTemplates: ToolTemplateEntry[]
  open: boolean
  /** 当前浮层的插入点层级过滤；undefined 表示按层分组展示全部模板。 */
  layer: string | undefined
  /** 只展示工具模板（菜单「添加工具模板」入口）。 */
  toolsOnly: boolean
  /** 打开模板浮层；传入插入点层级时只列该层模板（无分组标题）。 */
  openPicker: (layer?: string) => void
  /** 打开只含工具模板的浮层。 */
  openTools: () => void
  closePicker: () => void
  pickTemplate: (entry: PromptConfigTemplateEntry) => void
} {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [toolTemplates, setToolTemplates] = useState<ToolTemplateEntry[]>([])
  const [open, setOpen] = useState(false)
  const [layer, setLayer] = useState<string | undefined>(undefined)
  const [toolsOnly, setToolsOnly] = useState(false)

  const loadTemplates = async (): Promise<void> => {
    if (templates.length > 0) return
    try {
      const res = await bridgeCall('templates')
      if (!res.ok) {
        onNotice('error', '读取模板库失败：' + (res.message ?? 'settings bridge unavailable'))
        return
      }
      if (!Array.isArray(res.value.templates)) {
        onNotice('error', '读取模板库失败：模板列表为空')
        return
      }
      setTemplates(res.value.templates as PromptConfigTemplateEntry[])
      setToolTemplates((res.value.toolTemplates ?? []) as ToolTemplateEntry[])
    } catch (error) {
      onNotice('error', '读取模板库失败：' + errorMessage(error))
    }
  }

  const openPicker = (target?: string): void => {
    setLayer(target)
    setToolsOnly(false)
    setOpen(true)
    void loadTemplates()
  }

  const openTools = (): void => {
    setLayer(undefined)
    setToolsOnly(true)
    setOpen(true)
    void loadTemplates()
  }

  const closePicker = (): void => setOpen(false)

  const pickTemplate = (entry: PromptConfigTemplateEntry): void => {
    if (configs.some((config) => config.id === entry.spec.id)) {
      onNotice('error', `id 已存在：${entry.spec.id}（请先改名或删除同 id 配置）`)
      return
    }
    const clone = JSON.parse(JSON.stringify(entry.spec)) as PromptConfigDraft
    onPickConfig(clone)
    onNotice('ok', `已插入模板 ${entry.file}（id=${clone.id}）`)
    setOpen(false)
  }

  return { anchorRef, templates, toolTemplates, open, layer, toolsOnly, openPicker, openTools, closePicker, pickTemplate }
}
