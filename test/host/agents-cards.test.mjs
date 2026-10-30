/**
 * 指令文件卡的探测结果：项目根到 cwd 的目录链、scope 与展示路径。
 * 夹具是独立临时目录，不碰真实 DSH_HOME；结束后清理本次创建的唯一根目录。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAgentsFiles } from '../../src/host/agents-cards.ts'

const work = mkdtempSync(join(tmpdir(), 'pt-agents-cards-'))
after(() => { rmSync(work, { recursive: true, force: true }) })

test('detectAgentsFiles：项目根到 cwd 的链，广到窄，展示路径相对项目根', () => {
  const repo = join(work, 'repo')
  const packagesDir = join(repo, 'packages')
  const sub = join(packagesDir, 'app')
  mkdirSync(sub, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, 'AGENTS.md'), 'ROOT RULES\n')
  writeFileSync(join(packagesDir, 'AGENTS.md'), 'PKG RULES\n')
  writeFileSync(join(sub, 'CLAUDE.md'), 'SUB RULES\n')
  const home = join(work, 'home')
  mkdirSync(home, { recursive: true })

  const cards = detectAgentsFiles({ cwd: sub, home })
  assert.deepEqual(cards.map((card) => [card.scope, card.displayPath]), [
    ['project', 'AGENTS.md'],
    ['project', 'packages/AGENTS.md'],
    ['project', 'packages/app/CLAUDE.md'],
  ])
})

test('detectAgentsFiles：projects:false 只留可确认的全局文件', () => {
  const home = join(work, 'home-global')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n')

  const cards = detectAgentsFiles({ cwd: work, home, projects: false })
  assert.deepEqual(cards.map((card) => [card.scope, card.displayPath]), [['global', '~/.dsh/AGENTS.md']])
})

test('detectAgentsFiles：宿主只认 .git，.hg 不进目录链', () => {
  // 独立根：既固定项目根（不依赖 tmpdir 是否落在 git 仓内），也不给同文件其它用例留共享标记。
  const hgWork = mkdtempSync(join(tmpdir(), 'pt-agents-hg-'))
  try {
    mkdirSync(join(hgWork, '.git'), { recursive: true })
    const hgRepo = join(hgWork, 'hg-repo')
    const sub = join(hgRepo, 'pkg')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(hgRepo, '.hg'), { recursive: true })
    writeFileSync(join(hgRepo, 'AGENTS.md'), 'HG ROOT RULES\n')
    const home = join(hgWork, 'home-hg')
    mkdirSync(home, { recursive: true })

    // .hg 不参与选根：root 固定在 hgWork，hg-repo 只是链上目录，展示路径保留 hg-repo/。
    // 若 .hg 被认作 marker，root 会变成 hg-repo，displayPath 塌缩成 AGENTS.md。
    assert.deepEqual(
      detectAgentsFiles({ cwd: sub, home }).map((card) => card.displayPath),
      ['hg-repo/AGENTS.md'],
    )
  } finally {
    rmSync(hgWork, { recursive: true, force: true })
  }
})
