import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'yaml'

const previousHome = process.env.DSH_HOME
const home = mkdtempSync(join(process.cwd(), 'pt-layer-contract-save-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { validatePromptConfigs } = await import('../../src/runtime/configs-validate.ts')
const { validateCharacterSpec } = await import('../../src/host/import-source.ts')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
after(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

let sequence = 0
function harness(original) {
  const id = `contract-${++sequence}`
  const dir = join(home, '.agent-presets', id)
  original = `id: ${id}\n${original}`
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'preset.yml')
  writeFileSync(file, original)
  const handlers = new Map()
  let rebuilds = 0
  const sctx = {
    get: () => undefined,
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }] },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: fn => fn(),
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(sctx) }, 'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ skillsRoot: join(home, 'skills'), folders: [], listSkills: () => [] }),
    () => '', undefined, () => dir, undefined, () => { rebuilds += 1 })
  return {
    file,
    dir,
    original,
    get rebuilds() { return rebuilds },
    async request(endpoint, body) {
      let status
      let payload
      await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS[endpoint])({
        method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' },
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
      }, { writeHead: code => { status = code }, end: text => { payload = JSON.parse(text) } })
      return { status, payload }
    },
  }
}

test('源码调用提示词校验与包运行共用引擎解析入口', async () => {
  const result = await validatePromptConfigs([{ id: 'valid', layer: 'agent-request', params: { patch: { stop: ['END'] } } }])
  assert.equal(result.valid, true)
})

test('实际保存拒绝非法九层配置且原字节不变，不触发重建', async () => {
  const original = '# comment\nunknown: keep\n'
  const target = harness(original)
  for (const spec of [
    { id: 'bad-strategy', layer: 'agent-request', strategy: 'world-book' },
    { id: 'bad-subject', layer: 'subagent-end', subject: 'toolArgs' },
    { id: 'bad-patch', layer: 'agent-request', params: { replace: true } },
    { id: 'bad-identity', identity: { field: 'kind', value: 'x' } },
    { id: '../bad-file' },
  ]) {
    const result = await target.request('paramOverrides', { promptConfigs: [spec] })
    assert.equal(result.status, 400, JSON.stringify(result.payload))
    assert.equal(result.payload.code, 'prompt-configs-invalid')
    assert.equal(readFileSync(target.file, 'utf8'), target.original)
    assert.equal(target.rebuilds, 0)
  }
})

test('保存清理只读来源和空变量键，保留有效扩展参数', async () => {
  const target = harness('')
  const result = await target.request('paramOverrides', { promptConfigs: [{
    id: 'valid', layer: 'subagent-end', text: 'done',
    params: { action: 'inject-main', extension: { keep: true } },
    variables: { '': 'draft row', keep: '' }, fieldSources: { configId: 'forged', fields: [] },
  }] })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  const [saved] = parse(readFileSync(target.file, 'utf8')).promptConfigs
  assert.equal(saved.fieldSources, undefined)
  assert.deepEqual(saved.variables, { keep: '' })
  assert.deepEqual(saved.params.extension, { keep: true })
  assert.equal(target.rebuilds, 1)
})

test('保存校验按目标预设共享引擎位置解析有效 templateFile', async () => {
  const target = harness('')
  writeFileSync(join(target.dir, 'rule.txt'), 'template content')
  const templateFile = `../${basename(target.dir)}/rule.txt`
  const result = await target.request('paramOverrides', { promptConfigs: [{ id: 'template', templateFile }] })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(parse(readFileSync(target.file, 'utf8')).promptConfigs[0].templateFile, templateFile)
})

test('无效当前层参数由统一格式守卫拒绝，读写均不伪报成功或改动原文件', async () => {
  const target = harness('layerSettings:\n  pre-step:\n    modelTemperature: 0.7\n')
  for (const [endpoint, body] of [
    ['bootstrap', undefined], ['describe', undefined], ['paramOverrides', {}],
    ['paramOverrides', { overrides: { modelTemperature: '0.8' } }],
    ['paramOverrides', { promptConfigs: [{ id: 'new', text: 'new' }] }],
    ['presetVariables', {}], ['persona', {}], ['customTools', {}], ['subagentToolPolicy', {}],
  ]) {
    const result = await target.request(endpoint, body)
    assert.equal(result.status, 400, `${endpoint}: ${JSON.stringify(result.payload)}`)
    assert.equal(result.payload.code, 'preset-layer-settings-invalid')
    assert.match(result.payload.message, /layerSettings/)
    assert.equal(readFileSync(target.file, 'utf8'), target.original)
    assert.equal(target.rebuilds, 0)
  }
})

test('旧模型和 params 字段不进入桥接读回，也不阻断当前层参数保存', async () => {
  const target = harness('params: { modelTemperature: 0.7 }\nmodel: { provider: old }\nsubagentModel: { name: old-child }\nlayerSettings:\n  agent-request:\n    modelTemperature: 0.2\n')
  for (const endpoint of ['bootstrap', 'describe', 'presetVariables', 'persona', 'customTools', 'subagentToolPolicy']) {
    const result = await target.request(endpoint, {})
    assert.equal(result.status, 200, `${endpoint}: ${JSON.stringify(result.payload)}`)
  }
  const before = await target.request('paramOverrides', {})
  assert.deepEqual(before.payload.value.overrides, { modelTemperature: 0.2 })
  const saved = await target.request('paramOverrides', { overrides: { modelTemperature: '0.8' } })
  assert.equal(saved.status, 200)
  const disk = parse(readFileSync(target.file, 'utf8'))
  assert.deepEqual(disk.params, { modelTemperature: 0.7 })
  assert.deepEqual(disk.model, { provider: 'old' })
  assert.deepEqual(disk.subagentModel, { name: 'old-child' })
  assert.equal(disk.layerSettings['agent-request'].modelTemperature, '0.8')
  assert.deepEqual((await target.request('paramOverrides', {})).payload.value.overrides, { modelTemperature: '0.8' })
})

test('角色片段忽略无消费者的旧模型段，当前参数与工具边界仍校验', () => {
  const spec = { id: 'character', name: 'Character', model: { provider: 'old' }, subagentModel: { name: 'old-child' }, promptConfigs: [] }
  assert.doesNotThrow(() => validateCharacterSpec(spec))
  assert.throws(() => validateCharacterSpec({ ...spec, customTools: [{ id: 'tool' }] }), /不支持 customTools/)
  assert.throws(() => validateCharacterSpec({ ...spec, layerSettings: { 'pre-step': { modelName: 'wrong-layer' } } }), { code: 'preset-layer-settings-invalid' })
})
