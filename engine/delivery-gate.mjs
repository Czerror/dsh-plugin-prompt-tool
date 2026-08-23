/**
 * delivery-gate — 交付 gate 工具（参考 dsh-router-standard delivery_check
 * 机制自写，MIT）。
 *
 * 校验交付物：file-exists / file-nonempty / encoding-utf8（必查）+ headless
 * smoke（页面类：传 url；requireSmoke 默认 true——省略 url 会 FAIL）+ 证据
 * 清单（evidence.items[]：{label, kind, target?, result?, reviewed?}）。
 * 全部 PASS 才允许宣告完成；任一 FAIL 修复后重跑，不允许绕过。
 *
 * 职责分离：headless smoke 复用 page-check 模块（pageCheckRun），本模块
 * 只做文件/编码/证据结构校验——与阶段披露解耦，任意预设可挂。
 * config：requireSmoke 默认 true；description 参数化。config 错误 fail at
 * apply time；执行失败返回 FAIL 明细（不 brick 会话）。
 */

import { readFileSync, statSync } from 'node:fs'
import { booleanOption, createWarnOnce, validateConfig } from './shared.mjs'
import { pageCheckRun } from './page-check.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'delivery-gate'

/** tools（注册工具）必须就绪；subprocess 经 page-check 懒取。 */
export const inject = ['tools']

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['requireSmoke', 'description'])

const DEFAULT_DESCRIPTION = [
  'Delivery gate: verify the deliverable before declaring completion.',
  '* file: path of the deliverable (required). Checks: exists / non-empty / UTF-8.',
  '* url: page deliverables must pass a headless smoke (screenshot + DOM + console); omit only with requireSmoke:false for non-page artifacts (scripts/docs).',
  '* evidence: { items: [{ label, kind, target?, result?, reviewed? }] } — kind ∈ file|page|image|run|test|text|external.',
  '  - file/page/image/test: target (path) required; page/image must set reviewed:true (visual review).',
  '  - run/text: result (output text) required.',
  '  - external: target (validator artifact) or result (output summary) — external validator results are first-class.',
  '* Page deliverables additionally need at least one reviewed visual evidence (page/image/external).',
  '* ALL checks PASS before you may report completion; any FAIL: fix and re-run, never bypass.',
].join('\n')

/** 证据清单允许的 kind。 */
const ALLOWED_KINDS = new Set(['file', 'page', 'image', 'run', 'test', 'text', 'external'])

