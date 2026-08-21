/** 「Preset / AGENTS 内容」卡片：内容资产（preset.md / agents.md）编辑。
 *  与提示词配置解耦——不依赖模板自带 prompt-injector / instruction-hint 卡片存在，
 *  任何预设（含 minimal）都可编辑；数据存生成目录子预设（随预设隔离），不写 settings。
 *  注入关系：preset.md → pre-step prompt-injector（custom-fallback）；
 *            agents.md → agents-instruction.txt → pre-step instruction-hint。 */
import { useRef, useState, type ReactNode } from 'react'
import { CollapsibleCard } from './CollapsibleCard.tsx'
import { ToggleRow } from './ToggleRow.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import { tabKeyHandler } from './tab-key.ts'
import ui from './PromptUi.module.css'
import type { PromptToolStore } from './prompt-tool-store.ts'

type AssetScope = 'preset' | 'agents'

export function ContentAssetCard(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const [scope, setScope] = useState<AssetScope>('preset')
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isPreset = scope === 'preset'
  const text = isPreset ? fields.promptText : fields.agentsText
  const title = isPreset ? 'Preset 预设' : 'AGENTS 设置'
  const desc = isPreset
    ? 'preset.md 内容存于生成目录（.agent-presets/<模板>/preset.md），经 pre-step 的 prompt-injector 提示词配置注入；直接编辑、失焦自动保存，或「导入文件」写入；不写入 settings.yaml。'
    : 'AGENTS.md 内容存于生成目录 agents.md，经 pre-step 的 instruction-hint 提示词配置注入；直接编辑、失焦自动保存，或「导入文件」写入。'
  const pickFile = (file: File | undefined): void => {
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result ?? '')
      setImporting(true)
      void store.importPreset(scope, content).finally(() => setImporting(false))
    }
    reader.readAsText(file)
  }
  return (
    <CollapsibleCard id="pt-content-assets" title="Preset / AGENTS 内容"
      meta={`${isPreset ? 'preset.md' : 'agents.md'} · ${text.length} 字符`}>
      <div className={ui.assetTabs} role="tablist" aria-label="内容资产">
        <button type="button" role="tab" aria-selected={isPreset} data-active={isPreset ? '' : undefined} onClick={() => setScope('preset')} onKeyDown={tabKeyHandler(['preset', 'agents'] as const, scope, setScope)}>Preset 预设</button>
        <button type="button" role="tab" aria-selected={!isPreset} data-active={!isPreset ? '' : undefined} onClick={() => setScope('agents')} onKeyDown={tabKeyHandler(['preset', 'agents'] as const, scope, setScope)}>AGENTS 设置</button>
      </div>
      <p className={ui.settingCopy}><small>{desc}</small></p>
      {!isPreset && (
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-inject-agents" label="注入 AGENTS.md" hint="经 pre-step 的 instruction-hint 提示词配置注入：消息追加在决策消息末尾，每会话一次。"
            checked={fields.injectAgentsPrompt} disabled={!fields.writePreset} onChange={() => store.toggle('injectAgentsPrompt')} />
        </div>
      )}
      <div className={ui.rowGroup}>
        <label className={ui.textBlock}>
          <span className={ui.settingCopy}><strong>当前内容</strong><small>直接编辑、失焦自动保存到生成目录；导入文件后自动刷新；不写入 settings.yaml。</small></span>
          <textarea
            className={ui.firstTurnInput}
            value={text}
            disabled={!fields.writePreset}
            spellCheck={false}
            aria-label={`${title}当前内容`}
            onChange={(event) => {
              autoResizeTextarea(event)
              if (isPreset) store.patch({ promptText: event.target.value })
              else store.patch({ agentsText: event.target.value })
            }}
            onBlur={() => void store.importPreset(scope, isPreset ? fields.promptText : fields.agentsText, false)}
          />
        </label>
      </div>
      <div className={ui.sectionActions}>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt" className={ui.visuallyHidden} aria-label="选择配置文件"
          onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = '' }} />
        <button type="button" className={ui.pillButton} disabled={importing} onClick={() => fileRef.current?.click()}>
          {importing && <span className={ui.spinner} aria-hidden="true" />}
          {importing ? '导入中…' : '导入文件'}
        </button>
      </div>
      {isPreset && (
        <div className={ui.rowGroup}>
          <label className={ui.textBlock}>
            <span className={ui.settingCopy}><strong>缺省文本（preset.md 缺失时使用）</strong><small>仅当包内 preset.md 不存在或不可读时生效；修改后失焦保存。</small></span>
            <textarea
              className={ui.firstTurnInput}
              value={fields.fallbackText}
              onChange={(event) => { autoResizeTextarea(event); store.patch({ fallbackText: event.target.value }) }}
              onBlur={store.persistSwitches}
              spellCheck={false}
            />
          </label>
        </div>
      )}
    </CollapsibleCard>
  )
}
