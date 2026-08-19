/**
 * HostSurfaceAdapter — 所有宿主 DOM 选择器与挂载点探测的集中适配层。
 *
 * 目标：优先使用官方 slots/入口 API；当前仍以 CSS 类选择器兜底时，
 * 所有选择器只允许出现在本文件，宿主改版时只需改这里。
 */

export const PROMPT_TOOL_VIEW_SELECTOR = '[data-dsh-prompt-tool-view]'
export const PROMPT_TOOL_ENTRY_SELECTOR = '[data-dsh-prompt-tool-entry]'
export const OFFICIAL_WORKSPACE_SLOT_SELECTOR = '[data-dsh-workspace-slot]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
const LOGO_ROW_SELECTOR = '[class*="logoRow"]'
const NEW_SESSION_SELECTOR = 'button[class*="newSession"]'
const SIDEBAR_CONTEXT_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
const FAMILY_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-prompt-tool-entry]'

/** 官方 workspace slot 挂载点；宿主未暴露时返回 undefined，由 selector 兜底。 */
export function findOfficialWorkspaceMount(doc: Document = document): HTMLElement | undefined {
  return doc.querySelector<HTMLElement>(OFFICIAL_WORKSPACE_SLOT_SELECTOR) ?? undefined
}

/** 中央列容器：工作台面板挂载点（官方 slot 优先，CSS 选择器兜底）。 */
export function findConversationColumn(doc: Document = document): HTMLElement | undefined {
  return doc.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/** 侧边栏根节点。 */
export function findSidebarRoot(doc: Document = document): HTMLElement | undefined {
  const column = doc.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  return column.querySelector<HTMLElement>(LOGO_ROW_SELECTOR)?.parentElement
    ?? (column.firstElementChild as HTMLElement | undefined)
}

/** 新建会话按钮，用于决定侧边栏入口插入位置。 */
export function findNewSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>(NEW_SESSION_SELECTOR)
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** 侧边栏入口插入基准：优先 logoRow，否则使用新建会话按钮本身。 */
export function findSidebarInsertBase(root: HTMLElement, button: HTMLElement): HTMLElement {
  const row = button.closest(LOGO_ROW_SELECTOR) as HTMLElement | null
  return row !== null && row.parentElement === root ? row : button
}

/** 侧边栏中已有的同类入口（task-board / ssh / prompt-tool）。 */
export function findFamilyEntries(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element.matches(FAMILY_SELECTOR),
  )
}

/** 侧边栏上下文选择器：点击这些区域时关闭工作台面板。 */
export function matchesSidebarContext(element: Element): boolean {
  return element.closest(SIDEBAR_CONTEXT_SELECTOR) !== null
}
