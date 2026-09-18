import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { prepareImport, normalizeAssetFiles } from '../../src/host/import-source.ts'

const native = { id: 'native', name: '原生', version: '1', engineCompat: '>=0.4.2', modules: ['prompt-config-engine'], params: { custom: false }, promptConfigs: [{ id: 'one', texts: ['甲', '乙'] }] }
const json = (path, value) => ({ path, content: JSON.stringify(value) })

test('原生 JSON 与 YAML 共用语义，保留未知字段和 YAML 注释', () => {
  const value = prepareImport([json('native.json', native)], 'preset')
  assert.equal(value.kind, 'native-preset')
  assert.deepEqual(value.spec, native)
  const yaml = prepareImport([{ path: 'preset.yml', content: '# 保留注释\nid: native\nname: 原生\nmodules: []\nx-user: keep\n' }, json('attachment.json', { prompt_order: [] })], 'preset', { targetId: 'changed' })
  assert.equal(yaml.spec.id, 'changed')
  assert.match(yaml.yaml, /# 保留注释/)
  assert.match(yaml.yaml, /x-user: keep/)
  assert.equal(yaml.files.length, 2)
})

test('拒绝未知、矛盾对象和非法字节路径，不产生空预设', () => {
  for (const value of [null, [], {}, { hello: 'world' }, { ...native, prompts: [] }]) {
    assert.throws(() => prepareImport([json('bad.json', value)], 'preset'), /bad.json/)
  }
  for (const path of ['../x.json', '/x.json', 'a:stream', 'A/../b', 'CON.json', 'a./x']) {
    assert.throws(() => normalizeAssetFiles([{ path, content: '{}' }]), /路径/)
  }
  assert.throws(() => normalizeAssetFiles([json('a.json', {}), json('A.json', {})]), /重复|冲突/)
  assert.throws(() => prepareImport([{ path: 'x.json', content: '???', encoding: 'base64' }], 'preset'), /base64/)
})

test('ST YAML 角色与原生角色片段保留 texts、控制配置，拒绝外部文件', () => {
  const st = prepareImport([{ path: 'card.yaml', content: 'spec: chara_card_v3\ndata:\n  name: Alice\n  description: hello\n' }], 'character')
  assert.equal(st.kind, 'st-character')
  const card = prepareImport([json('converted.json', native)], 'character')
  assert.equal(card.kind, 'native-character')
  assert.deepEqual(card.spec.promptConfigs, native.promptConfigs)
  assert.throws(() => prepareImport([json('card.json', { ...native, promptConfigs: [{ id: 'external', templateFile: 'rules.txt' }] })], 'character'), /external.*templateFile/)
  assert.throws(() => prepareImport([json('one.json', { data: { name: 'A' } }), json('two.json', { data: { name: 'B' } })], 'character'), /单张|一张/)
})

test('PNG 按魔数识别且保留原始字节，截断 chunk 拒绝', () => {
  const chunk = (type, data) => {
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)])
  }
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify({ data: { name: 'PNG', description: 'body' } })).toString('base64')}`)), chunk('IEND', Buffer.alloc(0))])
  const result = prepareImport([{ path: 'misnamed.dat', content: png.toString('base64'), encoding: 'base64' }], 'character')
  assert.equal(result.kind, 'st-character')
  assert.equal(createHash('sha256').update(result.avatar).digest('hex'), createHash('sha256').update(png).digest('hex'))
  assert.throws(() => prepareImport([{ path: 'bad.png', content: png.subarray(0, -3).toString('base64'), encoding: 'base64' }], 'character'), /PNG/)
})

test('ST 多来源沿显式顺序合并，报告 ID 指向最终配置，待选组不返回提交凭据', () => {
  const a = json('a.json', { prompts: [{ identifier: 'shared', content: 'A', role: 'system' }] })
  const b = json('b.json', { prompts: [{ identifier: 'shared', content: 'B', role: 'system' }] })
  const first = prepareImport([a, b], 'preset')
  const second = prepareImport([b, a], 'preset')
  assert.notEqual(first.sourceDigest, second.sourceDigest)
  assert.deepEqual(first.spec.promptConfigs.map(c => c.text), ['A', 'B'])
  assert.deepEqual(first.report.entries.filter(entry => entry.targetId).map(entry => entry.targetId), first.spec.promptConfigs.map(config => config.id))
  const choice = prepareImport([json('groups.yaml', { prompts: [{ identifier: 'a', content: 'A' }], prompt_order: [{ character_id: 1, order: [] }, { character_id: 2, order: [] }] })], 'preset')
  assert.equal(choice.state, 'needs-order-selection')
  assert.deepEqual(choice.candidates.map(candidate => candidate.characterId), ['1', '2'])
  assert.equal(choice.sourceDigest, undefined)
})

test('上传数据自带的记忆来源记录不能成为可信的导出排除证明', () => {
  const imported = prepareImport([json('native.json', { ...native, meta: { importedCharacters: ['a'], characterMemories: { a: { characterId: 'a', configId: 'one', contentHash: 'fake' } } } })], 'preset')
  assert.equal(imported.spec.meta.characterMemories, undefined)
  assert.deepEqual(imported.spec.meta.importedCharacters, ['a'])
})

test('未声明完整预设身份的自包含片段返回真实类型候选，选择后重新准备', () => {
  const file = json('fragment.json', { id: 'fragment', name: '片段', promptConfigs: [{ id: 'a', texts: ['A'] }] })
  const candidate = prepareImport([file], 'preset')
  assert.equal(candidate.state, 'needs-kind-selection')
  assert.deepEqual(candidate.kinds, ['native-preset', 'native-character'])
  assert.equal(prepareImport([file], 'preset', { sourceKind: 'native-character' }).kind, 'native-character')
  assert.equal(prepareImport([file], 'preset', { sourceKind: 'native-preset' }).kind, 'native-preset')
  assert.equal(prepareImport([file], 'character').kind, 'native-character')
  assert.throws(() => prepareImport([file], 'preset', { sourceKind: 'world-book' }), /不一致/)
})
