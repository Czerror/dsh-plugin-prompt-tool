import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

test('规则诊断hook通过bridge读取时只接受最新轮询，应答倒序不恢复旧成功', async t => {
  const pending = [], cleanups = []
  let poll, summary
  globalThis.__diagnosticHook = {
    useState(value) { summary = value; return [value, next => { summary = next }] },
    useEffect(effect) { cleanups.push(effect()) },
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === 'react' ? { url: 'fixture:diagnostic-react', shortCircuit: true } : next(specifier, context)
  }, load(url, context, next) {
    return url === 'fixture:diagnostic-react' ? { format: 'module', shortCircuit: true, source: 'export const {useState,useEffect}=globalThis.__diagnosticHook' } : next(url, context)
  } })
  t.mock.method(globalThis, 'fetch', async () => new Promise(resolve => pending.push(resolve)))
  t.mock.method(globalThis, 'setInterval', callback => { poll = callback; return 1 })
  t.mock.method(globalThis, 'clearInterval', () => {})
  t.after(() => { for (const cleanup of cleanups) cleanup?.(); hooks.deregister(); delete globalThis.__diagnosticHook })
  const { useRuleDiagnostics } = await import('../../src/client/data/use-rule-diagnostics.ts')
  useRuleDiagnostics(true)
  poll()
  const response = identityOutcome => new Response(JSON.stringify({ ok: true, value: { records: [{ moduleId: 'm', ruleId: 'r', channel: 'persona:identity:preset', hit: 0, miss: 0, unavailable: 0, error: 0, identityOutcome }] } }))
  pending[1](response('target-mismatch')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(summary.records[0].identityOutcome, 'target-mismatch')
  pending[0](response('matched')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(summary.records[0].identityOutcome, 'target-mismatch', '迟到旧匹配不得覆盖较新失配')
})
