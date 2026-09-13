import type { PromptToolLocaleKey } from '../../locales.ts'

export type WorkspacePage = 'features' | 'subagent' | 'tools' | 'skills' | 'presets' | 'characters'

/**
 * 六页定义：只存字典键，文案在渲染时经翻译函数求值（语言切换跟随刷新）。
 * 页面 id 是稳定契约（tab/panel 的 DOM id 依赖它），不参与翻译。
 */
export const WORKSPACE_PAGES: ReadonlyArray<{
  id: WorkspacePage
  labelKey: PromptToolLocaleKey
  titleKey: PromptToolLocaleKey
  detailKey: PromptToolLocaleKey
}> = [
  {
    id: 'features',
    labelKey: 'page.features.label',
    titleKey: 'page.features.title',
    detailKey: 'page.features.detail',
  },
  {
    id: 'subagent',
    labelKey: 'page.subagent.label',
    titleKey: 'page.subagent.title',
    detailKey: 'page.subagent.detail',
  },
  {
    id: 'tools',
    labelKey: 'page.tools.label',
    titleKey: 'page.tools.title',
    detailKey: 'page.tools.detail',
  },
  {
    id: 'skills',
    labelKey: 'page.skills.label',
    titleKey: 'page.skills.title',
    detailKey: 'page.skills.detail',
  },
  {
    id: 'presets',
    labelKey: 'page.presets.label',
    titleKey: 'page.presets.title',
    detailKey: 'page.presets.detail',
  },
  {
    id: 'characters',
    labelKey: 'page.characters.label',
    titleKey: 'page.characters.title',
    detailKey: 'page.characters.detail',
  },
]

export const WORKSPACE_PAGE_IDS = WORKSPACE_PAGES.map((page) => page.id)
export const workspacePageMeta = (id: WorkspacePage) => WORKSPACE_PAGES.find((page) => page.id === id)!
