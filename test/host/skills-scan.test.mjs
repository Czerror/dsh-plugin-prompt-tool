import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogFromScan, resolveProjectRoot, scanRoot, scanRoots, skillRoots, withSkillWinners } from '../../src/host/skills-scan.ts'

const sandbox = mkdtempSync(join(process.cwd(), 'pt-scan-'))
after(() => rmSync(sandbox, { recursive: true, force: true }))
function write(root, folder, frontmatter) {
  mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, folder, 'SKILL.md'), `---\n${frontmatter}\n---\nbody\n`)
}

test('管理扫描只发现直属普通目录包与 flat Markdown，不递归资源或系统目录', () => {
  const root = join(sandbox, 'assets')
  write(root, 'alpha', 'name: alpha\ndescription: A')
  write(join(root, 'nested'), 'child', 'name: child\ndescription: C')
  write(root, '.system', 'name: system\ndescription: S')
  writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: F\n---\nbody\n')
  const skills = scanRoot({ kind: 'custom', path: root })
  assert.deepEqual(skills.map((skill) => skill.name), ['alpha', 'flat'])
  assert.deepEqual(catalogFromScan(skills).map((skill) => [skill.canSetPolicy, skill.canDelete]), [[true, true], [true, true]])
  assert.deepEqual(scanRoot({ kind: 'custom', path: join(root, 'absent') }), [])
  assert.deepEqual(scanRoot({ kind: 'custom', path: join(root, 'flat.md') }), [])
})

test('无效资产保留诊断；官方调用策略按端反映声明', () => {
  const root = join(sandbox, 'validation')
  write(root, 'no-name', 'description: D')
  write(root, 'no-description', 'name: no-description')
  write(root, 'bad-name', 'name: Bad_Name\ndescription: D')
  write(root, 'model-off', 'name: model-off\ndescription: D\ndisable-model-invocation: yes')
  write(root, 'user-off', 'name: user-off\ndescription: D\nuser-invocable: off')
  const entries = Object.fromEntries(catalogFromScan(scanRoot({ kind: 'user-dsh', path: root })).map((entry) => [entry.folder, entry]))
  assert.equal(entries['no-name'].issue, 'frontmatter 缺少 name')
  assert.equal(entries['no-description'].issue, 'frontmatter 缺少 description')
  assert.match(entries['bad-name'].issue, /kebab-case/)
  assert.equal(entries['no-name'].canSetPolicy, false)
  assert.deepEqual([entries['model-off'].modelInvocable, entries['model-off'].userInvocable], [false, true])
  assert.deepEqual([entries['user-off'].modelInvocable, entries['user-off'].userInvocable], [true, false])
})

test('管理根随 cwd 寻找项目边界，六类来源保留既有顺序', () => {
  const project = join(sandbox, 'project')
  const cwd = join(project, 'packages', 'app')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  assert.equal(resolveProjectRoot(cwd), project)
  assert.equal(resolveProjectRoot(sandbox), sandbox)
  const saved = [process.env.DSH_AGENTS_HOME, process.env.DSH_BUNDLED_SKILL_DIR]
  process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
  process.env.DSH_BUNDLED_SKILL_DIR = join(sandbox, 'bundled')
  try {
    const roots = skillRoots({ cwd, dshHome: join(sandbox, 'home'), folders: [join(sandbox, 'references')] })
    assert.deepEqual(roots.map((root) => root.kind), ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled'])
    assert.equal(roots[0].path, join(project, '.dsh', 'skills'))
    delete process.env.DSH_BUNDLED_SKILL_DIR
    assert.deepEqual(skillRoots({ dshHome: sandbox, folders: [] }).map((root) => root.kind), ['user-dsh', 'user-agents'])
    assert.deepEqual(scanRoots([{ kind: 'custom', path: join(sandbox, 'assets') }]).map((skill) => skill.name), ['alpha', 'flat'])
  } finally {
    for (const [index, key] of ['DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR'].entries()) {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    }
  }
})

test('投影按 registry 胜出路径标注状态，完整性与文件声明独立，补充虚拟提供方', () => {
  const root = join(sandbox, 'projection')
  write(root, 'first', 'name: shared\ndescription: D\ndisable-model-invocation: true')
  write(root, 'second', 'name: shared\ndescription: D')
  write(root, 'unregistered', 'name: unregistered\ndescription: D')
  const entries = catalogFromScan(scanRoot({ kind: 'custom', path: root }))
  const summaries = [{ name: 'shared', path: join(root, 'second', 'SKILL.md'), provider: 'filesystem', invocation: { modelInvocable: false, userInvocable: false } },
    { name: 'remote', description: 'remote', provider: 'remote-provider', source: 'runtime', invocation: { modelInvocable: true, userInvocable: true } }]
  const result = withSkillWinners(entries, summaries)
  assert.equal(result.find((entry) => entry.folder === 'first').availability, 'shadowed')
  assert.equal(result.find((entry) => entry.folder === 'second').availability, 'active')
  assert.equal(result.find((entry) => entry.folder === 'second').modelInvocable, true, 'registry 不覆盖磁盘声明')
  assert.equal(result.find((entry) => entry.name === 'unregistered').availability, 'unregistered')
  const remote = result.find((entry) => entry.name === 'remote')
  assert.deepEqual([remote.source, remote.availability, remote.canSetPolicy, remote.canDelete], ['other', 'active', false, false])
  assert.ok(withSkillWinners(entries, summaries, false).every((entry) => entry.availability === 'unknown' && entry.winnerId === undefined))
})
