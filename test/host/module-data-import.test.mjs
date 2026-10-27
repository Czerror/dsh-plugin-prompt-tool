import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { previewModuleDataImport, applyModuleDataImport } from '../../src/host/module-data-import.ts'
import { registerTuiCommand } from '../../src/runtime/tui.ts'
import { expandModuleSource, exportModulePackage } from '../../src/host/module-package.ts'

const { home, moduleRoot } = isolatedHome('pt-data-import-')

function fixture(id) {
  const dir = join(moduleRoot, id), source = join(home, id + ' source  files')
  mkdirSync(dir, { recursive: true })
  mkdirSync(source)
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  return { dir, source }
}

test('书房导入命令预览不写盘，只补用户选中的缺失数据并保留原件，重新预览后幂等', async () => {
  const { dir, source } = fixture('import-study')
  writeFileSync(join(source, '02-墨.jsonl'), '{"type":"fact","text":"ORIGINAL"}\n')
  writeFileSync(join(source, 'private.md'), 'PRIVATE')
  writeFileSync(join(source, 'unselected.md'), 'NOT SELECTED')
  let handler
  registerTuiCommand({ inject: (_deps, callback) => callback({ commands: { register: command => { handler = command.handler } } }) },
    'prompt-tool', () => ({ skillCatalog: [], activeSkillsDirs: [] }), () => ({}), async () => ({}),
    id => id === 'import-study' ? dir : '')
  const request = { moduleId: 'import-study', sourceDirectory: source, paths: ['02-墨.jsonl', 'private.md'] }
  const call = value => handler({ rawInput: 'data-import ' + JSON.stringify(value), agent: { id: 'user-session' } })
  const preview = await call(request)
  assert.equal(preview.kind, 'success', preview.text)
  const plan = JSON.parse(preview.text)
  assert.deepEqual(plan.entries.map(({ path, state }) => [path, state]), [['data/02-soul.jsonl', 'create'], ['data/private.md', 'create']])
  assert.equal(existsSync(join(dir, 'data')), false, '预览不创建data或暂存目录')
  const applied = await call({ ...request, expectedRevision: plan.revision })
  assert.equal(applied.kind, 'success', applied.text)
  assert.equal(readFileSync(join(dir, 'data', '02-soul.jsonl'), 'utf8'), '{"type":"fact","text":"ORIGINAL"}\n')
  assert.equal(readFileSync(join(source, '02-墨.jsonl'), 'utf8'), '{"type":"fact","text":"ORIGINAL"}\n')
  assert.equal(existsSync(join(dir, 'data', '02-墨.jsonl')), false)
  assert.equal(existsSync(join(dir, 'data', 'unselected.md')), false)
  const again = previewModuleDataImport(dir, request)
  assert.deepEqual(again.entries.map(entry => entry.state), ['skip', 'skip'])
  applyModuleDataImport(dir, { ...request, expectedRevision: again.revision })
  writeFileSync(join(source, 'private.md'), 'DIFFERENT')
  const conflict = previewModuleDataImport(dir, request)
  assert.equal(conflict.entries[1].state, 'conflict')
  applyModuleDataImport(dir, { ...request, expectedRevision: conflict.revision })
  assert.equal(readFileSync(join(dir, 'data', 'private.md'), 'utf8'), 'PRIVATE', '冲突只报告并跳过，不覆盖')
  const sharePreview = await exportModulePackage(moduleRoot, { id: request.moduleId, mode: 'zip', preview: true })
  const exported = await exportModulePackage(moduleRoot, { id: request.moduleId, mode: 'zip', expectedRevision: sharePreview.revision })
  const files = await expandModuleSource([{ path: 'module.zip', content: exported.content, encoding: 'base64' }])
  assert.deepEqual(files.map(file => file.path), ['module.yml'], '真实默认分享包不包含导入的私有data')
})

