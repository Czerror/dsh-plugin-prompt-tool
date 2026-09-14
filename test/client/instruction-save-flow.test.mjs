// 指令文件保存链路（W1 客户端侧）：
// - 未修改的文件不写盘，预设保存不把文件卡写进 preset.yml；
// - debounce 自动保存与预设切换绝不写文件（文件只能显式保存）；
// - 版本冲突保留草稿并要求重新读取，重新读取恢复可写；
// - 保存成功只更新请求快照基线，期间的新输入仍 dirty。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'

const require = createRequire(new URL('../../package.json', import.meta.url))
const React = require('react')
const { renderToString } = require('react-dom/server')

const okResponse = (payload) => new Response(JSON.stringify(payload))

const fileCard = (over = {}) => ({
  id: 'agents-file-f1',
  name: 'AGENTS：AGENTS.md',
  enabled: true,
  layer: 'pre-step',
  strategy: 'placeholder',
  sourceKind: 'instruction-file',
  form: 'instructions',
  fill: 'instruction-hint',
  position: 'after-user',
  params: {
    scope: 'project',
    file: 'D:/repo/AGENTS.md',
    displayPath: 'AGENTS.md',
    fileId: 'f1',
    revision: 'r1',
    readStatus: 'ready',
    text: 'V1',
  },
  ...over,
})

const fileSnapshot = (over = {}) => ({
  fileId: 'f1',
  path: 'D:/repo/AGENTS.md',
  displayPath: 'AGENTS.md',
  scope: 'project',
  status: 'ready',
  text: 'V1',
  revision: 'r1',
  ...over,
})

const bootstrapPayload = (options = {}) => ({
  ok: true,
  value: { value: { presetTemplate: options.presetTemplate ?? 'A' }, base: {}, revision: 1 },
  promptConfigs: { promptConfigs: options.cards ?? [fileCard()] },
  instructions: {
    context: { contextId: options.contextId ?? 'ctx-1', cwd: 'D:/repo', source: 'session' },
    files: options.files ?? [fileSnapshot()],
    owner: { officialInstructions: options.ownerOfficialInstructions ?? null },
  },
})

const makeSettings = () => ({
  scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) },
  ensure: async () => {},
  mutate: async () => {},
})

const policyValues = (over = {}) => ({ order: 30, position: 'after-user', promotion: 'none', audience: null, modelScope: 'all', ...over })

const policyPayload = (files = {}, over = {}) => ({
  ok: true,
  value: { policy: { enabled: true, defaults: policyValues(), files }, revision: 'pol-1', exists: true, ...over },
})

const makeApi = (options = {}) => ({
  sessionModel: { snapshot: () => ({}) },
  currentSessionId: () => options.sessionId ?? 'sess-1',
  switchPreset: async (id) => {
    options.onSwitch?.(id)
    return { applied: true }
  },
})

const mountStore = (api, settings) => {
  let store
  function Probe() {
    store = usePromptToolStore(api, settings)
    return null
  }
  renderToString(React.createElement(Probe))
  return store
}

/** 统一的 fetch 替身：bootstrap 走 payload，其余端点走 handler。 */
const installFetch = (requests, handler) => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    const body = JSON.parse(init?.body ?? '{}')
    requests.push({ endpoint, body })
    if (endpoint === 'bootstrap') {
      return okResponse(typeof handler.bootstrap === 'function' ? handler.bootstrap(body) : handler.bootstrap ?? bootstrapPayload())
    }
    if (endpoint === 'instructions-policy') {
      return okResponse(typeof handler.instructionsPolicy === 'function' ? handler.instructionsPolicy(body) : handler.instructionsPolicy ?? policyPayload())
    }
    const payload = handler[endpoint]
    return okResponse(typeof payload === 'function' ? payload(body) : payload ?? { ok: true, value: {} })
  }
  return () => { globalThis.fetch = original }
}

const fileCalls = (requests) => requests.filter(({ endpoint }) => endpoint === 'agents-file')

