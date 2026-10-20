/**
 * 通用有序任务规则分类器。
 * 规则：order 升序（同 order 按数组顺序）、首个匹配获胜；输入为
 * description + "\n" + prompt；无匹配回落 undefined（调用方用 default）。
 * 规则在保存时已编译（非法 pattern 拒绝整次保存），此处只按顺序 test。
 */
export function createOrderedTaskClassifier(rules) {
  const ordered = [...(Array.isArray(rules) ? rules : [])]
    .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.re?.test === 'function')
    .sort((a, b) => (a.order - b.order) || 0)
  return (text) => {
    for (const rule of ordered) {
      if (rule.re.test(String(text ?? ''))) return rule.id
    }
    return undefined
  }
}
