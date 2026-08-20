/** 「预设和配置」页：预设切换/导入 + 提示词配置列表统一管理。 */
import { type ReactNode } from 'react'
import { PresetSwitcher } from './PresetSwitcher.tsx'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import type { PromptToolStore } from './prompt-tool-store.ts'

export function PresetsPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <>
      <PresetSwitcher store={store} />
      <PromptConfigsEditor
        meta={store.meta}
        configs={store.fields.promptConfigs}
        configsDir={store.fields.promptConfigsDir}
        savedConfigs={store.savedConfigs}
        savedConfigsDir={store.savedConfigsDir}
        onPatchConfigs={(configs) => store.patch({ promptConfigs: configs })}
        onPatchConfigsDir={(dir) => store.patch({ promptConfigsDir: dir })}
        onSaveConfigs={(configs) => store.persistConfigs(configs)}
        onSaveConfigsDir={(dir) => store.persistConfigsDir(dir)}
        onNotice={store.showNotice}
      />
    </>
  )
}
