# 方案 A 可行性复核

复核日期：**2026-09-03（星期四）**
仓库基线：`dev@395caad`，`origin/dev` 同步；本轮只复核方案，不实施 UI 重构。
官方宿主基线：本地 `deepseek-harness@76fda729`。

## 结论

方案 A 的方向正确，且是当前 DSH 架构下最可行的方向，但原描述需要收敛。

**建议批准修正版 A′：**

> 保留 CSS Modules、`clsx` 与 DSH `--dsw-*` token；标准控件优先直接复用 `@deepseek-ai/dsh-client-ui-primitives`，原生 HTML 能解决的继续用原生 HTML；只有现有能力确实缺失、且至少有两个真实调用点时，才新增本地深模块。

这意味着：

- 不引入 Tailwind、shadcn/ui、Base UI、Radix 或其他 UI 依赖。
- 不为“目录看起来完整”预建 `src/client/ui/Button.tsx`、`Card.tsx`、`Tabs.tsx`、`Dialog.tsx`。
- 不做没有用户可见收益的全量 JSX 替换。
- 优先复用宿主原子和仓库已有模块，再修补真实缺口。

**最终判定：A′ 高可行；原版“四件套先搭起来”不建议直接执行。**

---

## 一、原分析需要修正的两点

### 1. 不只是“担心 Tailwind 污染”，而是宿主规范已经明确禁止

当前 DSH 官方文档 `deepseek-harness/docs/web-styling.zh.md` 明确规定：

- 使用 CSS Modules 和 `clsx`；
- 不得添加组件库或 Tailwind；
- 功能模块使用 `--dsw-alias-*` 语义 token；
- 全局样式只归 `ui-theme` 所有。

因此，不全量引入 shadcn/ui 不是单纯的风险偏好，而是与当前宿主规范保持一致。

### 2. “shadcn/ui 组件主要依赖 Radix”已经不是完整现状

截至 2026-09-03，shadcn/ui 仍是把开放组件代码分发到项目中的方案，标准配置仍围绕 Tailwind；但 2026 年 7 月起，新项目默认 primitive 已改为 Base UI，Radix 仍可显式选择。

这项变化不影响本项目结论：无论选择 Base UI 还是 Radix，都会新增一套与 DSH 原子、主题和浮层规则并行的控件体系。

---

## 二、仓库现状核验

### 1. 宿主原子已经存在，无需自建同名薄封装

项目已经在 `package.json` 的 peer/dev dependencies 中声明：

```text
@deepseek-ai/dsh-client-ui-primitives
```

`tsdown.config.ts` 也已经把它列入 `CLIENT_EXTERNALS`，当前多个模块已从中导入图标。因此继续导入它的标准控件：

```text
Button
Pill
Input
Menu
Modal
DisclosureRow
HoverCard
```

不会增加 npm 依赖，也不会把另一份控件库打进 `lib/client.js`。

官方原子本身只依赖 React props，并使用 `--dsw-*` token；这正是插件应复用的现有 seam。

### 2. 当前重复量并不支持“四个通用模块一起新建”

对 `src/client/*.tsx` 的静态统计：

| 形态 | 数量 | 分布 | 判断 |
|---|---:|---:|---|
| 原生 `<button>` | 98 | 多文件 | 有统一视觉需求，但宿主已有 `Button` |
| `pillButton` | 66 | 11 个文件 | 真实重复；不等于需要本地 Button wrapper |
| `primaryPill` | 10 | 8 个文件 | 可映射宿主 `Button variant="primary"` |
| `configCard` 外壳 | 5 | 5 个文件 | 每个都携带不同业务行为，暂不适合泛化 |
| `role="tablist"` | 2 | 2 个文件 | 有真实共享行为，但调用点很少 |
| 自定义 modal/backdrop | 2 | 2 个文件 | 重复了焦点循环，存在可提取价值 |

重复最多的是按钮视觉，但其标准能力已经由宿主提供；真正缺少的是少量交互行为，而不是一套新的基础控件目录。

### 3. 当前 CSS 正在承受上游视觉规范漂移

例如 `PromptUi.module.css` 中：

- `.pillButton` 使用 `1px` 中性边框；
- `.configCard` 使用 `1px` 中性边框；
- `.templateModal` 使用真实中性边框和手写阴影；
- 多个胶囊没有配套 `corner-shape: round`。

而当前 DSH 样式规范要求：

- 中性平面边框使用 `0.5px`；
- 高层浮层使用 elevation token，不再叠加中性边框；
- 正圆和胶囊配对 `corner-shape: round`。

如果再把这些旧样式包进本地 `Button` / `Card`，只是把样式债务固化成新的接口。直接使用宿主原子能减少这类漂移。

