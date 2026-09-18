// 指令文件保存链路（W1 客户端侧）：
// - 未修改的文件不写盘，预设保存不把文件卡写进 preset.yml；
// - debounce 自动保存与预设切换绝不写文件（文件只能显式保存）；
// - 版本冲突保留草稿并要求重新读取，重新读取恢复可写；
// - 保存成功只更新请求快照基线，期间的新输入仍 dirty。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const require = createRequire(new URL('../../package.json', import.meta.url))
const React = require('react')
const { renderToString } = require('react-dom/server')
const ts = require('typescript')
// 沿用客户端 Node runner 的源码加载方式；不构建、不替换 React hooks。
const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, { get: (_, key) => key })' }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { MainSessionPage } = await import('../../src/client/app/workspace/pages/MainSessionPage.tsx')
const { ConfigListWithTemplates } = await import('../../src/client/app/workspace/pages/ConfigListWithTemplates.tsx')
const { PromptConfigsEditor } = await import('../../src/client/features/prompts/PromptConfigsEditor.tsx')
const { PromptConfigList } = await import('../../src/client/features/prompts/PromptConfigList.tsx')
const { ToggleRow } = await import('../../src/client/ui/ToggleRow.tsx')
const { PromptConfigCard } = await import('../../src/client/features/prompts/PromptConfigCard.tsx')
const { PromptConfigForm } = await import('../../src/client/features/prompts/PromptConfigForm.tsx')
const { FormField } = await import('../../src/client/ui/FormField.tsx')
const { OptionField, NumberField } = await import('../../src/client/features/prompts/PromptConfigFields.tsx')
const { MenuSelect } = await import('../../src/client/ui/MenuSelect.tsx')
const { getEngineMeta } = await import('../../engine/schema.mjs')
loader.deregister()
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)

// SSR 只取得真实组件返回的元素与事件回调；不声称验证了 effect、DOM 事件或重渲染。
const componentTree = (Component, props) => {
  let tree
  function Probe() { tree = (Component.type ?? Component)(props); return null }
  renderToString(React.createElement(Probe))
  return tree
}
const findElement = (node, predicate) => {
  if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean)
  if (!React.isValidElement(node)) return undefined
  return predicate(node) ? node : findElement(node.props.children, predicate)
}
const listFromPage = (Page, store, onNotice) => {
  const view = { ...store, fields: store.getFields(), moduleFacts: store.moduleFacts ?? { editable: true }, instructionPolicy: store.getInstructionPolicy(), showNotice: onNotice ?? store.showNotice }
  const tree = componentTree(Page, { store: view, t })
  const editor = findElement(tree, (node) => node.type === PromptConfigsEditor)
  const list = findElement(editor ? componentTree(editor.type, editor.props) : tree, (node) => node.type === PromptConfigList)
  assert.ok(list, '实际页面必须能路由到提示词配置列表')
  return componentTree(list.type, list.props)
}

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
  value: { value: { presetTemplate: options.presetTemplate ?? 'A', writePreset: true }, base: {}, revision: 1 },
  moduleFacts: { editable: true, sourceMode: 'explicit', declaredModules: [], effectiveModules: [], rowIds: [] },
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
      return okResponse(typeof handler.bootstrap === 'function' ? await handler.bootstrap(body) : handler.bootstrap ?? bootstrapPayload())
    }
    if (endpoint === 'instructions-policy') {
      return okResponse(typeof handler.instructionsPolicy === 'function' ? await handler.instructionsPolicy(body) : handler.instructionsPolicy ?? policyPayload())
    }
    const payload = handler[endpoint]
    return okResponse(typeof payload === 'function' ? await payload(body) : payload ?? { ok: true, value: {} })
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

