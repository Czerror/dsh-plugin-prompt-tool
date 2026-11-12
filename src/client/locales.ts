/**
 * 提示词工具 UI 文案字典（官方 locale 命名空间 `prompt-tool`）。
 *
 * 约定：
 * - 只放用户可见文案；provider/model id、文件路径、用户内容、协议 code 不进字典。
 * - zh 是唯一事实源：键类型由它派生，en 用 Record<Key, string> 强制键集一致
 *   （缺键/多键都是编译错误，等价于官方类型化 register 的运行时校验）。
 * - 渲染时经 {@link Translate} 求值（调用时读当前语言），不在模块顶层缓存译文。
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { PARAMS_EN, PARAMS_ZH } from './locales-params.ts'
import { PROMPTS_EN, PROMPTS_ZH } from './locales-prompts.ts'
import { CARDS_EN, CARDS_ZH } from './locales-cards.ts'
import { TRIGGERS_EN, TRIGGERS_ZH } from './locales-triggers.ts'
import { RULES_EN, RULES_ZH } from './locales-rules.ts'
import { PROMPT_TOOL_NS } from '../shared/namespace.ts'

/** 官方 locale 服务注册用的命名空间（与 settings 共用同一字面量真源）。 */
export { PROMPT_TOOL_NS }

