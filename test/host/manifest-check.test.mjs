import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createManifestCheckReader } from '../../src/host/module-manifest-check.ts'
import { compileRules, rebindConditions } from '../../engine/rule-spec.mjs'
import { UNAVAILABLE } from '../../engine/conditions/availability.mjs'

const { moduleRoot } = isolatedHome('pt-manifest-check-')

function fixture(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  writeFileSync(join(dir, 'assets', 'manifest.yml'), 'checks:\n  - path: data/x.jsonl\n    kind: jsonl\n    maxBytes: 1024\n')
  return dir
}

test('清单检查事实随文件刷新，缺失或坏清单是不可用而不是检查失败', () => {
  const dir = fixture('facts')
  const reader = createManifestCheckReader(moduleRoot)
  assert.equal(reader.read('facts'), false, '检查项文件缺失 = 检查失败')
  writeFileSync(join(dir, 'data', 'x.jsonl'), '{"a":1}\n')
  assert.equal(reader.read('facts'), true)
  writeFileSync(join(dir, 'data', 'x.jsonl'), 'not json\n')
  assert.equal(reader.read('facts'), false, '同一缓存键失效后重新检查')
  assert.equal(reader.read('missing'), undefined, '模块目录不存在 = 不可用')
  rmSync(join(dir, 'assets', 'manifest.yml'))
  assert.equal(reader.read('facts'), undefined, '清单缺失 = 不可用')
})

test('坏 YAML 清单是不可用，不是检查失败', () => {
  const dir = fixture('broken-manifest')
  writeFileSync(join(dir, 'assets', 'manifest.yml'), 'checks: [')
  assert.equal(createManifestCheckReader(moduleRoot).read('broken-manifest'), undefined)
})

test('改 manifest 的 kind 立即生效，不因检查文件未变而沿用旧结论', () => {
  const dir = fixture('manifest-change')
  writeFileSync(join(dir, 'data', 'x.jsonl'), 'not json\n')
  const reader = createManifestCheckReader(moduleRoot)
  assert.equal(reader.read('manifest-change'), false)
  writeFileSync(join(dir, 'assets', 'manifest.yml'), 'checks:\n  - path: data/x.jsonl\n    kind: file\n    maxBytes: 1024\n')
  assert.equal(reader.read('manifest-change'), true, 'manifest 变更必须使结果缓存失效')
})

test('规则 manifest 条件在挂载期绑定清单事实：失败为真、通过为假、准备期为不可用', () => {
  const dir = fixture('rule-facts')
  const rules = [{
    id: 'check', layer: 'system-section', if: { manifest: { ok: false } },
    then: [{ id: 'inject', kind: 'inject-text', config: { id: 'check', strategy: 'static', layer: 'system-section', text: 'FAILED' } }],
  }]
  const [rule] = compileRules(rules, { moduleId: 'rule-facts' })
  assert.equal(rule.when(), UNAVAILABLE, '准备期没有挂载 scope 的清单服务')
  rebindConditions([{ moduleId: 'rule-facts', rules: [rule] }], { manifestCheck: createManifestCheckReader(moduleRoot), moduleId: 'rule-facts' })
  assert.equal(rule.when(), true, '检查项文件缺失时条件命中')
  writeFileSync(join(dir, 'data', 'x.jsonl'), '{"a":1}\n')
  assert.equal(rule.when(), false, '检查通过后不再命中')
  const badThen = [{ id: 'inject', kind: 'inject-text', config: { id: 'bad', strategy: 'static', layer: 'system-section', text: 'BAD' } }]
  assert.throws(() => compileRules([{ id: 'bad', layer: 'system-section', if: { manifest: { ok: 'yes' } }, then: badThen }], { moduleId: 'rule-facts' }),
    /ok must be a boolean/)
})