test('R4：A 的策略读取迟到不得把旧配置应用到已加载的预设 B', async () => {
  const requests = []
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let preset = 'A'
  let reads = 0
  const restore = installFetch(requests, {
    bootstrap: () => bootstrapPayload({ presetTemplate: preset, cards: [{ id: preset, text: preset }] }),
    instructionsPolicy: async () => {
      const read = ++reads
      if (read === 1) { entered.resolve(); await gate.promise }
      return policyPayload({}, { revision: read === 1 ? 'pol-A' : 'pol-B' })
    },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    const oldLoad = store.load()
    await entered.promise
    preset = 'B'
    await store.load()
    const current = store.getFields()
    gate.resolve()
    await oldLoad
    assert.equal(store.getFields(), current, '迟到的整条 load 链不得再发布任何 fields')
    assert.equal(store.getFields().presetTemplate, 'B')
    assert.deepEqual(store.getFields().promptConfigs.map(({ id }) => id), ['B'])
    assert.equal(store.getInstructionPolicy().revision, 'pol-B')
  } finally { gate.resolve(); restore() }
})

test('R4：策略读取期间的新草稿不得被 bootstrap 旧卡覆盖', async () => {
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let delay = false
  const restore = installFetch([], {
    bootstrap: bootstrapPayload({ cards: [{ id: 'preset-card', text: 'disk' }] }),
    instructionsPolicy: async () => {
      if (delay) { entered.resolve(); await gate.promise }
      return policyPayload()
    },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    delay = true
    const loading = store.load()
    await entered.promise
    store.patch({ promptConfigs: [{ id: 'preset-card', text: 'new draft' }] })
    gate.resolve()
    await loading
    assert.equal(store.getFields().promptConfigs[0].text, 'new draft')
  } finally { gate.resolve(); restore() }
})

test('R4：单文件重新读取迟到不得把 A 文件加入 B 草稿池', async () => {
  const gate = Promise.withResolvers()
  const restore = installFetch([], {
    bootstrap: ({ sessionId }) => sessionId === 'sess-B'
      ? bootstrapPayload({ contextId: 'ctx-B', cards: [], files: [] }) : bootstrapPayload(),
    'prompt-configs': async () => {
      await gate.promise
      return { ok: true, value: { instructions: bootstrapPayload().instructions } }
    },
  })
  try {
    const api = makeApi()
    const store = mountStore(api, makeSettings())
    await store.load()
    const reloading = store.reloadInstructionFile('f1')
    api.currentSessionId = () => 'sess-B'
    await store.load()
    const pool = store.getInstructionPool()
    gate.resolve()
    await reloading
    assert.equal(store.getInstructionPool(), pool)
    assert.equal(store.getInstructionPool().drafts[0].status, 'missing')
  } finally { gate.resolve(); restore() }
})

test('R4：重新读取期间继续编辑保留新草稿，错误上下文快照也不可应用', async () => {
  for (const contextId of ['ctx-1', 'ctx-other']) {
    const gate = Promise.withResolvers()
    const restore = installFetch([], {
      'prompt-configs': async () => {
        await gate.promise
        return { ok: true, value: { instructions: bootstrapPayload({ contextId, files: [fileSnapshot({ text: 'disk V2', revision: 'r2' })] }).instructions } }
      },
    })
    try {
      const store = mountStore(makeApi(), makeSettings())
      await store.load()
      const reloading = store.reloadInstructionFile('f1')
      if (contextId === 'ctx-1') store.patch({ promptConfigs: [fileCard({ text: 'new draft' })] })
      const pool = store.getInstructionPool()
      gate.resolve()
      await reloading
      assert.equal(store.getInstructionPool(), pool)
    } finally { gate.resolve(); restore() }
  }
})

test('R4：保存中切工作区，丢弃迟到结果且不继续发送余下 A 文件', async () => {
  const requests = []
  const gate = Promise.withResolvers()
  const first = Promise.withResolvers()
  const files = [fileSnapshot(), fileSnapshot({ fileId: 'f2' })]
  const cards = files.map((file) => fileCard({ id: `agents-file-${file.fileId}`, params: { ...fileCard().params, fileId: file.fileId } }))
  const restore = installFetch(requests, {
    bootstrap: ({ sessionId }) => sessionId === 'sess-B'
      ? bootstrapPayload({ contextId: 'ctx-B', cards: [], files: [] }) : bootstrapPayload({ cards, files }),
    'agents-file': async ({ fileId }) => {
      first.resolve()
      await gate.promise
      return { ok: true, value: { fileId, revision: 'saved' } }
    },
  })
  try {
    const api = makeApi()
    const store = mountStore(api, makeSettings())
    await store.load()
    store.patch({ promptConfigs: cards.map((card) => ({ ...card, text: 'A draft' })) })
    const saving = store.persistInstructionFiles()
    await first.promise
    api.currentSessionId = () => 'sess-B'
    await store.load()
    const current = store.getInstructionPool()
    gate.resolve()
    assert.equal(await saving, false)
    assert.equal(store.getInstructionPool(), current)
    assert.deepEqual(fileCalls(requests).map(({ body }) => body.fileId), ['f1'])
  } finally { gate.resolve(); restore() }
})

test('R6：工作区 A→B→A 保留草稿基线，仅真实磁盘变更阻止继续保存', async () => {
  for (const diskChanged of [false, true]) {
    const requests = []
    let returning = false
    const restore = installFetch(requests, {
      bootstrap: ({ sessionId }) => sessionId === 'sess-B'
        ? bootstrapPayload({ contextId: 'ctx-B', cards: [], files: [] })
        : bootstrapPayload({ files: [fileSnapshot(returning && diskChanged ? { text: 'external', revision: 'r2' } : {})] }),
      'agents-file': { ok: true, value: { fileId: 'f1', revision: 'saved' } },
    })
    try {
      const api = makeApi()
      const store = mountStore(api, makeSettings())
      await store.load()
      store.patch({ promptConfigs: [fileCard({ text: 'kept draft' })] })
      api.currentSessionId = () => 'sess-B'
      await store.load()
      const away = store.getInstructionPool().drafts[0]
      assert.equal(away.revision, 'r1', '离开范围只暂停写资格，不销毁基线')
      assert.equal(away.savedContent, 'V1')
      assert.equal(await store.persistInstructionFiles(), false, '不可写的未保存文件不算全部保存成功')
      assert.equal(fileCalls(requests).length, 0)
      returning = true
      api.currentSessionId = () => 'sess-1'
      await store.load()
      const back = store.getInstructionPool().drafts[0]
      assert.equal(back.content, 'kept draft')
      assert.equal(back.conflict === true, diskChanged)
      assert.equal(await store.persistInstructionFiles(), !diskChanged)
      assert.equal(fileCalls(requests).length, diskChanged ? 0 : 1)
      if (!diskChanged) assert.equal(fileCalls(requests)[0].body.expectedRevision, 'r1')
    } finally { restore() }
  }
})

test('R7：保存全部汇总失败，保留已成功文件/预设及失败草稿，不重载抹错误', async () => {
  const requests = []
  const files = [fileSnapshot(), fileSnapshot({ fileId: 'f2' })]
  const cards = files.map((file) => fileCard({ id: `agents-file-${file.fileId}`, params: { ...fileCard().params, fileId: file.fileId } }))
  cards.push({ id: 'preset-card', text: 'preset draft' })
  const restore = installFetch(requests, {
    bootstrap: bootstrapPayload({ cards, files }),
    'agents-file': ({ fileId }) => fileId === 'f1'
      ? { ok: true, value: { fileId, revision: 'saved' } }
      : { ok: false, code: 'agents-file-conflict', message: 'external change' },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: cards.map((card) => ({ ...card, text: 'edited' })) })
    assert.equal(await store.persistConfigs(store.getFields().promptConfigs), false)
    const [saved, failed] = store.getInstructionPool().drafts
    assert.equal(saved.revision, 'saved')
    assert.equal(saved.savedContent, 'edited')
    assert.equal(failed.savedContent, 'V1')
    assert.equal(failed.content, 'edited')
    assert.equal(failed.error, 'external change')
    assert.equal(failed.conflict, true)
    const presetWrites = requests.filter(({ endpoint }) => endpoint === 'param-overrides')
    assert.deepEqual(presetWrites[0].body.promptConfigs.map(({ id }) => id), ['preset-card'])
    assert.equal(requests.filter(({ endpoint }) => endpoint === 'bootstrap').length, 1)
  } finally { restore() }
})

test('R5：实际工作台来源总开关写顶层 enabled，不暗改文件开关或官方负责人', async () => {
  for (const Page of [MainSessionPage, ConfigListWithTemplates]) {
    const requests = []
    let policy = { enabled: false, defaults: policyValues(), files: {} }
    let revision = 'pol-1'
    const restore = installFetch(requests, {
      bootstrap: bootstrapPayload({ ownerOfficialInstructions: true }),
      instructionsPolicy: ({ policy: patch }) => {
        if (patch) {
          policy = { ...policy, ...patch, files: { ...policy.files, ...patch.files } }
          revision = 'pol-2'
        }
        return policyPayload({}, { policy, revision })
      },
    })
    try {
      const store = mountStore(makeApi(), makeSettings())
      await store.load()
      assert.equal(await store.updateInstructionPolicy('f1', { enabled: true }), true)
      assert.equal(store.getInstructionPolicy().policy.enabled, false, '文件启用不应偷偷开启独立来源')
      assert.equal(store.getFields().promptConfigs[0].enabled, false)
      const tree = listFromPage(Page, store)
      const toggle = findElement(tree, (node) => node.type === ToggleRow && node.props.label === '独立指令文件来源')
      assert.ok(toggle, '总开关必须从真实页面可达，而不是孤立 store API')
      assert.equal(toggle.props.checked, false)
      assert.match(toggle.props.hint, /已关闭.*文件开关不会生效/)
      assert.match(toggle.props.hint, /官方指令仍负责.*不会接管官方负责人/)
      assert.equal(await toggle.props.onChange(true), true)
      assert.deepEqual(requests.at(-1).body, { policy: { enabled: true }, expectedRevision: 'pol-2' })
      assert.equal(store.getFields().promptConfigs[0].enabled, true)
      assert.equal(store.getFields().promptConfigs[0].contentOwnerConflict, true)
      assert.deepEqual(store.getInstructionPool().owner, { officialInstructions: true })
      assert.ok(requests.every(({ endpoint }) => ['bootstrap', 'instructions-policy'].includes(endpoint)))
    } finally { restore() }
  }
})

test('R5：来源总开关等待写入结果，失败/缺少快照不假成功，读取失败时禁用', async () => {
  for (const response of [{ ok: false, message: 'denied' }, { ok: true, value: {} }]) {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const restore = installFetch([], {
      instructionsPolicy: async ({ policy: patch }) => {
        if (!patch) return policyPayload({}, { policy: { enabled: false, defaults: policyValues(), files: {} } })
        entered.resolve()
        await gate.promise
        return response
      },
    })
    try {
      const store = mountStore(makeApi(), makeSettings())
      await store.load()
      const initial = store.getInstructionPolicy()
      const toggle = findElement(listFromPage(MainSessionPage, store), (node) => node.type === ToggleRow && node.props.label === '独立指令文件来源')
      assert.ok(toggle)
      const saving = toggle.props.onChange(true)
      await entered.promise
      assert.equal(store.getInstructionPolicy(), initial, '请求中不得乐观显示已开启')
      gate.resolve()
      assert.equal(await saving, false)
      assert.equal(store.getInstructionPolicy(), initial)
    } finally { gate.resolve(); restore() }
  }
  const requests = []
  const restore = installFetch(requests, { instructionsPolicy: { ok: false, message: 'unavailable' } })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const toggle = findElement(listFromPage(MainSessionPage, store), (node) => node.type === ToggleRow && node.props.label === '独立指令文件来源')
    assert.ok(toggle)
    assert.equal(toggle.props.disabled, true)
    assert.match(toggle.props.hint, /unavailable/)
    assert.equal(await store.setInstructionSourceEnabled(true), false)
    assert.equal(requests.filter(({ body }) => body.policy).length, 0)
  } finally { restore() }
})

