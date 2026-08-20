/** 「预设和配置」页：全局开关 + 预设切换/导入 + 提示词配置列表统一管理。 */
import { type ReactNode } from 'react'
import { PresetSwitcher } from './PresetSwitcher.tsx'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import { ToggleRow } from './ToggleRow.tsx'
import ui from './PromptUi.module.css'
import type { PromptToolStore } from './prompt-tool-store.ts'

export function PresetsPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <>
      <section className={ui.section} aria-labelledby="pt-global-switch">
        <div className={ui.sectionHeading}><div><h2 id="pt-global-switch">全局开关</h2><p>预设生成总开关：关闭时移除生成目录，各层锚定开关随之失效；切换后自动重新加载模块卡片。</p></div></div>
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-write-preset" label="全局开关" hint="预设生成总开关，作用于全部六个层级：开启时生成并刷新生成目录；关闭时移除生成目录。关闭/开启后自动重新加载模块卡片。"
            checked={store.fields.writePreset} onChange={() => store.toggle('writePreset')} />
        </div>
      </section>
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
