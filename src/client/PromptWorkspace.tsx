import { memo, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { tabKeyHandler } from './tab-key.ts'
import {
  type PromptToolStore,
  type PromptToolSettingsTransport,
  usePromptToolStore,
} from './data/use-prompt-tool-store.ts'
import type { PromptToolHostApi } from './data/host-api.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import { PromptConfigsEditor } from './PromptConfigsEditor.tsx'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import { PresetsPage } from './PresetsPage.tsx'
import { CharactersPage } from './CharactersPage.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
import { DelegationToolsModuleCard, ModelRouteModuleCard } from './EngineModuleCards.tsx'
import { SkillsSettings } from './SkillsSettings.tsx'
import { usePromptToolFields } from './data/use-prompt-tool-fields.ts'
import ui from './PromptUi.module.css'
import css from './PromptWorkspace.module.css'

function PageHeader(props: { title: string; description: string; meta?: string }): ReactNode {
  return (
    <div className={ui.pageHeader}>
      <div><h2>{props.title}</h2><p>{props.description}</p></div>
      {props.meta !== undefined && <div className={css.pageHeaderMeta}><code>{props.meta}</code></div>}
    </div>
  )
}

/** 模型路由状态 chip：主对话页与子代理页共用（检测到 DeepSeek 路由时展示 provider 列表）。 */
function ModelRouteStatus(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const detected = store.providers.length > 0
  const catalog = store.modelCatalog
  const catalogEntries = Object.entries(catalog)
  const hostModel = store.hostDefaultModel?.model
  return (
    <div className={ui.skillStatusRow} aria-label="模型服务商状态">
      <span className={clsx(ui.skillStatusChip, detected ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {detected ? `已检测到模型服务商：${store.providers.join('、')}` : '未检测到模型服务商'}
      </span>
      <span className={clsx(ui.skillStatusChip, catalogEntries.length > 0 ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {catalogEntries.length > 0
          ? `已检测到模型名：${catalogEntries.map(([provider, models]) => `${provider} → ${models.join('、')}`).join('；')}`
          : hostModel !== undefined && hostModel.length > 0
            ? `模型名：继承宿主默认（${hostModel}）`
            : '未检测到模型名'}
      </span>
    </div>
  )
}

/** 主会话页：主对话参数 + Preset/AGENTS 内容 + 管线状态卡 + 模块库（层筛选）。
 *  注入层 tab 已并入本页（层专属开关与内容资产卡片），模块库按层级下拉筛选浏览。 */
const FeatureSettings = memo(function FeatureSettings(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  return (
    <section className={ui.section} aria-label="主会话与全局">
      <ModelRouteStatus store={store} />
      <PromptConfigsEditor
        meta={store.meta}
        configs={fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        onNotice={store.showNotice}
        templateVariables={store.templateVariables}
        setTemplateVariables={store.setTemplateVariables}
        templateVariablesEnabled={store.templateVariablesEnabled}
        setTemplateVariablesEnabled={store.setTemplateVariablesEnabled}
        saveTemplateVariables={store.saveTemplateVariables}
        store={store}
        currentSessionId={store.api.currentSessionId()}
      />
    </section>
  )
})

/** 配置列表 + 新建模板：六层页按 layer 过滤，子代理页按 scope 过滤（subagent 只列子代理可见模板）。 */
const ConfigListWithTemplates = memo(function ConfigListWithTemplates(props: { store: PromptToolStore; layer?: string; scope?: 'main' | 'subagent'; beforeCards?: ReactNode }): ReactNode {
  const { store, layer, scope, beforeCards } = props
  const fields = usePromptToolFields(store, (value) => value)
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  // 当前预设模板消息批层无配置时，pre-step 层空状态追加提示（列表仍可自定义：
  // 新建配置作为 settings 覆盖层保存，切换预设后保留）。
  const preStepEmpty = store.templatePreStepCount === 0 && (layer === undefined || layer === 'pre-step')
  const templatePicker = useTemplatePicker(
    fields.promptConfigs,
    (config) => store.patch({ promptConfigs: [...fields.promptConfigs, config] }),
    store.showNotice,
  )
  return (
    <>
      <PromptConfigList
        meta={store.meta}
        configs={fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        layer={layer}
        scope={scope}
        beforeCards={beforeCards}
        emptyHint={preStepEmpty ? '当前预设模板消息批层无配置；可新建自定义配置（作为 settings 覆盖层，切换预设后仍保留）。' : undefined}
        extraActions={
          <button type="button" className={ui.primaryPill} onClick={templatePicker.openPicker}>新建</button>
        }
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        onNotice={store.showNotice}
      />
      {templatePicker.open && (
        <TemplatePicker templates={templatePicker.templates} layer={layer} onPick={templatePicker.pickTemplate} onClose={templatePicker.closePicker} />
      )}
    </>
  )
})

/** 子代理页：路由状态 + 子代理引擎模块区块（列表上方，与主会话同构）+ 子代理配置列表
 *  （audience != main 即公用或仅子代理）。子代理独有：子代理模型、工具与深度
 *  （toolFilter / allowKinds / maxDepth）；主会话引擎模块（tool-bootstrap /
 *  context-gate / 工具管线）不在此重复（避免双入口）。 */
const SubagentPage = memo(function SubagentPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  // 订阅 fields：memo 后 props 不变，靠订阅通道随 fields 变化重渲（子代理模型/工具卡数据源）。
  usePromptToolFields(store, (value) => value)
  return (
    <>
      <section className={ui.section} aria-label="子代理">
        <ModelRouteStatus store={store} />
        <div className={ui.configList}>
          <ModelRouteModuleCard store={store} scope="subagent" />
          <DelegationToolsModuleCard store={store} />
        </div>
      </section>
      <div className={ui.subagentConfigs}>
        <ConfigListWithTemplates store={store} scope="subagent" />
      </div>
    </>
  )
})

/** 技能状态筛选维度（统计条与列表联动）。 */
export interface PromptWorkspaceProps {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  controller: PromptToolWorkspaceController
  onClose: () => void
}

/** 顶层页面：注入层已并入主会话页（层专属开关 + 内容资产卡片 + 模块库层筛选）。 */
type WorkspacePage = 'subagent' | 'skills' | 'features' | 'presets' | 'characters'

const TOP_PAGES: Array<{ id: WorkspacePage; label: string }> = [
  { id: 'features', label: '主会话' },
  { id: 'subagent', label: '子代理' },
  { id: 'skills', label: '技能设置' },
  { id: 'presets', label: '预设配置' },
  { id: 'characters', label: '角色管理' },
]

/** 侧边栏独立工作台：顶层 4 页（注入层并入主会话）。 */
export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api, props.settings)
  const [page, setPage] = useState<WorkspacePage>('features')
  const open = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  ).open

  useEffect(() => {
    // 每次打开工作台都重新同步 settings（其他客户端可能已修改）。
    if (open) void store.load()
  }, [open, store.load])


  const enabledCount = store.fields.promptConfigs.filter((config) => config.enabled !== false).length
  const layerMeta = page === 'skills'
    ? `${store.fields.skillCatalog.length} 技能`
    : page === 'features'
      ? '全局'
      : page === 'presets'
        ? '预设配置'
        : page === 'characters'
          ? `${(store.meta.presets ?? []).filter((preset) => preset.meta?.source === 'sillytavern').length} 角色卡`
          : '子代理'
  const pageTitle = page === 'skills' ? '技能设置'
    : page === 'features' ? '主会话'
      : page === 'presets' ? '预设配置'
        : page === 'characters' ? '角色管理'
          : '子代理'
  const pageDetail = page === 'skills'
    ? '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。'
    : page === 'features'
      ? '主会话参数（模型设置、工具与深度）、消息批层入口开关、Preset/AGENTS 内容与提示词配置模块库（按层级筛选）。'
      : page === 'presets'
        ? '统一管理预设模板（切换/导入）与提示词配置（六层列表/模板插入/配置目录）。'
        : page === 'characters'
          ? '导入 SillyTavern 角色卡（PNG / JSON）并管理转换出的角色卡预设模块（角色设定 / 系统提示 / 开场白 / 提示词库）。'
          : '子代理作用域参数（模型/工具集/深度）与子代理提示词配置（audience 非仅主会话；子代理独立人设 = 新建配置卡：system-section + audience=subagent + 人设段，装配时替换主会话人设，无卡 = 继承主会话）。'
  // 已加载过数据时保留旧内容（顶部状态点显示「读取中」），避免切换/保存触发整区骨架屏闪烁。
  const hasData = store.meta.layers.length > 0
    || store.fields.skillCatalog.length > 0
    || store.fields.promptConfigs.length > 0

  return (
    <div className={css.shell}>
      <header className={css.masthead}>
        <div className={css.brand}>
          <span className={css.brandLogo} aria-hidden="true">⌁</span>
          <h1>提示词工具</h1>
        </div>
        <div className={css.statusCluster}>
          <span className={css.statusDot} data-state={store.loading ? 'checking' : 'online'} aria-hidden="true" />
          <span>{store.loading ? '读取中' : `${store.fields.promptConfigs.length} 配置 · ${enabledCount} 启用`}</span>
        </div>
        <button type="button" className={css.backButton} onClick={props.onClose}>返回对话</button>
      </header>

      <div className={css.topNavigation}>
        <div className={css.nav} role="tablist" aria-label="提示词工具页面">
          {TOP_PAGES.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={page === item.id} data-active={page === item.id ? '' : undefined} onClick={() => setPage(item.id)} onKeyDown={tabKeyHandler(TOP_PAGES.map((entry) => entry.id), page, setPage)}>
              <span><strong>{item.label}</strong></span>
            </button>
          ))}
        </div>
      </div>

      <main className={css.canvas}>
        <div>
          <PageHeader title={pageTitle} description={pageDetail} meta={layerMeta} />

          {store.loading && !hasData ? (
            <div className={ui.skeletonStack} aria-hidden="true">
              {[0, 1, 2, 3].map((item) => <div key={item} className={ui.skeletonRow} />)}
            </div>
          ) : page === 'skills' ? <SkillsSettings store={store} api={props.api} /> : (
            <>
              {page === 'features' && <FeatureSettings store={store} />}
              {page === 'presets' && <PresetsPage store={store} />}
              {page === 'characters' && <CharactersPage store={store} />}
              {page === 'subagent' && <SubagentPage store={store} />}
            </>
          )}

          {store.notice && <p className={clsx(ui.notice, store.noticeKind === 'error' && ui.noticeError)} role="status">{store.notice}</p>}
        </div>
      </main>
    </div>
  )
}
