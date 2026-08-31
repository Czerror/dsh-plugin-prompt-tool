import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../src/client/PromptWorkspace.module.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../../src/client/slot-workbench.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

test('workbench registers official slots and a sidebar geometry bridge', () => {
  for (const slot of ['settings.plugins.tab', 'sidebar.footer.action', 'shell.overlay']) {
    assert.ok(source.includes("ctx.slots.inject('" + slot + "'"), slot + ' registration missing')
  }
  assert.match(source, /SidebarGeometryProbe/)
  assert.ok(source.includes("id: 'prompt-tool'"), 'settings tab id missing')
  assert.ok(source.includes("id: 'prompt-tool-workbench'"), 'overlay entry id missing')
  assert.doesNotMatch(source, /createRoot|MutationObserver|querySelector/)
  assert.match(source, /createPortal/)
  assert.match(source, /createPortal\(trigger, document\.body\)/)
  assert.match(source, /body portal/)
  assert.doesNotMatch(source, /class\*|data-pane|centerCol|logoRow|newSession/)
})

test('floating trigger position stays independent from third-party title-bar settings', () => {
  assert.match(source, /strokeWidth="1\.5"/)
  assert.match(source, /data-dsh-plugin="prompt-tool"/)
  assert.match(source, /data-dsh-part="floating-trigger"/)
  assert.match(source, /className=\{css\.floatingTrigger\}/)

  assert.match(source, /floatingTriggerLayer/)
  const layer = css.match(/\.floatingTriggerLayer\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(layer, /position:\s*fixed/)
  assert.match(layer, /top:\s*calc\(3px \+ env\(safe-area-inset-top\)/, '浮层保持自己的固定纵向位置')
  assert.doesNotMatch(css, /data-dsh-title-bar-compat|--dsh-title-bar-strip/, '浮层不得读取第三方标题栏位置契约')
  assert.match(layer, /left:\s*var\(--pt-sidebar-edge, 284px\)/, '浮层必须使用真实 sidebar 边缘变量并额外右移 10px')
  assert.match(source, /const FLOATING_TRIGGER_GAP = 20/, '动态 sidebar 几何同样必须额外右移 10px')
  assert.match(layer, /z-index:\s*60/, '浮层必须位于 shell.overlay 及抽屉背板之上')
  assert.match(layer, /pointer-events:\s*auto/)
  const trigger = css.match(/\.floatingTrigger\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(trigger, /width:\s*28px/)
  assert.match(trigger, /height:\s*28px/)
  assert.match(trigger, /border-radius:\s*50%/)
  assert.match(trigger, /pointer-events:\s*auto/)
  assert.match(css, /\.sidebarEdgeProbe\s*\{[^}]*display:\s*none/s)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /document\.documentElement\.style\.setProperty/)
  assert.match(source, /probe\.parentElement\?\.parentElement/)
  assert.match(source, /SIDEBAR_COLLAPSED_WIDTH/)
  assert.doesNotMatch(css, /\.entry(?:Icon|Label)?(?:\[data-rail\])?\s*\{/)
})

test('shell.overlay drawer is styled as an official overlay child', () => {
  assert.match(css, /\.drawerLayer\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*20;[^}]*visibility:\s*hidden/s)
  assert.match(css, /\.drawerLayer\[data-open\]\s*\{[^}]*visibility:\s*visible/s)
  assert.match(css, /\.drawerBackdrop\s*\{[^}]*pointer-events:\s*auto/s)
  assert.match(css, /\.drawerPanel\s*\{[^}]*transform:\s*translateX\(100%\)/s)
  assert.match(css, /\.drawerLayer\[data-open\] \.drawerPanel\s*\{[^}]*transform:\s*translateX\(0\)/s)
  assert.doesNotMatch(css, /data-dsh-prompt-tool-active|centerCol|data-dsh-workspace-slot/)
})

test('client service and bundle injection edges cover the slot declarations', () => {
  assert.match(entry, /'slots'/)
  for (const dependency of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ]) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), dependency + ' missing from dsh.client.inject')
    assert.ok(manifest.peerDependencies[dependency] !== undefined, dependency + ' missing from peerDependencies')
  }
})

test('/meta 预设下拉读 value.meta（不是顶层 meta 扩展字段）', () => {
  assert.match(source, /res\.value\.meta\?\.presets/, '必须读 value.meta.presets（bridge 统一 {ok,value} 载荷）')
  assert.doesNotMatch(source, /res\.meta\?\.meta/, '顶层 meta 扩展字段仅 /describe 与 /bootstrap 携带，/meta 端点没有')
})
