import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { TagInput } from '../../ui/TagInput.tsx'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, isEngineCapabilityPresent } from '../../../shared/engine-capabilities.ts'
import styles from '../../ui/controls.module.css'

function EngineCapabilityCreateMenu(props: { store: PromptToolStore }): ReactNode {
  const [open, setOpen] = useState(false)
  const facts = props.store.moduleFacts
  if (!props.store.fields.writePreset || facts === undefined || facts.editable === false) return null
  const capabilities = ENGINE_CAPABILITIES.filter((item) => !isEngineCapabilityPresent(item.id, facts))
  const items = [
    ...capabilities.map((item) => ({ id: `cap:${item.id}`, label: `新建能力 · ${item.id}` })),
    ...ENGINE_RECIPES.map((item) => ({ id: `recipe:${item.id}`, label: `连锁创建 · ${item.id}` })),
  ]
  if (items.length === 0) return null
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={items}
      onSelect={(id) => {
        setOpen(false)
        const [kind, value] = id.split(':', 2)
        if (value !== undefined) void props.store.createEngineCapability(kind === 'recipe' ? 'create-recipe' : 'create', value)
      }}
      align="end"
      portal
      compact
      anchor={(
        <button
          type="button"
          className={styles.pillButton}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          新建引擎能力
          <IconChevronDownOutline14 />
        </button>
      )}
    />
  )
}

/** 引擎模块卡片组（模块列表顶部，按 6 层注入层级归类）：
 *  一项引擎能力一张卡，卡片内只编辑该模块拥有的参数。
 *  语义 = 参数桥扁平键的 UI 化；保存走 params 桥 /param-overrides。
 *  layerFilter：模块列表层筛选联动（'all' 显示全部；指定层只显示该层；
 *  'world-book' 不显示引擎卡）。 */
