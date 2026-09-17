import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PromptConfigCard } from '../../src/client/features/prompts/PromptConfigCard.tsx'
import { EngineModuleCard } from '../../src/client/ui/EngineModuleCard.tsx'
import { CollapsibleCard } from '../../src/client/ui/CollapsibleCard.tsx'
import { HintTooltip } from '../../src/client/ui/HintTooltip.tsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
const fields = new Map()
window.fieldDrafts = fields
window.events = { saved: 0, reloaded: 0, deleted: 0, outerEscape: 0 }
function App() {
  const [visible, setVisible] = useState(true)
  const [hasOrdinary, setHasOrdinary] = useState(true)
  const [readOnly, setReadOnly] = useState(false)
  const [capabilityOpen, setCapabilityOpen] = useState(false)
  const [expanded, setExpanded] = useState({ ordinary: true, file: true })
  const [ordinary, setOrdinary] = useState({ id: 'ordinary', name: '普通配置', layer: 'pre-step', strategy: 'static', order: 2, params: { nested: true }, sourceKind: 'preset' })
  const [file, setFile] = useState({ id: 'file', name: 'AGENTS.md', layer: 'pre-step', strategy: 'placeholder', fill: 'instruction-hint', sourceKind: 'instruction-file', origin: { kind: 'instruction-file', fileId: 'file1' }, params: { fileId: 'file1', file: 'AGENTS.md' }, text: 'disk', contentStatus: 'ready' })
  window.currentConfig = ordinary
  window.currentFile = file
  window.setConflict = (value) => setFile((prev) => ({ ...prev, contentConflict: value }))
  window.setSaving = (value) => setFile((prev) => ({ ...prev, contentSaving: value }))
  window.setReadOnly = setReadOnly
  window.patchOrdinary = (patch) => setOrdinary((prev) => ({ ...prev, ...patch }))
  const common = {
    t, meta: window.fixture.meta, canMoveUp: false, canMoveDown: true, fieldDrafts: fields, draftScope: 'preset-test',
    onToggleExpanded: (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })),
    onToggleEnabled: () => {}, onMoveUp: () => {}, onMoveDown: () => {}, onDuplicate: () => {},
  }
  return React.createElement('main', { onKeyDown: (event) => { if (event.key === 'Escape') window.events.outerEscape++ } },
    React.createElement('button', { id: 'switch-page', onClick: () => setVisible(!visible) }, '切页'),
    React.createElement(EngineModuleCard, { name: '纯开关', meta: '静态能力', topSwitch: { id: 'compact', label: '启用纯开关', hint: '帮助', checked: true, onToggle() {} } }),
    visible && React.createElement(EngineModuleCard, { name: '可控能力', meta: '参数', anchorId: 'controlled', expanded: capabilityOpen, onExpandedChange: setCapabilityOpen }, React.createElement('input', { 'aria-label': '能力字段' })),
    React.createElement(CollapsibleCard, { id: 'basic', title: '普通折叠' }, React.createElement('input', { 'aria-label': '折叠内容' })),
    visible && hasOrdinary && React.createElement(PromptConfigCard, { ...common, config: ordinary, expanded: expanded.ordinary, disabled: readOnly, readOnlyReason: readOnly ? '只读预设' : undefined,
      onPatch: (_, patch) => setOrdinary((prev) => ({ ...prev, ...patch })),
      onDelete: async () => {
        window.events.deleted++
        await new Promise((resolve) => setTimeout(resolve, 80))
        if (window.failDelete) throw new Error('删除失败，草稿保留')
        setHasOrdinary(false)
      },
    }),
    visible && React.createElement(PromptConfigCard, { ...common, config: file, expanded: expanded.file,
      onPatch: (_, patch) => setFile((prev) => ({ ...prev, ...patch, contentDirty: true })), onDelete() {},
      onSaveInstructionFile: () => { window.events.saved++; window.savedText = window.currentFile.text },
      onReloadInstructionFile: async () => { window.events.reloaded++; if (window.failReload) throw new Error('读取失败'); setFile((prev) => ({ ...prev, text: 'fresh disk', contentDirty: false, contentConflict: false })) },
      onPatchInstructionPolicy() {},
    }),
    React.createElement('button', { id: 'outside' }, '下一张卡'),
    React.createElement(HintTooltip, { label: '官方开关帮助' }, React.createElement(Switch, { checked: true, label: '测试官方开关', onChange() {} })))
}
createRoot(document.getElementById('root')).render(React.createElement(App))
