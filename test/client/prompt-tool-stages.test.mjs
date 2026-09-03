import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EMPTY_FIELDS, hasIncompleteStageDrafts } from '../../src/client/data/prompt-tool-fields.ts'
import { shouldReloadAfterParamSave, snapshotSwitches } from '../../src/client/data/dirty-state.ts'

const cards = readFileSync(new URL('../../src/client/features/modules/EngineModuleList.tsx', import.meta.url), 'utf8')
const snapshotWithStages = (stages) => snapshotSwitches({ ...EMPTY_FIELDS, stages })

test('stages 添加按钮追加可编辑的空草稿行', () => {
  const start = cards.indexOf('<strong>渐进披露（stages）</strong>')
  const end = cards.indexOf('<EngineModuleCard name="context-gate"')
  assert.ok(start >= 0 && end > start, '应找到 stages UI 区块')
  const stagesUi = cards.slice(start, end)
  assert.ok(stagesUi.includes("store.patch({ stages: [...fields.stages, { name: '', tools: '' }] })"), '添加按钮应追加空阶段草稿行')
  assert.ok(stagesUi.includes('>+ 添加阶段</button>'), '应显示添加阶段按钮')
})

test('stages 未完成草稿保存后不重载，避免新增行立即消失', () => {
  for (const stages of [
    [{ name: '', tools: '' }],
    [{ name: '了解', tools: '' }],
    [{ name: '', tools: 'read, glob' }],
  ]) {
    const snapshot = snapshotWithStages(stages)
    assert.equal(hasIncompleteStageDrafts(stages), true)
    assert.equal(shouldReloadAfterParamSave(snapshot, snapshot), false)
  }
})

test('stages 完整且保存期间未继续编辑时允许重载', () => {
  const saved = snapshotWithStages([{ name: '了解', tools: 'read, glob' }])
  assert.equal(hasIncompleteStageDrafts(saved.stages), false)
  assert.equal(shouldReloadAfterParamSave(saved, saved), true)
})

test('stages 保存期间继续编辑时仍跳过旧快照重载', () => {
  const saved = snapshotWithStages([{ name: '了解', tools: 'read' }])
  const current = snapshotWithStages([{ name: '了解', tools: 'read, glob' }])
  assert.equal(shouldReloadAfterParamSave(current, saved), false)
})