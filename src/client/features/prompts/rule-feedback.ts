import type { RuleEditor, RulesDraft } from '../../data/rule-drafts.ts'
import type { PromptToolTranslate } from '../../locales.ts'

/** 规则卡和模块列表共享恢复操作。当前草稿与已保存版本各有一份回执。 */
export function ruleFeedback(draft: RulesDraft, editor: RuleEditor, t: PromptToolTranslate) {
  let issue: string | undefined
  if (draft.pending) issue = t('rules.savePending')
  else if (draft.errorCode === 'shared-alias') issue = t('rules.sharedAlias')
  else if (draft.remote) issue = t('rules.conflict')
  else if (draft.retryCreate) issue = t('rules.createNotSaved')
  else if (draft.error) issue = draft.retry === 'read' ? t('rules.readBeforeRetry') : draft.error

  const publication = draft.publicationPending && !draft.activationPending
    ? t(draft.publicationError === undefined ? 'rules.publishPending' : 'rules.publishFailed')
    : undefined
  let action: string | undefined
  if (draft.pending) action = t('rules.checkSave')
  else if (issue || publication || draft.activationPending) {
    const retry = editor.retryKind
    if (retry === 'read') action = t('rules.reloadAria')
    else if (draft.retryCreate) action = t('rules.retryCreate')
    else if (draft.activationPending) action = t('rules.resumeWinner')
    else action = t(retry === 'publish' ? 'publication.retry' : 'rules.retrySave')
  }
  return { issue, publication, action }
}
