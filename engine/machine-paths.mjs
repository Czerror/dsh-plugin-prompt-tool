/**
 * 机器路径事实的**唯一取值来源**：`DSH_HOME` / `CWD` / `WORKSPACE` 三个键怎么推导，只在这里定。
 *
 * 此前这条配方在四处各写一遍——`interpolate` 的内置变量、`fillers` 的 env facts、
 * `run-code-env` 的进程环境兜底、`instruction-hint` 的指令文件探测——而且已经分叉：
 * 未设 `DSH_HOME` 时前两者按用户主目录推导出 `<USERPROFILE>\.dsh`，`run-code-env` 则
 * **不给该键**。同一台机器上 `{{DSH_HOME}}` 与 `run_code` 里的 `env.DSH_HOME` 因此可能
 * 是两个答案。
 *
 * 本模块只提供**取值**：各处的白名单、注入形态（插值保留名 / variables / 进程 env）与
 * 「空值算不算有值」的策略留在调用方——它们的产出物本来就不同，不该被这一个函数接管。
 */

/**
 * @param {object|undefined} session 会话（读它的 `header.cwd`；缺省回退进程 cwd）
 * @param {Record<string, string|undefined>|undefined} env 环境来源（缺省取当前 `process.env`；
 *   宿主快照与测试可显式替换——测试**应该**传它，否则读真实环境、用例不稳定）
 * @returns {{ DSH_HOME: string, WORKSPACE: string, CWD: string }}
 *   `DSH_HOME`：显式环境变量 → `<USERPROFILE>\.dsh` → 空串（**不是** `undefined`：
 *   调用方若要区分「不可用」，自行把空串当缺省——例如 `instruction-hint` 需要
 *   `undefined` 表示「没有可探测的全局目录」）。
 *
 * **只给取值，不给策略**：键要不要出现在产物里由调用方决定。例如 `run-code-env` 原来
 * 「没有会话 cwd 就不写 `DSH_WORKSPACE`」，统一取值后 `CWD` 会回退到 `process.cwd()`，
 * 那处仍按自己的规则判空后再决定是否落键。
 *
 * 无 `process` 的环境（非 Node 宿主）不抛：环境与 cwd 都退化成空值，与 `run-code-env`
 * 原来的 `typeof process === 'undefined'` 守卫同口径。
 */
export function machinePaths(session, env = currentEnv()) {
  const cwd = session?.header?.cwd ?? currentCwd()
  return {
    DSH_HOME: env?.DSH_HOME ?? (env?.USERPROFILE ? `${env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: env?.DSH_WORKSPACE ?? cwd,
    CWD: cwd,
  }
}

const currentEnv = () => (typeof process === 'undefined' ? undefined : process.env)
const currentCwd = () => (typeof process === 'undefined' ? '' : process.cwd())
