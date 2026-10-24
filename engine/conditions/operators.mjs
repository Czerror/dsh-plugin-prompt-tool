/** 条件树组合算子的唯一清单：纯 ESM，无宿主 import，client 可打包。 */
import { MATCH_LOGIC } from '../anchor-match.mjs'

export const COMPOSITE_OPERATORS = Object.freeze(Object.values(MATCH_LOGIC))
