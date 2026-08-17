import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyCustomBash } from '../preset/custom-bash.mjs'

function makeTool({ timeoutMs = 30, exitCode = 0, output = '', pending = false } = {}) {
  let registered
  const ctx = {
    subprocess: {
      resolveExecutable: async (path) => `resolved:${path}`,
      spawn: (spec) => {
        const done = new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
          if (!pending) resolve({ exitCode, signal: null })
        })
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: output }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
    tools: { register: (tool) => { registered = tool } },
  }
  applyCustomBash(ctx, { bashPath: 'C:/git/bin/bash.exe', timeoutMs })
  assert.ok(registered)
  return registered
}

test('timeoutMs 到期后终止进程树并报告超时', async () => {
  const tool = makeTool({ timeoutMs: 20, pending: true })
  await assert.rejects(
    () => tool.execute({ command: 'sleep 100' }, {}),
    /bash timed out after 20ms/,
  )
})

test('exec.signal 中止时报告 aborted 而不是超时', async () => {
  const tool = makeTool({ timeoutMs: 1000, pending: true })
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('caller abort')), 10)
  await assert.rejects(
    () => tool.execute({ command: 'sleep 100' }, { signal: controller.signal }),
    /bash aborted: caller abort/,
  )
})

test('正常退出返回输出文本', async () => {
  const tool = makeTool({ exitCode: 0, output: 'hello' })
  const result = await tool.execute({ command: 'echo hello' }, {})
  assert.deepEqual(result, { text: 'hello' })
})
