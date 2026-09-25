/**
 * 悬浮入口的位置模型：只处理视口坐标与夹取，不触碰任何宿主 DOM。
 *
 * 位置是纯客户端界面偏好（不是预设行为、也不是部署轴），因此存在浏览器
 * localStorage：既不加 host bridge 写端点，也不往 settings descriptor 里塞 UI 噪音。
 * 存取失败（无 localStorage、隐私模式、配额）时静默退回默认位置。
 */

export interface TriggerPoint {
  x: number
  y: number
}

export interface TriggerBounds {
  width: number
  height: number
}

/** 默认位置：侧栏轨道右缘（折叠 56px）再往右 8px，垂直居中偏上。 */
export const DEFAULT_TRIGGER: TriggerPoint = { x: 64, y: 64 }
/** 拖动判定阈值（px）：小于它视为单击，避免抖动吞掉开合。 */
export const DRAG_THRESHOLD_PX = 4
/** 视口边缘留白（px）：夹取后按钮整体离边缘至少这么远，避免贴边难以点中。 */
export const TRIGGER_MARGIN_PX = 8
/** 悬浮按钮尺寸（px）：与 Workbench.module.css 的 .floatingTrigger 保持一致。 */
export const TRIGGER_SIZE_PX = 28

/**
 * 桌面版窗口顶部被原生 chrome 占用的高度（px）。
 *
 * 只读官方发布的 CSS 变量：Windows 桌面由 preload 设成 40px，Web 版与 macOS 未定义
 * （回退 0）。按钮只要落在该带内，按下会被 Electron 判成拖窗口，`pointerdown` 永远
 * 到不了这里——既点不开也拖不回来，而位置已写进偏好，等于永久失去入口。
 *
 * `dsh-windows-titlebar-height` 是唯一的原生 chrome 高度真源：插件无权测量 caption 行，
 * 官方 `--dsh-frame-top-clearance` 是另一套语义（固定 48px 的窗口顶带下沉量）。
 */
export function titlebarTopInset(): number {
  if (typeof document === 'undefined') return 0
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height').trim()
  if (raw.length === 0) return 0
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 单轴夹取：先保留边缘留白，留白放不下时退化为「按钮完整可见」。
 *  `topInset` 只抬高下界（顶部原生 chrome），不影响右/下边留白语义。 */
function clampAxis(value: number, limit: number, topInset = 0): number {
  const max = Math.max(0, limit - TRIGGER_MARGIN_PX)
  // 下界取「留白」与「顶部安全距离」的较大者，且不超过上界（视口比两者还矮时保留完整可见）。
  const min = Math.min(Math.max(TRIGGER_MARGIN_PX, topInset), max)
  return Math.min(Math.max(value, min), max)
}

/**
 * 夹取到视口内：按钮必须完整可见。
 * 尺寸取实际渲染尺寸（窄屏断点下按钮是 40px），缺省用设计尺寸 28px。
 * `topInset` 由调用方按桌面环境传入（见 {@link titlebarTopInset}），缺省 0 时与原先一致。
 */
export function clampPoint(
  point: TriggerPoint,
  bounds: TriggerBounds,
  size: Partial<TriggerBounds> = {},
  topInset = 0,
): TriggerPoint {
  const width = size.width ?? TRIGGER_SIZE_PX
  const height = size.height ?? TRIGGER_SIZE_PX
  return {
    x: clampAxis(point.x, bounds.width - width),
    y: clampAxis(point.y, bounds.height - height, topInset),
  }
}

const STORAGE_KEY = 'dsh-plugin-prompt-tool:trigger-position'
/** 早期提交写过的键：读到就沿用，避免用户位置偏好丢失。 */
const LEGACY_STORAGE_KEY = 'dsh-plugin-prompt-tool:floating-trigger'

/** 拖动等价判定：位移超过阈值才算拖动（拖动结束必须吞掉尾随 click）。 */
export function isDragGesture(start: TriggerPoint, current: TriggerPoint): boolean {
  return Math.abs(current.x - start.x) > DRAG_THRESHOLD_PX || Math.abs(current.y - start.y) > DRAG_THRESHOLD_PX
}

export function readStoredTriggerPosition(): TriggerPoint | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.x !== 'number' || typeof record.y !== 'number') return undefined
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return undefined
    return { x: record.x, y: record.y }
  } catch {
    return undefined
  }
}

export function storeTriggerPosition(point: TriggerPoint): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }))
  } catch {
    // 存不下就不存：位置偏好丢失不影响功能。
  }
}
