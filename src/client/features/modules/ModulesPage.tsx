/** 「模块」页：模块的列表与管理（切换 / 新建 / 复制 / 导出 / 删除 / 打开目录 / 导入）+
 *  生成开关与顺序 + 角色卡素材（并入当前模块 / 移除）。
 *
 *  这一页由原来的「预设配置」页与「角色管理」页合并而成：模块统一了载体与库成员两种身份，
 *  所以列表、导入、并入、移除、删除与新建/复制/导出属于同一件事，不再分成两页两套列表。
 *  页 id 用 `modules`（已进 DOM 契约，见 WorkspaceNavigation/WorkspaceFrame）。
 *
 *  两页原有差异里只有卡体语义被收敛：预设卡的整块点击取消，激活改为底部按钮，
 *  与角色卡同形（卡体只是内容，动作全在卡脚）。数据源、状态维度与各自的端点仍然分开，
 *  不为了「看起来统一」把角色卡的 `charactersList` 端点搬进 store。 */
import { memo, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { PresetSwitcher } from '../presets/PresetSwitcher.tsx'
import { CharactersPage } from '../characters/CharactersPage.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { SettingInputRow } from '../../ui/SettingInputRow.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from '../presets/presets.module.css'

const ui = { ...sharedCss, ...featureCss }
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'

export const ModulesPage = memo(function ModulesPage(
  props: { store: PromptToolStore; t: PromptToolTranslate; onReady?: () => void },
): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      {!fields.writePreset && <p className={ui.configFieldHint}>{t('configs.readOnly.disabled')}</p>}
      <PresetSwitcher store={store} t={t} />
      <section className={ui.section} aria-label={t('presets.aria')}>
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-write-preset" label={t('presets.writePreset.label')} hint={t('presets.writePreset.hint')}
            checked={fields.writePreset} onChange={() => store.toggle('writePreset')} />
        </div>
      </section>
      <CollapsibleCard id="pt-host-generated" title={t('presets.agents.title')} meta={t('presets.agents.meta')}>
        <SettingInputRow id="pt-preset-order" label={t('presets.order.label')} hint={t('presets.order.hint')}
          type="number" value={String(fields.presetOrder)}
          onInput={(value) => store.patch({ presetOrder: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>
      <CharactersPage store={store} t={t} onReady={props.onReady} />
    </>
  )
})
