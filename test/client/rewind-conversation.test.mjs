import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { installRewindConversation } from '../../src/client/data/rewind-conversation.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const version = require('@deepseek-ai/dsh-client-ui-conversation/package.json').version
const archives = new Map()
// Client-only support packages are in the existing fixed package graph, not Node runtime dependencies.
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-client-store' || specifier === '@deepseek-ai/dsh-util-values') {
    let url = archives.get(specifier)
    if (url === undefined) {
      const name = specifier.slice('@deepseek-ai/'.length)
      const archive = fileURLToPath(new URL(`../../.scratch/harness/packages/deepseek-ai-${name}-${version}.tgz`, import.meta.url))
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar'
      let source = execFileSync(tar, ['-xOf', archive, 'package/lib/index.js'], { encoding: 'utf8', windowsHide: true })
      if (name === 'dsh-client-store') {
        // This target has no groups: retain the actual notifier; fail if a grouping store is used.
        const parsed = ts.createSourceFile('official-store.js', source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.JS)
        const notify = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'notifySubscribers')
        assert.ok(notify, 'locked official store must export its self-contained notifier')
        const declared = new Set(['notifySubscribers', 'console']), referenced = new Set()
        const inspect = node => {
          if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
            assert.ok(ts.isIdentifier(node.name), 'unexpected notifier binding shape')
            declared.add(node.name.text)
          }
          if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) referenced.add(node.text)
          ts.forEachChild(node, inspect)
        }
        inspect(notify)
        for (const identifier of referenced) assert.ok(declared.has(identifier), `notifier is not self-contained: ${identifier}`)
        source = `${notify.getText(parsed)}\nexport { notifySubscribers }; export function createSnapshotStore() { throw new Error('Grouping is outside this fixture'); }`
      }
      url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
      archives.set(specifier, url)
    }
    return { url, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText }
  return next(url, context)
} })
const { ConversationNodeAssembler } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts')).href)
loader.deregister()

const at = (seq, type, data = {}) => ({ type: type === 'assistant/live-chunk' ? 'transient' : 'event', event: { seq, type, time: seq, data } })
const marker = seq => at(seq, 'user/message', { id: 'rewind-pt-00000000-0000-0000-0000-000000000000', role: 'user', source: { kind: 'user' }, content: [] })
function fixture(initial) {
  let starts = 0
  const events = { entries: () => [{ kind: 'messages', target: 'probe', match: event => event.type.endsWith('/message') || event.type === 'assistant/live-chunk' ? { id: String(event.seq), role: 'start' } : null,
    start: (_context, match) => { starts++; return match.event.seq }, update: context => context.state,
    publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
    buildViewNode: context => ({ key: context.key, kind: context.kind, id: context.id, target: 'probe', data: context.start === undefined ? undefined : context.state }),
  }], fallbackEntry: () => undefined }
  const views = { entries: () => [{ target: 'probe', create: () => { let current = []; return { empty: current,
    replace: ({ nodes }) => (current = nodes.filter(node => node.data !== undefined).map(node => node.data)), apply: ({ upserts }) => {
      const values = new Set(current)
      for (const node of upserts) { if (node.data === undefined) values.delete(Number(node.id)); else values.add(node.data) }
      return (current = [...values].sort((a, b) => a - b))
    },
  } } }] }
  const groups = { entries: () => [], forTarget: () => undefined }
  const owner = new ConversationNodeAssembler(events, views, groups)
  owner.activateTarget('probe')
  const session = { sessionId: 's', eventSource: { getSnapshot: () => ({ entries: initial, hasMore: false }) } }
  const binding = { snapshot: { getSnapshot: () => ({ views: owner }) } }
  const service = { events, views, groups, binding: () => binding }
  const dispose = installRewindConversation(service, () => session)
  service.binding('s')
  return { owner, dispose, starts: () => starts, values: () => owner.snapshot('probe') }
}

test('回退适配保留真实assembler的增量流式发布节奏，不重放既有消息', () => {
  const f = fixture(Array.from({ length: 1000 }, (_, i) => at(i, 'assistant/message')))
  const initialStarts = f.starts()
  for (let i = 0; i < 20; i++) assert.equal(f.owner.append(at(1000 + i / 100, 'assistant/live-chunk', { attemptId: 'a' })), 'animation-frame')
  f.owner.flush()
  assert.equal(f.starts() - initialStarts, 20)
  assert.equal(f.values().length, 1020)
  f.dispose()
})

test('回退标记裁切、同轮续写、乱序与分页重放保留真实会话视图', () => {
  const f = fixture([at(1, 'turn/start', { turn: 1 }), at(2, 'step/start', { turn: 1, step: 1 }), at(3, 'user/message'), at(4, 'assistant/message')])
  const cut = marker(5)
  cut.event.surfaceOp = { op: 'replace', startSeq: 3, endSeq: 4 }
  cut.event.sourceEventSeqs = [3, 4]
  f.owner.append(cut); f.owner.flush()
  assert.deepEqual(f.values(), [])
  f.owner.append(at(6, 'assistant/message')); f.owner.flush()
  assert.deepEqual(f.values(), [6]); assert.equal(f.owner.openTurn(), 1)
  assert.equal(f.owner.append(at(3, 'user/message')), 'none')
  f.owner.append(at(8, 'turn/start', { turn: 2 }))
  f.owner.append(at(10, 'assistant/message')); f.owner.append(at(9, 'user/message')); f.owner.flush()
  assert.deepEqual(f.values(), [6, 9, 10])
  f.owner.prepend([at(0, 'assistant/message')], true); f.owner.flush()
  assert.deepEqual(f.values(), [0, 6, 9, 10])
  f.owner.replaceWindow([at(20, 'turn/start', { turn: 3 }), at(21, 'user/message')], false); f.owner.flush()
  assert.deepEqual(f.values(), [21])
  assert.equal(f.owner.append(at(22, 'assistant/live-chunk', { attemptId: 'b' })), 'animation-frame')
  f.dispose()
})

test('回复结算后回退重放不复活瞬时chunk，释放恢复原有方法', () => {
  const f = fixture([at(1, 'turn/start', { turn: 1 })])
  f.owner.append(at(2.1, 'assistant/live-chunk', { attemptId: 'a' })); f.owner.flush()
  f.owner.settleAssistant('a', at(3, 'assistant/message')); f.owner.flush()
  assert.deepEqual(f.values(), [3])
  const cut = marker(4)
  cut.event.surfaceOp = { op: 'replace', startSeq: 3, endSeq: 3 }; cut.event.sourceEventSeqs = [3]
  f.owner.append(cut); f.owner.flush()
  assert.deepEqual(f.values(), [])
  f.dispose()
  for (const name of ['append', 'prepend', 'replaceWindow', 'settleAssistant']) assert.equal(Object.hasOwn(f.owner, name), false)
})