test('新建书房先预览manifest，只补缺失资产并保留用户内容，初始化可重复', () => {
  const { dir } = fixture('new-study')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'manifest.yml'), 'dirs: [data/archive]\nfiles:\n  - from: assets/seed.md\n    to: data/AGENTS.md\n')
  writeFileSync(join(dir, 'assets', 'seed.md'), 'SEED')
  const request = { moduleId: 'new-study', initialize: true }
  const preview = previewModuleDataImport(dir, request)
  assert.equal(existsSync(join(dir, 'data')), false)
  assert.deepEqual(preview.entries.map(({ path, state }) => [path, state]), [['data/archive', 'create'], ['data/AGENTS.md', 'create']])
  applyModuleDataImport(dir, { ...request, expectedRevision: preview.revision })
  assert.equal(existsSync(join(dir, 'data', 'archive')), true)
  assert.equal(readFileSync(join(dir, 'data', 'AGENTS.md'), 'utf8'), 'SEED')
  writeFileSync(join(dir, 'data', 'AGENTS.md'), 'USER TEXT')
  const repeated = previewModuleDataImport(dir, request)
  assert.deepEqual(repeated.entries.map(entry => entry.state), ['skip', 'conflict'])
  applyModuleDataImport(dir, { ...request, expectedRevision: repeated.revision })
  assert.equal(readFileSync(join(dir, 'data', 'AGENTS.md'), 'utf8'), 'USER TEXT')
})

test('导入拒绝过期来源/目标、越界、链接、超限与双账本，候选写入失败保持旧目录完整', () => {
  const { dir, source } = fixture('guard-study')
  writeFileSync(join(source, 'good.md'), 'GOOD')
  const request = { moduleId: 'guard-study', sourceDirectory: source, paths: ['good.md'] }
  const preview = previewModuleDataImport(dir, request)
  writeFileSync(join(source, 'good.md'), 'CHANGED')
  assert.throws(() => applyModuleDataImport(dir, { ...request, expectedRevision: preview.revision }), /预览已过期/)
  writeFileSync(join(source, 'good.md'), 'GOOD')
  writeFileSync(join(dir, 'unknown.md'), 'KEEP USER FILE')
  assert.throws(() => applyModuleDataImport(dir, { ...request, expectedRevision: preview.revision }), /预览已过期/)
  assert.equal(existsSync(join(dir, 'data')), false)
  for (const paths of [['../good.md'], ['data/../../good.md'], ['/good.md'], ['good.md', 'good.md']]) {
    assert.throws(() => previewModuleDataImport(dir, { ...request, paths }), /非法资源路径|重复或冲突/)
  }
  assert.throws(() => previewModuleDataImport(dir, { ...request, extra: 'bad' }), /未知字段/)
  assert.throws(() => previewModuleDataImport(dir, { ...request, moduleId: 'wrong' }), /不存在|主语/)
  assert.throws(() => applyModuleDataImport(dir, request), /预览已过期/)
  symlinkSync(source, join(home, 'source-link'), 'junction')
  assert.throws(() => previewModuleDataImport(dir, { ...request, sourceDirectory: join(home, 'source-link') }), /链接/)
  writeFileSync(join(source, 'big.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
  assert.throws(() => previewModuleDataImport(dir, { ...request, paths: ['big.md'] }), /8 MiB/)
  writeFileSync(join(source, 'bad-utf8.md'), Buffer.from([0xff]))
  assert.throws(() => previewModuleDataImport(dir, { ...request, paths: ['bad-utf8.md'] }), /UTF-8|utf-8|encoded/i)

  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, 'data', '02-墨.jsonl'), 'LEGACY')
  writeFileSync(join(source, '02-墨.jsonl'), 'SOURCE')
  assert.throws(() => previewModuleDataImport(dir, { ...request, paths: ['02-墨.jsonl'] }), /旧账本/, '拒绝让现有旧账本旁出现第二权威账本')
  assert.equal(existsSync(join(dir, 'data', '02-soul.jsonl')), false)

  writeFileSync(join(source, 'fail.md'), 'FAIL')
  const atomic = { ...request, paths: ['good.md', 'fail.md'] }
  const approved = previewModuleDataImport(dir, atomic)
  const originalWrite = fs.writeFileSync
  mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).includes('.install-') && String(path).endsWith('fail.md')) throw new Error('INJECTED DISK FAILURE')
    return originalWrite(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => applyModuleDataImport(dir, { ...atomic, expectedRevision: approved.revision }), /INJECTED DISK FAILURE/)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(join(dir, 'data', 'good.md')), false, '候选已写的第一份文件没有生效')
  assert.equal(readFileSync(join(dir, 'unknown.md'), 'utf8'), 'KEEP USER FILE')
  assert.equal(readFileSync(join(dir, 'data', '02-墨.jsonl'), 'utf8'), 'LEGACY')
})
