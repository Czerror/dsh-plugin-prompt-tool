export type WorkspacePage = 'features' | 'subagent' | 'tools' | 'skills' | 'presets' | 'characters'

export const WORKSPACE_PAGES: ReadonlyArray<{ id: WorkspacePage; label: string; title: string; detail: string }> = [
  {
    id: 'features',
    label: '主会话',
    title: '主会话',
    detail: '主会话参数（模型设置、工具与深度）、消息批层入口开关、Preset/AGENTS 内容与提示词配置模块库（按层级筛选）。',
  },
  {
    id: 'subagent',
    label: '子代理',
    title: '子代理',
    detail: '子代理作用域参数（模型/工具集/深度）与子代理提示词配置（audience 非仅主会话；子代理独立人设 = 新建配置卡：system-section + audience=subagent + 人设段，装配时替换主会话人设，无卡 = 继承主会话）。',
  },
  {
    id: 'tools',
    label: '工具预览',
    title: '工具预览',
    detail: '只读查看当前会话冻结的模型工具与所选预设后续 generation 的工具能力；添加和编辑仍在主会话配置卡，不管理 MCP 或插件安装。',
  },
  {
    id: 'skills',
    label: '技能设置',
    title: '技能设置',
    detail: '按 skills 目录注册的可开关技能；目录与逐技能开关立即生效。',
  },
  {
    id: 'presets',
    label: '预设配置',
    title: '预设配置',
    detail: '统一管理预设模板（切换/导入）与提示词配置（六层列表/模板插入/配置目录）。',
  },
  {
    id: 'characters',
    label: '角色管理',
    title: '角色管理',
    detail: '导入 SillyTavern 角色卡（PNG / JSON）并管理转换出的角色卡预设模块（角色设定 / 系统提示 / 开场白 / 提示词库）。',
  },
]

export const WORKSPACE_PAGE_IDS = WORKSPACE_PAGES.map((page) => page.id)
export const workspacePageMeta = (id: WorkspacePage) => WORKSPACE_PAGES.find((page) => page.id === id)!
