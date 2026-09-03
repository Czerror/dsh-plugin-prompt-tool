import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { bridgeCall } from '../../data/bridge-client.ts'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import ui from '../../PromptUi.module.css'
/** settings.plugins.tab：基础开关（settings 命名空间直读直写，官方 SettingsScope 通道）。 */
type TabProps = PropsRuntime<'settings.plugins.tab'> & InjectFace<PromptToolWorkbenchFace>

export function SettingsTab(props: TabProps): ReactNode {
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
    void bridgeCall('meta')
      .then((res) => {
        if (!res.ok) return
        const meta = res.value.meta as { presets?: Array<{ id: string; name: string }> }
        if (meta.presets !== undefined) setPresets(meta.presets)
      })
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
