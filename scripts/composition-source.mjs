// 默认重建只接受官方当前 master：核验远端 HEAD，不修改本地宿主仓库。
import { execFileSync } from 'node:child_process'

export const OFFICIAL_UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git'
export const OFFICIAL_BRANCH = 'master'
export const PRESET_SOURCE_PATH = 'packages/bundle/web-app/presets'
export const PRESET_SKILLS_PATH = 'packages/preset/agent-preset/skills'

const runGit = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 30000 }).trim()

/** git 参数注入仅用于离线行为回归；真实路径始终核验官方远端而非本地 origin 别名。 */
export function verifyLatestCompositionSource(repo, git = runGit) {
  const remote = git(['ls-remote', OFFICIAL_UPSTREAM, `refs/heads/${OFFICIAL_BRANCH}`]).trim()
  const [latest, ref] = remote.split(/\s+/)
  if (!/^[0-9a-f]{40}$/.test(latest ?? '') || ref !== `refs/heads/${OFFICIAL_BRANCH}`) {
    throw new Error('cannot verify latest official composition source: invalid remote HEAD')
  }
  const head = git(['-C', repo, 'rev-parse', 'HEAD']).trim()
  if (head !== latest) {
    throw new Error(`official composition source is stale: local ${head}, latest ${latest}; update the source checkout before rebuilding`)
  }
  const dirty = git(['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', PRESET_SOURCE_PATH, PRESET_SKILLS_PATH]).trim()
  if (dirty.length > 0) {
    throw new Error('official preset source has local changes; refusing to publish it as latest upstream')
  }
  return { label: OFFICIAL_BRANCH, commit: latest }
}