test('R7：实际页面保存按钮等待真实 store 布尔结果，失败不能提前报成功', { timeout: 5000 }, async () => {
  for (const Page of [MainSessionPage, ConfigListWithTemplates]) {
    for (const succeeds of [false, true]) {
      const gate = Promise.withResolvers()
      const entered = Promise.withResolvers()
      const notices = []
      const restore = installFetch([], {
        'configs-validate': { ok: true, value: { valid: true } },
        'agents-file': async () => {
          entered.resolve()
          await gate.promise
          return succeeds ? { ok: true, value: { fileId: 'f1', revision: 'saved' } } : { ok: false, message: 'denied' }
        },
      })
      try {
        const store = mountStore(makeApi(), makeSettings())
        await store.load()
        store.patch({ promptConfigs: [fileCard({ text: 'edited' })] })
        const tree = listFromPage(Page, store, (...notice) => notices.push(notice))
        const button = findElement(tree, (node) => node.type === 'button' && React.Children.toArray(node.props.children).includes(t('configs.save')))
        assert.ok(button)
        const saving = button.props.onClick()
        await entered.promise
        assert.deepEqual(notices, [], '文件写入尚未返回时不报告全量成功')
        gate.resolve()
        assert.equal(await saving, succeeds)
        assert.equal(notices.filter(([kind]) => kind === 'ok').length, succeeds ? 1 : 0)
      } finally { gate.resolve(); restore() }
    }
  }
})

