import css from './PromptWorkspace.module.css'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'

export const PROMPT_TOOL_ENTRY_SELECTOR = '[data-dsh-prompt-tool-entry]'

const FAMILY_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-prompt-tool-entry]'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
    ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

function createIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('width', '14')
  icon.setAttribute('height', '14')
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
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement === root) return true
  const row = button.closest('[class*="logoRow"]')
  const base = row !== null && row.parentElement === root ? row : button
  const family = Array.from(root.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element.matches(FAMILY_SELECTOR),
  )
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
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(tryPlace)
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const syncActive = (): void => {
    if (controller.getSnapshot().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}
