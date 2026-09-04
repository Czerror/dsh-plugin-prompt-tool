import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { resolveProviderModels } from './model-route-status.ts'
import ui from '../../../ui/controls.module.css'

/** 模型路由状态：服务商展示检测结果，模型只展示当前选中服务商的目录。 */
export function ModelRouteStatus(props: { store: PromptToolStore; provider: string }): ReactNode {
  const { store } = props
  const detected = store.providers.length > 0
  const { provider, models } = resolveProviderModels(
    store.modelCatalog,
    props.provider,
    store.providers,
    store.hostDefaultModel,
  )
  const hasModels = models.length > 0
  const modelStatus = hasModels
    ? `已检测到模型名（${provider}）：${models.join('、')}`
    : provider.length > 0
      ? `未检测到 ${provider} 的模型名`
      : '未检测到模型名'
  return (
    <div className={ui.skillStatusRow} aria-label="模型服务商状态">
      <span className={clsx(ui.skillStatusChip, detected ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {detected ? `已检测到模型服务商：${store.providers.join('、')}` : '未检测到模型服务商'}
      </span>
      <span
        className={clsx(ui.skillStatusChip, ui.modelStatusChip, hasModels ? ui.skillStatusModel : ui.skillStatusOff)}
        title={modelStatus}
      >
        <i className={ui.skillStatusDot} aria-hidden="true" />
        <span className={ui.modelStatusText}>{modelStatus}</span>
      </span>
    </div>
  )
}