export function EngineModuleCards(props: { store: PromptToolStore; layerFilter?: string }): ReactNode {
  const { store } = props
  const fields = store.fields
  const layerFilter = props.layerFilter ?? 'all'
  const visible = (layer?: string): boolean =>
    layerFilter === 'all' || (layer !== undefined && layerFilter === layer)
  const visibleCapability = (id: string, layer: string): boolean =>
    visible(layer) && isEngineCapabilityPresent(id, store.moduleFacts)
  // 选中层无引擎模块卡时给出提示（引擎模块分布在 pre-step / system-section / tool-pipeline）。
  const hasVisibleCard = (store.moduleFacts !== undefined && [
    'tool-bootstrap', 'context-gate', 'anchor-turn', 'code-presentation', 'tool-filter',
    'str-replace-editor', 'deliberation-gate', 'cot-drip',
  ].some((id) => visibleCapability(id, id === 'tool-bootstrap' ? 'system-section' : id === 'context-gate' || id === 'anchor-turn' ? 'pre-step' : 'tool-pipeline')))
  const capped = fields.bootstrapMaxTokens > 0
  // 紧凑开关项（合并行/栅格内用）：标签文字 + 开关内联，逐项说明收敛到 title 悬浮提示。
  const gateChip = (id: string, label: string, hint: string, key: 'usePtcMode' | 'promoteGate' | 'promoteAfterFirstResponse' | 'personaSectionsOnly' | 'workspaceLine' | 'toolFilterSubagents' | 'instructionHint' | 'anchorTurn' | 'deliberationGate' | 'cotDrip'): ReactNode => (
    <span className={styles.switchGridItem} title={hint}>
      <span className={styles.switchGridLabel}>{label}</span>
      <label className={styles.configEnable} htmlFor={id}>
        <input id={id} type="checkbox" checked={fields[key]} disabled={!fields.writePreset} aria-label={label} onChange={() => store.toggle(key)} />
        <span className={styles.switch} aria-hidden="true"><i /></span>
      </label>
    </span>
  )
  // 内联数字字段：标签 + 输入同一 flex 项（无独立行），说明收敛到 title；空 = 0 语义与原 numberRow 一致。
  const inlineNumber = (label: string, hint: string, value: number, onCommit: (next: number) => void, min = 0): ReactNode => (
    <span key={label} className={clsx(styles.switchGridItem, styles.switchGridField)} title={hint}>
      <span className={styles.switchGridLabel}>{label}</span>
      <input
        className={styles.configInput}
        type="number"
        min={min}
        step={1}
        value={String(value)}
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
    </span>
  )
  // 内联文本字段：标签 + 输入同一 flex 项；wide = 长文本吃更多宽度。
  const inlineText = (label: string, hint: string, value: string, onChange: (next: string) => void, wide = false): ReactNode => (
    <span key={label} className={clsx(styles.switchGridItem, styles.switchGridField, wide && styles.sessionModelRowWide)} title={hint}>
      <span className={styles.switchGridLabel}>{label}</span>
      <input
        className={styles.configInput}
        type="text"
        value={value}
        disabled={!fields.writePreset}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => void store.persistParamOverrides()}
      />
    </span>
  )
  return (
    <>
      <div className={styles.configActions}>
        <EngineCapabilityCreateMenu store={store} />
      </div>
      {visibleCapability('tool-bootstrap', 'system-section') && (
      <EngineModuleCard name="tool-bootstrap" layer="system-section" meta="目录相位 · 首轮窄化 / 门控晋升 / 压缩恢复">
        <div className={styles.settingRowStack}>
          <div className={styles.sessionModelRow}>
            <span className={styles.switchGridItem} title="bootstrapMaxTokens：关闭 = 首轮不设输出上限">
              <span className={styles.switchGridLabel}>首轮输出封顶</span>
              <label className={styles.configEnable} htmlFor="pt-bootstrap-tokens">
                <input id="pt-bootstrap-tokens" type="checkbox" checked={capped} disabled={!fields.writePreset} aria-label="首轮输出封顶" onChange={store.toggleBootstrapMaxTokens} />
                <span className={styles.switch} aria-hidden="true"><i /></span>
              </label>
            </span>
            <span className={clsx(styles.switchGridItem, styles.switchGridField)} title="bootstrapMaxTokens：首轮请求 #1 的 maxTokens（正整数，失焦保存）">
              <span className={styles.switchGridLabel}>数值</span>
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
            </span>
            <span className={clsx(styles.switchGridItem, styles.switchGridField)} title="maxPromoteSteps：门控模式步数达上限强制晋升；0 = 引擎默认 4。失焦保存。">
              <span className={styles.switchGridLabel}>门控回退步数</span>
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
            </span>
            {inlineText('首次调用指令', 'phase1FirstCallInstruction：phase-1 persona 追加的首次工具调用指令，例如 After your first reasoning block, make one tool call.；空 = 不追加。失焦保存。', fields.phase1FirstCallInstruction, (next) => store.patch({ phase1FirstCallInstruction: next }), true)}
          </div>
        </div>
        <div className={styles.settingRowStack}>
          <div className={styles.switchGrid}>
            {gateChip('pt-promote-gate', '门控晋升', 'promoteGate：首段 reasoning minimal-like（we 无 let me）+ 工具调用才晋升', 'promoteGate')}
            {gateChip('pt-promote-after', '首响应即晋升', 'promoteAfterFirstResponse：无工具首响应 / 首轮 turn/end 即晋升', 'promoteAfterFirstResponse')}
            {gateChip('pt-persona-only', '首轮只留人设', 'personaSectionsOnly：phase-1 提示词段只留 persona（plan-mode 等晋升后恢复）', 'personaSectionsOnly')}
            {gateChip('pt-workspace-line', '工作目录行', 'workspaceLine：晋升后 persona 附加工作目录行', 'workspaceLine')}
          </div>
        </div>
        <TagInput id="pt-bootstrap-tools" label="首轮窄化集" hint="bootstrapTools：首轮模型可见工具；清空 = 零工具模式（首请求空工具面，assistant/message 后晋升）。回车或逗号添加，× 移除。"
          value={fields.bootstrapTools} placeholder="bash, str_replace_editor" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ bootstrapTools: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <TagInput id="pt-compaction-tools" label="压缩后恢复集" hint="compactionTools：压缩后回到受控相位时的核心工作集（模型中途继续工作）。回车或逗号添加，× 移除。"
          value={fields.compactionTools} placeholder="read, write, edit, glob, grep" disabled={!fields.writePreset}
          onChange={(value) => store.patch({ compactionTools: value })}
          onCommit={() => void store.persistParamOverrides()} />
        <div className={styles.configFieldHint} style={{ marginTop: '6px' }}>
          <strong>渐进披露（stages）</strong>：阶段定义非空即激活多级阶段窄化（替换两相窄化）；每阶段模型可见工具 = 当前档 + 预放档。
        </div>
        {fields.stages.map((stage, index) => (
          <div key={`stage-${index}`} className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              <span className={clsx(styles.switchGridItem, styles.switchGridField, styles.sessionModelRowWide)} title="阶段名称（空名称或空工具集的行不写入）。失焦保存。">
                <span className={styles.switchGridLabel}>{`阶段 ${index + 1}`}</span>
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
              </span>
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
          </div>
        ))}
        <div className={styles.configActions}>
          <button type="button" className={styles.pillButton} disabled={!fields.writePreset}
            onClick={() => {
              store.patch({ stages: [...fields.stages, { name: '', tools: '' }] })
              void store.persistParamOverrides()
            }}>+ 添加阶段</button>
        </div>
        <div className={styles.settingRowStack}>
          <div className={styles.sessionModelRow}>
            {inlineNumber('预放档数', 'stagePreUnlock：调用预放档工具 = 直达其档；0 = 不预放，未设置 = 引擎默认 1。', fields.stagePreUnlock, (next) => store.patch({ stagePreUnlock: next }))}
            {inlineText('推进工具名', 'stageAdvanceTool：阶段推进工具（模型调用即进下一档）；空 = 默认 phase_advance。失焦保存。', fields.stageAdvanceTool, (next) => store.patch({ stageAdvanceTool: next }))}
            {inlineText('推进工具描述', 'stageAdvanceDescription：阶段推进工具的模型可见描述，例如 Advance to the next stage.；空 = 引擎默认。失焦保存。', fields.stageAdvanceDescription, (next) => store.patch({ stageAdvanceDescription: next }))}
            {inlineText('阶段状态模板', 'stageSectionTemplate：阶段状态 section 模板，例如 Stage {{stageName}} ({{stage}}/{{total}}). Unlocked: {{unlocked}}.；空 = 不注入。失焦保存。', fields.stageSectionTemplate, (next) => store.patch({ stageSectionTemplate: next }), true)}
          </div>
        </div>
      </EngineModuleCard>
      )}
      {(visibleCapability('context-gate', 'pre-step') || visibleCapability('anchor-turn', 'pre-step')) && (
      <>
        {visibleCapability('context-gate', 'pre-step') && <EngineModuleCard name="context-gate" layer="pre-step" meta="注入门控 · 白名单 / 延迟注入 / 指令提示">
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
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {gateChip('pt-instr-hint', '指令提示转换', 'instructionHint：晋升后 agent-instructions 全文 → 一次性引用提示', 'instructionHint')}
              {inlineNumber('延迟宽限步数', 'deferredGraceSteps：晋升后前 N 步过滤延迟注入源；0 = 不延迟。失焦保存。', fields.deferredGraceSteps, (next) => store.patch({ deferredGraceSteps: next }))}
            </div>
          </div>
        </EngineModuleCard>}
        {visibleCapability('anchor-turn', 'pre-step') && <EngineModuleCard name="anchor-turn" layer="pre-step" meta="前置锚定轮 · 首条用户消息">
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {gateChip('pt-anchor-turn', '前置锚定轮', 'anchorTurn：用户首条真实消息前 prepend 合成锚定轮（配合零工具模式 = 空工具面锚定）；需模块列表已挂 anchor-turn 行。', 'anchorTurn')}
              {inlineText('锚定文本', 'anchorTurnText：合成锚定轮文本，例如「你是谁」；空 = 引擎默认 This round is a test…。失焦保存。', fields.anchorTurnText, (next) => store.patch({ anchorTurnText: next }), true)}
            </div>
          </div>
        </EngineModuleCard>}
      </>
      )}
      {visibleCapability('code-presentation', 'tool-pipeline') || visibleCapability('tool-filter', 'tool-pipeline') || visibleCapability('str-replace-editor', 'tool-pipeline') || visibleCapability('deliberation-gate', 'tool-pipeline') || visibleCapability('cot-drip', 'tool-pipeline') ? (
      <>
        {visibleCapability('code-presentation', 'tool-pipeline') && <EngineModuleCard name="code-presentation" layer="tool-pipeline" meta="晋升后 Code Mode (PTC) 呈现">
          <div className={styles.settingRowStack}>
            <div className={styles.switchGrid}>
              {gateChip('pt-use-ptc', '使用 PTC 模式', 'usePtcMode：晋升后 Code Mode (PTC) 呈现（默认 false，opt-in）；false = 原生完整工具目录', 'usePtcMode')}
            </div>
          </div>
        </EngineModuleCard>}
        {visibleCapability('tool-filter', 'tool-pipeline') && <EngineModuleCard name="tool-filter" layer="tool-pipeline" meta="常驻白名单 / 黑名单 / 子代理">
          <TagInput id="pt-tool-filter-allow" label="工具集白名单" hint="toolFilter.allow：主会话常驻过滤（tool-filter 模块，作用于任意注册工具含自定义插件）+ 委派子代理 toolFilter；留空 = 不限制。"
            value={fields.toolFilterAllow} placeholder="read, write, glob" disabled={!fields.writePreset}
            onChange={(value) => store.patch({ toolFilterAllow: value })}
            onCommit={() => void store.persistParamOverrides()} />
          <TagInput id="pt-tool-filter-deny" label="工具集黑名单" hint="toolFilter.deny：主会话常驻过滤（tool-filter 模块）+ 委派子代理 toolFilter；留空 = 不限制。"
            value={fields.toolFilterDeny} placeholder="bash, run_code" disabled={!fields.writePreset}
            onChange={(value) => store.patch({ toolFilterDeny: value })}
            onCommit={() => void store.persistParamOverrides()} />
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {gateChip('pt-tool-filter-subagents', '子代理同过滤', 'toolFilterSubagents：主会话 tool-filter 也作用于子代理；false/未设置 = 子代理不受主会话过滤限制。', 'toolFilterSubagents')}
            </div>
          </div>
        </EngineModuleCard>}
        {visibleCapability('str-replace-editor', 'tool-pipeline') && <EngineModuleCard name="str-replace-editor" layer="tool-pipeline" meta="编辑工具 · 单次输出上限">
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {inlineNumber('编辑器输出上限', 'strReplaceEditorMaxOutputChars：str_replace_editor 单次输出字符上限；16000 = 官方默认。失焦保存。', fields.strReplaceEditorMaxOutputChars, (next) => store.patch({ strReplaceEditorMaxOutputChars: next }), 1)}
            </div>
          </div>
        </EngineModuleCard>}
        {visibleCapability('deliberation-gate', 'tool-pipeline') && <EngineModuleCard name="deliberation-gate" layer="tool-pipeline" meta="首工具调用前 · 轨迹深度门">
          <div className={styles.settingRowStack}>
            <div className={styles.switchGrid}>
              {gateChip('pt-deliberation-gate', '轨迹深度门', 'deliberationGate：首工具调用前流式深思 < 下限时 deny 一次（规划式提示）；需模块列表已挂 deliberation-gate 行。', 'deliberationGate')}
            </div>
          </div>
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {inlineNumber('深思下限', 'deliberationMinChars：首工具调用前的流式深思字符数下限；0 = 引擎默认 400。失焦保存。', fields.deliberationMinChars, (next) => store.patch({ deliberationMinChars: next }))}
              {inlineNumber('每轮最大门控', 'deliberationMaxGatesPerTurn：每轮最多 deny 次数；0 = 引擎默认 1。失焦保存。', fields.deliberationMaxGatesPerTurn, (next) => store.patch({ deliberationMaxGatesPerTurn: next }))}
            </div>
          </div>
        </EngineModuleCard>}
        {visibleCapability('cot-drip', 'tool-pipeline') && <EngineModuleCard name="cot-drip" layer="tool-pipeline" meta="工具结果后 · 深思维持节拍">
          <div className={styles.settingRowStack}>
            <div className={styles.switchGrid}>
              {gateChip('pt-cot-drip', '深思维持节拍', 'cotDrip：每 N 次工具结果滴入一条 "We…" 重申提醒（additionalContexts）；需模块列表已挂 cot-drip 行。', 'cotDrip')}
            </div>
          </div>
          <div className={styles.settingRowStack}>
            <div className={styles.sessionModelRow}>
              {inlineNumber('节拍间隔', 'cotDripEvery：每几次工具结果滴入一条；0 = 引擎默认 4（0 禁用由引擎 every:0 语义处理）。失焦保存。', fields.cotDripEvery, (next) => store.patch({ cotDripEvery: next }))}
              {inlineNumber('每轮最大提醒', 'cotDripMaxPerTurn：每轮最多提醒条数；0 = 引擎默认 1。失焦保存。', fields.cotDripMaxPerTurn, (next) => store.patch({ cotDripMaxPerTurn: next }))}
            </div>
          </div>
        </EngineModuleCard>}
      </>
      ) : null}
      {store.moduleFacts === undefined && (
        <p className={styles.configFieldHint} role="status">正在读取当前预设模块事实…</p>
      )}
      {store.moduleFacts !== undefined && !hasVisibleCard && (
        <p className={styles.configFieldHint} role="status">
          该层无引擎模块卡：引擎模块分布在 pre-step、system-section 与 tool-pipeline。
        </p>
      )}
    </>
  )
}
