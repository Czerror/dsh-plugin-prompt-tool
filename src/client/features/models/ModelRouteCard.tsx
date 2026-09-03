import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import styles from '../../ui/controls.module.css'
/** 模型路由模块卡（官方 agent-default-model 层，非引擎模块——归类配置列表下）：
 *  主对话/子代理共用同一配置源（缺省继承宿主默认）；模型路由与人设按作用域完全分离
 *  （main=主对话模型、subagent=子代理模型，参数各自独立）。 */
export function ModelRouteModuleCard(props: { store: PromptToolStore; scope: 'main' | 'subagent' }): ReactNode {
  const { store } = props
  const fields = store.fields
  const host = store.hostDefaultModel
  // 当前会话模型选择（官方 session 投影 + selectModel 通道）：会话切换即换显，
  // 宿主侧切换经投影帧实时回流；投影缺省时回退宿主默认（对齐官方目录 current 语义）。
  const sessionFace = store.api.sessionModel
  const sessionView = useSyncExternalStore(sessionFace.subscribe, sessionFace.snapshot)
  const [selecting, setSelecting] = useState(false)
  const sessionProvider = sessionView.selection?.provider ?? host?.provider ?? ''
  const sessionModelName = sessionView.selection?.model ?? host?.model ?? ''
  const sessionEffort = sessionView.selection?.reasoningEffort ?? host?.reasoningEffort ?? ''
  // 宿主默认模型回显：插件参数未设置（空 = 继承宿主）时，下拉可见宿主当前
  // agent-default-model 的可选项（模型目录查询失败/未公布时也能选择与回显）。
  const providerOptions = [...new Set([...store.providers, ...(host?.provider !== undefined && host.provider.length > 0 ? [host.provider] : [])])]
  const provider = props.scope === 'main' ? fields.modelProvider : fields.subagentModelProvider
  const modelName = props.scope === 'main' ? fields.modelName : fields.subagentModelName
  const modelOptions = [...new Set([
    ...(store.modelCatalog[provider] ?? []),
    ...(host?.model !== undefined && host.model.length > 0 ? [host.model] : []),
  ])]
  const reasoningEffortOptions = ['', 'off', 'low', 'high', 'max']
  // 宿主默认思维程度回显（agent-default-model settings reasoningEffort；官方档位同源）。
  const hostEffort = host?.reasoningEffort !== undefined && host.reasoningEffort.length > 0
    ? host.reasoningEffort
    : undefined
  const withCurrent = (options: string[], current: string): string[] =>
    current.length > 0 && !options.includes(current) ? [...options, current] : options
  const active = provider.length > 0 && modelName.length > 0
  const reasoningEffort = props.scope === 'main' ? fields.modelReasoningEffort : fields.subagentReasoningEffort
  const temperature = props.scope === 'main' ? fields.modelTemperature : fields.subagentTemperature
  const maxTokens = props.scope === 'main' ? fields.modelMaxTokens : fields.subagentMaxTokens
  const patchModelParam = (key: 'modelReasoningEffort' | 'modelTemperature' | 'modelMaxTokens' | 'subagentReasoningEffort' | 'subagentTemperature' | 'subagentMaxTokens', value: string): void => {
    store.patch({ [key]: value } as Partial<typeof fields>)
    void store.persistParamOverrides()
  }
  // 会话级切换：官方 selectModel 需要完整 provider+model；单项改动与其余当前值合并提交。
  const applySessionSelection = (patch: { provider?: string; model?: string; reasoningEffort?: string }): void => {
    const nextProvider = patch.provider ?? sessionProvider
    const nextModel = patch.model ?? sessionModelName
    const nextEffort = patch.reasoningEffort ?? sessionEffort
    if (nextProvider.length === 0 || nextModel.length === 0) {
      store.showNotice('error', '会话模型切换需要服务商与模型名：当前会话尚无完整选择')
      return
    }
    setSelecting(true)
    void sessionFace.select({ provider: nextProvider, model: nextModel, ...(nextEffort.length > 0 ? { reasoningEffort: nextEffort } : {}) })
      .then(() => {
        store.showNotice('ok', '已切换当前会话模型选择（宿主默认同步更新）')
        // 宿主默认已随 selectModel 更新：刷新桥回显（hostDefaultModel）。
        void store.load()
      })
      .catch((error: unknown) => {
        store.showNotice('error', '会话模型切换失败：' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setSelecting(false))
  }
  const scopeMeta = props.scope === 'main'
    ? { title: '模型路由', idle: '未设置：展开选择模型（留空 = 继承宿主默认）', active: '固定模型路由已设置（新会话默认模型）' }
    : { title: '子代理模型', idle: '未设置：展开选择模型（留空 = 继承主会话）', active: '子代理固定模型路由已设置' }
  // 主对话卡片：宿主默认模型名回显（子代理默认继承主会话，不回显宿主）。
  const idleMeta = props.scope === 'main' && host?.model !== undefined && host.model.length > 0
    ? `未设置：展开选择模型（当前继承宿主默认 ${host.model}）`
    : scopeMeta.idle
  return (
    <EngineModuleCard name={scopeMeta.title} meta={active ? scopeMeta.active : idleMeta}>
      {props.scope === 'main' && (
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>当前会话</strong>
            <small>{sessionView.sessionId === undefined
              ? '无活动会话：打开会话后此处显示其模型选择并可切换。'
              : sessionView.selectable
                ? '与官方模型选择器同源（session.selectModel）：切换即对当前会话生效，并保存为宿主新会话默认。下方预设参数非空时按请求覆盖会话选择。'
                : '子代理会话不支持会话级切换（走子代理固定路由）。'}</small>
          </span>
          <div className={styles.sessionModelRow}>
            <select
              className={styles.configInput}
              aria-label="会话服务商"
              value={sessionProvider}
              disabled={!sessionView.selectable || selecting}
              onChange={(event) => applySessionSelection({ provider: event.target.value })}
            >
              {sessionProvider.length === 0 && <option value="">（服务商）</option>}
              {withCurrent(providerOptions, sessionProvider).filter((item) => item.length > 0).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <select
              className={styles.configInput}
              aria-label="会话模型"
              value={sessionModelName}
              disabled={!sessionView.selectable || selecting}
              onChange={(event) => applySessionSelection({ model: event.target.value })}
            >
              {sessionModelName.length === 0 && <option value="">（模型）</option>}
              {withCurrent([...new Set([...(store.modelCatalog[sessionProvider] ?? []), ...(host?.model !== undefined && host.model.length > 0 ? [host.model] : [])])], sessionModelName).filter((item) => item.length > 0).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <select
              className={styles.configInput}
              aria-label="会话思维程度"
              value={sessionEffort}
              disabled={!sessionView.selectable || selecting}
              onChange={(event) => applySessionSelection({ reasoningEffort: event.target.value })}
            >
              {withCurrent(reasoningEffortOptions, sessionEffort).map((item) => (
                <option key={item} value={item}>{item.length === 0 ? '（模型默认）' : item}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>预设模型</strong>
          <small>{props.scope === 'main'
            ? `服务商与模型名同时非空时生效（新会话默认模型，agent-default-model）；思维程度官方档位 off / low / high / max，选择即保存并同步宿主新会话默认；留空 = 继承宿主默认${hostEffort !== undefined ? `（思维程度当前为 ${hostEffort}）` : ''}。`
            : '子代理固定模型路由（agentOptions 注入 tool-subagent）：服务商与模型名同时非空时生效，调用方显式模型优先；思维程度官方档位 off / low / high / max，留空 = 不设置（模型默认）。'}</small>
        </span>
        <div className={styles.sessionModelRow}>
          <select
            className={styles.configInput}
            aria-label="模型服务商"
            value={provider}
            disabled={!fields.writePreset}
            onChange={(event) => {
              store.patch(props.scope === 'main' ? { modelProvider: event.target.value } : { subagentModelProvider: event.target.value })
              void store.persistParamOverrides()
            }}
          >
            {withCurrent(providerOptions, provider).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select
            className={styles.configInput}
            aria-label="模型名"
            value={modelName}
            disabled={!fields.writePreset}
            onChange={(event) => {
              store.patch(props.scope === 'main' ? { modelName: event.target.value } : { subagentModelName: event.target.value })
              void store.persistParamOverrides()
            }}
          >
            {withCurrent(modelOptions, modelName).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select
            className={styles.configInput}
            aria-label="思维程度"
            value={reasoningEffort}
            disabled={!fields.writePreset}
            onChange={(event) => patchModelParam(
              props.scope === 'main' ? 'modelReasoningEffort' : 'subagentReasoningEffort',
              event.target.value,
            )}
          >
            {withCurrent(hostEffort !== undefined ? [...new Set([...reasoningEffortOptions, hostEffort])] : reasoningEffortOptions, reasoningEffort).map((item) => (
              <option key={item} value={item}>{item.length === 0 ? '（不设置）' : item}</option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>采样参数</strong>
          <small>temperature（数字 0–2）与 maxTokens（正整数）经 agent-request patch 生效；留空 = 不设置（模型默认）。失焦保存。</small>
        </span>
        <div className={styles.sessionModelRow}>
          <input
            className={styles.configInput}
            type="number"
            min={0}
            max={2}
            step={0.1}
            aria-label="采样温度"
            value={temperature}
            disabled={!fields.writePreset}
            placeholder="温度（不设置）"
            onChange={(event) => patchModelParam(
              props.scope === 'main' ? 'modelTemperature' : 'subagentTemperature',
              event.target.value,
            )}
            onBlur={() => void store.persistParamOverrides()}
          />
          <input
            className={styles.configInput}
            type="number"
            min={1}
            step={1}
            aria-label="输出上限"
            value={maxTokens}
            disabled={!fields.writePreset}
            placeholder="输出上限（不设置）"
            onChange={(event) => patchModelParam(
              props.scope === 'main' ? 'modelMaxTokens' : 'subagentMaxTokens',
              event.target.value,
            )}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
      </div>
    </EngineModuleCard>
  )
}
