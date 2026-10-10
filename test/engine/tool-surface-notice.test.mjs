/**
 * tool-surface 的**首轮提示**行为回归（`modules/tool-surface/module.yml` 的 `tool-surface-notice`）。
 *
 * 为什么需要行为测试而不是只钉形状：这条提示的触发点同时受两个机制约束——
 *   `if.count{user-message,max:1}` 把它限制在会话最早阶段；
 *   `dedupe: session` 再按「每当前上下文一次」兜一层。
 * 两者任一失效，模型会每轮收到重复提示（白付 token），或者根本收不到（首轮就收窄之后，
 * 模型不知道工具面被裁过，只会用现有工具硬凑）。
 *
 * 真值源：`if` 真值来自规格（每会话「用户消息数 ≤ 1」时才注入），注入与否由规则引擎
 * 的公开行为给出；期望值手算为「step1 注入 → step2 被 dedupe 拦住 → step3 条件失效」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'

const definition = parseYaml(
  readFileSync(new URL('../../modules/tool-surface/module.yml', import.meta.url), 'utf8'),
  { logLevel: 'silent' },
)

function harness() {
  const events = new Map()
  const ctx = {
    get: () => undefined,
    logger: { warn() {}, info() {} },
    on(name, handler, options) {
      const list = events.get(name) ?? []; events.set(name, list)
      if (options?.prepend) list.unshift(handler); else list.push(handler)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    effect(callback) { return callback() },
  }
  return { ctx, run(name, args, terminal) {
    const list = (events.get(name) ?? []).slice()
    const invoke = i => i === list.length ? terminal() : list[i](...args, () => invoke(i + 1))
    return invoke(0)
  } }
}

const userMessage = (seq, text, source) => ({
  type: 'user/message',
  seq,
  data: { message: { id: `m${seq}`, role: 'user', source, content: [{ type: 'text', text }] } },
})

test('tool-surface 首轮提示：只在会话最早阶段注入一次，后续靠 dedupe 与 count 双重拦住', async () => {
  const h = harness()
  const dispose = mountRuleSources(h.ctx, [{ moduleId: 'tool-surface', rules: compileRules(definition.rules) }])

  const log = []
  const agent = { session: { id: 'notice-session', header: {}, snapshotEvents: () => [...log] }, options: { model: 'deepseek-chat' } }
  const step = async () => {
    const current = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }]
    const decision = await h.run('agent/pre-step', [{ agent }], () => ({ kind: 'enter', messages: current }))
    return decision.messages
  }
  const textsOf = messages => messages.map(message => message.content.map(block => block.text).join(''))
  const isNotice = texts => texts.some(text => text.startsWith('Tool catalog notice:'))

  const first = await step()
  assert.equal(isNotice(textsOf(first)), true, '会话最早阶段必须注入提示')
  const notice = first.find(message => message.content[0].text.startsWith('Tool catalog notice:'))
  assert.match(notice.content[0].text, /dev_tool_search/)
  assert.match(notice.content[0].text, /instead of making do/, '必须明确「不要用现有工具硬凑」')
  // 身份必须是 `plugin:<配置 id>`：写裸 `sourceKind: plugin` 会归一成 `plugin:plugin`，
  // 于是所有注入共用一份身份、`dedupe` 静默失效（这条断言就是那个坑的哨兵）。
  assert.equal(notice.source.kind, 'plugin:tool-surface-notice')

  // 宿主把注入的那条持久化后，它与真实用户消息一同出现在下一步的当前上下文里。
  log.push(userMessage(1, notice.content[0].text, notice.source))

  const second = await step()
  assert.equal(isNotice(textsOf(second)), false, '同一条提示不得重复注入（dedupe: session）')
  log.push(userMessage(2, 'USER', { kind: 'user' }))

  const third = await step()
  assert.equal(isNotice(textsOf(third)), false, '用户消息数已 > 1 → if 条件失效（中途启用模块也不补注）')

  dispose()
})
