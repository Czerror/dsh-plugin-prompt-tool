#!/usr/bin/env node
// 离线命令：只操作显式提供的模块根；没有默认真实 DSH_HOME。
import { planRulesMigration, planCharacterRulesMigration, applyRulesMigration, rollbackRulesMigration } from './host/rules-migration.ts'

const args = process.argv.slice(2).filter(value => value !== '--')
let root: string | undefined
let charactersRoot: string | undefined
let mode: string | undefined
for (let index = 0; index < args.length; index++) {
  const value = args[index]
  if (value === '--root' && root === undefined) root = args[++index]
  else if (value === '--characters-root' && charactersRoot === undefined) charactersRoot = args[++index]
  else if (['--check', '--apply', '--rollback'].includes(value!) && mode === undefined) mode = value
  else throw new Error(`未知或重复参数：${value}`)
}
if ((!root && !charactersRoot) || !mode) throw new Error('用法：prompt-tool-migrate-rules [--root <模块根绝对路径>] [--characters-root <角色库绝对路径>] --check|--apply|--rollback')
const roots = [root, charactersRoot].filter((value): value is string => value !== undefined)
if (mode === '--rollback') {
  for (const directory of roots) rollbackRulesMigration(directory, { checkOnly: true })
  console.log(JSON.stringify(roots.map(directory => ({ root: directory, ...rollbackRulesMigration(directory) })), null, 2))
} else {
  // 两个显式根都先完成只读预检，任一无效时任何一侧都不开始写入。
  const plans = [...(root ? [planRulesMigration(root)] : []), ...(charactersRoot ? [planCharacterRulesMigration(charactersRoot)] : [])]
  if (mode === '--check') console.log(JSON.stringify(plans.map(plan => ({ root: plan.root, kind: plan.kind, changes: plan.items.map(({ moduleId, sourceHash }) => ({ moduleId, sourceHash })), writable: false })), null, 2))
  else {
    const completed: Array<{ root: string } & Awaited<ReturnType<typeof applyRulesMigration>>> = []
    try {
      for (const plan of plans) completed.push({ root: plan.root, ...await applyRulesMigration(plan) })
      console.log(JSON.stringify(completed, null, 2))
    } catch (error) {
      const failures = [error]
      for (const result of completed.reverse()) if (result.changed.length > 0) {
        try { rollbackRulesMigration(result.root) } catch (rollbackError) { failures.push(rollbackError) }
      }
      throw new AggregateError(failures, '迁移失败；已完成来源仅在内容仍匹配时回滚，备份保留')
    }
  }
}
