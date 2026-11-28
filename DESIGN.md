---
name: DSH 提示词工具
description: 面向规则作者的深色点阵画布、浮动工具条与属性栏。
colors:
  primary: "#72aaff"
  then: "#70d5ad"
  else: "#efc467"
  order: "#9ca7b7"
  stage: "#0e1116"
  panel: "#181c23"
  inspector: "#181f2a"
  node: "#192230"
  list-row: "#1c283a"
  ink: "#e7edf6"
  focus: "#a6c7f6"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
    lineHeight: "18px"
  field:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "20px"
  rule-title:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  node-title:
    fontSize: "17px"
    lineHeight: 1.25
  node-kind:
    fontFamily: "ui-monospace, monospace"
    fontSize: "11px"
rounded:
  badge: "5px"
  row: "6px"
  sm: "8px"
  panel: "10px"
  md: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  panel: "12px"
  section: "16px"
components:
  button-primary:
    backgroundColor: "var(--dsw-alias-button-primary-fill)"
    textColor: "var(--dsw-alias-label-primary-foreground)"
    typography: "{typography.body}"
    height: "28px"
    padding: "0 10px"
  button-outline:
    textColor: "var(--dsw-alias-label-primary)"
    typography: "{typography.body}"
    height: "28px"
    padding: "0 10px"
  button-ghost:
    textColor: "var(--dsw-alias-label-primary)"
    typography: "{typography.body}"
    height: "28px"
    padding: "0 10px"
  search-input:
    backgroundColor: "var(--dsw-alias-bg-layer-1)"
    textColor: "var(--dsw-alias-label-primary)"
    typography: "{typography.field}"
    height: "36px"
    padding: "0 34px 0 36px"
  canvas-nav:
    backgroundColor: "#171c24"
    rounded: "{rounded.panel}"
    padding: "{spacing.xs}"
  module-state:
    textColor: "#94e1b8"
    rounded: "{rounded.badge}"
    padding: "0 6px"
  action-node:
    backgroundColor: "{colors.node}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "0.7rem 0.8rem"
  rule-row:
    backgroundColor: "{colors.list-row}"
    rounded: "{rounded.row}"
    typography: "{typography.rule-title}"
  switch:
    rounded: "{rounded.pill}"
    width: "36px"
    height: "20px"
---

# DSH 提示词工具设计系统

## Overview

**Creative North Star: "规则工作台"**

规则工作台围绕一张深色点阵画布展开。打开规则后，顶栏写明所属模块、规则名和保存状态。作者认清编辑对象，再顺着连线读条件、分支和动作。

左侧列表负责查找和切换，右侧属性栏负责检查和编辑。控件排列紧凑，细边框和阴影交代每一层的位置。名称、开关和状态文字各自回答一个问题。

**Key Characteristics:**

- 顶栏用名称标识编辑目标，用文字报告保存状态。
- 节点用形状和文字区分种类，连线有方向、线型与图例。
- 节点落在画布上，工具条、列表和属性栏浮在上面。

## Colors

| 连线 | 在画布上的含义 | 线型 |
| --- | --- | --- |
| 条件蓝 · `primary` | 条件关系，也用于选中节点的外框 | 实线 |
| 成立绿 · `then` | 条件成立后执行 | 实线 |
| 否则琥珀 · `else` | 条件不成立时执行 | 长虚线（7 / 5） |
| 同点次序灰 · `order` | 同一执行点内的先后次序 | 短点线（2 / 4） |

**连线图例。** 同一种关系在画布与底栏图例中使用相同的颜色和线型。 边上保留文字标签，输入端口为空心，输出端口为实心。条件节点本身用金色菱形，条件关系则用蓝线。[画布与图例](src/client/features/prompts/rule-canvas.module.css)

画布、规则列表和属性栏各用固定深色，正文用浅色。共享按钮、搜索框和开关从 DSH 的 `--dsw-*` 语义别名取色，画布局部控件按所在面板覆盖样式。预览面板的色阶供比较明度，实际界面使用上方列出的角色色和宿主别名。[工作台外壳](src/client/app/workspace/PromptWorkspace.module.css) · [共享控件](src/client/ui/primitives.module.css)

## Typography

