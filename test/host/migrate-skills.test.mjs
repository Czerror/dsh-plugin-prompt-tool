import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'migrate-skills.mjs')

/** 造一个含旧 settings 技能键 + 旧 per-profile 副本的 DSH_HOME。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-skills-home-'))
  const legacy = join(home, 'profiles', 'prompt-tool', 'skills')
  for (const [folder, name] of [['keep-skill', 'keep-skill'], ['off-skill', 'off-skill']]) {
    mkdirSync(join(legacy, folder), { recursive: true })
    writeFileSync(join(legacy, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\nbody\n`, 'utf8')
  }
  writeFileSync(join(legacy, '.prompt-tool-manifest.json'), '{"version":1,"skills":{}}\n', 'utf8')
  writeFileSync(join(home, 'settings.yaml'), [
    'agent-presets:',
    '  default: standard',
    'prompt-tool:',
    `  skillsDir: "${legacy.replace(/\\/g, '\\\\')}"`,
    '  skillSwitches:',
    '    {',
    '      keep-skill: true,',
    '      off-skill: false',
    '    }',
    '  skillOrder:',
    '    - off-skill',
    '    - keep-skill',
    '  skillsDirs:',
    `    - ${legacy}`,
    '    - D:\\external-skills',
    '  skillRankBase: 300',
    '  writeAgents: false',
    '# 手工注释：保留我',
    'mnemon:',
    '  displayMode: sidebar',
    '',
  ].join('\n'), 'utf8')
  return { home, legacy }
}

const run = (home, extra = []) =>
  execFileSync(process.execPath, [SCRIPT, ...extra], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })

test('migrate-skills：旧副本搬运 + settings 技能键 → 配置/磁盘停用，旧参数清理且保留注释', () => {
  const { home, legacy } = makeHome()
  try {
    const output = run(home)
    assert.match(output, /搬运: 复制 2 个技能/)
    assert.match(output, /settings\.yaml: 删除旧键 skillsDir, skillsDirs, skillSwitches, skillOrder, skillRankBase/)

    // 1) 技能已搬到技能根；旧账本不搬。
    assert.equal(existsSync(join(home, 'skills', 'keep-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(home, 'skills', '.prompt-tool-manifest.json')), false)
    // 2) false 的技能在技能根里落成磁盘停用。
    assert.equal(existsSync(join(home, 'skills', 'off-skill', 'SKILL.md')), false)
    assert.equal(existsSync(join(home, 'skills', 'off-skill', 'SKILL.md.disabled')), true)
    // 3) 配置：废弃的 per-profile 路径不入 dirs，顺序/rank 保留。
    const config = readFileSync(join(home, 'skills', '.system', 'prompt-tool', 'config.yml'), 'utf8')
    assert.match(config, /D:\\external-skills/)
    assert.equal(config.includes(legacy), false, '废弃副本路径不得写入 dirs')
    assert.match(config, /- off-skill/)
    assert.match(config, /rankBase: 300/)
    // 4) settings.yaml：旧键清掉、其他段与注释保留、写前备份。
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.equal(/skillsDir|skillSwitches|skillOrder|skillRankBase|skillsDirs/.test(settings), false)
    assert.match(settings, /writeAgents: false/)
    assert.match(settings, /# 手工注释：保留我/)
    assert.match(settings, /mnemon:/)
    assert.equal(readdirSync(home).some((name) => name.startsWith('settings.yaml.bak-')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-skills：dry-run 不写盘，重复运行幂等', () => {
  const { home } = makeHome()
  try {
    const dry = run(home, ['--dry-run'])
    assert.match(dry, /\[dry-run\]/)
    assert.equal(existsSync(join(home, 'skills')), false, 'dry-run 不得写盘')
    assert.match(readFileSync(join(home, 'settings.yaml'), 'utf8'), /skillSwitches/)

    run(home)
    const second = run(home)
    assert.match(second, /搬运: 复制 0 个技能/)
    assert.match(second, /settings\.yaml: 删除旧键 无（本次无）/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-skills：--clean-legacy 把旧副本目录改名归档（可恢复，不删除）', () => {
  const { home, legacy } = makeHome()
  try {
    run(home, ['--clean-legacy'])
    assert.equal(existsSync(legacy), false, '旧副本目录已归档')
    assert.equal(readdirSync(join(home, 'profiles', 'prompt-tool')).some((name) => name.startsWith('skills.retired-')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