test('未修改的指令文件不写盘，文件卡也不进 preset.yml', async () => {
  const requests = []
  const restore = installFetch(requests, {})
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    assert.equal(store.getFields().promptConfigs[0].text, 'V1')
    await store.persistConfigs(store.getFields().promptConfigs)
    assert.deepEqual(fileCalls(requests), [])
    const presetWrite = requests.filter(({ endpoint }) => endpoint === 'param-overrides').at(-1)
    assert.deepEqual(presetWrite.body.promptConfigs.map((config) => config.id), [])
    assert.equal(store.dirtyInstructions, false)
  } finally {
    restore()
  }
})

test('debounce 自动保存路径不写文件，只把草稿标记为未保存', async () => {
  const requests = []
  const restore = installFetch(requests, {})
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const cards = store.getFields().promptConfigs.map((config) => ({ ...config, text: 'V2 draft' }))
    store.patch({ promptConfigs: cards })
    await store.persistConfigs(cards, { includeInstructions: false })
    assert.deepEqual(fileCalls(requests), [])
    const draft = store.getInstructionPool().drafts[0]
    assert.equal(draft.content, 'V2 draft')
    assert.equal(draft.content !== draft.savedContent, true)
  } finally {
    restore()
  }
})

test('显式保存只提交 dirty 文件并带 contextId/expectedRevision；冲突保留草稿且不重发', async () => {
  const requests = []
  const restore = installFetch(requests, {
    'agents-file': { ok: false, code: 'agents-file-conflict', message: '文件已被外部修改，保存被拒绝' },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'my draft' })) })
    await store.persistInstructionFiles(['f1'])
    const calls = fileCalls(requests)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, {
      sessionId: 'sess-1',
      contextId: 'ctx-1',
      fileId: 'f1',
      expectedRevision: 'r1',
      content: 'my draft',
    })
    const card = store.getFields().promptConfigs[0]
    assert.equal(card.text, 'my draft', '冲突不得丢草稿')
    assert.equal(card.contentConflict, true)
    assert.equal(card.contentStatus, 'ready')
    const poolDraft = store.getInstructionPool().drafts[0]
    assert.equal(poolDraft.content !== poolDraft.savedContent, true, '冲突后草稿仍视为未保存')
    // 冲突未解决前不再重复发送注定 409 的请求。
    await store.persistInstructionFiles(['f1'])
    assert.equal(fileCalls(requests).length, 1)
  } finally {
    restore()
  }
})

test('重新读取采纳磁盘版本，清除冲突后可再次保存', async () => {
  const requests = []
  const restore = installFetch(requests, {
    'agents-file': { ok: false, code: 'agents-file-conflict', message: '文件已被外部修改，保存被拒绝' },
    'prompt-configs': { ok: true, value: { instructions: { context: { contextId: 'ctx-1', cwd: 'D:/repo', source: 'session' }, files: [fileSnapshot({ text: 'V2 disk', revision: 'r2' })] } } },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'my draft' })) })
    await store.persistInstructionFiles(['f1'])
    await store.reloadInstructionFile('f1')
    const card = store.getFields().promptConfigs[0]
    assert.equal(card.text, 'V2 disk')
    assert.equal(card.contentConflict, undefined)
    assert.equal(card.contentDirty, false)
    assert.equal(store.dirtyInstructions, false)
    // 重新读取后再编辑：请求使用磁盘最新版本。
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'V3 draft' })) })
    await store.persistInstructionFiles(['f1'])
    assert.equal(fileCalls(requests).at(-1).body.expectedRevision, 'r2')
  } finally {
    restore()
  }
})

test('保存成功只更新请求快照基线，期间继续编辑仍 dirty', async () => {
  const requests = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    const body = JSON.parse(init?.body ?? '{}')
    requests.push({ endpoint, body })
    if (endpoint === 'bootstrap') return okResponse(bootstrapPayload())
    if (endpoint === 'agents-file') {
      await gate
      return okResponse({ ok: true, value: { fileId: 'f1', revision: 'r9' } })
    }
    return okResponse({ ok: true, value: {} })
  }
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'first' })) })
    const saving = store.persistInstructionFiles(['f1'])
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'second' })) })
    release()
    await saving
    const draft = store.getInstructionPool().drafts[0]
    assert.equal(draft.savedContent, 'first')
    assert.equal(draft.content, 'second')
    assert.equal(draft.revision, 'r9')
    assert.equal(draft.saving, false)
    assert.equal(draft.content !== draft.savedContent, true, '新输入仍 dirty')
    await store.persistInstructionFiles(['f1'])
    assert.deepEqual(fileCalls(requests).at(-1).body.expectedRevision, 'r9')
  } finally {
    globalThis.fetch = original
  }
})