/** 交付校验（纯检查；headless smoke 委托 pageCheckRun）。ctx 只需 subprocess（page-check 用）。 */
export async function deliveryCheck(ctx, args) {
  const file = String(args?.file || '').trim()
  const checks = []
  if (!file) return { ok: false, checks: [{ name: 'file-path', pass: false, detail: 'missing file parameter' }] }
  try {
    const st = statSync(file)
    checks.push({ name: 'file-exists', pass: true, detail: `${file} (${st.size} bytes, mtime ${st.mtime.toISOString()})` })
    checks.push(st.size > 0
      ? { name: 'file-nonempty', pass: true, detail: `${st.size} bytes` }
      : { name: 'file-nonempty', pass: false, detail: 'file is 0 bytes' })
  } catch (e) {
    return { ok: false, checks: [...checks, { name: 'file-exists', pass: false, detail: String((e && e.message) || e) }] }
  }
  try {
    const head = readFileSync(file).subarray(0, 65536)
    new TextDecoder('utf-8', { fatal: true }).decode(head)
    checks.push({ name: 'encoding-utf8', pass: true, detail: 'UTF-8 decode OK (head 64KB)' })
  } catch (e) {
    checks.push({ name: 'encoding-utf8', pass: false, detail: String((e && e.message) || e) })
  }
  const requireSmoke = args?.requireSmoke !== false
  if (args?.url) {
    const smoke = await pageCheckRun(ctx, { ...args, url: args.url })
    checks.push({
      name: 'headless-smoke',
      pass: smoke.ok,
      detail: `title=${smoke.title || '(empty)'} dom=${smoke.domText.length} console=${smoke.consoleTail ? 'errors present' : 'clean'}${smoke.timedOut ? ' TIMED_OUT' : ''}`,
    })
  } else if (requireSmoke) {
    checks.push({ name: 'headless-smoke', pass: false, detail: 'smoke required for delivery — pass url (page deliverable); set requireSmoke:false only for non-page artifacts (scripts/docs)' })
  }
  const ev = args?.evidence
  if (!ev || !Array.isArray(ev.items) || ev.items.length === 0) {
    checks.push({ name: 'delivery-evidence', pass: false, detail: 'missing evidence items — provide at least one: {label, kind, target?, result?, reviewed?}' })
  } else {
    const failures = []
    for (const it of ev.items) {
      const label = String(it?.label || '').trim()
      const kind = String(it?.kind || '').trim()
      if (!label) { failures.push('empty label'); continue }
      if (!ALLOWED_KINDS.has(kind)) { failures.push('bad kind: ' + kind); continue }
      if (kind === 'run' || kind === 'text') {
        if (!String(it?.result || '').trim()) failures.push(kind + ' evidence without result')
        continue
      }
      if (kind === 'external') {
        const hasTarget = String(it?.target || '').trim() !== ''
        const hasResult = String(it?.result || '').trim() !== ''
        if (!hasTarget && !hasResult) failures.push('external evidence needs target (file) or result (output summary)')
        if (hasTarget) {
          try {
            const st = statSync(String(it.target))
            if (!st.isFile() || st.size <= 0) failures.push('external target not valid file: ' + st)
          } catch { failures.push('external target missing: ' + it.target) }
        }
        continue
      }
      const t = String(it?.target || '').trim()
      if (!t) { failures.push(kind + ' evidence without target'); continue }
      try {
        const st = statSync(t)
        if (!st.isFile() || st.size <= 0) failures.push('target not valid file: ' + t)
      } catch { failures.push('target missing: ' + t) }
      if ((kind === 'page' || kind === 'image') && it?.reviewed !== true) failures.push('visual not reviewed: ' + label)
    }
    if (args?.url) {
      const hasReviewedVisual = (ev.items || []).some((it) => ['page', 'image', 'external'].includes(String(it?.kind)) && it?.reviewed === true)
      if (!hasReviewedVisual) failures.push('page deliverable needs at least one reviewed visual evidence (page/image/external)')
    }
    checks.push({ name: 'delivery-evidence', pass: failures.length === 0, detail: failures.length === 0 ? 'evidence accepted (' + ev.items.length + ' item(s))' : failures.join('; ') })
  }
  return { ok: checks.every((c) => c.pass), checks }
}

function deliveryCheckRender(_args, v) {
  let text = 'delivery-check: ' + (v.ok ? 'PASS ✅' : 'FAIL ❌') + '\n'
  for (const c of v.checks || []) text += `- [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}\n`
  text += v.ok
    ? 'All checks passed — delivery gate satisfied; you may report completion to the user.'
    : 'Delivery gate NOT satisfied — do NOT report completion; fix the failing checks and re-run delivery_check.'
  return [{ type: 'text', text }]
}

/** Register the model-facing `delivery_check` tool. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const requireSmoke = booleanOption(name, source.requireSmoke, 'requireSmoke', true)
  const description = typeof source.description === 'string' && source.description.length > 0
    ? source.description
    : DEFAULT_DESCRIPTION
  const warnOnce = createWarnOnce(ctx, name)
  ctx.tools.register({
    name: 'delivery_check',
    description,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Deliverable path (required).' },
        url: { type: 'string', description: 'Page deliverable URL for the headless smoke (required unless requireSmoke:false).' },
        requireSmoke: { type: 'boolean', description: 'false = skip the headless smoke for non-page artifacts (default true).' },
        evidence: {
          type: 'object',
          description: 'Evidence manifest: { items: [{label, kind, target?, result?, reviewed?}] } — kind ∈ file|page|image|run|test|text|external.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                pass: { type: 'boolean' },
                detail: { type: 'string' },
              },
              required: ['name', 'pass', 'detail'],
            },
          },
        },
        required: ['ok', 'checks'],
      },
      render: deliveryCheckRender,
    },
    async execute(args) {
      try {
        return await deliveryCheck(ctx, { ...args, requireSmoke: args?.requireSmoke ?? requireSmoke })
      } catch (error) {
        warnOnce(`${name}: delivery_check failed, returning FAIL: ${String((error && error.message) || error)}`)
        return { ok: false, checks: [{ name: 'gate-error', pass: false, detail: String((error && error.message) || error) }] }
      }
    },
  })
}
