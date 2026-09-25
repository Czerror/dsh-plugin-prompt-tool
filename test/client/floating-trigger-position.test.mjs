/**
 * 可拖动悬浮入口的位置模型：视口夹取、拖动判定与持久化读写。
 *
 * 这些纯函数是拖动交互的判定核心（拖动 vs 单击、按钮始终完整可见、位置跨刷新保持），
 * 在 Node 里用最小 window/localStorage 替身验证，不启动浏览器也不读宿主 DOM。
 *
 *（2026-09-17 测试归一精简 Wave 3 C2a 组）：clampPoint 的 6 个场景与 isDragGesture 的 4 个场景
 *  收进各自用例内的参数表（固定夹具与调用样板只写一次，失败信息带场景名），
 *  第 4 条「拖动实现不读宿主布局」是源码禁令，按要求保持原样；运行用例数仍 4。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_TRIGGER,
  DRAG_THRESHOLD_PX,
  TRIGGER_MARGIN_PX,
  clampPoint,
  isDragGesture,
  readStoredTriggerPosition,
  storeTriggerPosition,
  titlebarTopInset,
} from '../../src/client/app/workbench/floating-trigger-position.ts'

test('clampPoint：按钮始终完整可见（含窄屏 40px 尺寸与极小视口）', () => {
  for (const [label, point, viewport, size, expected] of [
    ['左上角同样保留边缘留白', { x: -20, y: -5 }, { width: 1000, height: 800 }, undefined, { x: TRIGGER_MARGIN_PX, y: TRIGGER_MARGIN_PX }],
    ['右下角夹取到视口内', { x: 5000, y: 5000 }, { width: 1000, height: 800 }, undefined, { x: 964, y: 764 }],
    ['窄屏按钮是 40px，夹取必须用实际渲染尺寸', { x: 5000, y: 5000 }, { width: 320, height: 400 }, { width: 40, height: 40 }, { x: 272, y: 352 }],
    ['视口小于按钮时不产生负坐标', { x: 10, y: 10 }, { width: 20, height: 10 }, undefined, { x: 0, y: 0 }],
    ['留白放不下时退化为按钮完整可见，仍不越出视口', { x: 500, y: 500 }, { width: 30, height: 30 }, undefined, { x: 0, y: 0 }],
    ['默认位置在常规视口内不变', DEFAULT_TRIGGER, { width: 1200, height: 900 }, undefined, DEFAULT_TRIGGER],
  ]) {
    assert.deepEqual(clampPoint(point, viewport, size), expected, label)
  }
})

test('titlebarTopInset：只认官方标题栏变量，缺失或非法一律回退 0', () => {
  // Node 环境没有 document：桌面探测必须安静回退，不能抛错。
  assert.equal(titlebarTopInset(), 0, '无 document 时回退 0')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  const withVariable = (raw) => {
    globalThis.document = { documentElement: {} }
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => raw })
  }
  try {
    withVariable('')
    assert.equal(titlebarTopInset(), 0, '变量未定义（Web 版 / macOS）回退 0')
    withVariable('   ')
    assert.equal(titlebarTopInset(), 0, '空白值回退 0')
    withVariable('auto')
    assert.equal(titlebarTopInset(), 0, '非数值回退 0')
    withVariable('-8px')
    assert.equal(titlebarTopInset(), 0, '非正数回退 0')
    withVariable('40px')
    assert.equal(titlebarTopInset(), 40, 'Windows 桌面的 40px 原样读出')
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', previousDocument)
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle
    else Object.defineProperty(globalThis, 'getComputedStyle', previousGetComputedStyle)
  }
})

test('clampPoint：topInset 只抬高下界，缺省时与既有行为逐像素一致', () => {
  for (const [label, point, viewport, size, topInset, expected] of [
    ['不传 topInset 时行为不变（Web 版 / macOS）', { x: 10, y: 8 }, { width: 1000, height: 800 }, undefined, undefined, { x: 10, y: 8 }],
    ['topInset 把上方越界的按钮压回安全线以下', { x: 10, y: 8 }, { width: 1000, height: 800 }, undefined, 40, { x: 10, y: 40 }],
    ['按钮在安全线以下时不受影响', { x: 10, y: 120 }, { width: 1000, height: 800 }, undefined, 40, { x: 10, y: 120 }],
    ['topInset 不影响横轴夹取', { x: 5000, y: 8 }, { width: 1000, height: 800 }, undefined, 40, { x: 964, y: 40 }],
    ['顶部安全线与底部留白同时生效', { x: 10, y: 5000 }, { width: 1000, height: 800 }, undefined, 40, { x: 10, y: 764 }],
    // 极矮视口（60px）下安全线 40 与底部留白 8 无法同时满足：上界 60−28−8=24 先夹住下界，
    // 退化为「按钮完整可见」（24 ≤ y ≤ 32），与 clampAxis 的既有契约一致。
    ['矮视口放不下安全线时仍保证按钮完整可见（退化为 60−28−8=24）', { x: 10, y: 0 }, { width: 1000, height: 60 }, { width: 28, height: 28 }, 40, { x: 10, y: 24 }],
  ]) {
    assert.deepEqual(clampPoint(point, viewport, size ?? {}, topInset ?? 0), expected, label)
  }
})

test('isDragGesture：位移超过阈值才算拖动（小于阈值保留单击）', () => {
  const start = { x: 100, y: 100 }
  for (const [label, point, expected] of [
    ['原地不动是单击', { x: 100, y: 100 }, false],
    ['等于阈值仍算单击', { x: 100 + DRAG_THRESHOLD_PX, y: 100 }, false],
    ['刚过阈值算拖动', { x: 100 + DRAG_THRESHOLD_PX + 1, y: 100 }, true],
    ['向上拖动同样成立', { x: 100, y: 100 - DRAG_THRESHOLD_PX - 1 }, true],
  ]) {
    assert.equal(isDragGesture(start, point), expected, label)
  }
})

test('位置持久化：写入后可读回；损坏与缺失数据回退默认位置', () => {
  const store = new Map()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value) },
    },
  }
  try {
    assert.equal(readStoredTriggerPosition(), undefined, '未写过时返回 undefined')
    storeTriggerPosition({ x: 120.4, y: 88.6 })
    assert.deepEqual(readStoredTriggerPosition(), { x: 120, y: 89 }, '位置按整数像素读回')
    assert.ok(store.has('dsh-plugin-prompt-tool:trigger-position'), '写入固定的 storage key')
    store.set('dsh-plugin-prompt-tool:trigger-position', '{not json')
    assert.equal(readStoredTriggerPosition(), undefined, '损坏 JSON 回退默认')
    store.set('dsh-plugin-prompt-tool:trigger-position', JSON.stringify({ x: 'left', y: 1 }))
    assert.equal(readStoredTriggerPosition(), undefined, '非法类型回退默认')
    // 只保留旧键时也要读回（早期提交用过 floating-trigger 键）。
    store.clear()
    store.set('dsh-plugin-prompt-tool:floating-trigger', JSON.stringify({ x: 10, y: 20 }))
    assert.deepEqual(readStoredTriggerPosition(), { x: 10, y: 20 }, '旧键位置偏好继续可用')
  } finally {
    if (previous === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', previous)
  }
})

test('拖动实现不读宿主布局：无 grid 模板、无祖先爬链、无针对宿主的观察器', () => {
  for (const file of ['FloatingTrigger.tsx', 'floating-trigger-position.ts', 'register-workbench.tsx']) {
    const source = readFileSync(new URL(`../../src/client/app/workbench/${file}`, import.meta.url), 'utf8')
    assert.ok(!source.includes('gridTemplateColumns'), `${file} 不应读取宿主 grid 模板`)
    assert.ok(!source.includes('parentElement'), `${file} 不应向上爬宿主 DOM`)
    assert.ok(!source.includes('MutationObserver'), `${file} 不应观察宿主 DOM`)
    assert.ok(!source.includes('new ResizeObserver'), `${file} 不应针对宿主布局安装观察器`)
    assert.ok(!source.includes('--pt-sidebar-edge'), `${file} 不应依赖侧栏几何变量`)
  }
  const css = readFileSync(new URL('../../src/client/app/workbench/Workbench.module.css', import.meta.url), 'utf8')
  assert.ok(!css.includes('--pt-sidebar-edge'), '样式不应残留侧栏几何变量')
  assert.ok(!css.includes('.sidebarEdgeProbe'), '样式不应残留几何探针')
})
