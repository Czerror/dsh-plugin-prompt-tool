// 内置 ponytail 模块：内容对齐上游 + 注入点映射。
//
// 两个断言面各自有独立真值源：
//   1. 规则文本含上游 skills/ponytail/SKILL.md 的关键句（字面量摘录于 v5.0.0）；
//   2. 注入点落位与上游 hook 一致：常驻规则走 system-section、子代理档位标记走
//      subagent-start（上游 SubagentStart hook）、档位切换走互斥组、子代理正文分档
//      走 pre-step 上的动作级 if/then/else。
//
// 定义只有一份真值源：`module.yml`。`rules/` 切片由 `ensureModuleSlices` 在运行时生成，
// 不随包分发；旧的 `configs/` 投影已列入 write-module 的 `LEGACY_ARTIFACTS`（只删不生成），
// 因此这里不再有「投影不得成为第二真相」的断言面。
//
// 修规则文本时，只有「上游改了措辞」才动 UPSTREAM_ANCHORS；本地 DSH 适配
// （档位走配置卡、不注册 /ponytail 命令）不属于上游锚点，不要写进来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
// @ts-expect-error 定义合法性归唯一引擎编译器，测试直接调它而不是复刻规则。
import { compileRules } from '../../engine/rule-spec.mjs'

const moduleDir = fileURLToPath(new URL('../../modules/ponytail/', import.meta.url))
const spec = parseYaml(readFileSync(join(moduleDir, 'module.yml'), 'utf8'))

/** 上游 skills/ponytail/SKILL.md（v5.0.0）关键句；4.10.3 → 5.0 整段重建后逐条重抽。 */
const UPSTREAM_ANCHORS = [
  'You solve the whole problem with the least new code.',
  'Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports.',
  'Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.',
  'Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.',
  'Be lazy about the solution, never about the change itself',
  'grep every caller of the function you touch, then fix the root cause once in the shared code.',
  'Between options of equal size, take the one that is correct on edge cases.',
  'Lazy code without its check is unfinished',
  'A shortcut with a known limit gets a `ponytail:` comment that names the limit and when to upgrade.',
  'Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility',
]

/** 上游 v5.0.0 `## Levels` 表的逐档文案；档位卡各持本档一行，规则卡不得内联整表。 */
const UPSTREAM_LEVELS = {
  lite: 'Build what was asked. Name the smaller option in one line and let the user pick.',
  full: 'The rules above. Default.',
  ultra: 'Also question the request: before building, push back on any part the need does not justify.',
}

const rulesById = new Map(spec.rules.map((rule) => [rule.id, rule]))
const ruleText = (id) => rulesById.get(id).then[0].config.text

