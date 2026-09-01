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
  assert.match(source, /createPortal\(drawer, document\.body\)/, '抽屉必须 body portal 到导航栏之上')
  assert.match(source, /body portal/)
  assert.doesNotMatch(source, /class\*|data-pane|centerCol|logoRow|newSession/)
})

// 契约锚点（6ada119 定稿）：顶部 40px 避开宿主顶条、探针生效前左缘 10px 初始
// 回退、侧栏间距 GAP 15、折叠窄栏 36px。改悬浮触发器几何必须同步本测试、
// README「官方 slot 工作台」概览与 CSS 注释——该提交曾只改样式漏更测试，
// 契约断言红了一个提交周期。
test('floating trigger position stays independent from third-party title-bar settings', () => {
  assert.match(source, /strokeWidth="1\.5"/)
  assert.match(source, /data-dsh-plugin="prompt-tool"/)
  assert.match(source, /data-dsh-part="floating-trigger"/)
  assert.match(source, /className=\{css\.floatingTrigger\}/)

  assert.match(source, /floatingTriggerLayer/)
  const layer = css.match(/\.floatingTriggerLayer\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(layer, /position:\s*fixed/)
  assert.match(layer, /top:\s*calc\(40px \+ env\(safe-area-inset-top\)/, '浮层保持自己的固定纵向位置（40px，避开宿主顶部条）')
  assert.doesNotMatch(css, /data-dsh-title-bar-compat|--dsh-title-bar-strip/, '浮层不得读取第三方标题栏位置契约')
  assert.match(layer, /left:\s*var\(--pt-sidebar-edge, 10px\)/, '探针生效前贴左缘 10px 初始回退（探针覆盖为侧栏右缘）')
  assert.match(source, /const FLOATING_TRIGGER_GAP = 15/, '动态 sidebar 几何间距 15px')
  assert.match(source, /const SIDEBAR_COLLAPSED_WIDTH = 36/, '折叠态 36px 窄栏几何（探针回退宽度）')
  assert.match(layer, /z-index:\s*1100/, '悬浮按钮必须高于宿主导航栏与抽屉背板（1100）')
  assert.match(layer, /pointer-events:\s*auto/)
  const trigger = css.match(/\.floatingTrigger\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(trigger, /width:\s*28px/)
  assert.match(trigger, /height:\s*28px/)
  assert.match(trigger, /border-radius:\s*50%/)
  assert.match(trigger, /pointer-events:\s*auto/)
  assert.match(css, /\.sidebarEdgeProbe\s*\{[^}]*display:\s*none/s)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /document\.documentElement\.style\.setProperty/)
  // 几何探针不假设宿主父节点层级：向上查找第一个有实际尺寸的祖先。
  assert.match(source, /measuredAncestor/)
  assert.doesNotMatch(source, /parentElement\?\.parentElement/, '不得硬编码宿主父节点层级')
  // 关闭后焦点还给触发器（经 ref，不 querySelector 宿主 DOM）。
  assert.match(source, /triggerRef\.current\?\.focus\(\)/)
  assert.doesNotMatch(css, /\.entry(?:Icon|Label)?(?:\[data-rail\])?\s*\{/)
})

test('shell.overlay drawer is styled as an official overlay child', () => {
  assert.match(css, /\.drawerLayer\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1000;[^}]*visibility:\s*hidden/s)
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