---

## 三、方案 A 逐项可行性

| 候选模块 | 可行性 | 是否现在做 | 结论 |
|---|---|---|---|
| `Button` | 高 | **不新建本地模块** | 直接使用 DSH `Button`；特殊 danger/图标尺寸继续由调用点 CSS 补充 |
| `Card` | 技术上高，收益低 | **暂不做** | 已有 `CollapsibleCard`，其他卡片含拖拽、顶层开关、受控展开、自动保存等不同语义；通用 Card 会成为浅模块 |
| `Tabs` | 高 | **先深化现有 seam** | 先修 `tab-key.ts` 和两个调用点，无需立即新建组件目录 |
| `Dialog` | 中 | **后置** | 两处确有重复，但不能直接换宿主 `Modal` 后丢失现有焦点循环与焦点恢复 |

### 1. Button：复用宿主，而不是再包一层

宿主 `Button` 已支持：

```text
primary / ghost / outline / toolbar
md / sm
icon
原生 button attributes
```

本项目常用的普通胶囊和主按钮可以直接映射。

仍需保留的本地差异只有：

- danger 色；
- 极小的排序/删除图标按钮；
- 个别全宽、网格或响应式布局；
- 当前 `data-active` 等功能专属状态。

这些是调用点呈现规则，不值得为其设计一个几乎完整转发宿主 props 的 `Button` wrapper。删除这个 wrapper 后复杂度不会回到多个调用点，因此它不会形成有深度的模块。

**迁移策略：** 新代码直接用宿主 `Button`；旧按钮只在相邻功能本来就要修改时顺手迁移，不单开全量替换工程。

### 2. Card：当前没有统一接口

现有卡片至少包含以下不同形态：

- `CollapsibleCard`：内部自持展开状态；
- `PromptConfigCard`：受控展开、拖拽、删除确认和自动保存；
- `EngineModuleCard`：可折叠或顶层开关二选一；
- `CustomToolsModuleCard`：编辑、删除和复杂表单；
- 模板变量卡：焦点离开后自动保存。

为了容纳这些差异，通用 `Card` 很快会出现：

```text
open / defaultOpen / onOpenChange / draggable / actions / topSwitch /
autoSaveOnBlur / danger / headerMode / bodyMode ...
```

这会把实现复杂度搬到接口上，形成浅模块。当前更合理的是保留业务卡片，只复用已有 `CollapsibleCard`；以后若三个以上卡片稳定共享同一种 header/展开/动作语义，再抽取该具体形态，而不是先做空泛 `Card`。

### 3. Tabs：存在真实问题，但已有 seam 可深化

当前 `tab-key.ts` 已集中处理：

- 左右方向键；
- Home / End；
- 循环选择。

但两个调用点目前都缺少完整 tabs 语义：

- 所有 tab 仍是默认 `tabIndex=0`，没有 roving tabindex；
- 方向键更新选中值后，没有把 DOM 焦点移动到新 tab；
- 没有 `aria-controls` / `aria-labelledby` 配对；
- 内容区域没有 `role="tabpanel"`。

因此 Tabs 是唯一有明确行为收益的候选。不过最小修复不是立即搭一套 compound component，而是先深化已有 `tab-key.ts`：

1. 键盘切换后聚焦目标 tab；
2. 两个调用点补 `tabIndex`、稳定 id 和 panel 关联；
3. 为纯键盘索引逻辑增加一个 Node 内置 runner 测试；
4. 只有出现第三种 tabs 调用形态或调用点仍重复大量 props 时，再升级为 `Tabs.tsx`。

这样保留现有 seam，改动更小，也能直接修复真实可访问性缺口。

### 4. Dialog：有提取价值，但不能盲换宿主 Modal

`TemplatePicker.tsx` 与 `PresetSwitcher.tsx` 都实现了：

- backdrop；
- Escape 关闭；
- 首控件聚焦；
- Tab / Shift+Tab 焦点循环。

`TemplatePicker` 还会在关闭后恢复原焦点。

当前 DSH `Modal` 已提供 body portal、mask、Escape 和宿主主题样式，但在本地核验的实现中没有焦点陷阱与焦点恢复。直接替换会产生行为回退。

因此 Dialog 的安全路径是二选一：

1. 等宿主 `Modal` 补齐焦点契约后直接复用；或
2. 当下一次确实修改这两个选择弹窗时，先提取一个只隐藏焦点管理和弹窗 chrome 的本地深模块/钩子。

现在为了“凑齐 ui 目录”先写通用 Dialog，不值得。

---

## 四、对方案 B、C 的补充判断

### 方案 B：只加 Base UI / Radix，不加 Tailwind

