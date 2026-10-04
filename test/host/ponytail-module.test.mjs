// 内置 ponytail 模块：内容对齐上游 + 注入点映射。
//
// 两个断言面各自有独立真值源：
//   1. configs/ 投影与 module.yml 定义逐字一致（投影不得成为第二真相）；
//   2. 规则文本含上游 skills/ponytail/SKILL.md 的关键句（字面量摘录于 4.10.3），
//      且注入点落位与上游 hook 一致：常驻规则走 system-section、子代理注入走
//      subagent-start（上游 SubagentStart hook）、档位走互斥组。
//
// 修规则文本时，只有「上游改了措辞」才动 UPSTREAM_ANCHORS；本地 DSH 适配
// （档位走配置卡、不注册 /ponytail 命令）不属于上游锚点，不要写进来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const moduleDir = fileURLToPath(new URL('../../modules/ponytail/', import.meta.url))
const spec = parseYaml(readFileSync(join(moduleDir, 'module.yml'), 'utf8'))
const configsDir = join(moduleDir, 'configs')

/** 上游 skills/ponytail/SKILL.md（4.10.3）关键句；旧版模块缺的正是这几处。 */
const UPSTREAM_ANCHORS = [
  'take the higher one and move on. The lazy solution that works is the right',
  'edit, grep every caller of the function you\'re about to touch, then fix the',
  'shared function once. The lazy fix IS the root-cause fix: one guard there is a',
  'No abstractions that were not requested: no interface with one implementation, no factory for one product, no config for a value that never changes. No avoidable dependency. No boilerplate nobody asked for.',
  'in the same response, "Did X; Y covers it. Need full X? Say so." Never stall',
  'Never simplify away: input validation at trust boundaries, error handling',
  'that prevents data loss, security measures, accessibility basics, anything',
  'fixtures, no per-function suites unless asked. Trivial one-liners need no',
  'mode commands. Off: "stop ponytail" / "normal mode".',
]

const rulesById = new Map(spec.rules.map((rule) => [rule.id, rule]))
const ruleText = (id) => rulesById.get(id).do[0].config.text
// configs/ 是 writePreset 的物化投影，文件名形态即它的固有命名 `<seq>-<ruleId>--<actionId>.yml`。
const ACTION_IDS = Object.fromEntries(spec.rules.map((rule) => [rule.id, rule.do.map((action) => action.id)]))
const projectionName = (rule) => `${String(spec.configOrder[rule.id] ?? 0).padStart(4, '0')}-${rule.id}--${ACTION_IDS[rule.id][0]}.yml`

test('ponytail 模块：rules 内容与 configs/ 投影逐字一致且文件名符合序号契约', () => {
  assert.ok(Array.isArray(spec.rules) && spec.rules.length > 0, 'module.yml 必须有 rules')
  const onDisk = readdirSync(configsDir).sort()
  const expected = spec.rules.map(projectionName).sort()
  // 只比精确文件名的集合：Windows 下 existsSync 大小写不敏感，会漏掉大小写漂移。
  assert.deepEqual(onDisk, expected, 'configs/ 只放本模块 rules 的投影，命名与 configOrder 一致')

  for (const rule of spec.rules) {
    const action = rule.do[0]
    const projected = parseYaml(readFileSync(join(configsDir, projectionName(rule)), 'utf8'))
    assert.equal(projected.id, action.config.id, `${rule.id}: 投影 id`)
    assert.equal(projected.layer, rule.layer, `${rule.id}: 投影 layer 跟随规则`)
    assert.equal(projected.enabled, rule.enabled !== false, `${rule.id}: 投影 enabled 跟随规则`)
    assert.equal(projected.text, action.config.text, `${rule.id}: 投影正文与定义逐字一致`)
  }
})

test('ponytail 模块：规则正文与上游 SKILL.md 对齐', () => {
  const text = ruleText('ponytail-rules')
  for (const anchor of UPSTREAM_ANCHORS) {
    assert.ok(text.includes(anchor), `规则正文缺上游关键句：${anchor}`)
  }
  // 上游规则里 lite/full/ultra 三档表只在档位卡上，规则卡不得重复一份漂移的表。
  for (const level of ['lite', 'full', 'ultra']) {
    assert.ok(!text.includes(`| **${level}** |`), `规则卡不得内联 ${level} 档位表`)
  }
})

