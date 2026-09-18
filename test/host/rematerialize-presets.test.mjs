import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'
// 内置 anchored 预设已随上游冻结下线；夹具模板承接它的「锚定/门控装配 + 三条
// 提示词配置」结构。rematerialize 脚本按 $DSH_HOME/.agent-presets 扫描预设根，
// 因此夹具必须装进隔离 DSH_HOME 的官方预设根（而非 writePreset 的输出根）。
import { installFixturePresetInHome } from '../fixtures/preset-template.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'rematerialize-presets.mjs')

function run(home, ...extra) {
  return execFileSync(process.execPath, [SCRIPT, '--dsh-home', home, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
}

/** 子进程内仅 mock Node fs 边界，不改生产入口或磁盘上的脚本。 */
function runWithFsMock(home, setup) {
  const preload = `
    import fs from 'node:fs'
    import { mock } from 'node:test'
    import { syncBuiltinESMExports } from 'node:module'
    ${setup}
    syncBuiltinESMExports()
  `
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    SCRIPT, '--dsh-home', home, '--refresh-skills',
  ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
}

/** 用包内模板播种一个插件格式用户预设目录。 */
function seedPreset(home, name, template = 'pt-minimal') {
  const dir = join(home, '.agent-presets', name)
  mkdirSync(dir, { recursive: true })
  cpSync(join(ROOT, 'preset', template), dir, { recursive: true })
  const file = join(dir, 'preset.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  doc.set('id', name)
  writeFileSync(file, doc.toString(), 'utf8')
  return dir
}

test('rematerialize-presets：按当前 preset.yml 重新物化组合与共享引擎', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'minimal')
    const output = run(home)
    assert.match(output, /1 materialized/)
    assert.match(output, /0 failed/)

    const composition = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /# prompt-tool:render v/, '组合带 render 版本戳')
    assert.ok(Array.isArray(parseYaml(composition)), '组合是 YAML 数组')
    assert.ok(existsSync(join(home, '.agent-presets', '.engine', '.pt-engine-fingerprint')), '共享引擎已物化')
    assert.ok(existsSync(join(dir, 'prompt-configs')), '提示词配置目录已物化')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：手写/官方格式预设（无 modules/params）跳过，不覆盖组合', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = join(home, '.agent-presets', 'liangshen')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preset.yml'), 'name: 梁神模式\ndescription: 手写预设\norder: 9\n', 'utf8')
    const composition = '# hand-written composition\n[]\n'
    writeFileSync(join(dir, 'agent.cordis.yml'), composition, 'utf8')

    const output = run(home)
    assert.match(output, /1 skipped/)
    assert.equal(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'), composition, '手写组合不被覆盖')
    assert.match(readFileSync(join(dir, 'preset.yml'), 'utf8'), /手写预设/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：dry-run 只报告不写盘', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    writeFileSync(skill, 'dry-run 不刷新\n', 'utf8')
    mkdirSync(join(dir, 'skills', 'extra'))
    writeFileSync(join(dir, 'skills', 'extra', 'SKILL.md'), '独有技能\n', 'utf8')
    const before = readFileSync(join(dir, 'preset.yml'), 'utf8')
    const entries = readdirSync(home, { recursive: true }).sort()
    const output = run(home, '--dry-run', '--refresh-skills')
    assert.match(output, /dry-run/)
    assert.match(output, /would materialize pt-cordis/)
    assert.match(output, /would refresh skills pt-cordis/)
    assert.equal(readFileSync(skill, 'utf8'), 'dry-run 不刷新\n')
    assert.equal(readFileSync(join(dir, 'skills', 'extra', 'SKILL.md'), 'utf8'), '独有技能\n')
    assert.deepEqual(readdirSync(home, { recursive: true }).sort(), entries, '不创建暂存目录或备份')
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), before, 'dry-run 不写 preset.yml')
    assert.equal(existsSync(join(dir, 'agent.cordis.yml')), false, 'dry-run 不生成组合')
    assert.equal(existsSync(join(home, '.agent-presets', '.engine')), false, 'dry-run 不物化引擎')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：引擎参数按 preset.yml 解析，不回落 writePreset 默认值', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = installFixturePresetInHome(home)
    const doc = parseDocument(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    doc.setIn(['params', 'firstTurnAnchor'], true)
    doc.setIn(['params', 'injectPrompt'], false)
    writeFileSync(join(dir, 'preset.yml'), doc.toString(), 'utf8')

    const output = run(home)
    assert.match(output, /1 materialized/)
    const configs = join(dir, 'prompt-configs')
    assert.match(readFileSync(join(configs, '0000-near-anchor.yml'), 'utf8'), /enabled: true/)
    assert.match(readFileSync(join(configs, '0020-prompt-injector.yml'), 'utf8'), /enabled: false/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：预设内嵌 skills 漂移只报告，不覆盖本机副本', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    assert.ok(existsSync(skill), '模板自带预设内嵌技能')
    writeFileSync(skill, '本机改动\n', 'utf8')

    const output = run(home)
    assert.match(output, /stale skills pt-cordis/, '漂移必须被报告')
    assert.match(output, /1 stale skills/)
    assert.equal(readFileSync(skill, 'utf8'), '本机改动\n', '默认不得覆盖用户副本')
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('skills.bak-')).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：--refresh-skills 先备份再按包内模板刷新', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    const packaged = readFileSync(skill, 'utf8')
    writeFileSync(skill, '本机改动\n', 'utf8')

    const output = run(home, '--refresh-skills')
    assert.match(output, /refreshed skills pt-cordis/)
    assert.equal(readFileSync(skill, 'utf8'), packaged, '按包内模板刷新')
    const backups = readdirSync(dir).filter((name) => name.startsWith('skills.bak-'))
    assert.equal(backups.length, 1, '原副本先备份为 skills.bak-<时间戳>')
    assert.equal(readFileSync(join(dir, backups[0], 'editing-cordis-compositions', 'SKILL.md'), 'utf8'), '本机改动\n',
      '备份保留本机改动')

    const second = run(home)
    assert.match(second, /0 stale skills/, '刷新后不再报告漂移')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：刷新保留独有文件和目录，只有 extra 时不重复备份', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skills = join(dir, 'skills')
    const shared = join('editing-cordis-compositions', 'SKILL.md')
    const packaged = readFileSync(join(skills, shared), 'utf8')
    const extras = [join('extra', 'SKILL.md'), join('editing-cordis-compositions', 'local.txt'), 'notes.txt']
    mkdirSync(join(skills, 'extra', 'empty'), { recursive: true })
    for (const extra of extras) writeFileSync(join(skills, extra), `用户文件 ${extra}\n`, 'utf8')
    writeFileSync(join(skills, shared), '原同名技能\n', 'utf8')
    const before = readdirSync(skills, { recursive: true }).sort()

    assert.match(run(home, '--refresh-skills'), /refreshed skills pt-cordis/)
    assert.equal(readFileSync(join(skills, shared), 'utf8'), packaged, '同名文件按模板刷新')
    for (const extra of extras) {
      assert.equal(readFileSync(join(skills, extra), 'utf8'), `用户文件 ${extra}\n`, '独有文件仍在有效 skills 中')
    }
    assert.deepEqual(readdirSync(join(skills, 'extra', 'empty')), [], '独有空目录保留')
    const backups = readdirSync(dir).filter((name) => name.startsWith('skills.bak-'))
    assert.equal(backups.length, 1)
    const backup = join(dir, backups[0])
    assert.deepEqual(readdirSync(backup, { recursive: true }).sort(), before, '备份保留完整旧树')
    assert.equal(readFileSync(join(backup, shared), 'utf8'), '原同名技能\n')
    for (const extra of extras) assert.equal(readFileSync(join(backup, extra), 'utf8'), `用户文件 ${extra}\n`)

    assert.doesNotMatch(run(home, '--refresh-skills'), /refreshed skills/, '仅 extra 不再刷新')
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('skills.bak-')), backups, '不产生无尽备份')
    for (const extra of extras) assert.equal(readFileSync(join(skills, extra), 'utf8'), `用户文件 ${extra}\n`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：新 skills 切换失败时恢复旧目录，只清理本次暂存目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skills = join(dir, 'skills')
    const skill = join(skills, 'editing-cordis-compositions', 'SKILL.md')
    writeFileSync(skill, '切换前原文\n', 'utf8')
    mkdirSync(join(skills, 'extra'))
    writeFileSync(join(skills, 'extra', 'SKILL.md'), '用户独有\n', 'utf8')
    const unrelated = '.skills-refresh-existing'
    mkdirSync(join(dir, unrelated))
    writeFileSync(join(dir, unrelated, 'keep'), '不得清理\n', 'utf8')
    const result = runWithFsMock(home, `
      const rename = fs.renameSync
      let failed = false
      mock.method(fs, 'renameSync', (source, target) => {
        if (!failed && target === ${JSON.stringify(skills)}) {
          failed = true
          throw new Error('injected skills activation failure')
        }
        return rename(source, target)
      })
    `)

    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /injected skills activation failure/)
    assert.equal(readFileSync(skill, 'utf8'), '切换前原文\n', '失败后 live 恢复原文')
    assert.equal(readFileSync(join(skills, 'extra', 'SKILL.md'), 'utf8'), '用户独有\n')
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('skills.bak-')), [], '备份已回退到 live')
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.skills-refresh-')), [unrelated])
    assert.equal(readFileSync(join(dir, unrelated, 'keep'), 'utf8'), '不得清理\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：暂存复制失败时 live 未被移走，不留下半成品或备份', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    writeFileSync(skill, '复制前原文\n', 'utf8')
    const result = runWithFsMock(home, `
      const copy = fs.cpSync
      mock.method(fs, 'cpSync', (source, target, options) => {
        if (source === ${JSON.stringify(join(ROOT, 'preset', 'pt-cordis', 'skills'))}) {
          if (fs.readFileSync(${JSON.stringify(skill)}, 'utf8') !== '复制前原文\\n') {
            throw new Error('live moved before staging completed')
          }
          fs.mkdirSync(target, { recursive: true })
          fs.writeFileSync(target + '/partial', '半成品')
          throw new Error('injected skills copy failure')
        }
        return copy(source, target, options)
      })
    `)

    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /injected skills copy failure/)
    assert.equal(readFileSync(skill, 'utf8'), '复制前原文\n')
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('skills.bak-') || name.startsWith('.skills-refresh-')), [])
    assert.equal(existsSync(join(dir, 'skills', 'partial')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：刷新不沿同名目录链接外写，独有链接和旧链接保留', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'pt-cordis', 'pt-cordis')
    // skills 刷新也适用于手写预设；跳过 writePreset，直接验证本脚本的链接边界。
    writeFileSync(join(dir, 'preset.yml'), 'name: cordis\norder: 0\n', 'utf8')
    const skills = join(dir, 'skills')
    const linked = join(skills, 'editing-cordis-compositions')
    const packaged = readFileSync(join(linked, 'SKILL.md'), 'utf8')
    const outside = join(home, 'outside')
    renameSync(linked, outside)
    writeFileSync(join(outside, 'SKILL.md'), '外部原文\n', 'utf8')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(outside, linked, linkType)
    symlinkSync(outside, join(skills, 'extra-link'), linkType)
    const target = readlinkSync(linked)
    const entries = readdirSync(outside, { recursive: true }).sort()

    assert.match(run(home, '--refresh-skills'), /refreshed skills pt-cordis/)
    assert.equal(lstatSync(linked).isSymbolicLink(), false, '包内同名目录从模板刷新')
    assert.equal(readFileSync(join(linked, 'SKILL.md'), 'utf8'), packaged)
    assert.equal(readlinkSync(join(skills, 'extra-link')), target, '独有链接原样保留')
    const backups = readdirSync(dir).filter((name) => name.startsWith('skills.bak-'))
    assert.equal(backups.length, 1)
    assert.equal(readlinkSync(join(dir, backups[0], 'editing-cordis-compositions')), target)
    assert.equal(readlinkSync(join(dir, backups[0], 'extra-link')), target)
    assert.equal(readFileSync(join(outside, 'SKILL.md'), 'utf8'), '外部原文\n')
    assert.deepEqual(readdirSync(outside, { recursive: true }).sort(), entries, '链接目标树不改动')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
