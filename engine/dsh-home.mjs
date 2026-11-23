import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolve the deployment home at use time, including relative and tilde forms. */
export function resolveDshHome() {
  const ambient = process.env.DSH_HOME
  if (ambient === undefined || ambient.trim().length === 0) return join(homedir(), '.dsh')
  if (ambient === '~') return homedir()
  return resolve(ambient.startsWith('~/') || ambient.startsWith('~\\') ? join(homedir(), ambient.slice(2)) : ambient)
}