test('R4：保存迟到遇到重新读取或 A→B→A，不能覆盖当前基线；重复保存不并发写同文件', async () => {
  for (const reset of ['reload', 'A-B-A']) {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const requests = []
    const restore = installFetch(requests, {
      bootstrap: ({ sessionId }) => sessionId === 'sess-B'
        ? bootstrapPayload({ contextId: 'ctx-B', cards: [], files: [] }) : bootstrapPayload(),
      'prompt-configs': { ok: true, value: { instructions: bootstrapPayload({ files: [fileSnapshot({ text: 'reread', revision: 'r2' })] }).instructions } },
      'agents-file': async () => {
        entered.resolve()
        await gate.promise
        return { ok: true, value: { fileId: 'f1', revision: 'old-save' } }
      },
    })
    try {
      const api = makeApi()
      const store = mountStore(api, makeSettings())
      await store.load()
      store.patch({ promptConfigs: [fileCard({ text: 'first draft' })] })
      const saving = store.persistInstructionFiles()
      await entered.promise
      assert.equal(await store.persistInstructionFiles(), false)
      assert.equal(fileCalls(requests).length, 1)
      if (reset === 'reload') await store.reloadInstructionFile('f1')
      else {
        api.currentSessionId = () => 'sess-B'
        await store.load()
        api.currentSessionId = () => 'sess-1'
        await store.load()
      }
      const current = store.getInstructionPool()
      gate.resolve()
      assert.equal(await saving, false)
      assert.equal(store.getInstructionPool(), current)
      assert.equal(current.drafts[0].saving === true, false)
      assert.equal(current.drafts[0].revision, reset === 'reload' ? 'r2' : 'r1')
    } finally { gate.resolve(); restore() }
  }
})

