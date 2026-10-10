/** 模块私有记忆的唯一 owner；不修改规则或自动注入。 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertModuleDirectory, assertNoModuleLinks, modulePathExists } from './module-install.ts'

function memoryFile(moduleDir: string): string {
  assertNoModuleLinks(moduleDir)
  const file = join(assertModuleDirectory(dirname(moduleDir), basename(moduleDir)), 'memory.md')
  assertNoModuleLinks(file)
  return file
}

export function appendModuleMemory(moduleDir: string, note: string): void {
  const content = note.trim()
  if (content.length === 0) return
  const file = memoryFile(moduleDir)
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (modulePathExists(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `# 本地记忆\n${line}`, 'utf8')
}

export function readModuleMemory(moduleDir: string): string {
  const file = memoryFile(moduleDir)
  return modulePathExists(file) ? readFileSync(file, 'utf8') : ''
}
