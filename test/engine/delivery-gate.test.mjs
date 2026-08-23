import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveryCheck, apply as applyDeliveryGate } from '../../engine/delivery-gate.mjs'

/** 无 subprocess 的桩 ctx：url 场景下 headless-smoke 走 page-check 返回 FAIL（不依赖真实浏览器）。 */
const stubCtx = { get: () => undefined, logger: { warn: () => {} } }

test('deliveryCheck：file 必填；存在/非空/UTF-8 校验矩阵', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-delivery-'))
  try {
    const okFile = join(dir, 'ok.txt')
    writeFileSync(okFile, 'hello', 'utf8')
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '')
    const badUtf8 = join(dir, 'bad.bin')
    writeFileSync(badUtf8, Buffer.from([0xff, 0xfe, 0x00, 0x80]))

    const ok = await deliveryCheck(stubCtx, { file: okFile, requireSmoke: false, evidence: { items: [{ label: 'r', kind: 'run', result: 'ok' }] } })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.checks.map((c) => c.name), ['file-exists', 'file-nonempty', 'encoding-utf8', 'delivery-evidence'])

    const missing = await deliveryCheck(stubCtx, { file: join(dir, 'nope.txt'), requireSmoke: false })
    assert.equal(missing.ok, false)
    assert.equal(missing.checks[0].pass, false)

    const emptyRes = await deliveryCheck(stubCtx, { file: empty, requireSmoke: false })
    assert.equal(emptyRes.ok, false)
    assert.equal(emptyRes.checks.find((c) => c.name === 'file-nonempty').pass, false)

    const badRes = await deliveryCheck(stubCtx, { file: badUtf8, requireSmoke: false })
    assert.equal(badRes.ok, false)
    assert.equal(badRes.checks.find((c) => c.name === 'encoding-utf8').pass, false)

    const noFile = await deliveryCheck(stubCtx, {})
    assert.equal(noFile.ok, false)
    assert.equal(noFile.checks[0].name, 'file-path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deliveryCheck：requireSmoke 默认 true（无 url FAIL）；false 跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-delivery-'))
  try {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x', 'utf8')
    const strict = await deliveryCheck(stubCtx, { file: f })
    assert.equal(strict.ok, false)
    assert.equal(strict.checks.find((c) => c.name === 'headless-smoke').pass, false, '默认要求 smoke')
    const loose = await deliveryCheck(stubCtx, { file: f, requireSmoke: false, evidence: { items: [{ label: 't', kind: 'text', result: 'ok' }] } })
    assert.equal(loose.ok, true)
    // url 场景：桩 ctx 无浏览器 → headless-smoke FAIL（降级不抛）。
    const withUrl = await deliveryCheck(stubCtx, { file: f, url: 'https://example.com' })
    assert.equal(withUrl.checks.find((c) => c.name === 'headless-smoke').pass, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deliveryCheck：evidence 清单校验矩阵', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-delivery-'))
  try {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x', 'utf8')
    const evFile = join(dir, 'ev.png')
    writeFileSync(evFile, 'fake-image', 'utf8')
    const base = { file: f, requireSmoke: false }

    const good = await deliveryCheck(stubCtx, { ...base, evidence: { items: [
      { label: 'run1', kind: 'run', result: 'pass' },
      { label: 'file1', kind: 'file', target: evFile },
      { label: 'page1', kind: 'page', target: evFile, reviewed: true },
    ] } })
    assert.equal(good.ok, true)

    const missingResult = await deliveryCheck(stubCtx, { ...base, evidence: { items: [{ label: 'r', kind: 'run' }] } })
    assert.equal(missingResult.ok, false)
    assert.match(missingResult.checks.find((c) => c.name === 'delivery-evidence').detail, /without result/)

    const unReviewed = await deliveryCheck(stubCtx, { ...base, evidence: { items: [{ label: 'p', kind: 'page', target: evFile }] } })
    assert.equal(unReviewed.ok, false)
    assert.match(unReviewed.checks.find((c) => c.name === 'delivery-evidence').detail, /visual not reviewed/)

    const badKind = await deliveryCheck(stubCtx, { ...base, evidence: { items: [{ label: 'x', kind: 'video', target: evFile }] } })
    assert.equal(badKind.ok, false)
    assert.match(badKind.checks.find((c) => c.name === 'delivery-evidence').detail, /bad kind/)

    const externalTarget = await deliveryCheck(stubCtx, { ...base, evidence: { items: [{ label: 'e', kind: 'external', target: evFile, reviewed: true }] } })
    assert.equal(externalTarget.ok, true)

    const noEvidence = await deliveryCheck(stubCtx, base)
    assert.equal(noEvidence.ok, false)
    assert.match(noEvidence.checks.find((c) => c.name === 'delivery-evidence').detail, /missing evidence/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delivery-gate apply：注册 delivery_check 工具；unknown key fail loud', () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) }, logger: { warn: () => {} } }
  applyDeliveryGate(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'delivery_check')
  assert.ok(registered[0].description.includes('Delivery gate'))
  assert.throws(() => applyDeliveryGate(ctx, { nope: 1 }), /unknown config key/)
})