test('R4：load 的策略读取期间文件已保存，旧读取不得倒退文件基线', async () => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let delay = false
  const restore = installFetch([], {
    instructionsPolicy: async () => {
      if (delay) { entered.resolve(); await gate.promise }
      return policyPayload()
    },
    'agents-file': { ok: true, value: { fileId: 'f1', revision: 'saved' } },
  })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: [fileCard({ text: 'edited' })] })
    delay = true
    const loading = store.load()
    await entered.promise
    assert.equal(await store.persistInstructionFiles(), true)
    const current = store.getInstructionPool()
    gate.resolve()
    await loading
    assert.equal(store.getInstructionPool(), current)
    assert.equal(current.drafts[0].savedContent, 'edited')
    assert.equal(current.drafts[0].revision, 'saved')
  } finally { gate.resolve(); restore() }
})

test('R7：后续文件尚未应答时即确认前一成功文件，批次失效也保留成功资源', async () => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const files = [fileSnapshot(), fileSnapshot({ fileId: 'f2' })]
  const cards = files.map((file) => fileCard({ id: `agents-file-${file.fileId}`, params: { ...fileCard().params, fileId: file.fileId } }))
  const restore = installFetch([], {
    bootstrap: ({ sessionId }) => sessionId === 'sess-B'
      ? bootstrapPayload({ contextId: 'ctx-B', cards: [], files: [] }) : bootstrapPayload({ cards, files }),
    'agents-file': async ({ fileId }) => {
      if (fileId === 'f2') { entered.resolve(); await gate.promise }
      return { ok: true, value: { fileId, revision: 'saved' } }
    },
  })
  try {
    const api = makeApi()
    const store = mountStore(api, makeSettings())
    await store.load()
    store.patch({ promptConfigs: cards.map((card) => ({ ...card, text: 'edited' })) })
    const saving = store.persistInstructionFiles()
    await entered.promise
    assert.equal(store.getInstructionPool().drafts[0].revision, 'saved')
    assert.equal(store.getInstructionPool().drafts[0].savedContent, 'edited')
    api.currentSessionId = () => 'sess-B'
    await store.load()
    gate.resolve()
    assert.equal(await saving, false)
    assert.equal(store.getInstructionPool().drafts[0].revision, 'saved')
    assert.equal(store.getInstructionPool().drafts[1].content, 'edited')
  } finally { gate.resolve(); restore() }
})

