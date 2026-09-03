import { useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { TagInput } from './TagInput.tsx'
import { SubagentToolPolicyCard } from './SubagentToolPolicyCard.tsx'
import styles from './PromptUi.module.css'

import type { PromptToolStore } from './prompt-tool-store.ts'

/** 引擎模块可折叠卡片：与模块列表（PromptConfigList）同款形态——
 *  configCard + configToggle + chevron，点击展开 configForm 编辑组合行 config
 *  （经 params 参数桥扁平键落 preset.yml）。归类于配置列表下（beforeCards）。
 *  layer：6 层注入层级归类（pre-step / system-section / tool-pipeline），
 *  参与模块列表层筛选（layerFilter 联动）。 */
function EngineModuleCard(props: {
  store: PromptToolStore
  name: string
  meta: string
  layer?: string
  children?: ReactNode
  /** 纯开关卡：开关直接渲染在 header 顶层（右侧），卡片不展开、不折叠。 */
  topSwitch?: {
    id: string
    label: string
    hint: string
    checked: boolean
    disabled?: boolean
    onToggle: () => void
  }
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const compact = props.topSwitch !== undefined
  return (
    <article className={styles.configCard}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{props.name}</span>
              {props.layer !== undefined && <span className={styles.configChip}>{props.layer}</span>}
            </span>
            <span className={styles.configMeta}>{props.meta}</span>
          </span>
          {!compact && <IconChevronDownOutline14 className={clsx(styles.chevron, expanded && styles.chevronOpen)} />}
        </button>
        {props.topSwitch !== undefined && (
          <span className={styles.configHeaderActions}>
            <label className={styles.configEnable} htmlFor={props.topSwitch.id} title={props.topSwitch.hint}>
              <input
                id={props.topSwitch.id}
                type="checkbox"
                checked={props.topSwitch.checked}
                disabled={props.topSwitch.disabled}
                aria-label={props.topSwitch.label}
                onChange={props.topSwitch.onToggle}
              />
              <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </span>
        )}
      </header>
      {expanded && !compact && <div className={styles.configForm}>{props.children}</div>}
    </article>
  )
}

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
    <EngineModuleCard store={store} name={scopeMeta.title} meta={active ? scopeMeta.active : idleMeta}>
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

/** 工具与深度模块卡（子代理作用域配置；参数经 params 桥扁平键，与主会话引擎模块卡同一来源）。 */
export function DelegationToolsModuleCard(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  const fields = store.fields
  const [spExpanded, setSpExpanded] = useState(false)
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  return (
    <EngineModuleCard store={store} name="工具与深度" meta="工具集白名单/黑名单 + 注入 kind 白名单 + 递归深度">
      <TagInput id="pt-tool-filter-allow" label="工具集白名单" hint="toolFilter.allow：主会话常驻过滤（tool-filter 模块，作用于任意注册工具含自定义插件）+ 委派子代理 toolFilter；留空 = 不限制。"
        value={fields.toolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ toolFilterAllow: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <TagInput id="pt-tool-filter-deny" label="工具集黑名单" hint="toolFilter.deny：主会话常驻过滤（tool-filter 模块）+ 委派子代理 toolFilter；留空 = 不限制。"
        value={fields.toolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ toolFilterDeny: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <TagInput id="pt-allow-kinds" label="注入 kind 白名单" hint="context-gate allowKinds（注入门控）；例如 skill-invocation、near-anchor、router-guide；留空 = 官方默认（不过滤）。"
        value={fields.allowKinds} placeholder="skill-invocation, near-anchor, router-guide" disabled={!fields.writePreset}
        onChange={(value) => store.patch({ allowKinds: value })}
        onCommit={() => void store.persistParamOverrides()} />
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>递归深度</strong>
          <small>委派 maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。</small>
        </span>
        <select
          className={styles.configInput}
          aria-label="递归深度"
          value={fields.maxDepth}
          disabled={!fields.writePreset}
          onChange={(event) => {
            store.patch({ maxDepth: event.target.value })
            void store.persistParamOverrides()
          }}
        >
          {maxDepthOptions.map((item) => (
            <option key={item} value={item}>{item === '' ? '（不设置）' : item}</option>
          ))}
        </select>
      </div>
      <SubagentToolPolicyCard
        expanded={spExpanded}
        onToggleExpanded={() => setSpExpanded(!spExpanded)}
        onNotice={(kind, message) => store.showNotice(kind, message)}
        seedAllow={fields.toolFilterAllow}
        currentSessionId={store.api.currentSessionId()}
      />
    </EngineModuleCard>
  )
}

/** 引擎模块卡片组（模块列表顶部，按 6 层注入层级归类）：
 *  tool-bootstrap（system-section）/ context-gate（pre-step）/
 *  code-presentation · tool-filter · delegation
 *  （tool-pipeline）各一张可折叠模块卡。
 *  语义 = 参数桥扁平键的 UI 化；保存走 params 桥 /param-overrides。
 *  layerFilter：模块列表层筛选联动（'all' 显示全部；指定层只显示该层；
 *  'world-book' 不显示引擎卡）。 */
export function EngineModuleCards(props: { store: PromptToolStore; layerFilter?: string }): ReactNode {
  const { store } = props
  const fields = store.fields
  const layerFilter = props.layerFilter ?? 'all'
  const visible = (layer?: string): boolean =>
    layerFilter === 'all' || (layer !== undefined && layerFilter === layer)
  // 选中层无引擎模块卡时给出提示（引擎模块分布在 pre-step / system-section / tool-pipeline）。
  const hasVisibleCard = layerFilter === 'all' || layerFilter === 'pre-step'
    || layerFilter === 'system-section' || layerFilter === 'tool-pipeline'
  const capped = fields.bootstrapMaxTokens > 0
  const maxDepthOptions = ['', 'provider-managed', '0', '1', '2', '3', '5']
  const gateRow = (id: string, label: string, hint: string, key: 'usePtcMode' | 'promoteGate' | 'promoteAfterFirstResponse' | 'personaSectionsOnly' | 'workspaceLine' | 'toolFilterSubagents' | 'instructionHint' | 'anchorTurn' | 'deliberationGate' | 'cotDrip'): ReactNode => (
    <div className={styles.settingRowStack}>
      <span className={styles.settingCopy}>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <label className={styles.configEnable} htmlFor={id}>
        <input id={id} type="checkbox" checked={fields[key]} disabled={!fields.writePreset} aria-label={label} onChange={() => store.toggle(key)} />
        <span className={styles.switch} aria-hidden="true"><i /></span>
      </label>
    </div>
  )
  const numberRow = (id: string, label: string, hint: string, value: number, onCommit: (next: number) => void, min = 0): ReactNode => (
    <div className={styles.settingRowStack}>
      <span className={styles.settingCopy}>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        className={styles.configInput}
        type="number"
        min={min}
        step={1}
        value={String(value)}
        placeholder="1（默认）"
        disabled={!fields.writePreset}
        aria-label={label}
        onChange={(event) => {
          if (event.target.value.trim() === '') onCommit(0)
          else {
            const parsed = Number(event.target.value)
            if (Number.isSafeInteger(parsed) && parsed >= 0) onCommit(parsed)
          }
        }}
        onBlur={() => void store.persistParamOverrides()}
      />
    </div>
  )
  return (
    <>
      {visible('system-section') && (
      <EngineModuleCard store={store} name="tool-bootstrap" layer="system-section" meta="目录相位 · 首轮窄化 / 门控晋升 / 压缩恢复">
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>首轮输出封顶</strong>
            <small>bootstrapMaxTokens：首轮请求 #1 的 maxTokens（正整数，失焦保存）；0 = 不设上限。</small>
          </span>
          <input
            className={styles.configInput}
            type="number"
            min={1}
            step={1}
            value={store.bootstrapTokensDraft}
            disabled={!fields.writePreset || !capped}
            aria-label="首轮输出封顶数值"
            onChange={(event) => store.setBootstrapTokensDraft(event.target.value)}
            onBlur={store.commitBootstrapTokensDraft}
          />
          <label className={styles.configEnable} htmlFor="pt-bootstrap-tokens">
            <input id="pt-bootstrap-tokens" type="checkbox" checked={capped} disabled={!fields.writePreset} aria-label="首轮输出封顶" onChange={store.toggleBootstrapMaxTokens} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
        </div>
        {gateRow('pt-promote-gate', '门控晋升', 'promoteGate：首段 reasoning minimal-like（we 无 let me）+ 工具调用才晋升', 'promoteGate')}
        {gateRow('pt-promote-after', '首响应即晋升', 'promoteAfterFirstResponse：无工具首响应 / 首轮 turn/end 即晋升', 'promoteAfterFirstResponse')}
        {gateRow('pt-persona-only', '首轮只留人设', 'personaSectionsOnly：phase-1 提示词段只留 persona（plan-mode 等晋升后恢复）', 'personaSectionsOnly')}
        {gateRow('pt-workspace-line', '工作目录行', 'workspaceLine：晋升后 persona 附加工作目录行', 'workspaceLine')}
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>首次调用指令</strong>
            <small>phase1FirstCallInstruction：phase-1 persona 追加的首次工具调用指令；空 = 不追加。失焦保存。</small>
          </span>
          <input
            className={styles.configInput}
            type="text"
            value={fields.phase1FirstCallInstruction}
            disabled={!fields.writePreset}
            aria-label="首次调用指令"
            placeholder="After your first reasoning block, make one tool call."
            onChange={(event) => store.patch({ phase1FirstCallInstruction: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>门控回退步数</strong>
            <small>maxPromoteSteps：门控模式步数达上限强制晋升；0 = 引擎默认 4。失焦保存。</small>
          </span>
          <input
            className={styles.configInput}
            type="number"
            min={0}
            step={1}
            value={store.gateStepsDraft}
            disabled={!fields.writePreset}
            aria-label="门控回退步数"
            onChange={(event) => store.setGateStepsDraft(event.target.value)}
            onBlur={store.commitGateStepsDraft}
          />
        </div>
        <TagInput id="pt-bootstrap-tools" label="首轮窄化集" hint="bootstrapTools：首轮模型可见工具；清空 = 零工具模式（首请求空工具面，assistant/message 后晋升）。回车或逗号添加，× 移除。"
          value={fields.bootstrapTools} placeholder="bash, str_replace_editor" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ bootstrapTools: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <div className={styles.configSectionTitle}>前置锚定轮（anchor-turn 模块）</div>
        {gateRow('pt-anchor-turn', '前置锚定轮', 'anchorTurn：用户首条真实消息前 prepend 合成锚定轮（配合零工具模式 = 空工具面锚定）；需模块列表已挂 anchor-turn 行。', 'anchorTurn')}
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>锚定文本</strong>
            <small>anchorTurnText：合成锚定轮文本（如「你是谁」）；空 = 引擎默认 "This round is a test…"。失焦保存。</small>
          </span>
          <input
            className={styles.configInput}
            type="text"
            value={fields.anchorTurnText}
            disabled={!fields.writePreset}
            aria-label="锚定文本"
            placeholder="This round is a test. Tools are not open yet…"
            onChange={(event) => store.patch({ anchorTurnText: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
        <TagInput id="pt-compaction-tools" label="压缩后恢复集" hint="compactionTools：压缩后回到受控相位时的核心工作集（模型中途继续工作）。回车或逗号添加，× 移除。"
          value={fields.compactionTools} placeholder="read, write, edit, glob, grep" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ compactionTools: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <div className={styles.configFieldHint} style={{ marginTop: '6px' }}>
          <strong>渐进披露（stages）</strong>：阶段定义非空即激活多级阶段窄化（替换两相窄化）；每阶段模型可见工具 = 当前档 + 预放档。
        </div>
        {fields.stages.map((stage, index) => (
          <div key={`stage-${index}`} className={styles.settingRowStack}>
            <span className={styles.settingCopy}>
              <strong>{`阶段 ${index + 1}`}</strong>
              <small>名称 + 本阶段工具集（空名称或空工具集的行不写入）；上移/下移调整阶段顺序。</small>
            </span>
            <input
              className={styles.configInput}
              type="text"
              value={stage.name}
              disabled={!fields.writePreset}
              aria-label={`阶段 ${index + 1} 名称`}
              placeholder="阶段名（如 了解 / 开发 / 验证）"
              onChange={(event) => {
                const next = [...fields.stages]
                next[index] = { ...stage, name: event.target.value }
                store.patch({ stages: next })
              }}
              onBlur={() => void store.persistParamOverrides()}
            />
            <TagInput
              id={`pt-stage-${index}-tools`}
              label="工具集"
              hint="本阶段工具（回车或逗号添加，× 移除）。"
              value={stage.tools}
              placeholder="read, glob, grep"
              disabled={!fields.writePreset}
              onChange={(value) => {
                const next = [...fields.stages]
                next[index] = { ...stage, tools: value }
                store.patch({ stages: next })
              }}
              onCommit={() => void store.persistParamOverrides()}
            />
            <span className={styles.configActions}>
              <button type="button" className={styles.pillButton} aria-label={`上移阶段 ${index + 1}`} title="上移"
                disabled={!fields.writePreset || index === 0} onClick={() => {
                  const next = [...fields.stages]
                  ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                  store.patch({ stages: next })
                  void store.persistParamOverrides()
                }}>↑</button>
              <button type="button" className={styles.pillButton} aria-label={`下移阶段 ${index + 1}`} title="下移"
                disabled={!fields.writePreset || index >= fields.stages.length - 1} onClick={() => {
                  const next = [...fields.stages]
                  ;[next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
                  store.patch({ stages: next })
                  void store.persistParamOverrides()
                }}>↓</button>
              <button type="button" className={styles.pillButton} data-danger aria-label={`删除阶段 ${index + 1}`} title="删除"
                disabled={!fields.writePreset} onClick={() => {
                  const next = fields.stages.filter((_, at) => at !== index)
                  store.patch({ stages: next })
                  void store.persistParamOverrides()
                }}>×</button>
            </span>
          </div>
        ))}
        <div className={styles.configActions}>
          <button type="button" className={styles.pillButton} disabled={!fields.writePreset}
            onClick={() => {
              store.patch({ stages: [...fields.stages, { name: '', tools: '' }] })
              void store.persistParamOverrides()
            }}>+ 添加阶段</button>
        </div>
        {numberRow('pt-stage-pre-unlock', '预放档数', 'stagePreUnlock：调用预放档工具 = 直达其档；0 = 不预放，未设置 = 引擎默认 1。', fields.stagePreUnlock, (next) => store.patch({ stagePreUnlock: next }))}
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>推进工具名</strong>
            <small>stageAdvanceTool：阶段推进工具（模型调用即进下一档）；空 = 默认 phase_advance。失焦保存。</small>
          </span>
          <input
            className={styles.configInput}
            type="text"
            value={fields.stageAdvanceTool}
            disabled={!fields.writePreset}
            aria-label="推进工具名"
            placeholder="phase_advance"
            onChange={(event) => store.patch({ stageAdvanceTool: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>推进工具描述</strong>
            <small>stageAdvanceDescription：阶段推进工具的模型可见描述；空 = 引擎默认。失焦保存。</small>
          </span>
          <input
            className={styles.configInput}
            type="text"
            value={fields.stageAdvanceDescription}
            disabled={!fields.writePreset}
            aria-label="推进工具描述"
            placeholder="Advance to the next stage."
            onChange={(event) => store.patch({ stageAdvanceDescription: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>阶段状态模板</strong>
            <small>{'stageSectionTemplate：阶段状态 section 模板（{{stage}}/{{stageName}}/{{unlocked}}/{{total}}）；空 = 不注入。失焦保存。'}</small>
          </span>
          <input
            className={styles.configInput}
            type="text"
            value={fields.stageSectionTemplate}
            disabled={!fields.writePreset}
            aria-label="阶段状态模板"
            placeholder={'Stage {{stageName}} ({{stage}}/{{total}}). Unlocked: {{unlocked}}.'}
            onChange={(event) => store.patch({ stageSectionTemplate: event.target.value })}
            onBlur={() => void store.persistParamOverrides()}
          />
        </div>
      </EngineModuleCard>
      )}
      {visible('pre-step') && (
      <EngineModuleCard store={store} name="context-gate" layer="pre-step" meta="注入门控 · 白名单 / 延迟注入 / 指令提示">
        <TagInput id="pt-allow-kinds" label="注入 kind 白名单" hint="allowKinds：context-gate 注入门控；空 = 官方 pre-step 行为（不过滤）。"
          value={fields.allowKinds} placeholder="skill-invocation, near-anchor, router-guide" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ allowKinds: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-message-sources" label="消息源白名单" hint="messageSources：phase-1 只放行声明的 source.kind（含 claimed 批）；空 = 不启用。"
          value={fields.messageSources} placeholder="user, goal" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ messageSources: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-deferred-sources" label="晋升后延迟注入" hint="deferredSources：晋升后延迟 N 步注入的 source kind；空 = 不延迟。"
          value={fields.deferredSources} placeholder="agent-instructions, skill-catalog" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ deferredSources: value })}
          onCommit={() => void store.persistParamOverrides()} />
        {numberRow('pt-deferred-steps', '延迟宽限步数', 'deferredGraceSteps：晋升后前 N 步过滤延迟注入源；0 = 不延迟。', fields.deferredGraceSteps, (next) => store.patch({ deferredGraceSteps: next }))}
        {gateRow('pt-instr-hint', '指令提示转换', 'instructionHint：晋升后 agent-instructions 全文 → 一次性引用提示', 'instructionHint')}
      </EngineModuleCard>
      )}
      {visible('tool-pipeline') && (
      <EngineModuleCard store={store} name="工具管线" layer="tool-pipeline" meta="工具设置 · 呈现 / 过滤 / 委派 / 验证">
        <div className={styles.configSectionTitle}>呈现（code-presentation）</div>
        {gateRow('pt-use-ptc', '使用 PTC 模式', 'usePtcMode：晋升后 Code Mode (PTC) 呈现（默认 false，opt-in）；false = 原生完整工具目录', 'usePtcMode')}

        <div className={styles.configSectionTitle}>过滤（tool-filter）</div>
        <TagInput id="pt-tool-filter-allow" label="工具集白名单" hint="toolFilter.allow：主会话常驻过滤（tool-filter 模块，作用于任意注册工具含自定义插件）+ 委派子代理 toolFilter；留空 = 不限制。"
          value={fields.toolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ toolFilterAllow: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-tool-filter-deny" label="工具集黑名单" hint="toolFilter.deny：主会话常驻过滤（tool-filter 模块）+ 委派子代理 toolFilter；留空 = 不限制。"
          value={fields.toolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ toolFilterDeny: value })}
          onCommit={() => void store.persistParamOverrides()} />
        {gateRow('pt-tool-filter-subagents', '子代理同过滤', 'toolFilterSubagents：主会话 tool-filter 也作用于子代理；false/未设置 = 子代理不受主会话过滤限制。', 'toolFilterSubagents')}
        {numberRow('pt-editor-max-output', '编辑器输出上限', 'strReplaceEditorMaxOutputChars：str_replace_editor 单次输出字符上限；16000 = 官方默认。', fields.strReplaceEditorMaxOutputChars, (next) => store.patch({ strReplaceEditorMaxOutputChars: next }), 1)}

        <div className={styles.configSectionTitle}>委派（delegation）</div>
        <div className={styles.settingRowStack}>
          <span className={styles.settingCopy}>
            <strong>递归深度</strong>
            <small>委派 maxDepth：0 禁止委派；provider-managed 由服务商管理；正整数限制递归层数；不设置 = 官方默认。选择即保存。</small>
          </span>
          <select
            className={styles.configInput}
            aria-label="递归深度"
            value={fields.maxDepth}
            disabled={!fields.writePreset}
            onChange={(event) => {
              store.patch({ maxDepth: event.target.value })
              void store.persistParamOverrides()
            }}
          >
            {maxDepthOptions.map((item) => (
              <option key={item} value={item}>{item === '' ? '（不设置）' : item}</option>
            ))}
          </select>
        </div>

        <div className={styles.configSectionTitle}>深思门控（deliberation-gate / cot-drip 模块）</div>
        {gateRow('pt-deliberation-gate', '轨迹深度门', 'deliberationGate：首工具调用前流式深思 < 下限时 deny 一次（规划式提示）；需模块列表已挂 deliberation-gate 行。', 'deliberationGate')}
        {numberRow('pt-delib-min-chars', '深思下限', 'deliberationMinChars：首工具调用前的流式深思字符数下限；0 = 引擎默认 400。', fields.deliberationMinChars, (next) => store.patch({ deliberationMinChars: next }))}
        {numberRow('pt-delib-max-gates', '每轮最大门控', 'deliberationMaxGatesPerTurn：每轮最多 deny 次数；0 = 引擎默认 1。', fields.deliberationMaxGatesPerTurn, (next) => store.patch({ deliberationMaxGatesPerTurn: next }))}
        {gateRow('pt-cot-drip', '深思维持节拍', 'cotDrip：每 N 次工具结果滴入一条 "We…" 重申提醒（additionalContexts）；需模块列表已挂 cot-drip 行。', 'cotDrip')}
        {numberRow('pt-cot-every', '节拍间隔', 'cotDripEvery：每几次工具结果滴入一条；0 = 引擎默认 4（0 禁用由引擎 every:0 语义处理）。', fields.cotDripEvery, (next) => store.patch({ cotDripEvery: next }))}
        {numberRow('pt-cot-max', '每轮最大提醒', 'cotDripMaxPerTurn：每轮最多提醒条数；0 = 引擎默认 1。', fields.cotDripMaxPerTurn, (next) => store.patch({ cotDripMaxPerTurn: next }))}
      </EngineModuleCard>
      )}
      {!hasVisibleCard && (
        <p className={styles.configFieldHint} role="status">
          该层无引擎模块卡：引擎模块分布在 pre-step（context-gate）/ system-section（tool-bootstrap）/ tool-pipeline（code-presentation · tool-filter · delegation）。
        </p>
      )}
    </>
  )
}
