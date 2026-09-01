/**
 * 官方 slot 工作台：shell.overlay 左上角悬浮触发器 + 右侧抽屉 + settings.plugins.tab 基础设置。
 * 两个可见面共享同一个 PromptToolWorkspaceController，触发按钮通过 body portal
 * 落在对话界面层，几何探针只消费官方 sidebar slot 的宽度。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PromptWorkspace } from './PromptWorkspace.tsx'
import { PromptToolWorkspaceController } from './workspace-controller.ts'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import type { PromptToolHostApi } from './prompt-tool-types.ts'
import { ToggleRow } from './ToggleRow.tsx'
import { bridgePost } from './prompt-tool-bridge.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

/** 两个可见面共享的业务面（无 hooks 舱，InjectFace 原样透传成员）；几何探针不携带业务 face。 */
export interface PromptToolWorkbenchFace {
  controller: PromptToolWorkspaceController
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
}

type OverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<PromptToolWorkbenchFace>
type SidebarGeometryProps = PropsRuntime<'sidebar.footer.action'>

/** 左上角悬浮触发器：透过 body portal 落在对话界面层。 */
function FloatingTrigger(props: { controller: PromptToolWorkspaceController; triggerRef?: React.RefObject<HTMLButtonElement> }): ReactNode {
  const { controller, triggerRef } = props
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot).open
  return (
    <div className={css.floatingTriggerLayer} data-dsh-part="floating-trigger-layer">
      <button
        ref={triggerRef}
        type="button"
        className={css.floatingTrigger}
        data-open={open ? '' : undefined}
        data-dsh-plugin="prompt-tool"
        data-dsh-part="floating-trigger"
        aria-label={open ? '关闭提示词工具' : '打开提示词工具'}
        aria-pressed={open}
        title={open ? '关闭提示词工具' : '打开提示词工具'}
        onClick={() => controller.toggle()}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M6 8.5h4M8 6.5v4" />
        </svg>
      </button>
    </div>
  )
}

const SIDEBAR_WIDE_PADDING = 12
const SIDEBAR_COLLAPSED_WIDTH = 56
const FLOATING_TRIGGER_GAP = 20
const FLOATING_TRIGGER_LEFT_PROPERTY = '--pt-sidebar-edge'

/**
 * Official sidebar slot geometry bridge. The visible trigger is portaled to body
 * from the frame-wide overlay; this element only measures the real, resizable sidebar
 * edge, including the collapsed 56px rail.
 */
function SidebarGeometryProbe(props: SidebarGeometryProps): ReactNode {
  const { wide } = props
  const probeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (probe === null) return
    const setLeft = (left: number): void => {
      document.documentElement.style.setProperty(FLOATING_TRIGGER_LEFT_PROPERTY, String(Math.round(left)) + 'px')
    }
    // 向上查找第一个有实际布局尺寸的祖先：渲染锚点是 display:contents（0 尺寸），
    // 不假设宿主父节点层级（SidebarRoot footerActions 容器位置随版本变化）。
    const measuredAncestor = (): HTMLElement | undefined => {
      let node = probe.parentElement
      while (node !== null) {
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) return node
        node = node.parentElement
      }
      return undefined
    }
    const update = (): void => {
      if (!wide) {
        setLeft(SIDEBAR_COLLAPSED_WIDTH + FLOATING_TRIGGER_GAP)
        return
      }
      const target = measuredAncestor()
      if (target === undefined) return
      const rect = target.getBoundingClientRect()
      setLeft(rect.right + SIDEBAR_WIDE_PADDING + FLOATING_TRIGGER_GAP)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const measured = wide ? measuredAncestor() : undefined
    if (measured !== undefined) observer?.observe(measured)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      document.documentElement.style.removeProperty(FLOATING_TRIGGER_LEFT_PROPERTY)
    }
  }, [wide])
  return (
    <div
      ref={probeRef}
      className={css.sidebarEdgeProbe}
      aria-hidden="true"
    />
  )
}

/** shell.overlay：顶层触发器 + 右侧抽屉工作台；store 状态跨开关保留。 */
function WorkbenchDrawerSlot(props: OverlayProps): ReactNode {
  const { controller, api, settings } = props
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot).open
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); controller.close() }
    }
    // 与其他面板互斥：兼容仍在 DOM 面板上的 taskboard / ssh 事件总线。
    const onOther = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      if (detail === 'taskboard' || detail === 'ssh') controller.close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('dsh-panel-activate', onOther)
    document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'prompt-tool' }))
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('dsh-panel-activate', onOther)
    }
  }, [open, controller])
  // 关闭后焦点还给触发器（可访问性：焦点不得悬空在 body 上；经 ref 拿自己的按钮，
  // 只拿自己的按钮 ref，不触达宿主 DOM 结构。
  const triggerRef = useRef<HTMLButtonElement>(null)
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (wasOpen && !open) triggerRef.current?.focus()
  }, [open])
  const trigger = <FloatingTrigger controller={controller} triggerRef={triggerRef} />
  return (
    <>
      {typeof document === 'undefined' || document.body === null ? trigger : createPortal(trigger, document.body)}
      <div className={css.drawerLayer} data-open={open ? '' : undefined}>
        <div className={css.drawerBackdrop} onClick={() => controller.close()} aria-hidden="true" />
        <section className={css.drawerPanel} role="dialog" aria-modal="true" aria-label="提示词工具">
          <PromptWorkspace api={api} settings={settings} controller={controller} onClose={() => controller.close()} />
        </section>
      </div>
    </>
  )
}