**技术可行，但本项目不应采用。**

原因不是这些库质量有问题，而是：

- DSH 已有 `Button`、`Menu`、`Modal`、`HoverCard`、定位钩子等原子；
- 官方样式规范明确要求不新增组件库；
- 新增 headless primitive 会产生第二套 portal、焦点、dismiss 和版本生命周期；
- 当前仅 Tabs 的缺口用几十行现有 helper 改造即可解决。

除非未来出现宿主原子和原生 HTML 都无法覆盖的复杂交互，并且至少有两个稳定调用点，否则没有引入理由。

### 方案 C：shadcn/ui + Shadow DOM

**理论可行，当前构建链下不经济。**

除了原分析列出的 portal 和主题问题，还有一个本项目特有的确定性成本：`tsdown.config.ts` 会把 CSS Modules 编译后注入 `document.head`。这些样式不会自动进入 shadow root；要采用 Shadow DOM，必须先重写样式注入目标和 portal 容器策略。

CSS 自定义属性本身可以通过继承进入 shadow tree，但宿主全局样式、字体/滚动条规则和 portaled 浮层不会因此自动获得同一隔离环境。该方案已经不再是 UI 重构，而是宿主渲染与构建管线改造。

---

## 五、实施风险与验证成本

### 构建与依赖

修正版 A′ 不需要修改：

- `package.json` 依赖；
- `cordis.patch.yml`；
- DSH profile manifest；
- SlotRegistry 注册方式；
- host/runtime 数据链路。

使用新的宿主 primitive export 时，需要同步扩充 `test/client-bundle-facade.test.mjs` 中的 primitive stub，否则 client factory 的隔离物化测试会因缺少导出而失败。

### 测试

仓库没有 jsdom/happy-dom，也没有必要为这次重构新增测试框架。最小验证应为：

1. tabs 的纯索引/键盘逻辑使用 Node 内置 test runner；
2. 现有 client bundle facade 与 SlotRegistry/no-host-DOM 契约继续通过；
3. 完整运行 `typecheck`、`lint`、`test`；
4. 交互改动使用隔离 `DSH_HOME`、随机端口做一次浏览器 smoke，检查焦点、Escape、层级和明暗主题；
5. 不停止或重启当前用户正在运行的 DSH 服务。

---

## 六、推荐的最小试点顺序

### 第 1 步：只修 Tabs 行为

预计修改：

```text
src/client/tab-key.ts
src/client/PromptWorkspace.tsx
src/client/SkillsSettings.tsx
test/client/tab-key.test.mjs（或现有最接近的 client 测试文件）
```

目标只包含：roving tabindex、焦点移动和 tab/panel 关联。不改视觉，不引依赖，不新建通用 UI 目录。

### 第 2 步：新代码开始直接使用宿主 Button

不批量迁移 76 个现有 `pillButton` / `primaryPill` 使用点。只在下一次修改某个业务区域时，将该区域的标准按钮直接替换为 DSH `Button`，并保留确有必要的 danger/布局类。

### 第 3 步：弹窗被再次修改时再统一

若 `TemplatePicker` 或 `PresetSwitcher` 后续新增交互，再把两处重复的焦点逻辑抽成一个深模块；在此之前维持现状比提前设计通用 Dialog 更便宜。

### 不实施：通用 Card

除非后续出现三个以上真正相同的卡片接口，否则继续使用已有业务卡片和 `CollapsibleCard`。

---

## 七、Go / No-Go 条件

### Go

- 不新增 UI/Tailwind/headless 依赖；
- 优先直接使用 DSH primitive；
- 新模块能隐藏真实行为，而不是只转发 className/props；
- 改动有可观察收益：可访问性、重复行为删除或上游样式一致性；
- 完整验证通过。

### No-Go

- 为保持“shadcn 风格目录”预建未被使用的文件；
- 本地 Button 仅转发宿主 Button 的全部 props；
- Card 为容纳业务差异不断增加布尔 props；
- 以视觉统一为由一次性替换全部现有 JSX；
- 为两个简单 tab 引入 Base UI、Radix 或新的测试框架；
- 用宿主 `Modal` 替换后丢失现有焦点行为。

---

## 最终判定

**批准 A′，不批准原版 A 的四组件脚手架。**

推荐落点是：

```text
宿主 Button/Pill/Input/Menu/Modal 优先
        ↓
已有 CollapsibleCard / tab-key.ts 继续深化
        ↓
只为宿主与现有代码都缺失的行为新增本地深模块
```

第一项值得实施的代码改动是 Tabs 可访问性修复；Button 采用“新代码直接复用、旧代码随改随迁”；Card 暂不抽象；Dialog 后置。
