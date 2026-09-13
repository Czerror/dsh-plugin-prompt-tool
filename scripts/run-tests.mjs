// run-tests.mjs — 隔离 cwd 的测试入口。
//
// 用法:node scripts/run-tests.mjs [传给 node --test 的用例路径或 glob]
//
// `pnpm --dir <仓库> test` 只会把脚本的 cwd 设成仓库目录；测试自己若相对 cwd
// 写文件，就会污染仓库。这里先跑既有构建，再在临时目录里以绝对用例路径启动
// 同一个 Node 内置 test runner，并把 TEMP/TMP 指到该临时目录，最后原样返回退出码。
//
// 不改变用例发现范围：默认仍是 test/**/*.test.mjs。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const runDir = mkdtempSync(join(tmpdir(), 'pt-test-run-'))
// pnpm 会把额外参数合成一个逗号分隔的字符串转发进来，这里按逗号/空白拆开，
// 让 `pnpm test a.test.mjs b.test.mjs` 与直接 `node scripts/run-tests.mjs a b` 等价。
const forward = process.argv.slice(2)
  .filter((arg) => arg !== '--')
  .flatMap((arg) => arg.split(/[,\s]+/))
  .filter((arg) => arg.length > 0)
  .map((arg) => (/^[A-Za-z]:/.test(arg) || arg.startsWith('.') ? arg : join(root, arg)))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? runDir,
    stdio: 'inherit',
    // 只有拿不到 pnpm 的 JS 入口时才退回 shell 查找（Windows 的 .cmd shim）。
    shell: options.shell === true,
    env: {
      ...process.env,
      TEMP: runDir,
      TMP: runDir,
      ...options.env,
    },
  })
  if (result.error !== undefined) {
    process.stderr.write(`[run-tests] 无法启动 ${command}: ${String(result.error.message)}\n`)
    return 1
  }
  return result.status ?? 1
}

/** 优先用包管理器自己的 JS 入口（pnpm test 会提供 npm_execpath），避免跨 shell。 */
function buildInvocation() {
  const execPath = process.env.npm_execpath
  if (typeof execPath === 'string' && execPath.length > 0 && existsSync(execPath)) {
    return { command: process.execPath, args: [execPath, '--dir', root, 'build'], shell: false }
  }
  return { command: 'pnpm', args: ['--dir', root, 'build'], shell: true }
}

let code = 1
try {
  // 1. 既有构建（lib/ 是测试的输入，必须在隔离 cwd 之前完成）。
  const build = buildInvocation()
  code = run(build.command, build.args, { cwd: root, shell: build.shell })
  if (code === 0) {
    // 2. 用例在临时 cwd 中运行；默认 glob 保持与 package.json 原脚本一致。
    const patterns = forward.length > 0
      ? forward
      : [join(root, 'test', '**', '*.test.mjs').replaceAll('\\', '/')]
    code = run(process.execPath, ['--test', ...patterns])
  }
} finally {
  // 只清理本次创建、路径已确认的临时目录。
  rmSync(runDir, { recursive: true, force: true })
}
process.exit(code)
