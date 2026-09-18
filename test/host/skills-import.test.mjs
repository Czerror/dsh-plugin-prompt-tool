// 技能导入（注册层屏蔽模型）：复制进用户技能根 `$DSH_HOME/skills`，不建受管实体库、不建链接。
// 随注册层屏蔽模型移除：`.system` 物化目标与受管记录不再存在；覆盖前只允许替换技能目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSkillsPackage, importSkillsDirectory, readSkillDirectory } from '../../src/host/skills-import.ts'

const makeRoot = (prefix = 'prompt-tool-skills-import') => {
  const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(root, { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const file = (path, text) => ({ path, content: Buffer.from(text).toString('base64') })
const skill = (name, body = name) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`

test('importSkillsPackage：目录导入保留顶层文件夹并落在用户技能根', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nbody\n'),
      { path: 'demo/assets/icon.png', content: Buffer.from([1, 2, 3]).toString('base64') },
    ])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.path, root)
    assert.equal(result.count, 2)
    assert.equal(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: demo\n---\nbody\n')
    assert.deepEqual([...readFileSync(join(root, 'demo', 'assets/icon.png'))], [1, 2, 3])
    assert.equal(existsSync(join(root, '.system')), false, '导入不落受管实体库')
    assert.deepEqual(readdirSync(root).sort(), ['demo'])
  } finally {
    cleanup()
  }
})

test('importSkillsPackage：覆盖前要求目标是技能目录，非技能目录原样保留', () => {
  const { root, cleanup } = makeRoot()
  try {
    const first = importSkillsPackage(root, [file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nold\n')])
    assert.equal(first.ok, true)
    const files = [file('demo/SKILL.md', skill('demo', 'new'))]
    const conflict = importSkillsPackage(root, files)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'skills-overwrite-required')
    assert.deepEqual(conflict.conflicts, ['demo'])
    assert.match(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), /old/)
    assert.deepEqual(readdirSync(root), ['demo'], '未确认时没有暂存或回收站写入')
    const replacement = importSkillsPackage(root, files, ['demo'])
    assert.equal(replacement.ok, true)
    assert.equal(replacement.overwritten, 1, '覆盖导入如实报告替换数量')
    assert.match(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), /new/)
    assert.deepEqual(readdirSync(root), ['demo'], '确认覆盖成功不保留技能历史版本')

    // 用户根里的普通目录不是技能目录：覆盖导入必须拒绝且不改动它。
    mkdirSync(join(root, 'plain'))
    writeFileSync(join(root, 'plain', 'note.txt'), 'keep', 'utf8')
    const rejected = importSkillsPackage(root, [file('plain/SKILL.md', skill('plain'))], ['plain'])
    assert.equal(rejected.ok, false)
    assert.equal(readFileSync(join(root, 'plain', 'note.txt'), 'utf8'), 'keep')
    assert.equal(existsSync(join(root, 'plain', 'SKILL.md')), false)
  } finally {
    cleanup()
  }
})

test('importSkillsDirectory：复制宿主机目录内容到用户技能根并保留资源', () => {
  const { root, cleanup } = makeRoot()
  const source = makeRoot('pt-skills-source')
  try {
    mkdirSync(join(source.root, 'references'))
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported-skill\ndescription: imported\n---\nbody\n', 'utf8')
    writeFileSync(join(source.root, 'references', 'doc.md'), 'doc', 'utf8')

    const files = readSkillDirectory(source.root)
    assert.deepEqual(files.map((entry) => entry.path).sort(), ['SKILL.md', 'references/doc.md'])
    const result = importSkillsDirectory(root, source.root)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const name = source.root.split(/[\\/]/).at(-1)
    assert.equal(result.path, root)
    assert.equal(result.count, 2)
    assert.equal(readFileSync(join(root, name, 'references', 'doc.md'), 'utf8'), 'doc')
    assert.equal(existsSync(join(source.root, 'SKILL.md')), true, '复制导入不改动来源目录')
    assert.equal(existsSync(join(root, '.system')), false)
    // 来源目录名必须是合法技能目录名：非法名先于任何写盘被拒绝。
    const bad = makeRoot('pt-skills-source')
    const badName = join(bad.root, 'Bad Name')
    mkdirSync(badName)
    writeFileSync(join(badName, 'SKILL.md'), '---\nname: bad\ndescription: bad\n---\nbody\n', 'utf8')
    const rejected = importSkillsDirectory(root, badName)
    assert.equal(rejected.ok, false)
    assert.equal(existsSync(join(root, 'Bad Name')), false)
    rmSync(bad.root, { recursive: true, force: true })
    // 来源必须是绝对路径：空串会经 resolve('') 退化成进程工作目录，等于把整个 cwd 当技能导入。
    for (const [label, invalid] of [['空串', ''], ['纯空白', '   '], ['相对路径', 'pt-skills-source']]) {
      const guarded = importSkillsDirectory(root, invalid)
      assert.equal(guarded.ok, false, `${label}必须被拒绝`)
      assert.match(guarded.ok ? '' : guarded.message, /绝对路径|路径为空/u, label)
    }
    assert.deepEqual(readdirSync(root), [name], '被拒绝的导入不向用户技能根写入任何内容')
  } finally {
    cleanup()
    source.cleanup()
  }
})

test('importSkillsDirectory：同名技能必须先确认，成功覆盖后不保留历史版本', () => {
  const target = makeRoot()
  const source = makeRoot('pt-skills-source')
  const root = target.root
  try {
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported\ndescription: first\n---\nfirst body\n', 'utf8')
    const first = importSkillsDirectory(root, source.root)
    assert.equal(first.ok, true, first.ok ? '' : first.message)
    if (!first.ok) return
    assert.equal(first.overwritten, 0, '首次导入没有覆盖任何技能')
    const name = source.root.split(/[\\/]/).at(-1)

    // 改来源内容后再次导入：未确认时完整保留旧技能。
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported\ndescription: second\n---\nsecond body\n', 'utf8')
    const conflict = importSkillsDirectory(root, source.root)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'skills-overwrite-required')
    assert.deepEqual(conflict.conflicts, [name])
    assert.match(readFileSync(join(root, name, 'SKILL.md'), 'utf8'), /first body/)
    const second = importSkillsDirectory(root, source.root, [name])
    assert.equal(second.ok, true, second.ok ? '' : second.message)
    if (!second.ok) return
    assert.equal(second.overwritten, 1, '覆盖计数如实返回')
    assert.match(readFileSync(join(root, name, 'SKILL.md'), 'utf8'), /second body/)

    assert.deepEqual(readdirSync(root), [name], '成功后临时备份已清理，不创建回收站条目')
  } finally {
    target.cleanup()
    source.cleanup()
  }
})

test('整批预检：非法目录名被拒绝时新建和现存技能均无写入', () => {
  const target = makeRoot()
  const root = target.root
  try {
    mkdirSync(join(root, 'demo-skill'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: old\n---\nold body\n', 'utf8')

    const result = importSkillsPackage(root, [
      file('new-skill/SKILL.md', skill('new-skill')),
      file('demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: new\n---\nnew body\n'),
      file('Bad Name/SKILL.md', '---\nname: bad\ndescription: bad\n---\nbody\n'),
    ], ['demo-skill'])
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /kebab-case/u, '失败原因仍是原始错误')
    assert.match(readFileSync(join(root, 'demo-skill', 'SKILL.md'), 'utf8'), /old body/, '旧技能必须被放回原处')
    assert.deepEqual(readdirSync(root), ['demo-skill'], '预检失败不创建暂存目录或回收站')
  } finally {
    target.cleanup()
  }
})

test('importSkillsPackage：每个顶层必须有有效 SKILL.md，整批拒绝前零写盘', () => {
  const { root, cleanup } = makeRoot()
  try {
    for (const bad of [
      file('bad/note.md', 'missing marker'),
      file('bad/SKILL.md', 'missing frontmatter'),
      file('bad/SKILL.md', '---\nname: bad\ndescription: [\n---\nbody'),
      file('bad/SKILL.md', '---\nname: Bad_Name\ndescription: bad\n---\nbody'),
      file('bad/SKILL.md', '---\nname: bad\n---\nbody'),
    ]) {
      assert.equal(importSkillsPackage(root, [file('good/SKILL.md', skill('good')), bad]).ok, false, bad.path)
      assert.deepEqual(readdirSync(root), [], '一个无效技能应阻止整批写盘')
    }
  } finally { cleanup() }
})

test('浏览器容器外壳剥离后技能在根下一层，单技能与 rootless 资源保持归属', () => {
  const { root, cleanup } = makeRoot()
  try {
    assert.equal(importSkillsPackage(root, [
      file('skill-pack/alpha/SKILL.md', skill('alpha')),
      file('skill-pack/alpha/references/doc.md', 'alpha doc'),
      file('skill-pack/beta/SKILL.md', skill('beta')),
    ]).ok, true)
    assert.deepEqual(readdirSync(root).sort(), ['alpha', 'beta'])
    assert.equal(readFileSync(join(root, 'alpha/references/doc.md'), 'utf8'), 'alpha doc')
    assert.equal(importSkillsPackage(root, [file('gamma/SKILL.md', skill('declared-name'))]).ok, true)
    assert.equal(existsSync(join(root, 'gamma/SKILL.md')), true, '单技能目录名不换成声明名')
    assert.equal(importSkillsPackage(root, [
      file('SKILL.md', skill('rootless')),
      file('references/doc.md', 'rootless doc'),
      file('assets/nested/data.json', '{}'),
    ]).ok, true)
    assert.equal(readFileSync(join(root, 'rootless/references/doc.md'), 'utf8'), 'rootless doc')
    assert.equal(readFileSync(join(root, 'rootless/assets/nested/data.json'), 'utf8'), '{}')
    assert.deepEqual(readdirSync(root).sort(), ['alpha', 'beta', 'gamma', 'rootless'])
  } finally { cleanup() }
})

test('确认名单只授权已展示目录：新增冲突会再次阻止整批写盘', () => {
  const { root, cleanup } = makeRoot()
  try {
    assert.equal(importSkillsPackage(root, [file('alpha/SKILL.md', skill('alpha', 'old alpha'))]).ok, true)
    const files = [file('alpha/SKILL.md', skill('alpha', 'new alpha')), file('beta/SKILL.md', skill('beta', 'new beta'))]
    assert.deepEqual(importSkillsPackage(root, files).conflicts, ['alpha'])
    assert.equal(existsSync(join(root, 'beta')), false)
    assert.equal(importSkillsPackage(root, [file('beta/SKILL.md', skill('beta', 'old beta'))]).ok, true)
    const refused = importSkillsPackage(root, files, ['alpha'])
    assert.equal(refused.code, 'skills-overwrite-required')
    assert.deepEqual(refused.conflicts, ['beta'])
    assert.match(readFileSync(join(root, 'alpha/SKILL.md'), 'utf8'), /old alpha/)
    assert.match(readFileSync(join(root, 'beta/SKILL.md'), 'utf8'), /old beta/)
    assert.deepEqual(readdirSync(root).sort(), ['alpha', 'beta'])
    assert.equal(importSkillsPackage(root, files, ['alpha', 'beta']).overwritten, 2)
    assert.deepEqual(readdirSync(root).sort(), ['alpha', 'beta'])
  } finally { cleanup() }
})

test('切换中途失败：回滚已覆盖技能并清理已新增技能，资源字节保留', (t) => {
  const { root, cleanup } = makeRoot()
  try {
    assert.equal(importSkillsPackage(root, [
      file('existing/SKILL.md', skill('existing', 'old')),
      file('existing/assets/data.bin', 'old asset'),
    ]).ok, true)
    const rename = fs.renameSync
    const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
      if (target === join(root, 'failure')) throw new Error('模拟第三项切换失败')
      return rename(source, target)
    })
    syncBuiltinESMExports()
    const result = importSkillsPackage(root, [
      file('new-skill/SKILL.md', skill('new-skill')),
      file('existing/SKILL.md', skill('existing', 'new')),
      file('failure/SKILL.md', skill('failure')),
    ], ['existing'])
    mocked.mock.restore()
    syncBuiltinESMExports()
    assert.equal(result.ok, false)
    assert.match(result.message, /模拟第三项切换失败/)
    assert.deepEqual(readdirSync(root), ['existing'])
    assert.equal(readFileSync(join(root, 'existing/SKILL.md'), 'utf8'), skill('existing', 'old'))
    assert.equal(readFileSync(join(root, 'existing/assets/data.bin'), 'utf8'), 'old asset')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); cleanup() }
})

test('importSkillsPackage：拒绝路径穿越且不落盘', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      file('demo/../../escape.txt', 'bad'),
    ])
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
    assert.equal(existsSync(join(root, 'demo')), false)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    cleanup()
  }
})

test('importSkillsPackage：空文件列表直接失败', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [])
    assert.equal(result.ok, false)
  } finally {
    cleanup()
  }
})

test('目录导入在读取超限资源前拒绝，已有技能不变', (t) => {
  const source = makeRoot('pt-skills-capacity')
  const stat = fs.lstatSync
  let attempted = false
  writeFileSync(join(source.root, 'huge.bin'), 'fixture')
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const info = stat(path, ...args)
    if (String(path).endsWith('huge.bin')) info.size = 1024 * 1024 * 1024
    return info
  })
  t.mock.method(fs, 'readFileSync', () => { attempted = true; throw new Error('不得读取超限文件') })
  syncBuiltinESMExports()
  try {
    assert.throws(() => readSkillDirectory(source.root), /容量上限/)
    assert.equal(attempted, false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); source.cleanup() }
})

test('提交后清理失败仍返回成功与残留提示，目标技能已生效', (t) => {
  const { root, cleanup } = makeRoot()
  const remove = fs.rmSync
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (String(path).includes('.skills-import-')) throw new Error('cleanup-EACCES')
    return remove(path, options)
  })
  syncBuiltinESMExports()
  try {
    const result = importSkillsPackage(root, [file('demo/SKILL.md', skill('demo'))])
    assert.equal(result.ok, true, result.message)
    assert.match(result.warning, /cleanup-EACCES/)
    assert.match(result.warning, /\.skills-import-/)
    assert.equal(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), skill('demo'))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); cleanup() }
})

test('无效与旧策略字段整批拒绝，不能把官方无法发现的技能导入', () => {
  const { root, cleanup } = makeRoot()
  try {
    for (const line of ['disable-model-invocation: nope', 'user-invocable: []', 'disableModelInvocation: false', 'modelInvocable: true', 'userInvocable: false']) {
      const result = importSkillsPackage(root, [file('demo/SKILL.md', `---\nname: demo\ndescription: D\n${line}\n---\nbody\n`)])
      assert.equal(result.ok, false, line)
      assert.deepEqual(readdirSync(root), [], line)
    }
  } finally { cleanup() }
})