const ZH_CORE = {
  'rewind.label': '回退已发送内容',
  'rewind.once': '回退一次',
  'rewind.round': '回退上一轮',
  'rewind.done': '回退已提交。',
  'rewind.retry': '仅重试失败目标',
  'rewind.retryRequest': '重试原提交（结果尚未确认）',
  'rewind.restoreFailed': '回退已提交，但回填未完成；可取回原输入。',
  'rewind.recover': '取回回退文本（当前草稿已保留）',
  'rewind.unavailable': '当前页面不支持安全回退，请刷新页面。',
  'app.title': '提示词工具',
  'app.backToChat': '返回对话',
  'app.loading': '读取中',
  'app.statusRules': '{enabled}/{total} 规则',
  'app.statusModules': '{enabled}/{total} 模块',
  'app.statusUnavailable': '{count} 不可用',
  'app.open': '打开提示词工具',
  'app.close': '关闭提示词工具',
  'app.panelAria': '提示词工具',
  'nav.aria': '提示词工具页面',

  'settings.saveRejected': '设置未保存，请检查当前权限或重新读取后重试。',

  'page.features.label': '主会话',
  'page.subagent.label': '子代理',
  'page.tools.label': '工具预览',
  'page.modules.label': '模块',

  'main.aria': '主会话与全局',
  'main.addTemplate': '添加模板 · {layer}',
  'main.addToolTemplate': '添加工具模板…',
  'main.newBlankTool': '新建空白工具',
  'subagent.aria': '子代理',
  'configList.create': '新建',

  'tools.aria': '工具预览',
  'tools.search.aria': '搜索工具',
  'tools.search.placeholder': '搜索工具名或描述',
  'tools.surface.session': '当前会话工具',
  'tools.surface.preset': '官方预设工具能力',
  'tools.surface.source.aria': '官方预设来源',
  'tools.surface.source.placeholder': '选择官方预设',
  'tools.loadingPresets': '正在读取官方预设…',
  'tools.loadFailed': '官方预设列表读取失败',
  'tools.noPresets': '暂无可用官方预设。',
  'tools.surface.sourceLabel': '工具面',
  'tools.surface.count': '显示 {visible} / {total} 个工具',
  'tools.surface.emptySource': '该来源暂无可见工具。',
  'tools.surface.emptyFilter': '无匹配工具，请调整搜索。',
  'tools.surface.list.aria': '模型可见工具',
  'tools.surface.card.aria': '查看工具 {name}',
  'tools.surface.badge.visible': '模型可见',
  'tools.surface.detail.name': '完整名称',
  'tools.surface.detail.from': '来自',
  'tools.surface.detail.status': '可见状态',
  'tools.surface.detail.description': '工具描述',
  'tools.surface.detail.noDescription': '（无描述）',
  'tools.surface.sub.count': '{count} 个',
  'tools.surface.noSession': '尚未选择当前会话；不会自动创建或恢复会话。',
  'tools.surface.noPreset': '请选择模块后读取工具能力。',
  'tools.surface.origin': '来源：',
  'tools.surface.refresh': '刷新工具',
  'tools.surface.loading': '正在读取工具…',
  'tools.surface.readFailed': '工具面读取失败',
  'tools.surface.retrySuffix': '；可刷新重试。',
  'tools.surface.note.session': '刷新不升级既有会话的 generation，也不会自动 resume 会话。',
  'tools.surface.note.preset': '模块能力不代表当前会话；修改模块不替换既有会话的冻结 generation。',

  'modules.globalSwitch': '全局开关',
  'moduleOrder.current': '返回当前模块',
  'moduleOrder.all': '跨模块排序',
  'moduleOrder.hint': '排列已启用模块中当前受众可见的配置；拖拽、上下移或使用拖动按钮的上下方向键，修改后自动保存。编辑内容请切回当前模块。',
  'moduleOrder.refresh': '刷新排序',
  'moduleOrder.discardRefresh': '放弃未保存排序并刷新',
  'moduleOrder.empty': '已启用模块中没有符合当前受众和筛选的配置卡。',
  'moduleOrder.disabled': '此配置卡已停用',
  'moduleOrder.unavailable': '排序服务不可用',
  'moduleOrder.readFailed': '读取排序失败：{reason}',
  'moduleOrder.saveFailed': '排序保存失败，调整已保留：{reason}',
  'moduleOrder.refreshFailed': '排序已保存，但配置刷新失败，请刷新后再编辑。',

  'moduleSwitcher.new': '新建模块',
  'moduleSwitcher.import': '导入模块',
  'moduleSwitcher.importing': '导入中…',
  'moduleSwitcher.import.aria': '选择 module.yml / SillyTavern JSON 配置文件',
  'moduleSwitcher.importDir': '导入文件夹',
  'moduleSwitcher.importDir.aria': '选择模块文件夹',
  'moduleSwitcher.export': '导出模块',
  'moduleSwitcher.export.aria': '导出模块：{name}',
  'moduleSwitcher.empty': '暂无模块；点击上方「新建模块」创建，或「导入模块」添加。',
  'moduleSwitcher.dialog.title': '新建模块',
  'moduleSwitcher.dialog.close': '关闭新建模块',
  'moduleSwitcher.dialog.noTemplates': '插件目录无内置模板。',
  'moduleSwitcher.custom.hint': '新建一份所有参数为空的默认模块；重名时自动加序号',
  'moduleSwitcher.custom.title': '新建空白模块',
  'moduleSwitcher.custom.detail': '默认模块 · 创建后保持关闭',
  'moduleSwitcher.name.title': '编辑模块名称',
  'moduleSwitcher.name.edit': '改名',
  'moduleSwitcher.name.saved': '模块名称已保存',
  'moduleSwitcher.name.savedPending': '模块名称已保存，但运行刷新失败：{reason}。无需重复改名。',
  'moduleSwitcher.name.close': '关闭名称编辑',
  'moduleSwitcher.name.label': '模块名称',
  'moduleSwitcher.name.required': '请输入模块名称。',
  'moduleSwitcher.name.cancel': '取消',
  'moduleSwitcher.name.save': '保存',
  'moduleSwitcher.name.readFailed': '读取模块名称失败',
  'moduleSwitcher.name.saveFailed': '保存模块名称失败',
  'moduleSwitcher.name.conflict': '模块已被外部修改，请重新读取后再保存',
  'moduleSwitcher.name.reload': '重新读取',
  'moduleSwitcher.name.editAria': '编辑模块名称：{name}',
  'moduleSwitcher.template.hint': '新建到用户目录：{id}',
  'moduleSwitcher.card.blocked.hint': '模块不可渲染（缺模块清单/组合文件）：可删除后经「新建模块」从内置模板还原，或检查 module.yml',
  'moduleSwitcher.card.enable.hint': '启用 {name}：参与运行时装配',
  'moduleSwitcher.card.disable.hint': '停用 {name}：退出运行时装配',
  'moduleSwitcher.enabled': '已启用',
  'moduleSwitcher.blocked': '不可用',
  'moduleSwitcher.duplicate.label': '复制模块',
  'moduleSwitcher.duplicate.aria': '复制模块：{name}',
  'moduleSwitcher.open.label': '打开模块文件夹',
  'moduleSwitcher.open.aria': '打开模块文件夹：{name}',
  'moduleSwitcher.delete.confirmHint': '删除后可从内置模板重新创建',
  'moduleSwitcher.delete.confirm': '确认删除',
  'moduleSwitcher.delete.cancel': '取消',
  'moduleSwitcher.delete.hintActive': '先切换其他模块再删除',
  'moduleSwitcher.delete.hint': '删除用户目录副本；内置模板仍可重新创建',
  'moduleSwitcher.delete.aria': '删除模块：{name}',
  'moduleSwitcher.notice.imported': '模块 {id} 已导入，打开卡片上的开关即可启用',
  'moduleSwitcher.notice.importFailed': '导入模块失败：{reason}',
  'moduleSwitcher.notice.exportFailed': '导出模块失败：{reason}',
  'moduleSwitcher.notice.exported': '已导出 {file}（单文件配置，可保存到任意目录）',
  'moduleSwitcher.notice.deleted': '模块 {id} 已删除（可经「新建模块」从内置模板还原）',
  'moduleSwitcher.notice.deletedWithBackup': '模块 {id} 已删除；旧副本清理未完成，保留在 {path}（可能不完整，确认后可手动删除）',
  'moduleSwitcher.notice.deleteFailed': '删除模块失败：{reason}',
  'moduleSwitcher.notice.duplicated': '已复制为模块 {id}',
  'moduleSwitcher.notice.duplicateFailed': '复制模块失败：{reason}',
  'moduleSwitcher.notice.opened': '已打开模块文件夹：{path}',
  'moduleSwitcher.notice.openFailed': '打开模块文件夹失败：{reason}',
  'moduleSwitcher.notice.cloned': '已从内置模板新建模块 {id}',
  'moduleSwitcher.notice.refreshFailed': '模块操作已保存，但列表刷新失败；请重新打开工作台，不要重复操作。',
  'moduleSwitcher.notice.cloneFailed': '新建模块失败：{reason}',
  'moduleSwitcher.notice.enabled': '模块 {id} 已启用（参与运行时装配）',
  'moduleSwitcher.notice.disabled': '模块 {id} 已停用（退出运行时装配）',
  'moduleSwitcher.notice.enableFailed': '切换模块启用状态失败：{reason}',
} as const

