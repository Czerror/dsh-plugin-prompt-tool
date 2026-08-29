import css from './PromptWorkspace.module.css'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import { findFamilyEntries, findNewSessionButton, findSidebarInsertBase, findSidebarRoot } from './host-surface.ts'

export { PROMPT_TOOL_ENTRY_SELECTOR } from './host-surface.ts'

function createIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('width', '18')
  icon.setAttribute('height', '18')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '1.3')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', 'M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M6 8.5h4M8 6.5v4')
  icon.append(path)
  return icon
}

function createEntry(controller: PromptToolWorkspaceController): { entry: HTMLButtonElement; label: HTMLSpanElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshPromptToolEntry = ''
  entry.className = css.entry ?? ''
  const icon = document.createElement('span')
  icon.className = css.entryIcon ?? ''
  icon.append(createIcon())
  const label = document.createElement('span')
  label.className = css.entryLabel ?? ''
  label.textContent = '提示词工具'
  entry.setAttribute('aria-label', '提示词工具')
  entry.title = '提示词工具'
  entry.append(icon, label)
  entry.addEventListener('click', () => { controller.toggle() })
  return { entry, label }
}

function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = findNewSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement === root) return true
  const base = findSidebarInsertBase(root, button)
  const family = findFamilyEntries(root)
  const anchor = family.at(-1)?.nextElementSibling ?? base.nextElementSibling
  root.insertBefore(entry, anchor)
  return true
}

/** 自愈式官方风格入口：挂在新建会话行下方，点击开关工作台。 */
export function mountPromptToolSidebarEntry(controller: PromptToolWorkspaceController): () => void {
  const { entry, label } = createEntry(controller)
  let root: HTMLElement | undefined
  let placed = false

  const syncLabel = (): void => {
    const text = '提示词工具'
    if (entry.getAttribute('aria-label') !== text) entry.setAttribute('aria-label', text)
    if (entry.title !== text) entry.title = text
    if (label.textContent !== text) label.textContent = text
  }

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  const tryPlace = (): void => {
    syncLabel()
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed && document.body.contains(entry)) return
    if (placed) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= findSidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  // 宿主 DOM 高频变动：body subtree 观察防抖，避免每次变更都全文档扫描。
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  const waitObserver = new MutationObserver(() => {
    if (waitTimer !== undefined) clearTimeout(waitTimer)
    waitTimer = setTimeout(tryPlace, 200)
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const syncActive = (): void => {
    if (controller.getSnapshot().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    if (waitTimer !== undefined) clearTimeout(waitTimer)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}
