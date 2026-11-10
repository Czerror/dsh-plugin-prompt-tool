import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tempDir } from '../fixtures/host-harness.mjs'

test('预算早期公开入口缺目标时保持不可用，不接管未验证能力', () => {
  const repo = new URL('../..', import.meta.url)
  const entry = new URL('engine/instructions-budget-early.mjs', repo).href
  const bridge = new URL('engine/instructions-budget-bridge.mjs', repo).href
  const cwd = tempDir('pt-budget-entry-')
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    'await import(' + JSON.stringify(entry) + '); const {instructionsBudgetStatus}=await import(' + JSON.stringify(bridge) + '); console.log(JSON.stringify(instructionsBudgetStatus()));'], { cwd, encoding: 'utf8' })
  const status = JSON.parse(output)
  assert.equal(status.available, false)
  assert.equal(typeof status.reason, 'string')
  assert.ok(status.reason.length > 0)
  const cancelled = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const {instructionsBudgetState}=await import(' + JSON.stringify(bridge) + '); const signal=AbortSignal.abort(new Error("cancelled")); try {instructionsBudgetState.read({},signal,65536)} catch(error) {console.log(error.message)}'], { cwd, encoding: 'utf8' })
  assert.equal(cancelled.trim(), 'cancelled', '透传路径仍保留原取消信号')
})
