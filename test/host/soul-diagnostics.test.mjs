import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { readSoulDiagnostics } from '../../src/host/soul-diagnostics.ts'
import { readSoulPressure } from '../../src/runtime/soul-pressure.ts'
import { configContract } from '../../engine/soul-maintenance.mjs'

const { moduleRoot } = isolatedHome('pt-soul-diagnostics-')

test('水位配置可独立于维护启用且默认不配置，拒绝无序或越界阈值', () => {
  assert.equal(configContract.parse({}, 'soul-maintenance').pressureThresholds, undefined)
  const parsed = configContract.parse({ enabled: false, pressureThresholds: [0.45, 0.6, 0.8] }, 'soul-maintenance')
  assert.equal(parsed.enabled, false)
  assert.deepEqual(parsed.pressureThresholds, [0.45, 0.6, 0.8])
  for (const pressureThresholds of [[0.6, 0.45, 0.8], [0, 0.6, 0.8], [0.45, 0.6, 1], [0.45, 0.6], ['0.45', 0.6, 0.8]]) {
    assert.throws(() => configContract.parse({ pressureThresholds }, 'soul-maintenance'), /pressureThresholds/)
  }
})

test('运行诊断只读且文件通过不代表SELF已投递或能力已运行', () => {
  const dir = join(moduleRoot, 'checks')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'assets/manifest.yml'), 'checks: [{ path: data/SELF.src.md, kind: text }]')
  writeFileSync(join(dir, 'data/SELF.src.md'), '# PRIVATE SKELETON')
  writeFileSync(join(dir, 'data/02-soul.jsonl'), '')
  const before = readdirSync(join(dir, 'data')), body = readFileSync(join(dir, 'data/SELF.src.md'))
  const report = readSoulDiagnostics(dir, { index: { state: 'unbuilt' }, context: { state: 'ready' } })
  const checks = new Map(report.checks.map(check => [check.name, check]))
  assert.equal(report.state, 'attention')
  assert.equal(checks.get('manifest').state, 'ready')
  assert.equal(checks.get('self-delivered').state, 'not-observed')
  assert.equal(checks.get('context').state, 'not-observed')
  assert.equal(checks.get('ledger').state, 'pending-initialization')
  assert.equal(checks.get('index').state, 'unbuilt')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE SKELETON/)
  assert.deepEqual(readFileSync(join(dir, 'data/SELF.src.md')), body)
  assert.deepEqual(readdirSync(join(dir, 'data')), before)
  symlinkSync(join(dir, 'assets'), join(dir, 'data/linked'), 'junction')
  writeFileSync(join(dir, 'assets/manifest.yml'), 'checks: [{ path: data/linked/manifest.yml, kind: text }]')
  const failed = readSoulDiagnostics(dir)
  assert.equal(failed.checks.find(check => check.name === 'manifest').state, 'failed')
})

test('水位使用当前路由预算与真实测量，阈值和压缩下降不产生模型或维护调用', () => {
  let tokens = 449, window = 1000, route = 'one', fail = false
  const session = { requestHeader: () => ({ config: { provider: 'p', model: route } }), requestContext: () => ({ provider: 'p', model: 'one', contextWindow: window }) }
  const ctx = { get: name => { assert.equal(name, 'tokenMeter'); return { measure: actual => { assert.equal(actual, session); if (fail) throw new Error('PRIVATE BODY'); return { totalTokens: tokens } } } } }
  const agent = { session }, thresholds = [0.45, 0.6, 0.8]
  assert.equal(readSoulPressure(ctx, agent, thresholds).level, 'normal')
  tokens = 450
  assert.equal(readSoulPressure(ctx, agent, thresholds).level, 'organize')
  tokens = 600
  assert.equal(readSoulPressure(ctx, agent, thresholds).level, 'persist')
  tokens = 800
  assert.equal(readSoulPressure(ctx, agent, thresholds).level, 'urgent')
  tokens = 100
  assert.equal(readSoulPressure(ctx, agent, thresholds).level, 'normal')
  window = 200
  assert.equal(readSoulPressure(ctx, agent, thresholds).ratio, 0.5)
  route = 'two'
  assert.equal(readSoulPressure(ctx, agent, thresholds).state, 'unknown')
  route = 'one'; window = undefined
  assert.equal(readSoulPressure(ctx, agent, thresholds).state, 'unknown')
  window = 1000; fail = true
  const unknown = readSoulPressure(ctx, agent, thresholds)
  assert.equal(unknown.state, 'unknown')
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE BODY/)
  assert.throws(() => readSoulPressure(ctx, agent, [0.8, 0.6, 0.45]), /阈值/)
})
