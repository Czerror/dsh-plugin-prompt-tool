import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-trigger-save-'))
process.env.DSH_HOME = home
const { writePreset } = await import('../../src/host/write-preset.ts')
const { invalidatePresetSpec } = await import('../../src/host/manifest.ts')
test.after(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })

test('坏动作在物化前拒绝，现有组合、正文和共享引擎保持原样', () => {
  const root = join(home, '.agent-presets')
  const directory = join(root, 'draft')
  mkdirSync(directory, { recursive: true })
  mkdirSync(join(root, '.engine'))
  const preserved = new Map([
    [join(directory, 'agent.cordis.yml'), '# existing composition\n[]\n'],
    [join(directory, 'preset.md'), 'existing text'],
    [join(root, '.engine', '.pt-engine-fingerprint'), 'existing engine'],
  ])
  for (const [file, content] of preserved) writeFileSync(file, content)
  for (const [channel, action] of [
    ['system-prompt/assemble', { kind: 'assembly', target: null }],
    ['system-prompt/assemble', { kind: 'guard', mask: { allow: [], deny: [] } }],
    ['tools/pre-execute', { kind: 'decision', phase: 'invalid' }],
    ['agent/request', { kind: 'request-params', patch: [] }],
    ['agent/inbox/inserted', { kind: 'inbox-prepend', text: null }],
  ]) {
    writeFileSync(join(directory, 'preset.yml'), stringify({
      id: 'draft', modules: [], triggers: [{ id: 'bad', channel, do: action }],
    }))
    invalidatePresetSpec(directory)
    assert.throws(() => writePreset('new text', {
      presetDir: root, presetTemplate: 'draft', outputId: 'draft', presetOrder: 5, promptConfigs: [],
    }), /invalid triggers/)
    for (const [file, content] of preserved) assert.equal(readFileSync(file, 'utf8'), content)
    assert.equal(existsSync(join(directory, 'triggers.yml')), false)
  }
})
