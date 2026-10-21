/**
 * env-facts 的安全边界：只能读 SAFE_ENV_KEYS 里的环境变量。
 * 断言停在 FILLERS 构造入口与引擎编译器这两个公共入口，不匹配实现细节。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { FILLERS } from '../../engine/fillers.mjs'
import { SAFE_ENV_KEYS, SENSITIVE_ENV_RE } from '../../engine/env-safety.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const TEST_HOME = '/tmp/pt-env-safety-home'
const saved = { DSH_HOME: process.env.DSH_HOME, DSH_WORKSPACE: process.env.DSH_WORKSPACE }
process.env.DSH_HOME = TEST_HOME
delete process.env.DSH_WORKSPACE
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const agent = { session: { header: { cwd: '/repo' } } }
const envFacts = (params) => FILLERS['env-facts']({ id: 'env', text: '{{ENV_FACTS}}', params })

test('env-facts 构造期拒绝白名单外的键，消息点名被拒键与安全白名单', () => {
  for (const key of ['OPENAI_API_KEY', 'GITHUB_PAT']) {
    assert.throws(
      () => envFacts({ envKeys: `PATH,${key}` }),
      (error) => error instanceof TypeError
        && error.message.includes(key)
        && error.message.includes('safe keys: PATH'),
      key,
    )
  }
  assert.doesNotThrow(() => envFacts({ envKeys: [...SAFE_ENV_KEYS].join(',') }), '白名单全集必须被接受')
})

test('安全白名单不含凭据形态名', () => {
  assert.deepEqual([...SAFE_ENV_KEYS].filter((key) => SENSITIVE_ENV_RE.test(key)), [])
  assert.equal(SENSITIVE_ENV_RE.test('OPENAI_API_KEY'), true)
})

test('PATH 与 DSH_HOME 可读，CWD/WORKSPACE 照旧派生', () => {
  const result = envFacts({ envKeys: 'PATH,DSH_HOME' })({ agent })
  assert.equal(result.variables.PATH, process.env.PATH)
  assert.equal(result.variables.DSH_HOME, TEST_HOME)
  assert.equal(result.variables.WORKSPACE, '/repo')
  assert.equal(result.variables.CWD, '/repo')
  assert.ok(result.variables.ENV_FACTS.split('\n').includes(`- DSH_HOME=${TEST_HOME}`))
  assert.ok(result.variables.ENV_FACTS.split('\n').includes(`- PATH=${process.env.PATH}`))
})

test('空 envKeys 行为不变：只输出派生 CWD/WORKSPACE', () => {
  assert.deepEqual(envFacts()({ agent }).variables, {
    WORKSPACE: '/repo',
    CWD: '/repo',
    ENV_FACTS: '- WORKSPACE=/repo\n- CWD=/repo',
  })
})

test('模板 18 的 env-facts 配置仍可编译', () => {
  const template = parseYaml(readFileSync(join(repoRoot, 'templates', '18-placeholder-env-facts.yml'), 'utf8'))
  assert.doesNotThrow(() => compileRules([template]))
})