/** settings.plugins.tab：基础开关（settings 命名空间直读直写，官方 SettingsScope 通道）。 */
type TabProps = PropsRuntime<'settings.plugins.tab'> & InjectFace<PromptToolWorkbenchFace>

function SettingsTabSlot(props: TabProps): ReactNode {
  const scope = props.settings.scope
  // useSyncExternalStore 需要稳定的函数引用；直接传方法引用会脱离 this 调用。
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const value = (snapshot.value ?? {}) as Record<string, unknown>
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  const [switchingPreset, setSwitchingPreset] = useState(false)
  const [presetNotice, setPresetNotice] = useState<{ kind: 'ok' | 'error'; message: string }>()
  useEffect(() => {
    void bridgePost<{ meta?: { presets?: Array<{ id: string; name: string }> } }>('/meta', {})
      .then((res) => { if (res.ok && res.value.meta?.presets !== undefined) setPresets(res.value.meta.presets) })
      .catch(() => {})
  }, [])
  const set = (field: string, next: unknown): void => { void scope.set(field, next) }
  const switchPreset = async (id: string): Promise<void> => {
    if (switchingPreset || id === value.presetTemplate) return
    setSwitchingPreset(true)
    setPresetNotice(undefined)
    try {
      // 先持久化默认值：Host applyState 会物化目标预设并同步 agent-presets default；
      // settlement 后再重组当前空会话，避免目标生成物尚未就绪。
      await scope.set('presetTemplate', id)
      const result = await props.api.switchPreset(id)
      if (result.applied) {
        setPresetNotice({ kind: 'ok', message: `已切换到 ${id}，当前空会话已重组。` })
      } else if (result.message !== undefined) {
        setPresetNotice({ kind: 'error', message: `默认预设已更新为 ${id}；当前会话未切换：${result.message}` })
      } else {
        setPresetNotice({ kind: 'ok', message: `默认预设已更新为 ${id}；当前没有可重组的空会话。` })
      }
    } catch (error) {
      setPresetNotice({ kind: 'error', message: `切换预设失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setSwitchingPreset(false)
    }
  }

  return (
    <section className={ui.section} aria-label="提示词工具基础设置">
      <ToggleRow id="pt-writePreset" label="生成锚定注入预设" hint="关闭后移除各预设目录的生成物，参数与内容不再物化。" checked={value.writePreset === true} onChange={(v) => set('writePreset', v)} />
      <ToggleRow id="pt-writeAgents" label="写入 AGENTS.md" hint="把常驻规则写入 ~/.dsh/AGENTS.md。" checked={value.writeAgents === true} onChange={(v) => set('writeAgents', v)} />
      <ToggleRow id="pt-injectAgentsPrompt" label="注入 AGENTS 内容到提示词" hint="用 AGENTS.md 内容替换本地 instruction-hint 的默认提示文本。" checked={value.injectAgentsPrompt === true} onChange={(v) => set('injectAgentsPrompt', v)} />
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}><strong>预设模板</strong><small>新会话默认挂载的预设；完整预设管理与提示词配置请使用左上角悬浮按钮打开工作台。</small></span>
          <select className={ui.directoryInput} aria-label="预设模板"
            value={typeof value.presetTemplate === 'string' ? value.presetTemplate : ''}
            disabled={!snapshot.writable || switchingPreset}
            onChange={(event) => { void switchPreset(event.target.value) }}>
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          {presetNotice !== undefined && (
            <p className={presetNotice.kind === 'error' ? ui.noticeError : ui.notice} role="status">
              {presetNotice.message}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** 注册官方槽位；触发器在 shell.overlay 顶层，sidebar.footer.action 只提供可拉伸宽度探针。 */
export function registerWorkbenchSlots(ctx: ClientContext, face: PromptToolWorkbenchFace): () => void {
  const disposeGeometry = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'prompt-tool-floating-geometry', order: 40,
  }, SidebarGeometryProbe))
  const disposeTab = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'prompt-tool', order: 40, label: '提示词工具', inject: () => face,
  }, SettingsTabSlot))
  const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-workbench', order: 50, inject: () => face,
  }, WorkbenchDrawerSlot))
  return () => { disposeOverlay(); disposeGeometry(); disposeTab() }
}
