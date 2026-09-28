/** 构建器收集的 CSS 随插件 apply/dispose 挂载，模块求值不触碰 DOM。 */
export function installClientStyles(sheets: readonly string[]): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-prompt-tool'
  tag.textContent = sheets.join('\n')
  document.head.appendChild(tag)
  return () => tag.remove()
}
