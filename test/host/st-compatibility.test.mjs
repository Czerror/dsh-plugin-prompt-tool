import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, Document } from 'yaml'
import { convertStToPreset, mergeStPresets } from '../../src/host/sillytavern.ts'
import { importCharacterCard, applyCharacterToPreset, removeCharacterFromPreset } from '../../src/host/characters.ts'

test('ST 官方嵌套 prompt_order 决定启停和次序，缺席条目不误启用', () => {
  const spec = convertStToPreset({
    prompts: ['a', 'b', 'c', 'd'].map(identifier => ({ identifier, role: 'system', content: identifier, enabled: identifier !== 'c' })),
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'b', enabled: true }] },
      { character_id: 100001, order: [{ identifier: 'c', enabled: true }, { identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }],
  }, 'ordered')
  const configs = spec.promptConfigs
  assert.deepEqual(configs.filter(c => c.enabled).sort((a, b) => a.order - b.order).map(c => c.id), ['c', 'a'])
  assert.equal(configs.find(c => c.id === 'd').enabled, false)
})

test('ST 纯赋值卡保留源与开关，禁用卡不进入默认变量', () => {
  const spec = convertStToPreset({ prompts: [
    { identifier: 'on', role: 'system', enabled: true, content: '{{setvar::rule::BASE}}' },
    { identifier: 'off', role: 'system', enabled: false, content: '{{addvar::rule::-DISABLED}}' },
    { identifier: 'out', role: 'system', content: '{{getvar::rule}}' },
  ] }, 'variables')
  assert.equal(spec.promptConfigs.length, 3)
  assert.equal(spec.promptConfigs.find(c => c.id === 'off').enabled, false)
  assert.match(spec.promptConfigs.find(c => c.id === 'off').text, /addvar/)
  assert.notEqual(spec.variables?.rule, 'BASE-DISABLED')
})

test('合并变量默认值保留；每个来源的同名内容变量只绑定自身卡片', () => {
  const part = (id, tone) => ({ id, name: id, version: '1', engineCompat: '*', variables: { tone }, promptConfigs: [{ id: 'text', text: '{{tone}}' }] })
  const merged = mergeStPresets([part('a', 'A'), part('b', 'B')])
  assert.ok(merged.variables)
  assert.deepEqual(merged.promptConfigs.map(c => c.variables.tone), ['A', 'B'])
  assert.deepEqual(mergeStPresets([{ ...part('a', 'A'), meta: { stWarnings: ['LIMIT'] } }, part('b', 'B')]).meta.stWarnings, ['LIMIT'])
})

test('角色应用把变量绑定到卡片，移除不破坏预设原变量', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-st-variable-'))
  try {
    mkdirSync(join(root, 'target'))
    const file = join(root, 'target', 'preset.yml')
    writeFileSync(file, new Document({ id: 'target', name: 'target', modules: ['prompt-config-engine'], variables: { tone: 'HOST' }, promptConfigs: [] }).toString())
    const imported = importCharacterCard(root, [{ path: 'card.json', content: JSON.stringify({ data: { name: 'Card', description: 'DESC', system_prompt: '{{description}}' } }) }])
    assert.equal(imported.ok, true)
    assert.equal(applyCharacterToPreset(root, 'target', imported.id).ok, true)
    const applied = parse(readFileSync(file, 'utf8'))
    assert.equal(applied.variables.tone, 'HOST')
    assert.ok(applied.promptConfigs.some(c => c.variables?.description === 'DESC'))
    assert.equal(removeCharacterFromPreset(root, 'target', imported.id).ok, true)
    assert.deepEqual(parse(readFileSync(file, 'utf8')).variables, { tone: 'HOST' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('角色卡 mes_example 保留角色、次序和一次性身份，不吞示例正文', () => {
  const spec = convertStToPreset({ data: { name: 'Ada', mes_example: '<START>\n{{user}}: QUESTION\n{{char}}: ANSWER\n<START>\nUser: NEXT\nAda: REPLY', first_mes: 'HELLO' } }, 'examples')
  const examples = spec.promptConfigs.filter(c => c.id.startsWith('dialogue-example-'))
  assert.deepEqual(examples.map(c => [c.role, c.text]), [['user', 'QUESTION'], ['assistant', 'ANSWER'], ['user', 'NEXT'], ['assistant', 'REPLY']])
  assert.ok(examples.every(c => c.dedupe === 'session' && c.order < -40))
})

test('日期宏不登记空值；转换不修改输入对象或执行扩展代码', () => {
  const input = { data: { name: 'Ada', system_prompt: '{{date}} {{time}}', extensions: { regex_scripts: [{ content: 'CODE' }] } } }
  const snapshot = structuredClone(input)
  const spec = convertStToPreset(input, 'time')
  assert.deepEqual(input, snapshot)
  assert.equal(spec.variables?.date, undefined)
  assert.equal(spec.variables?.time, undefined)
  assert.equal(spec.meta.stWarnings.length, 1)
})
