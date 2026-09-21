/** 模板库加载与插入：两页共用，顶部注入模板与层内工具按钮分别提供真实锚点。 */
import { useRef, useState, type RefObject } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptConfigDraft, PromptConfigTemplateEntry } from '../../prompt-tool-types.ts'

/** 自定义工具模板条目：与提示词模板同一次 /templates 返回。 */
export type ToolTemplateEntry = { file: string; spec: Record<string, unknown> }

/** 列表作用域：决定新建配置的消息受众代入方向（过滤状态一律不动）。 */
export type TemplatePickerScope = 'main' | 'subagent'

/**
 * 由模板条目派生一条新配置草稿（纯函数：不改动任何过滤/展开状态）。
 *
 * 规则：
 * 1. id 与模板重复时追加 `-2`、`-3`… 后缀，且同名 identity 跟随新 id；
 * 2. `instruction-hint` 策略降级为 `placeholder` + `fill: instruction-hint`；
 * 3. 受众按列表作用域代入——子代理列表 → 仅子代理；主会话列表 → 清除模板自带的
 *    「仅子代理」限制（缺省 = 公用，两侧都可见），从而"新建即可见"。
 *
 * @param entry - 模板条目（来自 `/templates`）。
 * @param configs - 当前列表已有配置，用于 id 去重。
 * @param scope - 列表作用域；不传则不改动模板自带受众。
 * @returns 可直接追加进列表的新配置草稿。
 */
export function createConfigFromTemplate(
  entry: PromptConfigTemplateEntry,
  configs: readonly PromptConfigDraft[],
  scope?: TemplatePickerScope,
): PromptConfigDraft {
  const clone = JSON.parse(JSON.stringify(entry.spec)) as PromptConfigDraft
  let suffix = 2
  while (configs.some((config) => config.id === clone.id)) clone.id = `${entry.spec.id}-${suffix++}`
  if (clone.identity?.value === entry.spec.id) clone.identity = { ...clone.identity, value: clone.id }
  if (clone.strategy === 'instruction-hint') {
    clone.strategy = 'placeholder'
    clone.fill = 'instruction-hint'
  }
  if (scope === 'subagent') clone.audience = 'subagent'
  else if (scope === 'main' && clone.audience === 'subagent') clone.audience = null
  return clone
}

export function useTemplatePicker(
  configs: PromptConfigDraft[],
  onPickConfig: (config: PromptConfigDraft) => void,
  onNotice: (kind: 'ok' | 'error', message: string) => void,
  t: PromptToolTranslate,
  /** 传入列表作用域时，新建配置代入该受众，保证"新建即可见"；不传 = 不改动模板受众。 */
  scope?: TemplatePickerScope,
): {
  anchorRef: RefObject<HTMLButtonElement>
  popoverAnchorRef: RefObject<HTMLButtonElement>
  templates: PromptConfigTemplateEntry[]
  toolTemplates: ToolTemplateEntry[]
  open: boolean
  /** 当前浮层的插入点层级过滤；undefined 表示按层分组展示全部模板。 */
  layer: string | undefined
  /** 只展示工具模板（菜单「添加工具模板」入口）。 */
  toolsOnly: boolean
  createdConfigId: string | undefined
  /** 打开模板浮层；传入插入点层级时只列该层模板（无分组标题）。 */
  openPicker: (layer?: string) => void
  /** 打开只含工具模板的浮层。 */
  openTools: (anchor: HTMLButtonElement) => void
  closePicker: () => void
  pickTemplate: (entry: PromptConfigTemplateEntry) => void
} {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [toolTemplates, setToolTemplates] = useState<ToolTemplateEntry[]>([])
  const [open, setOpen] = useState(false)
  const [layer, setLayer] = useState<string | undefined>(undefined)
  const [toolsOnly, setToolsOnly] = useState(false)
  const [createdConfigId, setCreatedConfigId] = useState<string>()

  const loadTemplates = async (): Promise<void> => {
    if (templates.length > 0) return
    try {
      const res = await bridgeCall('templates')
      if (!res.ok) {
        onNotice('error', t('templates.loadFailed', { reason: res.message ?? 'settings bridge unavailable' }))
        return
      }
      if (!Array.isArray(res.value.templates)) {
        onNotice('error', t('templates.emptyList'))
        return
      }
      setTemplates(res.value.templates as PromptConfigTemplateEntry[])
      setToolTemplates((res.value.toolTemplates ?? []) as ToolTemplateEntry[])
    } catch (error) {
      onNotice('error', t('templates.loadFailed', { reason: errorMessage(error) }))
    }
  }

  const openPicker = (target?: string): void => {
    popoverAnchorRef.current = anchorRef.current
    setLayer(target)
    setToolsOnly(false)
    setOpen(true)
    void loadTemplates()
  }

  const openTools = (anchor: HTMLButtonElement): void => {
    popoverAnchorRef.current = anchor
    anchor.focus()
    setLayer(undefined)
    setToolsOnly(true)
    setOpen(true)
    void loadTemplates()
  }

  const closePicker = (): void => setOpen(false)

  const pickTemplate = (entry: PromptConfigTemplateEntry): void => {
    // 纯函数派生草稿（id 去重 + 策略降级 + 受众代入）；本 hook 只负责通知与展开信号。
    const clone = createConfigFromTemplate(entry, configs, scope)
    onPickConfig(clone)
    setCreatedConfigId(clone.id)
    onNotice('ok', t('templates.inserted', { file: entry.file, id: clone.id }))
    setOpen(false)
  }

  return { anchorRef, popoverAnchorRef, templates, toolTemplates, open, layer, toolsOnly, createdConfigId, openPicker, openTools, closePicker, pickTemplate }
}
