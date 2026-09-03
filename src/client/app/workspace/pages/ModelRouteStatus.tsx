import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import ui from '../../../PromptUi.module.css'
/** 模型路由状态 chip：主对话页与子代理页共用（检测到 DeepSeek 路由时展示 provider 列表）。 */
export function ModelRouteStatus(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const detected = store.providers.length > 0
  const catalog = store.modelCatalog
  const catalogEntries = Object.entries(catalog)
  const hostModel = store.hostDefaultModel?.model
  return (
    <div className={ui.skillStatusRow} aria-label="模型服务商状态">
      <span className={clsx(ui.skillStatusChip, detected ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {detected ? `已检测到模型服务商：${store.providers.join('、')}` : '未检测到模型服务商'}
      </span>
      <span className={clsx(ui.skillStatusChip, catalogEntries.length > 0 ? ui.skillStatusModel : ui.skillStatusOff)}>
        <i className={ui.skillStatusDot} aria-hidden="true" />
        {catalogEntries.length > 0
          ? `已检测到模型名：${catalogEntries.map(([provider, models]) => `${provider} → ${models.join('、')}`).join('；')}`
          : hostModel !== undefined && hostModel.length > 0
            ? `模型名：继承宿主默认（${hostModel}）`
            : '未检测到模型名'}
      </span>
    </div>
  )
}