test('预设切换不隐式保存文件，草稿跨预设保留', async () => {
  const requests = []
  const restore = installFetch(requests, {
    bootstrap: bootstrapPayload({ cards: [fileCard({ text: 'V1' })], presetTemplate: 'A' }),
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: store.getFields().promptConfigs.map((config) => ({ ...config, text: 'kept draft' })) })
    await store.setPresetTemplate('B')
    assert.deepEqual(fileCalls(requests), [], '切换预设不得写文件')
    assert.equal(store.getInstructionPool().drafts[0].content, 'kept draft', '文件草稿跨预设保留')
  } finally {
    restore()
  }
})

test('负责人冲突：服务端说官方指令行仍在 → 卡片显示冲突，false/null 不显示', async () => {
  const cases = [
    [true, true, '官方指令行仍在 → 独立来源本次不注入，必须有提示'],
    [false, undefined, '插件独立来源负责 → 不显示冲突'],
    [null, undefined, '尚未观察到 → 不当冲突处理'],
  ]
  for (const [ownerValue, expected, message] of cases) {
    const requests = []
    const restore = installFetch(requests, {
      bootstrap: bootstrapPayload({ ownerOfficialInstructions: ownerValue }),
    })
    try {
      const store = mountStore(makeApi(), makeSettings())
      await store.load()
      assert.equal(store.getFields().promptConfigs[0].contentOwnerConflict, expected, message)
      assert.equal(store.getInstructionPool().owner.officialInstructions, ownerValue)
    } finally {
      restore()
    }
  }
})

test('会话/工作区切换：草稿保留，新工作区外的旧草稿不可写、可见草稿仍需版本校验', async () => {
  const requests = []
  const otherCard = (fileId, name, revision, text) => fileCard({
    id: `agents-file-${fileId}`,
    params: { scope: 'project', file: `D:/repo/${name}`, displayPath: name, fileId, revision, readStatus: 'ready', text },
  })
  const otherFile = (fileId, name, revision, text) => fileSnapshot({
    fileId, path: `D:/repo/${name}`, displayPath: name, revision, text,
  })
  const goneFile = otherFile('f2', 'GONE.md', 'r2', 'GONE')
  const stableFile = otherFile('f3', 'STABLE.md', 'r3', 'C1')
  const restore = installFetch(requests, {
    bootstrap: (body) => {
      if (body.sessionId !== 'sess-B') {
        return bootstrapPayload({
          contextId: 'ctx-1',
          presetTemplate: 'A',
          cards: [fileCard(), otherCard('f2', 'GONE.md', 'r2', 'GONE'), otherCard('f3', 'STABLE.md', 'r3', 'C1')],
          files: [fileSnapshot(), goneFile, stableFile],
        })
      }
      // 工作区 B：f1 内容已变、f3 未变，f2 已不在当前范围。
      return bootstrapPayload({
        contextId: 'ctx-B',
        presetTemplate: 'A',
        files: [fileSnapshot({ text: 'B1', revision: 'rB' }), stableFile],
      })
    },
  })
  try {
    const api = makeApi({ sessionId: 'sess-A' })
    const store = mountStore(api, makeSettings())
    await store.load()
    // A 工作区里三份文件都改出未保存草稿。
    store.patch({
      promptConfigs: store.getFields().promptConfigs.map((config) => (
        config.id === 'agents-file-f3' ? { ...config, text: 'C draft' } : { ...config, text: 'A draft' }
      )),
    })

    api.currentSessionId = () => 'sess-B'
    await store.load()
    const pool = store.getInstructionPool()
    assert.equal(pool.contextId, 'ctx-B', '上下文切到新工作区')
    const keptF1 = pool.drafts.find((draft) => draft.fileId === 'f1')
    const strandedF2 = pool.drafts.find((draft) => draft.fileId === 'f2')
    const stableF3 = pool.drafts.find((draft) => draft.fileId === 'f3')
    assert.equal(keptF1.content, 'A draft', '新工作区里仍可见的文件保留草稿')
    assert.equal(keptF1.revision, 'r1', '草稿仍绑定读取时的版本，写盘必须过服务端版本校验')
    assert.equal(keptF1.conflict, true, '新工作区里该文件已变 → 进入冲突态，先重新读取')
    assert.equal(strandedF2.status, 'missing', '新工作区之外的文件标记为不可用')
    assert.notEqual(strandedF2.contextId, pool.contextId, '旧上下文草稿不得被当成新上下文草稿')
    assert.equal(stableF3.contextId, 'ctx-B', '版本未变的可见文件草稿跟随新上下文')
    assert.equal(stableF3.conflict, undefined)

    await store.persistInstructionFiles(['f1', 'f2', 'f3'])
    const calls = fileCalls(requests)
    assert.deepEqual(calls.map(({ body }) => body.fileId), ['f3'], '只提交版本可校验的可见文件')
    assert.equal(calls[0].body.contextId, 'ctx-B', '提交的是新上下文 id')
    assert.equal(calls[0].body.expectedRevision, 'r3', '版本未变 → 允许乐观写盘')
  } finally {
    restore()
  }
})

