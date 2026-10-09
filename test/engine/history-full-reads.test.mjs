/**
 * T6b —— 两个**刻意读完整历史**的点：`actions/assembly.mjs#fillUnlocked` 与
 * `compaction-epoch.mjs#scan`。
 *
 * 语义是「本会话曾经发生过」（跨请求保住的解锁名单 / 最后一次压缩之后的晋升信号），
 * 不是「模型现在看得见什么」。两者都按 T6 分类表保留 `historyEvents`：
 * 迁到 `currentEvents` 会在压缩后**裁掉已发现的工具**、并让门控重判「未晋升」。
 *
 * 真值源：`buildWorldBookEntry` 式的字面量期望——解锁名单只由日志里那次 `tool/call` 的参数决定，
 * 与可见节点无关；门控 `promoted` 只由日志里边界之后的事件决定。
 * 断言落在调用方观察到的行为上：装配产物的工具目录、`status()` 的相位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAction } from '../../engine/actions.mjs'
import { createEpochPromotion as rawCreateEpochPromotion } from '../../engine/compaction-epoch.mjs'

const unlockCall = { type: 'tool/call', seq: 0, data: { name: 'dev_tool_search', arguments: JSON.stringify({ toolNames: ['web_search'] }) } }
const summary = { type: 'user/message', seq: 1, data: { message: { id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }] } } }
/** 压缩后的 surface：只剩摘要节点，解锁调用已被遮蔽。 */
const compactedSession = (id) => ({
  id,
  header: { delegationDepth: 0 },
  snapshotEvents: () => [unlockCall, summary],
  append() {},
  surface: { nodes: [1], replaceGeneration: 1 },
})

/** 记录型 ctx 桩：assembly 动作只需要 `on` 与 `logger.warn`（同 actions.test.mjs 的最小面）。 */
function recordingCtx() {
  const warnings = []
  const events = []
  return {
    warnings,
    ctx: {
      logger: { warn: (message) => warnings.push(String(message)) },
      on(event, handler) { events.push({ event, handler }); return () => {} },
    },
    events,
  }
}

test('allowFrom 刻意读完整历史：解锁调用被压缩遮蔽后，已解锁的工具仍留在目录里', async () => {
  const recorder = recordingCtx()
  registerAction(recorder.ctx, { kind: 'assembly', id: 'dyn', target: { tools: { allow: ['pwsh'], allowFrom: { tool: 'dev_tool_search', key: 'toolNames' } } } })
  const handler = recorder.events.find((entry) => entry.event === 'system-prompt/assemble').handler
  const input = { sections: [], contexts: [], variables: {}, tools: ['pwsh', 'web_search', 'memory_recall'].map((name) => ({ name, description: name, parameters: {} })) }
  const output = await handler(input, { agent: { session: compactedSession('s-unlock') } }, async () => input)
  assert.deepEqual(output.tools.map((tool) => tool.name), ['pwsh', 'web_search'],
    '解锁名单来自完整历史（当前上下文里那条 tool/call 已不可见）')
  assert.deepEqual(recorder.warnings, [], '正常路径不得告警')
})

test('门控冷启动重建刻意读完整历史：边界后的 tool/call 被遮蔽，promoted 仍为真', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    unlockCall,
    summary,
  ]
  const session = {
    id: `s-epoch-${Math.random()}`,
    header: { cwd: '/workspace', delegationDepth: 0 },
    snapshotEvents: () => events,
    surface: { nodes: [2], replaceGeneration: 1 },
  }
  // 冷启动 = 新建容器后的第一次 status（无 observe 增量、无缓存条目），走 scan。
  const promo = rawCreateEpochPromotion(['tool/call'])
  assert.equal(promo.status({ session, ctx: { tools: { presentAs: () => () => {} } } }).promoted, true,
    '晋升信号取自完整日志：当前上下文里只有摘要，不得重判「未晋升」')
})
