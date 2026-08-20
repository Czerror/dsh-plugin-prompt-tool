/** 「预设和配置」页：预设切换/导入 + 提示词配置列表统一管理。 */
import { useState, type ReactNode } from 'react'
import { PresetSwitcher } from './PresetSwitcher.tsx'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import { BuiltinConfigRows } from './BuiltinConfigRows.tsx'
import type { PromptToolStore } from './prompt-tool-store.ts'

export function PresetsPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const [configFocus, setConfigFocus] = useState<{ id: string; tick: number } | undefined>(undefined)
  const requestConfigEdit = (id: string): void => {
    setConfigFocus((current) => ({ id, tick: (current?.tick ?? 0) + 1 }))
  }
  const isAnchored = store.fields.presetTemplate === 'anchored'
  return (
    <>
      <PresetSwitcher store={store} />
      {isAnchored && (
        <BuiltinConfigRows
          fields={store.fields}
          configs={store.fields.promptConfigs}
          disabled={store.loading}
          onChange={(key, value) => { if (store.fields[key] !== value) store.toggle(key) }}
          onEdit={requestConfigEdit}
        />
      )}
      <PromptConfigsEditor
        meta={store.meta}
        configs={store.fields.promptConfigs}
        configsDir={store.fields.promptConfigsDir}
        savedConfigs={store.savedConfigs}
        savedConfigsDir={store.savedConfigsDir}
        focusId={configFocus?.id}
        focusTick={configFocus?.tick}
        onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
        onPatchConfigsDir={(dir) => store.patch({ promptConfigsDir: dir })}
        onSaveConfigs={(configs) => store.persistConfigs(configs)}
        onSaveConfigsDir={(dir) => store.persistConfigsDir(dir)}
        onNotice={store.showNotice}
      />
    </>
  )
}