test('读取失败的文件卡不可保存，正文保持空且状态可见', async () => {
  const requests = []
  const restore = installFetch(requests, {
    bootstrap: bootstrapPayload({
      cards: [fileCard({ params: { scope: 'project', file: 'D:/repo/AGENTS.md', displayPath: 'AGENTS.md', fileId: 'f1', readStatus: 'unreadable', text: '' } })],
      files: [fileSnapshot({ status: 'unreadable', text: '', revision: null, message: 'EACCES' })],
    }),
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const card = store.getFields().promptConfigs[0]
    assert.equal(card.contentStatus, 'unreadable')
    assert.equal(card.contentMessage, 'EACCES')
    assert.equal(card.text, '')
    await store.persistInstructionFiles(['f1'])
    assert.deepEqual(fileCalls(requests), [])
  } finally {
    restore()
  }
})

test('指令策略：读取后按 fileId 生效到卡片（顺序/位置/启用）', async () => {
  const requests = []
  const restore = installFetch(requests, {
    instructionsPolicy: policyPayload({ f1: { order: 42, position: 'before-all', audience: 'main', name: '项目规范' } }),
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const card = store.getFields().promptConfigs[0]
    assert.equal(card.order, 42)
    assert.equal(card.position, 'before-all')
    assert.equal(card.audience, 'main')
    assert.equal(card.enabled, true)
    assert.equal(card.name, '项目规范')
    assert.equal(store.getInstructionPolicy().revision, 'pol-1')
  } finally {
    restore()
  }
})

test('指令策略：改动按 revision 提交并回写快照；失败保留旧快照', async () => {
  const writes = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    const body = JSON.parse(init?.body ?? '{}')
    writes.push({ endpoint, body })
    if (endpoint === 'bootstrap') return okResponse(bootstrapPayload())
    if (endpoint === 'instructions-policy') {
      if (body.policy === undefined) return okResponse(policyPayload())
      return okResponse({ ok: true, value: { policy: { enabled: true, defaults: policyValues(), files: { f1: { position: 'before-all' } } }, revision: 'pol-2', exists: true } })
    }
    return okResponse({ ok: true, value: {} })
  }
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    assert.equal(await store.updateInstructionPolicy('f1', { position: 'before-all' }), true)
    const write = writes.find(({ body }) => body.policy !== undefined)
    assert.deepEqual(write.body.policy, { files: { f1: { position: 'before-all' } } })
    assert.equal(write.body.expectedRevision, 'pol-1')
    assert.equal(store.getInstructionPolicy().revision, 'pol-2')
    assert.equal(store.getFields().promptConfigs[0].position, 'before-all')
  } finally {
    globalThis.fetch = original
  }
})

test('指令策略：读取失败或缺快照时禁用策略编辑', async () => {
  const requests = []
  const restore = installFetch(requests, { instructionsPolicy: { ok: false, code: 'settings-rejected', message: 'boom' } })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    assert.match(store.getInstructionPolicy().error ?? '', /未读取到指令策略/)
    await store.updateInstructionPolicy('f1', { order: 40 })
    assert.equal(requests.filter(({ body }) => body.policy !== undefined).length, 0, '策略不可信时不得发出写入')
  } finally {
    restore()
  }
})