/**
 * 字典键（zh 为唯一事实源；新增文案先加 zh，en 缺键即编译失败）。
 *
 * 文本量大的 feature 按归档计划 §8.3.1 分词典：核心词条留在本文件，其余按 feature
 * 放进 locales-params / locales-prompts / locales-cards，注册时合并为同一命名空间，
 * 不复制第二套翻译框架。
 */
export type PromptToolLocaleKey =
  | keyof typeof ZH_CORE
  | keyof typeof PARAMS_ZH
  | keyof typeof PROMPTS_ZH
  | keyof typeof CARDS_ZH
  | keyof typeof TRIGGERS_ZH
  | keyof typeof RULES_ZH

const EN_CORE: Record<keyof typeof ZH_CORE, string> = {
  'rewind.label': 'Rewind sent messages',
  'rewind.once': 'Rewind once',
  'rewind.round': 'Rewind previous round',
  'rewind.done': 'Rewind committed.',
  'rewind.retry': 'Retry failed targets only',
  'rewind.retryRequest': 'Retry original submission (result unconfirmed)',
  'rewind.restoreFailed': 'Rewind committed, but draft restoration failed. Recover the original input below.',
  'rewind.recover': 'Recover withdrawn text (current draft preserved)',
  'rewind.unavailable': 'Safe rewind is unavailable on this page. Refresh the page.',
  'app.title': 'Prompt Tool',
  'app.backToChat': 'Back to chat',
  'app.loading': 'Loading',
  'app.statusRules': '{enabled}/{total} rules',
  'app.statusModules': '{enabled}/{total} modules',
  'app.statusUnavailable': '{count} unavailable',
  'app.open': 'Open prompt tool',
  'app.close': 'Close prompt tool',
  'app.panelAria': 'Prompt tool',
  'nav.aria': 'Prompt tool pages',

  'settings.saveRejected': 'Settings were not saved. Check your permissions or reload and retry.',

  'page.features.label': 'Main session',
  'page.subagent.label': 'Subagent',
  'page.tools.label': 'Tool preview',
  'page.modules.label': 'Modules',

  'main.aria': 'Main session and global',
  'main.addTemplate': 'Add template · {layer}',
  'main.addToolTemplate': 'Add tool template…',
  'main.newBlankTool': 'New blank tool',
  'subagent.aria': 'Subagent',
  'configList.create': 'New',

  'tools.aria': 'Tool preview',
  'tools.search.aria': 'Search tools',
  'tools.search.placeholder': 'Search tool name or description',
  'tools.surface.session': 'Current session tools',
  'tools.surface.preset': 'Official preset tool capabilities',
  'tools.surface.source.aria': 'Official preset source',
  'tools.surface.source.placeholder': 'Select an official preset',
  'tools.loadingPresets': 'Loading official presets…',
  'tools.loadFailed': 'Failed to load the official preset list',
  'tools.noPresets': 'No official presets available.',
  'tools.surface.sourceLabel': 'Tool surface',
  'tools.surface.count': 'Showing {visible} / {total} tools',
  'tools.surface.emptySource': 'No visible tools for this source.',
  'tools.surface.emptyFilter': 'No matching tools; adjust the search.',
  'tools.surface.list.aria': 'Model-visible tools',
  'tools.surface.card.aria': 'View tool {name}',
  'tools.surface.badge.visible': 'Model-visible',
  'tools.surface.detail.name': 'Full name',
  'tools.surface.detail.from': 'From',
  'tools.surface.detail.status': 'Visibility',
  'tools.surface.detail.description': 'Tool description',
  'tools.surface.detail.noDescription': '(no description)',
  'tools.surface.sub.count': '{count}',
  'tools.surface.noSession': 'No current session selected; sessions are never created or resumed automatically.',
  'tools.surface.noPreset': 'Select a module to read its tool capabilities.',
  'tools.surface.origin': 'Source: ',
  'tools.surface.refresh': 'Refresh tools',
  'tools.surface.loading': 'Loading tools…',
  'tools.surface.readFailed': 'Failed to read the tool surface',
  'tools.surface.retrySuffix': '; refresh to retry.',
  'tools.surface.note.session': 'Refreshing does not upgrade the generation of an existing session and never resumes it.',
  'tools.surface.note.preset': 'Module capabilities do not describe the current session; editing a module does not replace a frozen generation.',

  'modules.globalSwitch': 'Global switch',
  'moduleOrder.current': 'Back to current module',
  'moduleOrder.all': 'Order across modules',
  'moduleOrder.hint': 'Order enabled-module configurations for this audience. Drag, move up/down, or use the handle’s arrow keys; changes save automatically. Return to the current module to edit content.',
  'moduleOrder.refresh': 'Refresh order',
  'moduleOrder.discardRefresh': 'Discard unsaved order and refresh',
  'moduleOrder.empty': 'No enabled-module configurations match this audience and filters.',
  'moduleOrder.disabled': 'This card is disabled',
  'moduleOrder.unavailable': 'The ordering service is unavailable',
  'moduleOrder.readFailed': 'Unable to read order: {reason}',
  'moduleOrder.saveFailed': 'Unable to save order. Your changes are retained: {reason}',
  'moduleOrder.refreshFailed': 'Order saved, but reloading the configurations failed. Refresh before editing.',

  'moduleSwitcher.new': 'New module',
  'moduleSwitcher.import': 'Import module',
  'moduleSwitcher.importing': 'Importing…',
  'moduleSwitcher.import.aria': 'Choose a module.yml / SillyTavern JSON config file',
  'moduleSwitcher.importDir': 'Import folder',
  'moduleSwitcher.importDir.aria': 'Choose a module folder',
  'moduleSwitcher.export': 'Export module',
  'moduleSwitcher.export.aria': 'Export module: {name}',
  'moduleSwitcher.empty': 'No modules yet; create one with "New module" above, or add one with "Import module".',
  'moduleSwitcher.dialog.title': 'New module',
  'moduleSwitcher.dialog.close': 'Close new module dialog',
  'moduleSwitcher.dialog.noTemplates': 'The plugin directory has no built-in templates.',
  'moduleSwitcher.custom.hint': 'Create a blank default module; duplicate names get a numeric suffix',
  'moduleSwitcher.custom.title': 'New blank module',
  'moduleSwitcher.custom.detail': 'Default module · stays disabled after creation',
  'moduleSwitcher.name.title': 'Edit module name',
  'moduleSwitcher.name.edit': 'Rename',
  'moduleSwitcher.name.saved': 'Module name saved',
  'moduleSwitcher.name.savedPending': 'The module name is saved, but runtime refresh failed: {reason}. Do not rename it again.',
  'moduleSwitcher.name.close': 'Close name editor',
  'moduleSwitcher.name.label': 'Module name',
  'moduleSwitcher.name.required': 'Enter a module name.',
  'moduleSwitcher.name.cancel': 'Cancel',
  'moduleSwitcher.name.save': 'Save',
  'moduleSwitcher.name.readFailed': 'Failed to read module name',
  'moduleSwitcher.name.saveFailed': 'Failed to save module name',
  'moduleSwitcher.name.conflict': 'The module changed externally; reload before saving',
  'moduleSwitcher.name.reload': 'Reload',
  'moduleSwitcher.name.editAria': 'Edit module name: {name}',
  'moduleSwitcher.template.hint': 'Create in the user directory: {id}',
  'moduleSwitcher.card.blocked.hint': 'Module cannot be rendered (missing module list/composition files): delete it and restore a built-in template, or inspect module.yml',
  'moduleSwitcher.card.enable.hint': 'Enable {name}: take part in runtime assembly',
  'moduleSwitcher.card.disable.hint': 'Disable {name}: leave runtime assembly',
  'moduleSwitcher.enabled': 'Enabled',
  'moduleSwitcher.blocked': 'Unavailable',
  'moduleSwitcher.duplicate.label': 'Duplicate module',
  'moduleSwitcher.duplicate.aria': 'Duplicate module: {name}',
  'moduleSwitcher.open.label': 'Open module folder',
  'moduleSwitcher.open.aria': 'Open module folder: {name}',
  'moduleSwitcher.delete.confirmHint': 'You can recreate it from a built-in template afterwards',
  'moduleSwitcher.delete.confirm': 'Confirm delete',
  'moduleSwitcher.delete.cancel': 'Cancel',
  'moduleSwitcher.delete.hintActive': 'Switch to another module before deleting this one',
  'moduleSwitcher.delete.hint': 'Delete the user-directory copy; the built-in template can still recreate it',
  'moduleSwitcher.delete.aria': 'Delete module: {name}',
  'moduleSwitcher.notice.imported': 'Module {id} imported; turn on its card switch to enable it',
  'moduleSwitcher.notice.importFailed': 'Failed to import the module: {reason}',
  'moduleSwitcher.notice.exportFailed': 'Failed to export the module: {reason}',
  'moduleSwitcher.notice.exported': 'Exported {file} (single-file config, save it anywhere)',
  'moduleSwitcher.notice.deleted': 'Module {id} deleted (restore it from a built-in template with "New module")',
  'moduleSwitcher.notice.deletedWithBackup': 'Module {id} deleted; the old copy at {path} was not fully cleaned up (it may be incomplete; remove it manually once verified)',
  'moduleSwitcher.notice.deleteFailed': 'Failed to delete the module: {reason}',
  'moduleSwitcher.notice.duplicated': 'Duplicated as module {id}',
  'moduleSwitcher.notice.duplicateFailed': 'Failed to duplicate the module: {reason}',
  'moduleSwitcher.notice.opened': 'Opened module folder: {path}',
  'moduleSwitcher.notice.openFailed': 'Failed to open the module folder: {reason}',
  'moduleSwitcher.notice.cloned': 'Created module {id} from a built-in template',
  'moduleSwitcher.notice.refreshFailed': 'The module change is saved, but the list could not refresh. Reopen the workspace; do not repeat the operation.',
  'moduleSwitcher.notice.cloneFailed': 'Failed to create the module: {reason}',
  'moduleSwitcher.notice.enabled': 'Module {id} enabled (takes part in runtime assembly)',
  'moduleSwitcher.notice.disabled': 'Module {id} disabled (leaves runtime assembly)',
  'moduleSwitcher.notice.enableFailed': 'Failed to toggle the module enable state: {reason}',
}

