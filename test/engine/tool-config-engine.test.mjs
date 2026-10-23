import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../engine/tool-config-engine.mjs'

/** 独立临时目录：不依赖共享状态，用例结束清理。 */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'pt-custom-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function toolOf(execute, timeoutMs) {
  return {
    id: 'probe',
    name: 'probe',
    description: '测试工具',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    output: { schema: { type: 'object', additionalProperties: true } },
    execute,
  }
}

function registerTool(definition) {
  const registered = []
  const warnings = []
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    get() { return undefined },
  }
  apply(ctx, { tools: [definition] })
  return { tool: registered[0], warnings }
}

function runTool(tool, cwd, args = {}) {
  return tool.execute(args, { agent: { session: { header: { cwd } } }, signal: new AbortController().signal })
}

/** 用当前 node 执行一段 JS：pwsh 需要 & 调用运算符，POSIX sh 不要。 */
function nodeEval(script) {
  return process.platform === 'win32'
    ? `& "${process.execPath}" -e "${script}"`
    : `"${process.execPath}" -e "${script}"`
}

test('fs 执行器：真实路径限定 cwd，正常读写照旧', async (t) => {
  const cwd = tempRoot(t)
  writeFileSync(join(cwd, 'notes.txt'), 'inside')
  const runFs = async (action, path, content) => {
    const { tool, warnings } = registerTool(toolOf({
      kind: 'fs', action, path,
      ...(content === undefined ? {} : { content }),
    }))
    assert.deepEqual(warnings, [], `${action} 定义应注册成功`)
    return runTool(tool, cwd)
  }

  assert.deepEqual(await runFs('read', 'notes.txt'), { ok: true, content: 'inside' })
  const written = await runFs('write', 'new.txt', 'hello')
  assert.equal(written.ok, true, '新文件由父目录真实路径校验后允许写入')
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'hello')
  assert.equal((await runFs('append', 'new.txt', '!')).ok, true)
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'hello!')
  assert.deepEqual((await runFs('list', '.')).entries.sort(), ['new.txt', 'notes.txt'])
  assert.equal((await runFs('delete', 'new.txt')).ok, true)
  assert.equal(existsSync(join(cwd, 'new.txt')), false)
})

test('fs 执行器：越界与 junction 逃逸在 read/write/append/list/delete 上全部拒绝', async (t) => {
  const root = tempRoot(t)
  const cwd = join(root, 'cwd')
  const outside = join(root, 'outside')
  mkdirSync(cwd)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
  // Windows junction 不要求提权；POSIX 用目录符号链接。
  symlinkSync(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const runFs = async (action, path, content) => {
    const { tool } = registerTool(toolOf({
      kind: 'fs', action, path,
      ...(content === undefined ? {} : { content }),
    }))
    return runTool(tool, cwd)
  }

  const lexical = await runFs('read', join('..', 'outside', 'secret.txt'))
  assert.equal(lexical.ok, false, '词法越界拒绝')
  assert.match(lexical.error, /escapes the trust root/)

  const throughLink = join('escape', 'secret.txt')
  for (const [action, content] of [['read'], ['write', 'PWNED'], ['append', 'PWNED'], ['delete']]) {
    const result = await runFs(action, throughLink, content)
    assert.equal(result.ok, false, `${action} 必须拒绝 junction 逃逸`)
    assert.match(result.error, /escapes the trust root/, `${action}: ${result.error}`)
  }
  const listed = await runFs('list', 'escape')
  assert.equal(listed.ok, false, 'list 不得穿过 junction 列出外部目录')
  assert.match(listed.error, /escapes the trust root/)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside-secret', '外部文件未被写/删')
})

test('shell 执行器：超时在 error 中写明原因，输出字段不变', async (t) => {
  const cwd = tempRoot(t)
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'while :; do :; done'
  const { tool, warnings } = registerTool(toolOf({ kind: 'shell', command }, 300))
  assert.deepEqual(warnings, [])
  const started = Date.now()
  const result = await runTool(tool, cwd)
  assert.ok(Date.now() - started < 4000, '超时应及时结束，不等待完整命令')
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error, /timed out after 300 ms/)
  assert.deepEqual(Object.keys(result).sort(), ['error', 'exitCode', 'stderr', 'stdout'], '不新增输出字段')
  assert.equal(typeof result.stdout, 'string')
  assert.equal(typeof result.stderr, 'string')
})

test('shell 执行器：输出超过 1 MiB 时给出可诊断错误并保留截断输出', async (t) => {
  const cwd = tempRoot(t)
  const command = nodeEval("process.stdout.write('x'.repeat(2097152))")
  const { tool, warnings } = registerTool(toolOf({ kind: 'shell', command }, 30000))
  assert.deepEqual(warnings, [])
  const result = await runTool(tool, cwd)
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error, /output exceeded 1048576 bytes/)
  assert.ok(result.stdout.length > 0 && result.stdout.length <= 1024 * 1024, '保留截断后的 stdout')
  assert.deepEqual(Object.keys(result).sort(), ['error', 'exitCode', 'stderr', 'stdout'])
})

test('shell 执行器：正常命令行为不变', async (t) => {
  const cwd = tempRoot(t)
  const command = nodeEval("process.stdout.write('ok')")
  const { tool, warnings } = registerTool(toolOf({ kind: 'shell', command }, 30000))
  assert.deepEqual(warnings, [])
  assert.deepEqual(await runTool(tool, cwd), { exitCode: 0, stdout: 'ok', stderr: '' })
})