test('ponytail 模块：定义通过引擎权威校验', () => {
  // 只 parseYaml 读 YAML 会漏掉引擎侧的不变量（真踩过：同一规则内两个分支的动作都叫
  // `inject`，YAML 完全合法、引擎拒绝 duplicate action id）。校验归唯一编译器，不复刻。
  assert.doesNotThrow(() => compileRules(spec.rules, { configOrder: spec.configOrder ?? {} }),
    'module.yml 的 rules 必须被引擎接受')
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
  // 停用语义与「档位由配置卡持有、不注册命令」是 DSH 本地适配，不属于上游锚点。
  assert.ok(text.includes('stop ponytail') && text.includes('normal mode'), '规则卡必须保留停用语义')
  assert.ok(text.includes('no `/ponytail` command'), '档位归配置卡，规则卡不注册 /ponytail 命令')
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

  // 子代理两档合并为**一张卡 + 动作级 if/then/else**：`else` 结构上保证必有一档注入，
  // 关键词表也只有一份，因此不存在「两处分叉 → 两档并注 / 两档都不注」。**必须在 pre-step
  // 层**——判别「只读 / 写」要看任务文本，而 subagent-start 层的载荷只有
  // runId/provider/id/local（见 docs/injection-point-contracts.md）。
  // 判别只认**明确表示整个任务只读**的信号，取不到就按写档（走 else）：关键词表只收形容
  // 整个任务的词——「不要修改」这类从句级表述不得入表，写任务里出现得比只读任务还频繁，
  // 会让「重构这个函数，不要修改测试文件」整条被判成只读档。
  const RULE_KEYS = ['PONYTAIL:readonly', 'only read', '只读']
  const card = rulesById.get('ponytail-subagent')
  assert.ok(card !== undefined, '子代理分档卡必须存在')
  assert.equal(card.layer, 'pre-step', '必须在 pre-step 层才能读任务文本')
  assert.equal(card.enabled, true)
  assert.deepEqual(card.if.all.find((node) => node.scope !== undefined).scope, { audience: 'subagent' }, '只作用于子代理')
  // 首轮守卫不可省：`agent/pre-step` 的 `messages` 是「本批被领取的消息」，任务文本只在
  // 首轮那批里。第二轮起 userText 为空 → 分档的 text 判假、恒走 else 的写档。判据必须钉在
  // 任务文本还在的那一刻。
  assert.deepEqual(card.if.all.find((node) => node.session !== undefined).session, { type: 'user/message', present: false }, '缺首轮守卫')

  assert.equal(card.then.length, 1, '外层只放一个分档节点')
  const branch = card.then[0]
  // 只读档收窄为**双条件**（`all` 是 AND）：只读信号 + 审查。「只读」类关键词本身有假阳性
  // （子代理分派里的「git 只读」），而只读档的正文是为审查/分析写的（结论优先、把发现当
  // 交付物），因此用第二条独立信号过滤误触，两张关键词表不合并。
  const REVIEW_KEYS = ['审查']
  assert.deepEqual(branch.if, { all: [
    { text: { keys: RULE_KEYS, subject: 'userMessage' } },
    { text: { subject: 'userMessage', keys: REVIEW_KEYS } },
  ] }, '分档判据＝只读信号 AND 审查（后者过滤「git 只读」类假阳性）')
  const readonlyAction = branch.then?.[0]
  const writeAction = branch.else?.[0]
  assert.ok(readonlyAction !== undefined, 'then 分支必须有只读档动作')
  assert.ok(writeAction !== undefined, 'else 分支必须有写档动作（否则漏档）')
  for (const [label, action] of [['只读档', readonlyAction], ['写档', writeAction]]) {
    assert.equal(action.kind, 'inject-text', `${label}: 动作种类`)
    assert.equal(action.config.strategy, 'static', `${label}: 内容策略`)
    assert.equal(action.config.position, 'before-all', `${label}: 规则排在任务文本之前`)
    assert.equal(action.config.dedupe, 'session', `${label}: 每个子代理只付一次`)
    assert.equal(typeof action.config.text, 'string', `${label}: 正文`)
  }
  // 只读档必须是轻量版：完整规则集的执行层条目对只读子代理无关。
  assert.ok(readonlyAction.config.text.length < 400, '只读档应保持轻量')
  assert.ok(!readonlyAction.config.text.includes('## The ladder'), '只读档不搬执行层清单')
  // 写档保留上游全文的关键段落，并声明自己是委派代理。
  for (const section of ['## Before you write', '## The smallest complete change', 'grep every caller', 'Never cut:']) {
    assert.ok(writeAction.config.text.includes(section), `写档缺段落：${section}`)
  }
  assert.ok(writeAction.config.text.includes('You are a delegated agent'), '写档必须说明子代理身份')

  // 档位卡同时服务主会话与子代理：`system-section` 只进主会话——子代理有自己的 system
  // prompt，官方按「global + 确切作用域」合并、不含祖先链；`subagent-start` 才是子代理
  // 读得到的通道。子代理侧只报档位标记，不搬 Levels 表：正文已由 pre-step 副本给出，
  // 同一张表写两份只会各自漂移。切档只靠互斥组启用哪张卡，子代理因此天然跟随。
  for (const level of levels) {
    const name = level.id.replace('ponytail-level-', '')
    assert.deepEqual(level.then.map((action) => action.id), ['inject', 'inject-subagent'], `${level.id}: 档位卡持有两个动作`)
    assert.deepEqual(level.then.map((action) => action.config.layer), ['system-section', 'subagent-start'], `${level.id}: 主会话与子代理各一个动作`)
    assert.ok(level.then[0].config.text.includes(`| **${name}** | ${UPSTREAM_LEVELS[name]} |`), `${level.id}: 主会话动作逐字给出上游本档文案`)
    assert.match(level.then[1].config.text, new RegExp(`^PONYTAIL MODE ACTIVE — level: ${name}`), `${level.id}: 子代理动作只报本档`)
    assert.ok(!level.then[1].config.text.includes('## Levels'), `${level.id}: 子代理动作不搬 Levels 表`)
    assert.equal(level.if, undefined, '档位无条件注入，与上游 matcher 缺省一致')
  }
})
