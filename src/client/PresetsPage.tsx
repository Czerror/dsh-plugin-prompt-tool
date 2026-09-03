/** 「预设和配置」页：全局开关 + 预设切换/导入 + 提示词配置列表统一管理。 */
import { memo, type ReactNode } from 'react'
import { usePromptToolFields } from './data/use-prompt-tool-fields.ts'
import { PresetSwitcher } from './PresetSwitcher.tsx'
import { ToggleRow } from './ToggleRow.tsx'
import { CollapsibleCard } from './CollapsibleCard.tsx'
import { SettingInputRow } from './SettingInputRow.tsx'
import ui from './PromptUi.module.css'
import type { PromptToolStore } from './data/use-prompt-tool-store.ts'

export const PresetsPage = memo(function PresetsPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      <section className={ui.section} aria-label="全局开关">
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-write-preset" label="全局开关" hint="预设生成总开关，作用于全部六个层级：开启时生成并刷新生成目录；关闭时清空各预设组合为空（预设保持可用，仅停止注入，工具注入随之关闭）。关闭/开启后自动重新加载模块卡片。"
            checked={fields.writePreset} onChange={() => store.toggle('writePreset')} />
        </div>
      </section>
      <CollapsibleCard id="pt-host-generated" title="AGENTS.md 与生成目录" meta="全局常驻注入、生成路径与显示顺序">
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-write-agents" label="写入 ~/.dsh/AGENTS.md" hint="保持 AGENTS.md 的全局常驻注入；关闭后不再写入，已有文件保持原样。与六层注入无关，属于宿主常驻层。"
            checked={fields.writeAgents} onChange={() => store.toggle('writeAgents')} />
        </div>
        <SettingInputRow id="pt-resident-agents-path" label="AGENTS.md 常驻路径" hint="写入/移除 AGENTS.md 受管块的目标文件；修改后下一次开关保存立即切换。"
          value={fields.residentAgentsPath} placeholder={fields.residentAgentsPath || '默认 ~/.dsh/AGENTS.md'}
          onInput={(value) => store.patch({ residentAgentsPath: value })}
          onCommit={store.persistSwitches} />
        <SettingInputRow id="pt-preset-dir" label="预设根目录" hint="预设根目录（官方 USER_PRESET_DIR）；每个预设一个官方预设目录，修改后下次写入会生成到新根，建议同时在宿主 agent-presets 设置里选择该目录。"
          value={fields.presetDir} placeholder={fields.presetDir || '默认 ~/.dsh/.agent-presets'}
          onInput={(value) => store.patch({ presetDir: value })}
          onCommit={store.persistSwitches} />
        <SettingInputRow id="pt-preset-order" label="preset 显示顺序" hint="生成 preset.yml 的 order；数值小的 preset 在宿主列表中靠前。"
          type="number" value={String(fields.presetOrder)}
          onInput={(value) => store.patch({ presetOrder: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>
      <PresetSwitcher store={store} />
    </>
  )
})