test('ponytail 模块：注入点映射与上游 hook 一致', () => {
  // SessionStart / 每轮注入 → system-section 常驻卡。
  assert.equal(rulesById.get('ponytail-rules').layer, 'system-section')
  // UserPromptSubmit 的档位切换 → 互斥组：同组只能启用一张。
  const levels = spec.rules.filter((rule) => rule.group === 'ponytail-level')
  assert.deepEqual(levels.map((rule) => rule.id), ['ponytail-level-full', 'ponytail-level-lite', 'ponytail-level-ultra'])
  assert.ok(levels.every((rule) => rule.exclusive === true))
  assert.equal(levels.filter((rule) => rule.enabled !== false).length, 1, '互斥组同时只允许一张启用')
  assert.equal(levels.find((rule) => rule.enabled !== false).id, 'ponytail-level-full', '默认档 full')
  for (const level of levels) assert.equal(level.layer, 'system-section')

  // 子代理分两档：写档（完整规则）与只读档（轻量）。**必须在 pre-step 层**——
  // 判别「只读 / 写」要看任务文本，而 subagent-start 层的载荷只有
  // runId/provider/id/local，拿不到任务文本（见 docs/injection-point-contracts.md）。
  // 判别只认**明确表示整个任务只读**的信号；取不到就是写档。关键词表只收形容整个任务
  // 的词——「不要修改」这类从句级表述不得入表：写任务里出现得比只读任务还频繁，
  // 会让「重构这个函数，不要修改测试文件」整条被判成只读档。
  const RULE_KEYS = ['PONYTAIL:readonly', 'only read', '只读']
  const write = rulesById.get('ponytail-subagent-rules')
  const readonly = rulesById.get('ponytail-subagent-readonly')
  for (const [label, rule] of [['写档', write], ['只读档', readonly]]) {
    assert.ok(rule !== undefined, `${label}卡必须存在`)
    assert.equal(rule.layer, 'pre-step', `${label}必须在 pre-step 层才能读任务文本`)
    assert.equal(rule.enabled, true)
    const config = rule.do[0].config
    assert.equal(config.strategy, 'static')
    assert.equal(config.position, 'before-all', '规则排在任务文本之前')
    assert.equal(config.dedupe, 'session', '每个子代理只付一次')
    assert.equal(typeof config.text, 'string')
  }
  // 首轮守卫不可省：`agent/pre-step` 的 `messages` 是「本批被领取的消息」，任务文本只在
  // 首轮那批里。第二轮起 userText 为空 → 写档的 notAny 翻真、只读档的 text 判假，同一
  // 子代理会先拿只读档再拿完整规则（真机踩过两档并注）。判据必须钉在任务文本还在的那一刻。
  for (const [label, rule] of [['写档', write], ['只读档', readonly]]) {
    const guard = rule.when.all.find((node) => node.session !== undefined)
    assert.deepEqual(guard?.session, { type: 'user/message', present: false }, `${label}缺首轮守卫`)
  }
  // 两档互斥且完备：写档排除只读词、只读档命中只读词，关键词表必须逐字一致，
  // 否则两边都不命中（子代理白拿不到规则）或都命中（重复注入）。
  const onlyReadKeys = readonly.when.all.flatMap((node) => node.text?.keys ?? [])
  assert.deepEqual(onlyReadKeys, RULE_KEYS, '只读档关键词表')
  const writeNodes = write.when.all
  assert.deepEqual(writeNodes.find((node) => node.notAny !== undefined).notAny.flatMap((node) => node.text.keys), RULE_KEYS, '写档排除词必须与只读档同表')
  for (const rule of [write, readonly]) {
    assert.deepEqual(rule.when.all.find((node) => node.scope !== undefined).scope, { audience: 'subagent' }, '两档都只作用于子代理')
  }
  // 只读档必须是轻量版：完整规则集的执行层条目对只读子代理无关。
  assert.ok(ruleText('ponytail-subagent-readonly').length < 400, '只读档应保持轻量')
  assert.ok(!ruleText('ponytail-subagent-readonly').includes('## The ladder'), '只读档不搬执行层清单')

  // 档位卡同时服务主会话与子代理：`system-section` 只进主会话——子代理有自己的 system
  // prompt，官方按「global + 确切作用域」合并、不含祖先链；`subagent-start` 才是子代理
  // 读得到的通道。两处文本逐字相同：切档只靠互斥组启用哪张卡，子代理因此天然跟随，
  // 不需要第二套开关。
  for (const level of levels) {
    assert.deepEqual(level.do.map((action) => action.id), ['inject', 'inject-subagent'], `${level.id}: 档位卡持有两个动作`)
    assert.deepEqual(level.do.map((action) => action.config.layer), ['system-section', 'subagent-start'], `${level.id}: 主会话与子代理各一个动作`)
    assert.equal(level.do[0].config.text, level.do[1].config.text, `${level.id}: 两个受众的档位文本必须逐字相同`)
    assert.match(level.do[1].config.text, /PONYTAIL MODE ACTIVE/)
    assert.equal(level.when, undefined, '档位无条件注入，与上游 matcher 缺省一致')
  }

  // 写档保留上游全文的关键段落；只读档不搬这些执行层清单（上面已断言）。
  const subagentText = ruleText('ponytail-subagent-rules')
  for (const section of ['## The ladder', '**Bug fix = root cause, not symptom.**', '## When NOT to be lazy', 'The shortest path to done is the right path.']) {
    assert.ok(subagentText.includes(section), `子代理副本缺段落：${section}`)
  }
})
