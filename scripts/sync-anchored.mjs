// 从 dsh-anchored-standard 上游拉取并刷新内联快照。
// 注意：preset/ 下的 cordis 与 JS 已是本项目自有快照，不会随本脚本自动更新；
// 上游变化需人工 review 后再决定是否移植到 preset/。
// 用法：node scripts/sync-anchored.mjs [ref]   # 默认 main
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = 'https://github.com/xiaobright/dsh-anchored-standard.git'
const ref = process.argv[2] ?? 'main'
const tmp = join(root, '.tmp-anchored-upstream')
const target = join(root, 'upstream', 'dsh-anchored-standard')

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
execFileSync('git', ['clone', '--depth', '1', '--branch', ref, repo, tmp], { stdio: 'inherit' })
const rev = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(join(tmp, 'preset'), join(target, 'preset'), { recursive: true })
for (const file of ['LICENSE', 'NOTICE']) cpSync(join(tmp, file), join(target, file))
writeFileSync(join(target, 'REVISION'), rev + '\n', 'utf8')
rmSync(tmp, { recursive: true, force: true })
console.log('synced dsh-anchored-standard', ref, rev)
console.log('upstream snapshot refreshed. preset/* local files are NOT auto-updated — review and port changes manually.')
