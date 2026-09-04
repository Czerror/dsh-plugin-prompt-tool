import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const register = read('src/client/app/workbench/register-workbench.tsx')
const overlay = read('src/client/app/workbench/WorkbenchOverlay.tsx')
const geometry = read('src/client/app/workbench/SidebarGeometryProbe.tsx')
const triggerSource = read('src/client/app/workbench/FloatingTrigger.tsx')
const settings = read('src/client/app/workbench/SettingsTab.tsx')
const source = [register, overlay, geometry, triggerSource, settings].join('\n')
const css = read('src/client/app/workbench/Workbench.module.css')
const skillsSettings = read('src/client/features/skills/SkillsPage.tsx')
const entry = read('src/client/index.ts')
const manifest = JSON.parse(read('package.json'))

test('workbench registers official slots and a sidebar geometry bridge', () => {
  for (const slot of ['settings.plugins.tab', 'sidebar.footer.action', 'shell.overlay']) {
    assert.ok(register.includes("ctx.slots.inject('" + slot + "'"), slot + ' registration missing')
  }
  assert.match(register, /SidebarGeometryProbe/)
  assert.ok(register.includes("id: 'prompt-tool'"), 'settings tab id missing')
  assert.ok(register.includes("id: 'prompt-tool-workbench'"), 'overlay entry id missing')
  assert.doesNotMatch(source, /createRoot|MutationObserver|querySelector/)
  assert.match(overlay, /createPortal/)
  assert.match(overlay, /createPortal\(trigger, document\.body\)/)
  assert.match(overlay, /createPortal\(drawer, document\.body\)/, '抽屉必须 body portal 到导航栏之上')
  assert.match(overlay, /body portal/)
  assert.doesNotMatch(source, /class\*|data-pane|centerCol|logoRow|newSession/)
})

test('floating trigger position stays independent from third-party title-bar settings', () => {
  assert.match(triggerSource, /strokeWidth="1\.5"/)
  assert.match(triggerSource, /data-dsh-plugin="prompt-tool"/)
  assert.match(triggerSource, /data-dsh-part="floating-trigger"/)
  assert.match(triggerSource, /className=\{css\.floatingTrigger\}/)
  assert.match(triggerSource, /floatingTriggerLayer/)
  const layer = css.match(/\.floatingTriggerLayer\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(layer, /position:\s*fixed/)
  assert.match(layer, /top:\s*calc\(40px \+ env\(safe-area-inset-top\)/)
  assert.doesNotMatch(css, /data-dsh-title-bar-compat|--dsh-title-bar-strip/)
  assert.match(layer, /left:\s*var\(--pt-sidebar-edge, 56px\)/)
  assert.match(geometry, /const FLOATING_TRIGGER_GAP = 0/)
  assert.match(geometry, /style\.gridTemplateColumns !== ''/)
  assert.doesNotMatch(geometry, /dataset\.sidebarCollapsed/)
  assert.match(geometry, /getComputedStyle\(frame\)\.gridTemplateColumns/)
  assert.doesNotMatch(geometry, /SIDEBAR_COLLAPSED_WIDTH|SIDEBAR_WIDE_PADDING/)
  assert.match(layer, /z-index:\s*1100/)
  assert.match(layer, /pointer-events:\s*auto/)
  const trigger = css.match(/\.floatingTrigger\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(trigger, /width:\s*28px/)
  assert.match(trigger, /height:\s*28px/)
  assert.match(trigger, /border-radius:\s*50%/)
  assert.match(trigger, /pointer-events:\s*auto/)
  assert.match(css, /\.sidebarEdgeProbe\s*\{[^}]*display:\s*none/s)
  assert.match(geometry, /ResizeObserver/)
  assert.match(geometry, /transitionend/)
  assert.match(geometry, /document\.documentElement\.style\.setProperty/)
  assert.match(geometry, /measuredAncestor/)
  assert.doesNotMatch(geometry, /parentElement\?\.parentElement/)
  assert.match(overlay, /drawerRef\.current\?\.focus\(\)/, '打开后焦点进入抽屉')
  assert.match(overlay, /triggerRef\.current\?\.focus\(\)/, '关闭后焦点返回入口')
  assert.match(css, /@media \(max-width: 920px\)[\s\S]*\.floatingTrigger\[data-open\][^}]*visibility:\s*hidden/, '全屏抽屉隐藏重复悬浮入口')
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
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), dependency + ' missing from dsh.client.inject')
    assert.ok(manifest.peerDependencies[dependency] !== undefined, dependency + ' missing from peerDependencies')
  }
})

test('/meta 预设下拉读 value.meta（不是顶层 meta 扩展字段）', () => {
  assert.match(settings, /const meta = res\.value\.meta as/)
  assert.match(settings, /meta\.presets/)
  assert.doesNotMatch(settings, /res\.meta\?\.meta/)
})

test('技能目录列表展示 skillsDirs 的全部配置项，空配置才使用默认副本', () => {
  assert.match(skillsSettings, /const displaySkillsDirs = fields\.skillsDirs\.length > 0\s*\? fields\.skillsDirs\s*: fields\.activeSkillsDirs/)
  assert.match(skillsSettings, /meta=\{`\$\{displaySkillsDirs\.length\} 个目录/)
  assert.match(skillsSettings, /\{displaySkillsDirs\.length === 0 \?/)
  assert.match(skillsSettings, /\{displaySkillsDirs\.map\(\(dir, index\) =>/)
})

test('技能目录同时提供绝对路径引用与文件夹内容导入', () => {
  assert.match(skillsSettings, /api\.pickDirectory\(\)/)
  assert.match(skillsSettings, /选择目录并添加引用/)
  assert.match(skillsSettings, /label="导入文件夹内容"/)
  assert.match(skillsSettings, /\bdirectory\b/, '技能页仍应保留文件夹导入入口')
})
