/**
 * classify-task — 任务分类器（能力归一）。
 *
 * buildPattern（构建任务正则）与 complexPattern（复杂任务正则）→ 三档分类
 * （complex / build / fix）。锚定策略（first-turn-anchor）三档判定与引导策略
 * （guide-auto）复杂判定共用本分类器——正则构建与判定逻辑单一实现，
 * 避免两个策略各自 new RegExp + test（历史重复实现）。
 *
 * 参数缺省 = 对应分类不生效：buildRe/complexRe 未配置时跳过该分支
 * （classify 落 fix；isComplex 恒 false）。
 */
export function createTaskClassifier({ buildPattern, complexPattern }) {
  const buildRe = typeof buildPattern === 'string' && buildPattern.length > 0
    ? new RegExp(buildPattern, 'i')
    : undefined
  const complexRe = typeof complexPattern === 'string' && complexPattern.length > 0
    ? new RegExp(complexPattern, 'i')
    : undefined
  return {
    /** 锚定三档判定可用：两档正则都配置。 */
    get ready() {
      return buildRe !== undefined && complexRe !== undefined
    },
    /** 三档分类：complex > build > fix（fix 为兜底档）。 */
    classify(text) {
      if (complexRe !== undefined && complexRe.test(text)) return 'complex'
      if (buildRe !== undefined && buildRe.test(text)) return 'build'
      return 'fix'
    },
    /** 复杂判定（引导 fallback 用；正则未配置 = false）。 */
    isComplex(text) {
      return complexRe !== undefined && complexRe.test(text)
    },
  }
}

/**
 * 通用有序任务规则分类器（subagentToolPolicy.taskRules 单一实现）。
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