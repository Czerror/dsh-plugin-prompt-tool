import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureWebSurface } from '../../lib/index.mjs'

function makeProfile(root, { bundles = ['@deepseek-ai/dsh-base'] } = {}) {
  const profileDir = join(root, 'prompt-tool')
  mkdirSync(profileDir, { recursive: true })
  const manifest = { name: 'prompt-tool', dsh: { profile: { bundles } } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { profileDir, manifest }
}

function ctxFor(profileDir, webServer) {
  return {
    baseUrl: pathToFileURL(profileDir + '/').href,
    get: (key) => key === 'webServer' ? webServer : undefined,
  }
}

test('ensureWebSurface 为当前 profile 补 web-app 并写 .bak 备份', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir, manifest } = makeProfile(root)
    const warnings = []
    ensureWebSurface(ctxFor(profileDir, undefined), (message) => warnings.push(message))

    const updated = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.ok(updated.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'))
    assert.ok(existsSync(join(profileDir, 'package.json.bak')))
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json.bak'), 'utf8')), manifest)
    assert.ok(warnings.some((message) => message.includes('please restart')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureWebSurface 不修改同级 profile', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir } = makeProfile(root)
    for (const name of ['web', 'dsh-tui']) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      const original = { name, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(original, null, 2) + '\n', 'utf8')
    }
    ensureWebSurface(ctxFor(profileDir, undefined), () => {})

    for (const name of ['web', 'dsh-tui']) {
      const content = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
      assert.equal(content.name, name)
      assert.deepEqual(content.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureWebSurface 在 webServer 已存在时不修改 manifest', () => {
  const root = join(tmpdir(), `prompt-tool-web-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const { profileDir, manifest } = makeProfile(root)
    ensureWebSurface(ctxFor(profileDir, {}), () => {})
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')), manifest)
    assert.equal(existsSync(join(profileDir, 'package.json.bak')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
