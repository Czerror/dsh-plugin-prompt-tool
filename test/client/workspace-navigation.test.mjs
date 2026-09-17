import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('工作台 tabs：roving tabindex 与 tab/tabpanel 关系完整', () => {
  const navigation = read('src/client/app/workspace/WorkspaceNavigation.tsx')
  const frame = read('src/client/app/workspace/WorkspaceFrame.tsx')
  assert.match(navigation, /tabIndex=\{active \? 0 : -1\}/)
  assert.match(navigation, /id=\{`pt-workspace-tab-\$\{item\.id\}`\}/)
  assert.match(navigation, /aria-controls=\{`pt-workspace-panel-\$\{item\.id\}`\}/)
  assert.match(frame, /role="tabpanel"/)
  assert.match(frame, /aria-labelledby=\{`pt-workspace-tab-\$\{item\.id\}`\}/)
})

test('技能筛选是命名按钮组，按普通 Tab 顺序可达并声明选中状态', () => {
  const source = read('src/client/features/skills/SkillsPage.tsx')
  assert.match(source, /role="group" aria-label=\{t\('skills\.tabs\.aria'\)\}/)
  assert.match(source, /<button\s+key=\{tab\.id\}[\s\S]*?type="button"\s+aria-pressed=\{statusTab === tab\.id\}/)
  assert.match(source, /onClick=\{\(\) => setStatusTab\(tab\.id\)\}/)
  assert.doesNotMatch(source, /role="(?:tablist|tab|tabpanel)"|tabIndex=|aria-controls="pt-skills-panel"|aria-labelledby=|nextTabIndex/)
  assert.match(source, /id="pt-skills-panel"/)
  // 筛选标签仍走字典键（渲染时求值），不硬编码状态文案。
  for (const key of ['all', 'model', 'user', 'disabled']) assert.match(source, new RegExp(`labelKey: 'skills\\.tabs\\.${key}'`))
  assert.doesNotMatch(source, /label: '模型可调用'|label: '未注册'/)
})

test('技能目录与来源卡片位于过滤编辑框上方', () => {
  const source = read('src/client/features/skills/SkillsPage.tsx')
  assert.ok(source.indexOf('id="pt-skills-dirs"') < source.indexOf('className={ui.listFilterRow}'))
})
