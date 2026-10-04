#!/usr/bin/env node
// 离线命令：只操作显式提供的模块根；没有默认真实 DSH_HOME。
import { planRulesMigration, applyRulesMigration, rollbackRulesMigration } from './host/rules-migration.ts'

const args = process.argv.slice(2).filter(value => value !== '--')
let root: string | undefined
let mode: string | undefined
for (let index = 0; index < args.length; index++) {
  const value = args[index]
  if (value === '--root' && root === undefined) root = args[++index]
  else if (['--check', '--apply', '--rollback', '--decompose'].includes(value!) && mode === undefined) mode = value
  else throw new Error(`未知或重复参数：${value}`)
}
if (!root || !mode) throw new Error('用法：prompt-tool-migrate-rules --root <模块根绝对路径> --check|--apply|--rollback|--decompose')
if (mode === '--rollback') {
  console.log(JSON.stringify({ root, ...rollbackRulesMigration(root) }, null, 2))
} else {
  const plan = planRulesMigration(root, { decompose: mode === '--decompose' })
  if (mode === '--check') console.log(JSON.stringify({ root: plan.root, changes: plan.items.map(({ moduleId, sourceHash }) => ({ moduleId, sourceHash })), writable: false }, null, 2))
  else console.log(JSON.stringify({ root: plan.root, ...await applyRulesMigration(plan) }, null, 2))
}
