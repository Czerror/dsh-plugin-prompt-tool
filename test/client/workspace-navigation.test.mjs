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

test('技能筛选 tabs：roving tabindex 与共享 panel 关系完整', () => {
  const source = read('src/client/SkillsSettings.tsx')
  assert.match(source, /id=\{`pt-skills-tab-\$\{tab\.id\}`\}/)
  assert.match(source, /tabIndex=\{statusTab === tab\.id \? 0 : -1\}/)
  assert.match(source, /aria-controls="pt-skills-panel"/)
  assert.match(source, /id="pt-skills-panel"/)
  assert.match(source, /aria-labelledby=\{`pt-skills-tab-\$\{statusTab\}`\}/)
})
