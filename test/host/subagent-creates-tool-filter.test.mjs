/**
 * 在子代理页创建 `tool-filter` 能力会发生什么（端到端核验）。
 *
 * 结论链条（全部实测）：
 * 1. 创建 = 预设级操作：写入激活预设 `modules`，与从主会话页创建完全等价（无作用域参数）；
 * 2. 过滤行对子代理**不生效**：`includeSubagents` 缺省 false + UI 已无该开关
 *    → `delegationDepth > 0` 时引擎直接返回未过滤目录；
 * 3. 同一份 allow/deny 是预设级配置，两侧卡片都能编辑，效果只落在主对话；
 * 4. 能力卡字段收窄：`tool-filter` 卡只剩 allow / deny / enabled（无「子代理同过滤」）；
 * 5. 创建/删除对称：移除能力后组合不再出现过滤行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pt-subfilter-home-'))
const { createEngineCapabilityInPreset, loadPresetSpec, removeEngineCapabilityFromPreset, renderComposition } =
  await import('../../lib/index.mjs')
const { buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')
const { apply: applyToolFilter } = await import('../../engine/tool-filter.mjs')

const PRESET_ID = 'subfilter-e2e'

/** 独立临时预设根：modules 可编辑（create/remove 都要求显式 modules 数组）。 */
function seedPreset() {
  const root = mkdtempSync(join(tmpdir(), 'pt-subfilter-root-'))
  const dir = join(root, PRESET_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'),
    `id: ${PRESET_ID}\nname: ${PRESET_ID}\nversion: "1"\nengineCompat: ">=0"\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\n`, 'utf8')
  return { root, dir }
}

function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    on(type, handler, opts) {
      const list = listeners.get(type) ?? []
      list.push({ handler, opts })
      listeners.set(type, list)
    },
  }
  ctx.listeners = listeners
  return ctx
}

const tool = (name) => ({ name, description: `tool ${name}` })
const assembled = (tools) => ({ sections: [], contexts: [], tools, variables: {} })

/** 跑一次 system-prompt/assemble 瀑布（模拟主会话或子代理）。 */
async function runAssemble(ctx, delegationDepth, tools) {
  const handler = ctx.listeners.get('system-prompt/assemble')?.[0]?.handler
  assert.ok(handler, 'tool-filter 应注册 assemble 监听器')
  const agent = { session: { id: `s-${delegationDepth}`, header: { delegationDepth } } }
  return handler(assembled(tools), { agent }, async () => assembled(tools))
}

test('子代理页创建 tool-filter：预设级落盘 + 组合行 + 参数桥只写主对话语义', async () => {
  const { root, dir } = seedPreset()
  try {
    // 1) 创建能力（等价于 UI 点「添加能力 → tool-filter」）。
    const created = createEngineCapabilityInPreset(dir, { action: 'create', capabilityId: 'tool-filter' })
    assert.equal(created.changed, true)
    assert.deepEqual(created.addedModules, ['tool-filter'])
    assert.ok(loadPresetSpec(dir).modules.includes('tool-filter'), '写入激活预设 modules（预设级，无作用域参数）')

    // 2) 参数桥：用户在卡片里配的白/黑名单只产生主对话语义的键。
    const configs = buildEngineModuleParams({ toolFilterAllow: ['read'], toolFilterDeny: ['bash'] })
    assert.deepEqual(configs['tool-filter'], { allow: ['read'], deny: ['bash'] })
    assert.equal(configs['tool-filter'].includeSubagents, undefined, '不存在写 includeSubagents 的 UI 路径')

    // 3) 组合行与参数桥一致。
    const row = parseYaml(renderComposition(loadPresetSpec(dir), { toolFilterAllow: ['read'], toolFilterDeny: ['bash'] }, root))
      .find((item) => item?.id === 'tool-filter')
    assert.deepEqual(row.config, { allow: ['read'], deny: ['bash'] })

    // 4) 引擎实测：主对话被过滤，子代理保持完整目录。
    const mainCtx = makeCtx()
    applyToolFilter(mainCtx, row.config)
    const main = await runAssemble(mainCtx, 0, [tool('bash'), tool('read'), tool('write')])
    assert.deepEqual(main.tools.map((item) => item.name), ['read'], '主对话只留白名单内工具')

    const subCtx = makeCtx()
    applyToolFilter(subCtx, row.config)
    const sub = await runAssemble(subCtx, 1, [tool('bash'), tool('read'), tool('write')])
    assert.deepEqual(sub.tools.map((item) => item.name), ['bash', 'read', 'write'], '子代理完全不受这条过滤影响')

    // 5) 总开关关闭时不注册监听器（整条链失效）。
    const offCtx = makeCtx()
    applyToolFilter(offCtx, { allow: ['read'], enabled: false })
    assert.equal(offCtx.listeners.get('system-prompt/assemble'), undefined, 'enabled=false 不注册监听器')

    // 6) 兼容路径：显式 moduleConfigs 直写 includeSubagents 仍可让子代理继承（非 UI 路径）。
    const directCtx = makeCtx()
    applyToolFilter(directCtx, { allow: ['read'], includeSubagents: true })
    const inherited = await runAssemble(directCtx, 1, [tool('bash'), tool('read')])
    assert.deepEqual(inherited.tools.map((item) => item.name), ['read'], '显式直写才让子代理继承')

    // 7) 创建/删除对称：移除能力后组合不再出现过滤行。
    const removed = removeEngineCapabilityFromPreset(dir, 'tool-filter')
    assert.equal(removed.changed, true)
    assert.deepEqual(removed.removedModules, ['tool-filter'])
    const rows = parseYaml(renderComposition(loadPresetSpec(dir), {}, root))
    assert.equal(rows.find((item) => item?.id === 'tool-filter'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