const ZH: Record<PromptToolLocaleKey, string> = { ...ZH_CORE, ...PARAMS_ZH, ...PROMPTS_ZH, ...CARDS_ZH, ...TRIGGERS_ZH, ...RULES_ZH }
const EN: Record<PromptToolLocaleKey, string> = { ...EN_CORE, ...PARAMS_EN, ...PROMPTS_EN, ...CARDS_EN, ...TRIGGERS_EN, ...RULES_EN }

/** 官方 locale 服务的最小使用面（便于 node:test 用 mock 覆盖注册/释放）。 */
export interface PromptToolLocaleRegistry {
  register(
    ns: typeof PROMPT_TOOL_NS,
    dicts: { zh: Record<PromptToolLocaleKey, string>; en: Record<PromptToolLocaleKey, string> },
  ): () => void
}

/** 命名空间翻译函数（调用时读当前语言）。 */
export type PromptToolTranslate = Translate<PromptToolLocaleKey>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'prompt-tool': PromptToolLocaleKey
  }
}

export const PROMPT_TOOL_DICTS: { zh: Record<PromptToolLocaleKey, string>; en: Record<PromptToolLocaleKey, string> } = {
  zh: ZH,
  en: EN,
}

/** 注册 zh/en 字典；返回官方 locale 服务的幂等 disposer。 */
export function registerPromptToolLocale(locale: PromptToolLocaleRegistry): () => void {
  return locale.register(PROMPT_TOOL_NS, PROMPT_TOOL_DICTS)
}