工作台以系统无衬线显示中文和英文。侧栏说明与紧凑按钮共用正文字级。规则列表用稍大、较重的单行标题方便扫读；打开的节点再用更大的标题说明动作或条件。节点种类、文件路径与键位提示使用等宽字体。规则行名称可省略，属性正文允许折行。[规则行与属性栏](src/client/features/prompts/rules.module.css) · [节点与文件卡](src/client/features/prompts/rule-canvas.module.css)

## Layout

宽工作区把导航放在左上，规则身份和操作放在顶栏，缩放、适配与图例贴在画布底部。左栏用于模块、规则、库或诊断，右栏随所选对象显示属性。面板内部滚动，拖动空白处可平移画布。[布局与导航](docs/subsystems/ui-workbench.md)

| 测量对象 | 宽度 | 可见变化 |
| --- | --- | --- |
| 规则工作区 | ≥ 56rem | 打开规则列表时为左栏留位，列表宽度在 17rem 与 22rem 之间。 |
| 规则工作区 | < 56rem | 列表覆盖工作区，打开时隐藏后面的规则详情。 |
| 画布视口 | < 46rem | 底栏图例收入可展开的按钮。 |
| 规则工作区 | < 43rem | 规则身份与命令分两行排列。 |
| 规则工作区 | < 30rem | 规则列表贴近左右边缘，顶栏紧凑命令以图标显示。 |

窄容器初次打开画布时保留可读的局部尺度，作者可以用底栏适配全图。工作台嵌入主区、会话或侧栏时都按各自的容器宽度判断。[面板断点](src/client/features/prompts/rules.module.css) · [图例断点](src/client/features/prompts/rule-canvas.module.css)

## Elevation & Depth

画布用间隔 20px 的点阵承托节点。节点投下短阴影，边框标出拖动对象。浮起的列表和属性栏用不透明底色、更宽的投影盖住经过身后的连线。底栏另有较浅的阴影，让缩放和图例仍能就近操作。选中节点会出现蓝色外框和淡色外圈；键盘焦点沿当前控件描边。[画布层次](src/client/features/prompts/rule-canvas.module.css) · [浮层与焦点](src/client/features/prompts/rules.module.css)

## Shapes

规则行用小圆角，节点与画布面板用较大的圆角。条件、分组和动作分别有菱形、圆形和小方块，旁边附种类文字。指令文件卡使用折角文件标记，启用状态关闭时卡片用虚线边框。开关轨道和胶囊按钮两端为圆弧。[节点和文件标记](src/client/features/prompts/rule-canvas.module.css) · [按钮变体](src/client/ui/Button.tsx)

## Components

| 组件 | 使用与交互 |
| --- | --- |
| 画布导航 | 左上依次为模块、规则、动作条件库、隐藏、诊断。图标按钮用按下态标明当前栏，键盘聚焦时显示轮廓。 |
| 规则行与动作节点 | 点行名打开规则，行末箭头调整同一执行位置的顺序。点节点打开右栏，同时突出直接相连的边。允许动态效果时光带沿边短暂移动；减少动态效果时保留静态高亮。 |
| 状态与开关 | 模块状态标签显示模块是否启用，规则开关控制当前规则，保存反馈另有文字与圆点。共享开关的轨道为 36 × 20px，滑块为 16px。 |
| 按钮 | 共享圆角按钮有主按钮、描边、透明三款，小号高 28px，中号高 36px。顶栏操作也使用胶囊变体。粗指针时共享按钮及开关的命中区至少为 44 × 44px。 |
| 搜索与编辑 | 共享搜索框保留图标位置和独立的焦点环；规则列表把输入框收紧到 30px。属性栏为长文本保留多行空间，正文离开编辑区时提交，规则开关即时提交。 |

九个可独立查看的预览取自上述组件。按钮示例采用共享的小号圆角变体，搜索框采用共享尺寸，模块状态示例并列展示启用和停用。[组件预览](.impeccable/design.json) · [搜索框](src/client/ui/SearchInput.module.css) · [规则编辑器](src/client/features/prompts/RuleCard.tsx)

## Do's and Don'ts

### Do

- 让规则名称、所属模块与保存反馈各有清晰的位置。
- 以工作台容器的实际宽度安排面板，给列表和属性内容各自的滚动空间。
- 保留键盘焦点、节点种类标记和连线图例，减少动态效果时仍突出当前连接。

### Don't

- 避免把分支色当成全局成功、警告或错误色。
- 避免把模块启用、规则启用与保存结果合成一个状态点。
- 避免把桌面三列等比缩进窄侧栏，或把单行名称截断用于属性正文。
