import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const register = read('src/client/app/workbench/register-workbench.tsx')
const tab = read('src/client/app/workbench/PromptToolTab.tsx')
const settings = read('src/client/app/workbench/SettingsTab.tsx')
const workspace = read('src/client/app/workspace/PromptWorkspace.tsx')
const source = [register, tab, settings].join('\n')
const skillsSettings = read('src/client/features/skills/SkillsPage.tsx')
const entry = read('src/client/index.ts')
const manifest = JSON.parse(read('package.json'))

test('工作台按官方右侧栏两段注册 + shell.overlay 悬浮入口，且不碰宿主 DOM', () => {
  assert.match(register, /ctx\.sidebarRightTabs\.register\(\{/)
  assert.match(register, /id: PROMPT_TOOL_TAB_ID/)
  assert.match(register, /kind: PROMPT_TOOL_TAB_KIND/)
  assert.match(register, /guide: \[\{/, 'guide 入口盒是右侧栏的官方入口')
  assert.match(register, /name: 'sidebar\.right\.pane\.tab', key: PROMPT_TOOL_TAB_ID/)
  assert.match(register, /name: 'settings\.plugins\.tab', id: 'prompt-tool'/)
  assert.match(register, /name: 'shell\.overlay', id: 'prompt-tool-workbench'/)
  assert.match(register, /name: 'sidebar\.footer\.action', id: 'prompt-tool-floating-geometry'/)
  assert.doesNotMatch(source, /createPortal|createRoot|MutationObserver|querySelector/)
  assert.doesNotMatch(source, /dsh-panel-activate/)
  assert.doesNotMatch(source, /class\*|data-pane|centerCol|logoRow|newSession/)
})

test('tab body 复用 PromptWorkspace，关闭走官方 tab actions，controller 可选', () => {
  assert.match(tab, /props\.useTabInfo\(\)/)
  assert.match(tab, /tab\.actions\.close\(\)/)
  assert.match(tab, /<PromptWorkspace/)
  // 悬浮入口传 controller（开关驱动加载），右侧栏 tab 不传（常开）。
  assert.match(workspace, /controller\?: PromptToolWorkspaceController/)
  assert.match(workspace, /if \(open\) void store\.load\(\)/)
})

test('client service and bundle injection edges cover the sidebar-right declarations', () => {
  assert.match(entry, /'slots'/)
  assert.match(entry, /'sidebarRightTabs'/)
  for (const dependency of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), dependency + ' missing from dsh.client.inject')
    assert.ok(manifest.peerDependencies[dependency] !== undefined, dependency + ' missing from peerDependencies')
  }
})

test('悬浮入口抽屉经 body portal 置顶，不受宿主导航栏遮挡', () => {
  const overlay = read('src/client/app/workbench/WorkbenchOverlay.tsx')
  const css = read('src/client/app/workbench/Workbench.module.css')
  assert.match(overlay, /createPortal\(trigger, document\.body\)/)
  assert.match(overlay, /createPortal\(drawer, document\.body\)/)
  assert.match(css, /\.drawerLayer\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1000/s)
  assert.match(css, /\.floatingTriggerLayer\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1100/s)
  assert.match(overlay, /aria-modal="true"/)
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
