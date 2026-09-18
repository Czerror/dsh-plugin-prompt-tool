import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createSkillsProvider } from '../../src/host/skills-provider.ts'

test('官方引用 provider：缺失根创建、删除和恢复均使真实 registry 缓存失效，释放后无晚到事件', async () => {
  const temporary = mkdtempSync(join(process.cwd(), 'pt-provider-'))
  const root = join(temporary, 'missing', 'nested', 'skills')
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  let provider
  let changes = 0
  const stopEvents = ctx.on('skills/change', () => { changes++ })
  const unregister = registry.registerProvider((control) => {
    provider = createSkillsProvider(ctx, control, [root])
    return provider
  })
  const write = (name) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`)
  }
  const changed = async (before) => {
    const deadline = Date.now() + 5000
    while (changes === before && Date.now() < deadline) await delay(25)
    assert.ok(changes > before, '必须由 watcher 触发失效，等待期间不查询 registry')
  }
  try {
    assert.deepEqual(await registry.list(), [])
    let before = changes
    write('created')
    await changed(before)
    assert.deepEqual((await registry.list()).map((skill) => skill.name), ['created'])
    assert.equal((await registry.get('created')).content, 'body')
    before = changes
    rmSync(root, { recursive: true })
    await changed(before)
    assert.deepEqual(await registry.list(), [])
    before = changes
    write('restored')
    await changed(before)
    assert.deepEqual((await registry.list()).map((skill) => skill.name), ['restored'])
    unregister()
    await provider.dispose()
    before = changes
    write('after-dispose')
    await delay(350)
    assert.equal(changes, before)
    assert.deepEqual(await registry.list(), [])
  } finally {
    unregister()
    await provider?.dispose?.()
    stopEvents()
    rmSync(temporary, { recursive: true, force: true })
  }
})
