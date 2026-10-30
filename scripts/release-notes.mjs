// release-notes.mjs — 从 CHANGELOG 提取当前 package.json 版本的段落，供 Release 正文使用。
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const match = changelog.match(new RegExp(`## \\[${escaped}\\][^\\n]*\\n\\n([\\s\\S]*?)\\n\\n## \\[`))
if (!match) {
  process.stderr.write(`release-notes: CHANGELOG 缺少 ${version} 段\n`)
  process.exit(1)
}
process.stdout.write(`${match[1].trim()}\n`)