test('R7：实际列表保存回调 reject 时返回 false 并明确报错', async () => {
  const restore = installFetch([], { 'configs-validate': { ok: true, value: { valid: true } } })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const notices = []
    const tree = listFromPage(MainSessionPage, { ...store, persistConfigs: async () => { throw new Error('write rejected') } }, (...notice) => notices.push(notice))
    const button = findElement(tree, (node) => node.type === 'button' && React.Children.toArray(node.props.children).includes(t('configs.save')))
    assert.equal(await button.props.onClick(), false)
    assert.deepEqual(notices, [['error', '保存失败：write rejected']])
  } finally { restore() }
})

const emptyLayerCards = () => ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline']
  .map((layer) => ({ id: `draft-${layer}`, layer, strategy: 'static', text: '' }))

test('六层空草稿：后台刷新不能覆盖刷新前已有的未保存配置', async () => {
  const restore = installFetch([], { bootstrap: bootstrapPayload({ cards: [], files: [] }) })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const cards = emptyLayerCards()
    store.patch({ promptConfigs: cards })
    await store.load({ silent: true })
    assert.deepEqual(store.getFields().promptConfigs, cards)
  } finally { restore() }
})

test('六层空草稿：保存成功不以尚未更新的生成快照清空编辑定义', async () => {
  const requests = []
  const restore = installFetch(requests, { bootstrap: bootstrapPayload({ cards: [], files: [] }) })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const cards = emptyLayerCards()
    store.patch({ promptConfigs: cards })
    assert.equal(await store.persistConfigs(cards, { includeInstructions: false }), true)
    assert.deepEqual(requests.find(({ endpoint }) => endpoint === 'param-overrides').body.promptConfigs, cards)
    assert.deepEqual(store.getFields().promptConfigs, cards)
  } finally { restore() }
})

test('指令文件复用标准配置卡：与普通前置步骤卡同组件同层，就地编辑正文', async () => {
  const cards = [
    fileCard(),
    { id: 'example-pre-step', name: '示例：消息批注入', layer: 'pre-step', strategy: 'static', position: 'after-user', order: 0, text: '示例正文' },
  ]
  const restore = installFetch([], { bootstrap: bootstrapPayload({ cards }) })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const tree = listFromPage(MainSessionPage, store)
    const fileElement = findElement(tree, (node) => node.type === PromptConfigCard && node.props.config?.id === 'agents-file-f1')
    const exampleElement = findElement(tree, (node) => node.type === PromptConfigCard && node.props.config?.id === 'example-pre-step')
    assert.ok(fileElement, '指令文件必须以标准配置卡渲染，而不是另一套卡片')
    assert.ok(exampleElement, '同一列表里存在可对比的普通前置步骤卡')
    assert.equal(fileElement.type, exampleElement.type, '两类卡使用同一个卡片组件')
    assert.equal(fileElement.props.config.layer, 'pre-step')
    assert.equal(typeof fileElement.props.onSaveInstructionFile, 'function', '卡片保留原文件写回通道（失焦触发）')
    const html = renderToString(React.createElement(PromptConfigCard, { ...fileElement.props, expanded: false }))
    assert.match(html, /前置步骤/, '卡片头部显示标准的层级信息')
    const expanded = componentTree(PromptConfigCard, { ...fileElement.props, expanded: true })
    const form = findElement(expanded, (node) => node.type === PromptConfigForm)
    assert.equal(form.props.config.id, 'agents-file-f1', '展开后就地编辑该文件正文')
    assert.equal(form.props.config.text, 'V1')
  } finally { restore() }
})

test('指令文件与普通前置步骤卡共用同一套表单字段：绑定项置灰、策略项可写', () => {
  const meta = getEngineMeta()
  const plain = { id: 'example-pre-step', name: '示例：消息批注入', layer: 'pre-step', strategy: 'static', position: 'after-user', order: 0, text: '示例正文' }
  const treeOf = (config) => componentTree(PromptConfigForm, { t, meta, config, onPatch() {}, onPatchPolicy() {} })
  const labelsOf = (node, out = []) => {
    if (Array.isArray(node)) { for (const child of node) labelsOf(child, out); return out }
    if (!React.isValidElement(node)) return out
    if (typeof node.props?.label === 'string') out.push(node.props.label)
    return labelsOf(node.props.children, out)
  }
  const shared = ['标识', '名称', '注入层', '内容策略', '配置类型', '消息角色', '拼接位置', '合并方式', '顺序', '互斥组', '去重方式', '晋升范围', '消息受众', '模型范围', '注入内容']
  for (const config of [plain, fileCard()]) {
    const labels = labelsOf(treeOf(config))
    for (const label of shared) assert.ok(labels.includes(label), `${config.id} 缺少字段 ${label}`)
  }
  const fileTree = treeOf(fileCard())
  const controlDisabled = (label) => {
    const field = findElement(fileTree, (node) => (node.type === FormField || node.type === OptionField || node.type === NumberField) && node.props.label === label)
    assert.ok(field, `找不到字段 ${label}`)
    const body = field.type === FormField ? field.props.children : componentTree(field.type, field.props)
    const control = findElement(body, (node) => node.type === MenuSelect || node.type === 'input')
    return control?.props.disabled === true || control?.props.readOnly === true
  }
  for (const label of ['标识', '注入层', '内容策略', '配置类型', '消息角色', '合并方式', '去重方式', '填充来源', '来源类型', '消息形式']) {
    assert.equal(controlDisabled(label), true, `${label} 由指令文件来源固定，应只读`)
  }
  for (const label of ['名称', '拼接位置', '顺序', '晋升范围', '消息受众', '模型范围']) {
    assert.equal(controlDisabled(label), false, `${label} 应可写（落独立指令策略）`)
  }
})

