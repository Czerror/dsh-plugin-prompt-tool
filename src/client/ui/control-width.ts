/** 按字符给编辑控件留空间；中文等宽字符按两个拉丁字符估算，不限制输入长度。 */
export function controlWidth(value: string | readonly string[], padding = 18, min = 6, max = 28): string {
  const lengths = (typeof value === 'string' ? [value] : value).map(text => [...text].reduce((width, char) => width + (char.codePointAt(0)! > 255 ? 2 : 1), 0))
  return `calc(${Math.max(min, Math.min(max, Math.max(0, ...lengths)))}ch + ${padding}px)`
}
