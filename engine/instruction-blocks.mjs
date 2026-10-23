/**
 * 官方系统提醒正文里的指令文件标题：filter 分段与 hint 路径提取共用的唯一解析。
 * 只认这 4 种行首标题；path 原样返回（调用方各自 trim/匹配），index 是标题行首位置。
 */
const ACTIONS = {
  'Instructions from:': 'set',
  'Additional instructions from:': 'set',
  'Updated instructions from:': 'replace',
  'Instructions removed:': 'remove',
}

const HEADING_RE = new RegExp('^(' + Object.keys(ACTIONS).join('|') + ') ([^\r\n]+)\r?$', 'gm')

export function instructionBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  return [...text.matchAll(HEADING_RE)].map(match => ({
    action: ACTIONS[match[1]],
    path: match[2],
    index: match.index,
  }))
}