test('指令文件正文失焦自动写回：无「保存到文件」按钮，脏草稿在焦点离开卡片时提交', async () => {
  const previousFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  const requests = []
  const restore = installFetch(requests, { 'agents-file': { ok: true, value: { fileId: 'f1', revision: 'saved' } } })
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    store.patch({ promptConfigs: [fileCard({ text: 'edited' })] })
    const tree = listFromPage(MainSessionPage, store)
    const card = findElement(tree, (node) => node.type === PromptConfigCard && node.props.config?.id === 'agents-file-f1')
    const rendered = componentTree(PromptConfigCard, { ...card.props, expanded: true })
    assert.equal(findElement(rendered, (node) => node.type === 'button' && node.props.children === t('card.saveFile')), undefined, '不再提供保存到文件按钮')
    const article = findElement(rendered, (node) => node.type === 'article')
    assert.equal(typeof article.props.onBlur, 'function', '正文失焦要自动写回')
    article.props.onBlur({ relatedTarget: null })
    for (let i = 0; i < 20 && store.getInstructionPool().drafts[0]?.savedContent !== 'edited'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.deepEqual(fileCalls(requests).map(({ body }) => body.fileId), ['f1'])
    assert.equal(store.getInstructionPool().drafts[0].savedContent, 'edited')
  } finally { restore(); globalThis.requestAnimationFrame = previousFrame }
})

test('指令文件卡折叠：展开时先落盘再折叠，未展开时不重复请求保存', async () => {
  // 折叠按钮在卡片内部：点击它时焦点没有离开卡片，ownsFocus 判据放行不了；
  // 编辑区又随折叠卸载，字段 commit 也不会再冒泡出失焦。所以折叠动作本身必须先
  // 请求保存一次，否则用户改完直接收卡就等于丢弃修改。
  const requests = []
  const restore = installFetch(requests, {})
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    const tree = listFromPage(MainSessionPage, store)
    const card = findElement(tree, (node) => node.type === PromptConfigCard && node.props.config?.id === 'agents-file-f1')
    assert.ok(card, '必须能路由到指令文件卡')

    const saved = []
    const toggled = []
    const expanded = componentTree(PromptConfigCard, {
      ...card.props,
      expanded: true,
      onSaveInstructionFile: (fileId) => saved.push(fileId),
      onToggleExpanded: (id) => toggled.push(id),
    })
    const openToggle = findElement(expanded, (node) => node.type === 'button' && node.props['aria-expanded'] === true)
    assert.ok(openToggle, '展开态的折叠按钮必须存在')
    openToggle.props.onClick()
    assert.deepEqual(saved, ['f1'], '折叠前必须先请求落盘')
    assert.deepEqual(toggled, ['agents-file-f1'], '折叠动作本身仍要执行')

    const collapsed = componentTree(PromptConfigCard, {
      ...card.props,
      expanded: false,
      onSaveInstructionFile: (fileId) => saved.push(fileId),
      onToggleExpanded: () => {},
    })
    const closedToggle = findElement(collapsed, (node) => node.type === 'button' && node.props['aria-expanded'] === false)
    assert.ok(closedToggle, '收起态的折叠按钮必须存在')
    closedToggle.props.onClick()
    assert.deepEqual(saved, ['f1'], '展开动作不涉及落盘')
  } finally { restore() }
})
