/**
 * 层卡片的唯一判据：某模块在某一层下有哪些卡、各是什么 kind（纯逻辑，无 React）。
 * 标签、搜索文本与渲染归页面层；这里只回答「有哪些」。
 */
import type { ModuleSummary } from '../../shared/bridge-contract.ts'
import {
  ENGINE_EDITOR_GROUP_MAP,
  MODULE_CAPABILITIES,
  engineGroupParamKeys,
  isModuleCapabilityDeclared,
  moduleCapability,
} from '../../shared/engine-capabilities.ts'
import { moduleDeclares, moduleFactsOf } from './module-subject.ts'

/** 卡片种类：参数组、已声明能力、可创建能力、资产卡、未声明节的添加入口。 */
export type LayerCardKind = 'param' | 'capability' | 'missingCapability' | 'asset' | 'add'

export interface LayerCard {
  id: string
  kind: LayerCardKind
}

/** 页面层补上已小写的搜索文本；data 层不依赖 UI 文案。 */
export interface LayerCardView extends LayerCard {
  searchText: string
}

/** 结构化资产卡（有自己的编辑器，不再进通用参数分组）。 */
export const LAYER_ASSET_IDS = ['variables', 'main-model', 'subagent-model', 'custom-tools'] as const

/** 资产卡读写的 module.yml 节；未登记的资产（模型路由）不按声明面门控。 */
export const LAYER_ASSET_SECTIONS: Record<string, readonly string[]> = {
  variables: ['variables', 'variablesEnabled'],
  'custom-tools': ['customTools'],
}

const isLayerAsset = (id: string): boolean => (LAYER_ASSET_IDS as readonly string[]).includes(id)

/** 本层归属的结构化资产候选（不看声明面）；子代理模型卡由受众视图另行渲染。 */
function assetCandidates(layer: string, exclude: readonly string[]): string[] {
  return ENGINE_EDITOR_GROUP_MAP
    .filter((group) => group.displayLayer === layer
      && group.id !== 'subagent-model'
      && !exclude.includes(group.id)
      && isLayerAsset(group.id))
    .map((group) => group.id)
}

/**
 * 一次给出某模块在某层的全部卡片。
 * 参数组：排除资产卡、要求有扁平参数、能力组要求模块显式声明；
 * 能力：已声明为 capability，未声明为 missingCapability（创建菜单用）；
 * 资产：声明面明确未声明且有登记节时给 add 入口，其余出 asset。
 */
export function layerCards(
  modules: readonly ModuleSummary[] | undefined,
  layer: string,
  moduleId: string,
  exclude: readonly string[] = [],
): LayerCard[] {
  const facts = moduleFactsOf(modules, moduleId)
  const excluded = new Set(exclude)
  const cards: LayerCard[] = []
  for (const group of ENGINE_EDITOR_GROUP_MAP) {
    if (group.displayLayer !== layer || excluded.has(group.id) || isLayerAsset(group.id)) continue
    if (engineGroupParamKeys(group.id).length === 0) continue
    if (moduleCapability(group.id) !== undefined && !isModuleCapabilityDeclared(group.id, facts)) continue
    cards.push({ id: group.id, kind: 'param' })
  }
  for (const { id, displayLayer } of MODULE_CAPABILITIES) {
    if (displayLayer !== layer || excluded.has(id)) continue
    cards.push({ id, kind: isModuleCapabilityDeclared(id, facts) ? 'capability' : 'missingCapability' })
  }
  for (const id of assetCandidates(layer, exclude)) {
    const sections = LAYER_ASSET_SECTIONS[id]
    const undeclared = sections !== undefined && moduleDeclares(modules, moduleId, ...sections) === false
    cards.push({ id, kind: undeclared ? 'add' : 'asset' })
  }
  return cards
}
