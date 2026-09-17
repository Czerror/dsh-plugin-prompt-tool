# dsh-plugin-prompt-tool 前端设计方案

> 版本：v2（2026-09-17，ui-skills MCP 复核）
> 范围：`src/client/` 全部前端实现，以及它与 DeepSeek Harness（以下简称 dsh）宿主 Web 客户端的设计边界。
> 方法：通过 ui-skills MCP 获取界面基线、无障碍和动效性能三项规范（见附录 C），对照仓库 `0bbe9869dca212e73c9fef5872c6a659861e1930`、现行架构文档及已安装 `@deepseek-ai/dsh-client-ui-primitives@0.1.6-alpha.1` 核对。原稿统计与行号作为历史定位线索保留，不冒充本轮全量重测结果。
> 本方案不修改任何代码，只给出目标、依据与落地路线。
> 阅读顺序：本总方案 → [页面设计方案](dsh-plugin-prompt-tool-页面设计方案.md) → [模块卡布局设计](dsh-plugin-prompt-tool-模块卡布局设计.md)。仓库内路径以 `D:/AI/GitHub/dsh-plugin-prompt-tool/` 为根，宿主源码路径以 `D:/AI/GitHub/deepseek-harness/` 为根；已发布包契约优先于宿主开发分支。

---

## 0. 摘要

**诊断**：插件已大量复用宿主语义变量，改进重点是控件尺度、装饰密度、交互可达性和状态表达。原稿记录了 303 处 token 引用，以及字号 11 档、圆角 14 档等统计；这些数量用于定位，不作为质量评分，也不能证明运行时对比度或无障碍已经达标。

**三条主张**：

1. **几何收敛，不重建系统**。宿主已提供 Button、Input、Switch、Tag、StateDot、DisclosureRow、Menu、Modal、Tooltip 等原子组件（primitive，即最小可复用 UI 单元）。对已验证行为等价的重复控件进行复用，保留业务交互，并把同用途的高度/圆角/字号对齐宿主档位。
2. **层级靠结构，不靠装饰**。原稿所查官方亮色主题中 `bg-layer-1/2/3` 同值，不能靠名称推断层次。优先用间距、分组与必要边界建立层级，删去与操作或状态无关的蓝色光晕、渐变和彩色投影；最终效果在实际明暗主题核对。
3. **accent（强调色）服务于操作与状态**。保留主操作、焦点和选中态；去掉标题装饰条、导航光晕、卡片彩色投影与空态渐变。错误、提醒、成功沿用各自语义色，并配文字，不能为统一配色牺牲辨识度。

**目标**：视觉与宿主一致，主要操作在窄容器与键盘下可达，失败后可恢复。焦点、菜单和布局属于本次设计改进；保存语义、bridge 载荷、预设写入与引擎注入顺序保持原契约。无障碍和视觉结果须在实现后实测，本文不声称已经达标。

**本轮修正**：保留六页导航和独立工具预览；取消默认扩宽抽屉、拆分 tablist 与强制迁移所有控件；修正触控尺寸、过时 ARIA、恒高布局和动效时长；补充安全区、弹层层级、草稿冲突及验收反例。优先级为可访问名称/焦点/草稿保护，其次响应式和视觉收敛。

---

## 1. 设计定位与现状诊断

### 1.1 这是什么界面

按 ui-skills 的界面类型划分，本插件属于**配置工作台**（settings / admin surface），不是内容消费界面，也不是营销页面。这决定了它的设计优先级：

| 维度 | 结论 | 理由 |
|---|---|---|
| 首要目标 | 快速定位"哪条配置注入了什么、注入在哪、生效几次" | 产品定位是位置、时机与受众可配置的提示词注入引擎 |
| 使用者 | 正在调提示词策略的 dsh 使用者，边用边调、会话短、频次高 | 工作台是抽屉形态，随时开关 |
| 与宿主关系 | **寄生于宿主设置语言**，不是独立产品 | 它出现在宿主 Web GUI 的 `shell.overlay`（顶层悬浮插槽）与 `settings.plugins.tab`（设置页插槽）内 |
| 密度取向 | 紧凑但成体系（12/13px 正文、28/36px 控件） | 配置项多、单页信息量大，官方设置页同样是紧凑密度 |
| 不追求 | 品牌表达、视觉惊喜、动效炫技 | 高频工具界面里，动画是成本不是收益 |

### 1.2 结构层面：良好，无需重构

以下结论均可在 `docs/ui-architecture.md` 与源码中核对，是本方案的**不动资产**：

- 四层依赖方向清晰：`index.ts → app → features/data/ui → shared`，根入口只做宿主适配。
- bridge（客户端与插件的本地回环通信通道）契约单一来源：`src/shared/bridge-contract.ts` 同时拥有路径表、请求体映射与响应映射。
- 已有正确的宿主复用实践（后续应扩大）：
  - `src/client/ui/MenuSelect.tsx:50` 使用官方 `Menu`（含 `portal`、`compact`、`anchor`）；
  - `src/client/ui/ToggleRow.tsx:11` 使用官方 `Switch`；
  - `src/client/ui/StatusBadge.tsx:20` 使用官方 `Tag`；
  - `src/client/features/tools/tools.module.css:31` 正确使用 `--dsw-elevation-stroke` / `--dsw-elevation-panel`。
- 纯逻辑已从视图剥离（`tab-key.ts`、`dialog-focus.ts`、`anchored-popover.ts`、`save-queue.ts` 等），有 Node 内置测试覆盖。

**颜色与主题使用：原稿静态统计基线。** 下表是原稿对 `src/client/**/*.module.css` 的计数，不等同于浏览器渲染、对比度或辅助技术验证：

| 检查项 | 实测 | 评价 |
|---|---|---|
| 引用 `--dsw-*` 设计变量 | 303 处，覆盖 10 个文件 | ✅ 全面使用语义变量 |
| 硬编码颜色（`#hex`） | **0 处** | ✅ 完全合规 |
| `rgb()`/`hsl()` 字面量 | **0 处** | ✅ 完全合规 |
| `:root` 全局声明 | **0 处** | ✅ 不污染宿主主题 |
| `transition: all` | **0 处** | ✅ 全部显式列出属性 |
| `!important` | 7 处，集中在 2 个文件 | ⚠️ 见缺口 G |
| `:focus-visible` 规则 | 25 处，覆盖 6 个文件 | ⚠️ 覆盖一半文件 |
| `prefers-reduced-motion` 查询 | 6 处，覆盖 6 个文件（共 12 个） | ⚠️ 见 1.4 |

**结论**：问题不在架构，也不在颜色纪律，而在**几何尺度、控件形态与装饰密度**。因此方案以"替换与收敛"为主，不做结构搬迁，且必须保住上表前五行这份资产。

### 1.3 视觉层面：七类可验证的缺口

#### 缺口 A：与宿主重叠的自建控件

| 自建物 | 位置 | 宿主复用候选 | 重叠程度 |
|---|---|---|---|
| `.pillButton` / `.primaryPill` 36px、圆角 18px | `controls.module.css:211-248` | `Button` size `md`（36px、圆角 18px、字号 14px）`ui-primitives/src/Button.module.css:4-36` | 几何相近，事件/ref/禁用语义另验 |
| `.pillButton` 28px 变体 | `controls.module.css:486-492` | `Button` size `sm`（28px、圆角 14px、字号 12px）同文件 `:30-36` | 几何相近，事件/ref/禁用语义另验 |
| 自建 `.switch`（40×24 与紧凑 32×18） | `controls.module.css:614-669` | `Switch`（`role="switch"`、`aria-checked`、**`label` 必填**）`ui-primitives/src/Switch.tsx:18-41` | 功能重叠；自建调用没有组件级必填约束，但现有多处已有aria-label，须逐点核对 |
| 自建状态点（6px 核心 + 光晕 + pulse） | `ui/StatusDot.tsx:9` | `StateDot`（5 种状态 done/warning/ongoing/error/idle，含 ongoing 扫描动画）`ui-primitives/src/StateDot.tsx:22-60` | 重叠，宿主状态更多且自带 `aria-hidden` |
| 自建胶囊 `.configChip` / `.tagChip` | `controls.module.css:692-705`、`:779` | `Tag`（8 档 tone：outline/solid/neutral/quiet/success/info/warning/danger）`ui-primitives/src/Tag.tsx:34-41` | 重叠 |
| 自建弹窗 `.modalBackdrop` / `.templateModal` | `controls.module.css:113-147` | `Modal`（含遮罩 `bg-mask-1` 与 `elevation-prominent`）`ui-primitives/src/Modal.module.css:12-33` | 重叠 |
| 自建折叠卡 `CollapsibleCard` | `ui/CollapsibleCard.tsx` | `DisclosureRow`（24px 折叠行，带 `aria-expanded` 与键盘处理）`ui-primitives/src/DisclosureRow.tsx:33-103` | 部分重叠（业务外观需保留） |

#### 缺口 B：同一界面并存两套开关

- 官方路径：`ToggleRow` → 官方 `Switch`（`ToggleRow.tsx:11`）。
- 自建路径：`.configEnable > input + .switch`（`controls.module.css:588-669`），被 `.skillSwitch`、模块卡内布尔项等处使用。

两者外观不同（40×24 对官方尺寸、32×18 紧凑对官方尺寸），导致**同一页面里开关长相不一致**，且自建版本绕过了官方组件的 `label` 必填约束（`Switch.tsx:1-2` 明确说明该设计意图：渲染点无法交付一个没有可访问名的开关）。

#### 缺口 C：几何尺度未成体系

以 `src/client/**/*.module.css`（12 个文件）全量实测：

| 尺度 | 实测 | 档数 | 问题 |
|---|---|---|---|
| 字号 | 8(×1) 10(×4) 11(×11) 12(×33) 13(×11) 14(×7) 15(×4) 16(×2) 17(×1) 18(×2) 20(×1)，共 77 处 | **11** | 8/10px可读性与同用途的随意差异需核对；11/12/13/14也可能是合法宿主角色，不按数量判错 |
| 圆角 | 2(×1) 6(×1) 7(×2) 8(×5) 9(×5) 10(×4) 11(×3) 12(×8) 13(×1) 14(×6) 15(×1) 16(×1) 18(×2) 999(×9)，共 49 处 | **14** | 仅"单行输入"一个功能族就出现 8/9/10 三种半径 |
| 间距 `gap` | 1 2 3 4 6 7 8 9 10 12 14 18 24 28，共 91 处 | **14** | 同用途的近邻档位需核对是否冗余；不能把图标微间距与区块间距混同 |
| 高度 | 全部 `height` 声明 79 处、32 种取值；其中控件相关在 18–48px 之间**连续分布** | ≈15（控件） | 单行输入出现 32/34/38 三种；按钮出现 22/28/30/32/36 五种 |
| 过渡时长 | .14(×14) .16(×17) .18(×6) .22 .26 .3 .32，共 7 档（另有 .7/1.4/2.4 属循环动画，不计） | **7** | 主力 .14s 与 .16s **都不在**官方三档（0.1/0.2/0.3s）内 |
| `padding` 首值 | 1 2 3 4 5 6 7 8 9 10 11 12 14 24，共 40 处 | **14** | 按组件角色检查重复值，不用奇偶数判断视觉正确性 |

对同一用途优先复用现有尺度；不要把按钮、图标、描边和容器的全部数值混成一个问题。相邻档位相差 25% 不是本轮 MCP 规范或无障碍标准，不能据此删除宿主的 12/13/14px 排版角色。以用途一致、文本可读和放大不裁切验收。

#### 缺口 D：四个变量在本机找不到定义（其中两个官方自己也在用）

在官方仓库 `deepseek-harness` 全范围、以及已安装的 `@deepseek-ai/dsh-client-ui-theme` 包内检索，以下变量**均无定义**：

| 变量 | 使用位置 | 官方自身是否也这样用 | 判定 |
|---|---|---|---|
| `--dsw-alias-fill-field` | `controls.module.css:225` | 原稿未找到官方使用 | 若运行时未定义则回退到 `var(--dsw-alias-bg-layer-3)`；需查computed style |
| `--dsw-alias-label-brand` | `controls.module.css:779`（`.configChip`） | 原稿未找到官方使用 | 若运行时未定义，依赖它的color/background声明无效；需核对实际回退结果 |
| `--dsw-font-mono` | `controls.module.css:457` | ✅ 官方 4 处：`ui-jobs/JobListAction.module.css:102`、`ui-agent-preset/AgentPresetSection.module.css:275`、`:359`、`:442`、`ui-sidebar-documentpreview/TextPreview.module.css:93`（回退值写法与本项目**逐字相同**） | **跟随官方惯例**，不应单独归咎于本项目 |
| `--dsw-alias-label-error` | `prompts.module.css:117`、`:120`、`tools.module.css:29` | ✅ 官方 5 处：`ui-settings-plugins/fields.module.css:78`、`:85`、`SubagentModelSelectionCard.module.css:43`、`:52`、`PluginCard.module.css:109` | **跟随官方惯例**，详见模块卡布局设计文档 1.4 的证据分级 |

**候选处置**：以下变量在原稿所查宿主源码中存在；实施前再以已安装包与实际主题确认，按语义和渲染结果选择。

| 改用 | 已确认的定义处 |
|---|---|
| `--ds-font-family-code` | `ui-theme/src/styles/base.css:9`（官方主流写法；本项目 `:339`、`:360`、`:830` 已正确使用） |
| `--dsw-alias-state-error-primary` | `design-platform.css:225`（亮）/ `:320`（暗） |
| `--dsw-alias-state-business-primary` / `--dsw-alias-brand-primary` | `design-platform.css:223`、`:179` |
| 直接写 `var(--dsw-alias-bg-layer-3)`（去掉不存在的回退链） | `design-platform.css:160` |

上述是候选替换，不能从静态搜索推出「无副作用」。先检查已安装主题与实际 computed style；比较明暗背景上的文字/图标对比度，再选语义匹配的 token。源码未找到定义只说明本地证据不足；未知运行时值不得宣称与候选 token 等价。

#### 缺口 E：亮色模式下层级不成立

官方 token 定义（`ui-theme/src/styles/design-platform.css`）：

| 变量 | 亮色（`:156-160`） | 暗色（`:251-255`） |
|---|---|---|
| `--dsw-alias-bg-base` | bluish-00（纯白） | bluish-950 |
| `--dsw-alias-bg-layer-1` | bluish-00（纯白） | bluish-875 |
| `--dsw-alias-bg-layer-2` | bluish-00（纯白） | bluish-850 |
| `--dsw-alias-bg-layer-3` | bluish-00（纯白） | bluish-800 |

即：**亮色下三层表面完全相同**，官方靠描边与阴影分层（`--dsw-elevation-stroke/panel/prominent/soft`，定义见 `gradient-shadow-text.css:28-34`，形态是"0.5px 描边 + 极淡黑阴影"）。

当这些表面 token 在亮色下同值时，不能仅用 token 名称推断层级。当前卡片另有描边、间距和局部装饰，需用截图核查实际层级，不能断言「完全由光晕承担」。方案保留明确边界，减少与任务无关的蓝色渐变。

#### 缺口 F：装饰过载

强调色出现在以下**非状态语义**位置（约 20 处）：

- 标题左侧渐变竖条 + 光晕：`controls.module.css:36-48`
- 分组标题渐变背景与标题后光点：`controls.module.css:79`、`:93-103`
- 卡片悬停彩色投影 + 上移 1px：`:760`（configCard）、`:431-434`（presetCard）、`:200-204`（templateModalItem）
- 卡片展开态彩色投影：`:764`
- 预设卡激活光圈：`:435-439`
- 主按钮彩色投影：`:248`
- 拖拽手柄悬停变蓝并上移：`:579-584`
- 空状态双层径向渐变：`:851-853`；空状态图标光晕：`:866`
- 展开表单顶部渐变：`:796-798`
- 顶部装饰渐变分隔线：`PromptWorkspace.module.css:50-58`
- 品牌方块渐变 + 内外光晕：`PromptWorkspace.module.css:75-79`
- 导航激活项发光下划线：`PromptWorkspace.module.css:194-204`
- 自建蓝色滚动条（未用官方 `--dsw-alias-scrollbar-*`）：`PromptWorkspace.module.css:216-226`
- 页头蓝色胶囊代号：`PromptWorkspace.module.css:240-252`

本轮 baseline-ui 支持去掉无请求的渐变和主提示光晕；层级优先由间距、字重与必要边界表达。不把60/30/10装饰配比作为工作台验收指标。

#### 缺口 G：`!important` 与不完整的焦点替代

- `!important` 共 7 处、集中在 2 个文件，其中 `controls.module.css:241-246` 用 `!important` 强制覆盖主按钮的颜色与边框。根因是**自建按钮**需要压过宿主按钮的默认样式——一旦改用官方 `Button` 的 `primary` 变体（`Button.module.css:38-45` 已用 `button-primary-fill` 正确实现），这 4 处 `!important` 可以整体删除。这是"收敛到宿主原子"能直接消灭技术债的典型例子。
- `outline: none` 共 6 处、全部位于 `controls.module.css`（`:819`、`:840`、`:1021` 等）。其中 `:1021` 用 `box-shadow` 环替代（做法正确），但 `:819`、`:840` 只把边框换成强调色，未保证 3:1 对比度。

### 1.4 交互与无障碍层面的缺口

| 项 | 证据 | 影响 |
|---|---|---|
| 焦点替换待验证 | `controls.module.css:819`、`:840`：`.configInput:focus-visible { border-color: ...; outline: none }` | 仅靠边框变色，需要实测可见性与3:1对比，静态源码不能断言通过或不通过 |
| 负偏移焦点环 | `controls.module.css:509-512`：`outline-offset: -1px` | 在密集卡片内可能被相邻元素遮挡 |
| 自建开关的可访问名依赖隐式实现 | `controls.module.css:595-604` 视觉隐藏 `input`；`Switch.tsx` 的设计要求是显式 `label` | 需要逐点确认每个 `.configEnable` 都有可访问名 |
| reduced-motion（减弱动效偏好）覆盖不全 | `controls.module.css:1040-1050` 覆盖了 switch/chevron/pageHeader/section/skeleton/spinner/按钮 | `presetCard`、`templateModalItem`、`configCard` 的 `transform: translateY(-1px)` 过渡未覆盖 |
| 滚动条未用官方变量 | `PromptWorkspace.module.css:216-226` | 优先复用宿主滚动条样式或变量；自建色的实际对比待验证 |

---

## 2. 视觉系统设计

本章给出**目标尺度表**。规则：任何新值必须从下表中选，不再新增档位。

### 2.1 表面与深度

**原则**：亮色以间距和边界分层，暗色可辅以表面差。平面用中性 `0.5px` border；高层浮面用 `border: 0` + elevation token。宿主 `docs/web-styling.md` 明确禁止中性 border 与 elevation 的描边叠加。

| 层级 | 用途 | 亮色表现 | 暗色表现 |
|---|---|---|---|
| L0 页面底 | 工作台背景 | `--dsw-alias-bg-base` | 同左 |
| L1 内容卡 | 配置卡、能力卡、技能行 | `--dsw-alias-bg-layer-3`（白）+ `0.5px solid var(--dsw-alias-border-l2)` | `--dsw-alias-bg-layer-3` + 同描边 |
| L2 卡内嵌区 | 展开后的表单区 | `--dsw-alias-bg-layer-2` + 顶部 `0.5px` 分隔 | 同左 |
| L3 浮层 | 抽屉面板、弹窗、菜单、气泡 | `--dsw-alias-bg-layer-2` + `border: 0` + `--dsw-elevation-prominent` | 同左 |
| 遮罩 | 弹窗/抽屉背板 | `--dsw-alias-bg-mask-1` + `var(--dsw-mask-blur)`（`gradient-shadow-text.css:19`） | 同左 |

描边选择（官方层级，`design-platform.css:172-176` / `:267-271`）：

| 用途 | token | 亮色/暗色不透明度 |
|---|---|---|
| 极淡分隔（表格行、区块间） | `--dsw-alias-border-l1` | 0.04 / 0.06 |
| 标准容器描边 | `--dsw-alias-border-l2` | 0.10 / 0.12 |
| 弹窗内分隔 | `--dsw-alias-border-l3` | 0.12 / 0.16 |
| 输入控件描边（官方 `Input` 用此档） | `--dsw-alias-border-l4` | 0.16 / 0.20 |
| 暗色下更细的容器描边 | `--dsw-alias-border-l2-darkmode-thin` | — / 0.06 |

**禁止**：用 `color-mix()` 把强调色调进卡片背景来"分层"；用彩色 `box-shadow` 表达悬停。

### 2.2 文字层级

官方已提供完整的排版阶梯（`gradient-shadow-text.css:179-268`），直接使用，不写裸字号：

| 用途 | 推荐 token | 实际值 |
|---|---|---|
| 工作台标题 | `--dsw-font-base-16` / `--dsw-font-base-strong-16` | 16px / 24px |
| 卡片标题、分组标题 | `--dsw-font-xs-strong-13` | 13px / 20px / 500 |
| 正文、字段值、设置项标题 | `--dsw-font-xxs-12` | 12px / 18px |
| 次要元信息 | `--dsw-font-xxxs-11` | 11px / 14px，仅用于非关键短标签 |
| 说明、错误、只读原因 | `--dsw-font-xxs-12` | 12px / 18px，不以弱化颜色降低可读性 |
| 官方标准按钮/输入 | 组件自身排版 / `--dsw-font-s-14` | 保留 14px，不为减少档位覆写宿主 |
| 代码、路径、标识符 | `--dsw-font-markdown-code` + `--ds-font-family-code` | 12px / 19px 等宽 |

颜色层级（最多用四级，官方定义见 `design-platform.css:201-209`）：

| 层级 | token | 用途 |
|---|---|---|
| 主 | `--dsw-alias-label-primary` | 标题、字段值、主要文本 |
| 次 | `--dsw-alias-label-secondary` | 说明、次要操作 |
| 三 | `--dsw-alias-label-tertiary` | 元信息、时间戳、帮助 |
| 弱 | `--dsw-alias-label-caption` / `--dsw-alias-label-dimmed` | 占位符 / 禁用 |

先用分组、间距和字重建立层级，字号与颜色只辅助。11–16px 普通文字仍按至少 4.5:1 验收，不能因为使用 tertiary/caption token 就默认可读。长标题允许换行；数字统计使用 `tabular-nums`，普通标签不加字间距。200% 文本放大与中文/英文切换不得裁掉内容。

### 2.3 控件几何

统一到官方两档 + 一个输入框高度：

| 控件 | 高度 | 圆角 | 字号 | 依据 |
|---|---|---|---|---|
| 主/次按钮（标准） | 36px | 18px | 14px | 官方 `Button` `md`（`Button.module.css:24-26`、`:10-12`） |
| 紧凑按钮（卡片内、工具栏） | 28px | 14px | 12px | 官方 `Button` `sm`（`Button.module.css:30-36`） |
| 单行输入 | 32px | 8px | 14px | 官方 `Input`（`Input.module.css:5-9`：height 32、radius 8、border `l4`、背景 `bg-layer-1`） |
| MenuSelect 下拉触发器 | 标准36px / 卡内28px | 沿用既有胶囊 | 标准14px / 紧凑12px | 遵循现行UI架构；不强行套用输入框32px档 |
| 紧凑输入（模块卡内） | 28px | 8px | 12px | 高度与 `Button sm` 齐平（圆角仍用输入框档 8px，不套用按钮胶囊） |
| 多行文本域 | 自适应（≥72px） | 8px | 12px 等宽 | 保留 `field-sizing: content` 与手动纵向缩放 |

**收敛**：同用途的 22/30px 按钮优先归 28px，34/38px 输入优先归 32px；32px 输入保留。表中尺寸是默认密度，不是裁字的固定上限；多行标签与缩放可撑高。指针目标至少 24×24 CSS px；粗指针/触控布局优先提供 44×44px 的真实命中框与间距，不能用互相重叠的伪元素热区补数。

### 2.4 色彩纪律

| 用途 | 允许 | token |
|---|---|---|
| 主操作按钮 | ✅ | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（项目已正确使用，`controls.module.css:238-246`） |
| 当前项 / 选中态 | ✅ | `--dsw-alias-state-business-primary`（当前 tab、当前预设、选中行） |
| 状态语义 | ✅ | success / warn / error 三系 token |
| 开关打开 | ✅ | 由官方 `Switch` 决定 |
| 卡片悬停 | ❌ 用背景色 | `--dsw-alias-interactive-bg-hover` |
| 标题装饰 | ❌ 删除 | — |
| 卡片彩色投影 | ❌ 删除，改用 `--dsw-elevation-stroke` 或描边加深 | — |
| 空状态放射渐变 | ❌ 删除 | — |

强调色配额：**单屏可见范围内，强调色元素不超过 3 类**（当前项、主操作、状态）。

### 2.5 形状与曲率

- 官方对全圆形状有专门约定：`corner-shape: superellipse(1.5)` 全局生效（`corner-shape.css:16-25`），**圆形与胶囊必须显式写 `corner-shape: round` 退出**，否则会被压成方圆形。项目已在多处正确书写（如 `Workbench.module.css:64`、`controls.module.css:222`），此约定必须保留并补全到所有胶囊/圆形控件。
- 插件自有表面优先用 **8px**（控件）、**12px**（卡片）、**14px**（浮层）；官方 `Button md/sm` 的 18/14px 胶囊交由组件，不覆写为所谓统一档位；自有胶囊可用 999px。

### 2.6 动效

官方提供三档时长（`ui-theme/src/styles/base.css:11-14`）：

| token | 值 | 用途 |
|---|---|---|
| `--ds-transition-duration-fast` | 0.1s | 悬停、按下等即时反馈 |
| `--ds-transition-duration` | 0.2s | 已有菜单、开关、抽屉的最长交互反馈 |
| `--ds-transition-duration-slow` | 0.3s | 宿主已有 token，插件本轮不用于交互反馈 |
| `--ds-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | 位移与状态切换 |

规则（本轮 baseline-ui 与 fixing-motion-performance）：

1. **不新增动效**；保留必要既有动效时优先 `transform` / `opacity`，不动画 height/width/top/left；小范围 hover 色彩反馈可保留。不写 `transition: all`。
2. **高频操作不动画**：抽屉开关、tab 切换、卡片展开是每天上百次的操作，进场动画应≤0.2s 或直接取消（当前 `.pageHeader`/`.section` 的 `pt-rise` 0.3s 位移入场属于"每次切页都要看一遍"的成本，建议删除）。
3. **弹层从触发器方向展开**（`transform-origin` 对齐触发元素），菜单/气泡适用；弹窗居中例外。
4. **`prefers-reduced-motion` 必须覆盖所有位移与缩放**，包括 `presetCard`、`configCard`、`templateModalItem` 的 `translateY(-1px)`。
5. **不发明 easing**：优先现有 `--ds-ease-in-out`；有必要的进入动画可用标准 `ease-out`，不为对齐时长新建动画库。
6. 不动画大面积 blur/backdrop-filter，不常驻 `will-change`；骨架与 spinner 仅在等待且可见时循环，reduced-motion 下保留静态形态与加载文字。读布局与写样式分批，禁止滚动监听驱动装饰动画。

---

## 3. 信息架构与导航

### 3.1 容器策略

当前入口（`app/workbench/register-workbench.tsx`、`WorkbenchOverlay.tsx`）：

- `shell.overlay`（宿主顶层悬浮插槽）+ 可拖动悬浮触发器 + body portal 抽屉，`z-index` 1000/1100。
- `settings.plugins.tab` 设置页承载部署设置（含AGENTS写入授权/注入）与默认预设。

**保留该策略**，理由充分且有实测依据（官方右侧栏已被验证不适合本项目，见 `docs/ui-architecture.md:217`）。需要调整的是**几何**：

| 项 | 当前 | 建议 | 理由 |
|---|---|---|---|
| 抽屉宽度 | `min(920px, 100vw)`（`Workbench.module.css:5`） | 先保持；导航简化与容器重排仍无法容纳任务时才评估加宽 | 视口宽不等于插件可用宽；加宽会遮挡更多会话内容 |
| 抽屉圆角 | 无（贴边） | 保持贴边，`border: 0` + elevation | elevation 已含描边，不另叠中性边框 |
| 触发器尺寸 | 28px（<520px 时 40px） | 精细指针保留28px；粗指针优先44px，补 `aria-expanded`/`aria-controls` | 视口阈值不能替代输入设备判断 |

固定层使用动态视口约束与 `env(safe-area-inset-*)` 内边距，覆盖刘海、底部指示条和软键盘；不得为安全区改变持久配置。抽屉仅内容区主滚动，短视口中关闭/保存可达。现有层级为抽屉1000、触发器1100、锚定浮层1200、Tooltip1400；居中 `.modalBackdrop` 当前100与抽屉存在遮挡风险。实施时按「抽屉 < 子对话框/菜单 < Tooltip」验证实际 stacking context 与官方 Menu portal，不靠不断增加随意 z-index 解决。

### 3.2 六页导航保持稳定

当前六页平级（`app/workspace/workspace-pages.ts`）：主会话、子代理、工具预览、技能设置、预设配置、角色管理。

六页承载不同任务。保留 `workspace-pages.ts` 的页面 ID、顺序和独立工具预览页；通过页标题与一句说明解释任务，不把导航分类变成额外操作。

```
主会话  子代理  工具预览  技能设置  预设配置  角色管理
└──────────── 一个 tablist，对应六个互斥 panel ────────────┘
```

- 六项共用现有 roving tabIndex、左右方向键和 Home/End；不拆为两个各有选中项的 tablist。切换后焦点留在目标 tab，进入内容由下一次 Tab 完成。
- 窄容器保留单行横向滚动的标签栏，选中项滚入可见区；页面本身不横向溢出。不能只显示图标或要求触屏用户猜隐藏页。
- 工具预览保持独立只读页面，只在用户打开后请求；页面切换立即显示本地骨架，网络不阻塞键盘导航。主会话筛选不触发诊断请求。

**兼容性**：不新增 `group` 元数据、不搬走工具预览、不重排页面。原稿的入口降级方案与 `docs/ui-architecture.md` 的独立工具预览及导航契约冲突，v2 撤回。

### 3.3 页面内布局模式

统一三种模式，避免每页各写一套：

| 模式 | 适用页 | 结构 |
|---|---|---|
| **列表-展开**（默认） | 主会话、子代理 | 顶置公共配置区 → 工具栏（筛选/搜索/创建）→ 平铺卡片列表，卡内展开编辑 |
| **资源库** | 预设、角色、技能 | 工具栏 → 预设/角色自适应网格、技能保留便于排序的单列；网格最小宽不得超过容器（如 `minmax(min(100%, 268px), 1fr)`） |
| **只读诊断** | 工具预览、世界书诊断 | 搜索置顶 → 可折叠分组 → 双列详情卡（<680px 单列） |

密度基准（写在 `PromptWorkspace.module.css` 的壳层，页面继承）：

- 页面左右内边距：16px（<760px 时 12px）
- 提示词配置列表保持现有10px；资源网格12px；卡片内分区间距见模块卡方案
- 卡头与展开区内边距以模块卡方案2.2/2.5为准，本总稿不另设第二套数值
- 页面底部留白：按实际固定操作区高度 + 16px + 安全区设置；触发器可拖动，不能用固定大留白保证永不遮挡。

断点属于布局 owner。先保留已有620/720/760px等实际阈值，按卡片/工作台内容宽度验证；只有行为等价的规则才合并。共享布局先复用 `WorkspaceFrame`、现有页头与 CSS，不为三种模式新增通用 PageShell 或一套注册器。页面详情以页面方案为准。

---

## 4. 组件策略

### 4.1 复用候选与迁移门槛

官方名字相似不等于行为等价。先核对已安装包类型、现有调用者和焦点行为；每个交互表面只保留一个 portal、Escape 与焦点管理 owner。迁移未满足门槛时保留现有实现，先统一视觉。

| 用官方 | 替换掉 | 迁移要点 |
|---|---|---|
| `Button`（`primary`/`ghost`/`outline`/`toolbar` × `md`/`sm`） | `.pillButton`、`.primaryPill`、`.presetIconButton`、`.dialogClose` | 变体映射：主按钮→`primary`；描边胶囊→`outline`；卡片内次要动作→`ghost`；工具栏图标按钮→`ghost` + `icon` |
| `Input`（按需） | 标准文本/搜索输入的重复视觉 | 已安装类型为 span 包装原生 input；需验证 ref、id、className、数字字符串草稿、IME、粘贴与事件等价。未通过则保留原生输入，符合现行架构 |
| `Switch` | `.switch` 的40×24与32×18两套 | 传本地化label；直接提交的开关在自身请求期间禁用；本地草稿开关保持可编辑，遵守权限/只读限制 |
| `Tag` | `.configChip`、`.tagChip`（非编辑态） | tone 映射：成功→`success`，失败→`danger`，提醒→`warning`，信息→`info`，中性事实→`neutral`，最弱→`quiet` |
| `StateDot`（按需） | `ui/StatusDot.tsx` 的重复绘制 | 核对真实状态含义再映射；状态文字保留，静态启用不能映成循环动画的 ongoing；检查 reduced-motion 和隐藏时停转，不新建通用状态适配框架 |
| `DisclosureRow`（仅等价场景） | 简单折叠行的重复部分 | 官方为24px紧凑行，不能直接吞入带开关、菜单、拖拽的整张业务卡；保留兄弟按钮，禁止嵌套交互元素 |
| `Modal`（仅居中场景） | 已验证等价的居中弹窗 | 先验证 portal、嵌套 Escape、初始焦点、Tab循环、关闭还焦和遮罩。不能把已有 DialogSurface 整体套进 Modal；锚定气泡不改成居中模态 |
| Tooltip 视觉 token | `HintTooltip` 样式偏差 | 保留现有 body portal、定位、指针与键盘规则；错误/保存状态留在正文。增加 Escape 可关闭、必要帮助可悬停读取及 `aria-describedby` 验收，不把原生 title 当替代 |

### 4.2 应当保留（宿主确实没有）

| 自建物 | 保留理由 |
|---|---|
| `MenuSelect`（`ui/MenuSelect.tsx`） | 宿主 `Menu` 是菜单容器，不含"选择器触发器"；该项目已正确组合官方 `Menu` + 自有触发器。**仅需**把触发器几何对齐 `Button sm/md`，并去掉自定的 `bg-module-platform` 背景 |
| `anchored-popover.ts` / `anchored-popover-fit.ts` | 锚点定位与窄视口收敛是纯算法，宿主未导出等价物 |
| `hint-tooltip-position.ts` / `hint-tooltip-focus.ts` | 悬停延迟、指针跟随、焦点即时是项目明确的产品契约 |
| `tab-key.ts` / `dialog-focus.ts` | 纯索引算法，已有测试锁定，宿主未导出 |
| `FormField` / `SettingInputRow` / `ToggleRow` | 组合层（label + hint + 控件），用官方原子拼装 |
| `ImportPreviewCard` / `WorldBookDiagnosticsCard` | 业务组件 |
| `ImportFileButton` | 隐藏原生 file input 的既定模式 |

### 4.3 组件规格表（迁移后的目标状态）

| 组件 | 高度 | 圆角 | 字号 | 背景 | 描边 | 状态 |
|---|---|---|---|---|---|---|
| Button md（primary） | 36 | 18 | 14 | `button-primary-fill` | 无 | hover/disabled 交由官方组件；禁用原因有文字 |
| Button md（outline） | 36 | 18 | 14 | transparent | 0.5px `border-l3` | hover `interactive-bg-hover` |
| Button sm（ghost） | 28 | 14 | 12 | transparent | 无 | hover `interactive-bg-hover`；active `interactive-bg-active` |
| Input / 原生输入 | 32 | 8 | 14 | `bg-layer-1` | 0.5px `border-l4` | 可见焦点环；不能只凭 token 名称判断达标 |
| Switch | 官方尺寸 | 官方 | — | 官方 | 官方 | 必填label；仅直接提交中的自身控件禁用，草稿控件遵循既有保存语义 |
| 卡片 | auto | 沿用14 | — | `bg-layer-3` | 0.5px `border-l2` | hover 仅加深描边到 `border-l3`，**无位移、无彩色投影**；与模块卡稿一致 |
| 展开区 | auto | 0（贴卡内） | 12 | `bg-layer-2` | 顶部 0.5px `border-l2` | — |
| 浮层（菜单/弹窗） | auto | 14 | — | `bg-layer-2` | `elevation-prominent`（自带 0.5px 描边） | Escape 关闭、焦点归还 |

---

## 5. 交互与状态规范

### 5.1 状态表达矩阵

| 状态 | 表达 | 禁止 |
|---|---|---|
| 加载中（有旧数据） | 保留旧数据，工具栏显示行内 spinner | 整页骨架闪烁 |
| 加载中（无数据） | 骨架行 46px（保留现有 `.skeletonRow`） | 空白页 |
| 保存中 | 按钮内 spinner + `disabled`，**其余草稿输入不禁用** | 全屏遮罩、冻结表单 |
| 保存成功 | 就地短暂提示（`role="status"`），2-3 秒后消失 | 永久"已保存"徽章 |
| 保存失败 | 就地错误 + 重试入口，草稿保留 | 静默重载清空错误 |
| 版本冲突 | 就地提示 + 「重新读取」；有未保存草稿时先复制/保留草稿，再明确确认丢弃后读取 | 自动覆盖、用一次刷新隐式丢弃草稿 |
| 空列表 | 一句说明 + 一个主操作 | 装饰性放射渐变与光晕图标 |
| 只读（system 预设） | 文字内容可选择/复制，文本字段优先 readonly；写操作 disabled + 就地原因，浏览/展开仍可用 | 禁用整张卡导致无法检查或复制 |

保存队列与冲突判定遵循 `docs/ui-architecture.md`「保存保护」。本方案补充呈现、焦点与草稿保护要求，不另建保存通道；涉及交互调整的代码必须以真实保存结果回归。

保存提示必须绑定真实请求快照：保存期间再编辑仍为未保存；配置与文件部分失败不能播报整体成功。列表操作标明「保存配置」的范围，自定义工具、人设、子代理策略与指令文件维持各自草稿 owner，不增加伪全局保存。筛选、切页和折叠不能清掉未提交 JSON、数字中间态或文件草稿；菜单 portal 的焦点转移也不能误判为用户离开编辑任务。既有 `reading → confirming → submitting` 导入流程保持：确认/取消在 confirming 可用，失败保留预览，切预设/卸载令迟到响应失效，换顺序组重新预览。

### 5.2 高频操作的去动画

| 操作 | 当前 | 建议 |
|---|---|---|
| 切页 | `.pageHeader` + `.section` 各 0.3s 位移动画（`controls.module.css:21`、`:63`） | 直接取消 |
| 卡片展开 | `.chevron` 0.18s 旋转 | 需要方向反馈时保留并用≤0.2s宿主时长；内容本身不动画高度 |
| 卡片悬停 | `translateY(-1px)` + 彩色投影 | 取消位移与投影，只加深描边 |
| 抽屉开合 | 0.26s 位移 + 0.22s 遮罩透明度 | 若保留，两者统一≤0.2s；reduce 下均关闭过渡 |
| 骨架 shimmer | 1.4s 无限循环 | 可改静态；保留时仅可见且加载中循环，reduce 下静止并显示文字 |

### 5.3 键盘与焦点

现有实现已有抽屉 dialog 语义、焦点循环/归还、tablist roving tabIndex 和排序替代；这些是可复用基础，不是无障碍通过证明。需在嵌套 portal、失效触发器和窄视口中验证完整行为。

需补齐：

1. 所有 `focus-visible` 必须有**可见且≥3:1**的替代（不能只靠 1px 边框变色）：统一为 `outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px`，或 `box-shadow: 0 0 0 2px` 环。
2. 卡片内嵌浮层（模板选择、导入预览）关闭后焦点必须回到触发按钮。
3. 折叠卡展开时，焦点保持在卡头按钮上（不跳转到展开内容）。
4. 排序保留「上移/下移」的键盘与点击替代，用 `role="status"` 简洁播报条目和新位置；不使用已废弃的 `aria-grabbed` / `aria-dropeffect`。比较顺序限于同一插入点，并保持当前策略筛选子集，不能把跨插入点次序宣称为运行顺序。
5. 子弹层打开时由其处理 Escape/焦点，关闭只关闭最上层；抽屉不吞掉 portal 内事件。触发器删除或因窄屏隐藏时，还焦到相邻操作或所在页面标题，不落到 body。模态声明与背景不可操作必须一致。
6. 菜单需显式核对官方 `Menu` 的 `autoFocus`、方向键、Escape和返回焦点；组件复用本身不证明键盘契约满足。Tab顺序按DOM自然顺序，不用正数 tabIndex。

---

## 6. 无障碍验收清单

以下为实现后的验收项，主要来自本轮 `fixing-accessibility` 与 `baseline-ui`。静态源码只能查结构，焦点、对比度、缩放和读屏必须在浏览器验证；勾选需附实测结果：

- [ ] 每个图标按钮有 `aria-label`（当前 `.presetIconButton`、`.dialogClose`、`.tagChipRemove` 需确认）
- [ ] 每个表单控件有可访问名；FormField可向原生子控件传id，MenuSelect等组合控件须验证id实际到达可聚焦DOM，不能仅检查外层label
- [ ] 开关具有本地化可访问名与真实 checked 状态；等价调用点复用官方 `Switch`，禁用原因可读
- [ ] 消除无焦点替代的 `outline: none`（`controls.module.css` 内共 6 处，其中 `:819`、`:840` 未保证 3:1）
- [ ] 交互元素用 `<button>`，不用带 `onClick` 的 `<div>`/`<span>`
- [ ] 非紧急保存/排序结果用单一 `role="status"`（polite）；关键错误就地保留并关联控件，避免每次输入都重复播报
- [ ] 拖拽有键盘和单击替代；筛选/未筛选下都不跨插入点，不使用废弃拖拽 ARIA
- [ ] `prefers-reduced-motion` 覆盖所有位移/缩放（补齐 `presetCard`、`configCard`、`templateModalItem`）
- [ ] 指针目标至少24×24 CSS px（本方案不依赖WCAG 2.5.8的间距例外）；触控优先44×44px，命中区互不重叠，键盘焦点不被sticky条或安全区遮住
- [ ] 普通长文本可换行；卡头截断文本可展开完整阅读，关键说明不藏在 title/hover；代码列若必须保持列宽，局部横向滚动且可键盘访问
- [ ] 数字列使用 `font-variant-numeric: tabular-nums`（当前仅 `pageHeaderMeta code` 使用）
- [ ] 加载文案以省略号结尾（中文用「…」而非「...」）
- [ ] 破坏性操作有可键盘完成的明确确认，含对象名/影响、取消、进行中与失败重试；初始焦点放取消，不以 toast 代替确认
- [ ] 普通文字≥4.5:1，大字≥3:1；必要控件边界/状态图标与焦点提示≥3:1，明暗主题均实测；颜色不是唯一状态通道
- [ ] 表单错误用 aria-invalid + aria-describedby 关联，辅助说明/必填可读；保留原生粘贴和中文输入法组合过程
- [ ] 200%文本放大、等效320 CSS px重排与400%缩放下，内容和主要操作不丢失；导航/代码可局部滚动，页面无双向滚动
- [ ] 关闭浮层后焦点归还有效目标，背景操作不可越过模态；forced-colors下控件与焦点仍可辨

---

## 7. 性能与不变量

**不变量（方案不得触碰）**：

1. 不改动 `preset.yml` 字段、优先级、空值语义、原子写盘与引擎运行时顺序。
2. 不改动 bridge（回环通信）路径、载荷形状与 32MiB/64MiB 上限。
3. 不改动六个官方插入点的语义与 UI 顺序的**非绑定关系**（UI 分组不表示运行时顺序）。
4. 不引入 Tailwind、CSS-in-JS、第二套主题变量、Redux/Zustand、路由库或新测试框架（`docs/ui-architecture.md:25` 已明确）。

**性能约束**：

- 继续用一次 `bootstrap` 聚合首屏请求；模型目录惰性加载。
- 筛选与搜索在客户端完成，不因输入字符增加 bridge 请求。
- 暂不引入虚拟列表；在真实列表规模与输入延迟测量表明存在瓶颈时再评估，不能只用「300项」作为阈值。先检查重复渲染、筛选和不必要请求。
- `useSyncExternalStore` 的 snapshot 必须复用引用；不改用 Context 广播整树。

---

## 8. 实施路线

以下是未来代码实施的四组工作面，不代表本次已实现，也不要求按数字先改CSS。执行优先级为草稿/危险操作/焦点风险 → 可达布局 → 视觉收敛；页面与卡片方案的步骤是相应工作面的细化，不叠加成额外多轮重构。各组独立回归与回滚，依赖关系在实施PLAN明确。沿用用户已授权范围，不人为增加逐波审批。代码交付必须通过 `typecheck`、`lint`、`test`、`build` 与 `git diff --check`；本次仅文档，检查文档差异、引用和一致性。

### Wave 1：设计变量与尺度收敛（CSS 为主，验证布局影响）

范围：`src/client/**/*.module.css`

任务：

- [ ] 验证4个静态未找到定义的变量及候选替换，明暗computed style与对比度通过后再替换（见缺口D），不凭搜索断言等价
- [ ] 排版对齐官方角色（11/12/13/14/16），保留官方控件自身值，关键说明不压到11px
- [ ] 自有圆角收敛到8/12/14/999，官方Button md的18px保留
- [ ] 控件高度收敛（→ 28/32/36 三档）
- [ ] 同用途间距收敛，优先4/8/12/16/24；保留有依据的紧凑6px与宿主控件值；页面水平padding为16px、窄容器12px，卡内按卡片方案
- [ ] 已有交互反馈收敛到fast/默认两档，最长200ms；非必要位移删除
- [ ] 删除装饰性强调色（标题装饰条、渐变分隔线、卡片彩色投影、空状态放射渐变、导航发光下划线）
- [ ] 滚动条改用 `--dsw-alias-scrollbar-*`
- [ ] 以实际动效清单补齐 reduced-motion，不以CSS文件覆盖率代替验证

验收：亮色与暗色下页面层级仍可辨（靠描边）；无 `color-mix(..., var(--dsw-alias-label-brand) ...)` 之类无效声明；`test/client/style-ownership.test.mjs` 通过。

### Wave 2：控件归一到宿主原子

范围：`src/client/ui/`、使用这些控件的 `features/`

任务：

- [ ] 删除 `.switch` 两套自建实现，全部改用官方 `Switch`
- [ ] `.pillButton`/`.primaryPill` 迁移到官方 `Button`（变体映射见 4.1）
- [ ] 标准输入按等价门槛决定是否用官方Input，保留数字草稿、ref与输入法；不强制替换现有原生输入
- [ ] 核实StatusDot到StateDot的状态/动效等价性，仅在成立时迁移
- [ ] 非编辑态胶囊改用官方 `Tag`（8 档 tone）
- [ ] 普通容器使用border或elevation之一；焦点环单独保留，不能被普通描边替代

验收：实际迁移调用者都通过命名/键盘/保存/IME行为检查；确认无调用者后删除重复CSS。运行ui-boundary与host-contract相关测试，不为删尽某个类名而破坏行为。

### Wave 3：层级与信息架构

范围：`app/workspace/`、`app/workbench/`

任务：

- [ ] 亮色层级用间距和border-l2表达；浮层用elevation且border为0
- [ ] 保留六页单一tablist，简化标签装饰，窄容器选中项可见
- [ ] 保留独立工具预览页的显式加载与分组刷新/错误
- [ ] 默认保持920px抽屉，补安全区与短视口操作可达性
- [ ] 复用WorkspaceFrame和共享样式，按页面/卡片容器容量重排，不新增导航元数据

验收：`test/client/workspace-navigation`、`slot-workbench-contract`、`structure-baseline` 通过；窄屏（<760px）无横向溢出。

### Wave 4：状态与交互完善

范围：`features/`、`ui/`

任务：

- [ ] 保存状态可视化（进行中/成功/失败的统一就地表达）
- [ ] 空状态统一（说明 + 主操作，去装饰）
- [ ] 焦点环统一且达标（≥3:1）
- [ ] 指针目标至少24px，触控优先44px且不重叠；验证缩放、焦点遮挡与长文本
- [ ] 数字列启用 `tabular-nums`

验收：键盘全流程可完成（抽屉开→切页→展开卡→编辑→保存→关闭）；reduced-motion 下无位移；`test/client/dialog-focus`、`tab-key`、`anchored-popover` 通过。

---

## 9. 验收与回归

**代码实施后的命令（使用 `D:\App\PowerShell\7\pwsh.exe`，测试必须从隔离目录执行）**：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

**受影响的契约测试**：先保留现有行为断言；只有批准的产品变化才改契约，不能为迁就新DOM删掉回归保护。新分支以最小行为反例验证，不用源码字符串出现与否代替焦点/保存行为。

| 测试 | 影响点 |
|---|---|
| `test/client/style-ownership.test.mjs` | CSS owner、token 使用、0.5px、reduced-motion 断言 |
| `test/client/ui-boundary.test.mjs` | `ui/` 只接收 props/callback 的边界 |
| `test/client/structure-baseline.test.mjs` | 目录与文件清单 |
| `test/client/slot-workbench-contract.test.mjs` | 悬浮入口、抽屉置顶、disposer |
| `test/client/workspace-navigation.test.mjs` | 页面顺序与 tab 键盘模型 |
| `test/client/locale-contract.test.mjs` | 新增/变更的文案键 |
| `test/host-contract.test.mjs` | 已安装宿主服务与组件契约 |

**视觉验收**（隔离 DSH_HOME + 随机端口，不接触运行中的 dsh 服务）：

- 明/暗双主题 × 1440×900 与 2048×1320 两档视口
- 抽屉/卡片实际可用宽度：断点前后各1px，并覆盖760、520、320 CSS px；200%文本和400%浏览器缩放
- `prefers-reduced-motion: reduce` 开启
- 键盘全流程、触控目标、长中文/英文名、长路径、无数据/筛选无结果/失败/只读、forced-colors
- 高风险流程：保存中再编辑、部分成功、切预设失败保留草稿、角色卡/预设导入换组和重试、指令文件冲突重新读取前保护草稿

验收记录附视口与容器宽度、主题、操作步骤、预期/实际、截图或行为断言；未运行的项维持 `[ ]`。本次仅完成方案静态核对，未启动浏览器、未测实际对比度、未执行应用全量测试。

---

## 10. 风险与不做的事

**风险**：

| 风险 | 缓解 |
|---|---|
| 官方 primitives 仍在演进（本轮已安装 `0.1.6-alpha.1`） | 以已安装包类型和host-contract锁定宿主面；源码分支只作辅助，升级后重验 |
| 移除自建控件会打破基于 DOM 结构的断言 | Wave 2 与测试更新同批提交，不跨波 |
| 亮色层级改造依赖描边，可能在低质量屏幕上偏弱 | 用 `border-l2`→`l3` 加深一档兜底，并在真机核对 |
| 多份方案互相覆盖导航/密度/保存规则 | 六页与保存边界以现行架构为准；总稿定共性，页面稿定页面行为，卡片稿定卡内行为；不复制互相矛盾的硬阈值 |

**明确不做**：

- 不引入新的 UI 依赖（图标、动画、状态库）。
- 不使用宿主 DOM 选择器、MutationObserver 或独立 React root。
- 不改引擎、参数、预设写盘与 bridge 载荷。
- 不把 PTC、首轮锚定、router-guide 等可选能力做成界面默认主线。
- 不为了视觉效果改动任何字段默认值或保存语义。

---

## 附录 A：数值证据总表

### A.1 字号分布（12 个 CSS 文件，77 处实测）

| 字号 | 实测处数 | 出现位置（节选） | 处置 |
|---|---|---|---|
| 8px | 1 | `PromptWorkspace.module.css:186`（导航副标签） | 升到 11px 或删除该副标签 |
| 10px | 4 | `PromptWorkspace.module.css:248`（页头代号）等 | 升到 11px |
| 11px | 11 | `controls.module.css:338`、`:458`、`:702`、`:779`、`:780` | 收敛到 `--dsw-font-xxxs-11` |
| 12px | **33**（主力） | 全库最常用档 | 收敛到 `--dsw-font-xxs-12` |
| 13px | 11 | `controls.module.css:186`、`:331`、`:468`、`:777` 等 | 收敛到 `--dsw-font-xs-13` |
| 14px | 7 | `controls.module.css:54`、`:87`、`:227`、`:337` 等 | 收敛到 `--dsw-font-s-14` |
| 15px | 4 | `controls.module.css:449`、`:868`、`PromptWorkspace.module.css:80` | 合并到 14 或 16 |
| 16px | 2 | `PromptWorkspace.module.css:87`、`:264` | 收敛到 `--dsw-font-base-16` |
| 17px | 1 | `controls.module.css:30`（页面主标题） | 收敛到 16px |
| 18px | 2 | `controls.module.css:161`（关闭按钮字形） | 保留（字形尺寸，非排版字号） |
| 20px | 1 | `controls.module.css:865`（空状态字形） | 保留或降到 16px |

**目标：按用途复用11/12/13/14/16px角色**；宿主控件与图标独立，不用总档数作为完成标准。

### A.2 圆角分布（49 处实测，14 档）

| 圆角 | 处数 | 用途 | 处置 |
|---|---|---|---|
| 2px | 1 | 细节内部件 | 并到 8px，或去掉圆角 |
| 6px | 1 | `PromptWorkspace.module.css:173`（导航项上部） | 删除，导航用直角 |
| 7px | 2 | `controls.module.css:499`、`:822` | 并到 8px |
| 8px | 5 | `controls.module.css:569`、`PromptWorkspace.module.css:102` | **保留（控件档）** |
| 9px | 5 | `controls.module.css:814`、`:836`、`:887`、`PromptWorkspace.module.css:76` | 并到 8px |
| 10px | 4 | `controls.module.css:355`、`:679` | 并到 8px |
| 11px | 3 | `controls.module.css:550`、`:862` | 并到 12px |
| 12px | 8 | 卡片主档 | **保留（容器档）** |
| 13px | 1 | `controls.module.css:850` | 并到 12px |
| 14px | 6 | `controls.module.css:130`、`:144`、`:755` | **保留（大容器/浮层档）** |
| 15px | 1 | `controls.module.css:787` | 并到 14px |
| 16px | 1 | 圆形图标容器 | 并到 14px，或改正圆（50% + `corner-shape: round`） |
| 18px | 2 | `controls.module.css:221` | **保留（Button md 胶囊）** |
| 999px | 9 | 胶囊 | **保留**，且必须配 `corner-shape: round` |

**目标：自有表面以8/12/14/999为主**，官方Button md的18px继续保留；不覆写宿主以满足计数。

### A.3 高度与间距分布

| 项 | 实测 | 处置 |
|---|---|---|
| 全部 `height` 声明 | 79 处、32 种取值（含 1/2px 描边与 50–150px 容器高度） | 控件收敛到 28/32/36 三档；容器高度由内容撑开 |
| 22px | 技能排序按钮（`controls.module.css:547`） | 并到28px；图标按钮同样满足命中尺寸与可访问名 |
| 30px | 配置卡操作按钮（`:787`）、`statusCluster` 最小高度（`PromptWorkspace.module.css:95`） | 并到 28 或 32 |
| 32px | 过滤框（`:885`）、批量按钮（`:975`） | **保留（官方 `Input` 档）** |
| 34px | 配置输入（`:811`） | 并到 32px |
| 36px | 主按钮（`:216`） | **保留（官方 `md`）** |
| 38px | 目录输入（`:353`） | 并到 32px |
| 46px | 骨架行（`:989`） | 保留（骨架专用） |
| `gap` | 91 处、14 档；主力 8px(×31)、10px(×12) | 按用途优先4/8/12/16/24；紧凑6px与宿主值按需保留 |
| `padding` 首值 | 40 处、14 档；含 5/7/9/11 等奇数档 | 页面16px、窄容器12px；卡片/控件依各自角色，不强行覆盖为五档 |

**目标：同用途尺度一致，内容可放大与重排。** 档位数量是排查线索，不是验收结果。

---

## 附录 B：官方设计变量速查（宿主 `ui-theme`）

**表面**：`bg-base`、`bg-layer-1/2/3`（亮色同值）、`bg-module-platform`、`bg-overlay`、`bg-multi-select`、`bg-skeleton`、`bg-mask-1/2/3`
**文字**：`label-primary`、`label-secondary`、`label-tertiary`、`label-caption`、`label-dimmed`、`label-primary-foreground`、`label-primary-inverted`、`label-primary-bluish`、`link`
**描边**：`border-l1/l2/l3/l4`、`border-l2-darkmode-thin`、`border-inverted`、`border-inverted2`
**状态**：`state-success-primary/secondary/tertiary`、`state-warn-primary/secondary/tertiary/label`、`state-error-primary/secondary`、`state-business-primary/tertiary`
**按钮**：`button-primary-fill/hover/dimmed`、`button-ghost-active-fill/border/hover`、`button-tool-bar-fill/hover`、`button-contrast-fill`、`button-elevated-fill`、`button-floating-fill/hover`、`button-info-fill/hover`
**交互**：`interactive-bg-hover`、`interactive-bg-active`、`interactive-bg-hover-solid`、`interactive-bg-hover-accent`、`interactive-bg-hover-danger`
**浮层**：`elevation-stroke`、`elevation-panel`、`elevation-prominent`、`elevation-soft`、`elevation-stroke-color`
**排版**：`font-xxxs-11`、`font-xxs-12`、`font-xs-13`、`font-s-14`、`font-base-16`、`font-m-18`、`font-l-20`、`font-xl-24`（各有 `-strong` 变体）
**动效**：`ds-transition-duration`(0.2s)、`-fast`(0.1s)、`-slow`(0.3s)、`ds-ease-in-out`
**字体族**：`dsw-font-family`（系统栈）、`ds-font-family-code`（等宽栈）
**滚动条**：`scrollbar-bg-l1/l2`、`scrollbar-hover-l1/l2`
**其他**：`tooltip-bg`、`markdown-code-block(-banner)`、`markdown-inline-code`、`specific-input-major`、`specific-menu`、`mask-blur`、`corner-shape`(superellipse 1.5)

> 主题切换机制：宿主在 `body[data-ds-dark-theme]` 上覆写同一批变量（`design-platform.css:251`）。插件**不得**自建主题变量或 `:root` 覆盖。

---

## 附录 C：本轮 ui-skills MCP 来源与适用边界

2026-09-17 经 `list_skills` 发现目录、`get_skill` 获取以下原文；路由参考 `ibelick/ui-skills-root`，本轮实质核对限三项。原稿提到的其他技能不算本轮已读取或验证。

| MCP name / 原文 | 本方案采纳 | 项目适配 |
|---|---|---|
| [ibelick/baseline-ui](https://www.ui-skills.com/skills/ibelick/baseline-ui/llms.txt) | 既有primitive优先、空态下一步、就地错误、安全区、固定层级、非必要动效不新增、交互≤200ms | 保留CSS Modules + clsx，不引入Tailwind、tailwind-merge、Motion或Base UI；破坏性确认复用现有已验证宿主/项目能力，不为AlertDialog名称装新库 |
| [ibelick/fixing-accessibility](https://www.ui-skills.com/skills/ibelick/fixing-accessibility/llms.txt) | 可访问名、原生语义、键盘、焦点返回、错误关联、状态播报、非颜色表达 | 不把静态ARIA检查视为读屏/对比度验收；保留项目已验证交互，不机械迁移组件库 |
| [ibelick/fixing-motion-performance](https://www.ui-skills.com/skills/ibelick/fixing-motion-performance/llms.txt) | transform/opacity优先、读写分离、禁止无停止循环、可见性停转、临时will-change | 使用现有CSS；不新增滚动驱动动画、View Transitions或动画依赖 |

数值验收补充参照 WCAG 2.2：目标尺寸 [2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)、重排 [1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)、非文本对比 [1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。44px是本方案触控优选值，不冒充AA统一最低值。约束冲突时遵循用户与仓库权威文档，技能建议不越过宿主API、预设或指令文件边界。

---

## 附录 D：关键证据索引

| 结论 | 证据 |
|---|---|
| 亮色下三层表面同值 | `deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css:156-160` |
| 暗色表面真实分层 | 同文件 `:251-255` |
| 描边四档定义 | 同文件 `:172-176`（亮）/ `:267-271`（暗） |
| 官方字体阶梯 | `ui-theme/src/styles/gradient-shadow-text.css:179-268` |
| 动效三档与 easing | `ui-theme/src/styles/base.css:11-14` |
| 等宽字体栈变量名 | 同文件 `:9`（`--ds-font-family-code`） |
| 全局圆角曲率与退出规则 | `ui-theme/src/styles/corner-shape.css:16-25` |
| 浮层阴影形态 | `ui-theme/src/styles/gradient-shadow-text.css:19`、`:28-34` |
| 官方 Button 几何 | `ui-primitives/src/Button.module.css:4-36` |
| 官方 Input 几何 | `ui-primitives/src/Input.module.css:1-14` |
| 官方 Switch 强制可访问名 | `ui-primitives/src/Switch.tsx:1-2`、`:18-27` |
| 官方 Tag 八档 tone | `ui-primitives/src/Tag.tsx:9-25` |
| 官方 StateDot 五状态 | `ui-primitives/src/StateDot.tsx:1-13` |
| 官方 DisclosureRow 键盘契约 | `ui-primitives/src/DisclosureRow.tsx:55-59`、`:78-82` |
| 项目自建按钮/开关/胶囊/弹窗 | `src/client/ui/controls.module.css:211-248`、`:614-669`、`:692-705`、`:113-147` |
| 项目已正确复用宿主 | `src/client/ui/MenuSelect.tsx:50`、`ToggleRow.tsx:11`、`StatusBadge.tsx:20`、`features/tools/tools.module.css:31` |
| 项目侧未定义变量引用（含官方同样在用的 2 个） | `src/client/ui/controls.module.css:225`、`:457`、`:779`；`src/client/features/prompts/prompts.module.css:117`、`:120`；`src/client/features/tools/tools.module.css:29` |
| 项目焦点处理缺陷 | `src/client/ui/controls.module.css:819`、`:840`、`:509-512` |
| 官方同类设置页的卡片做法（白底 + 描边 + 极淡阴影） | `deepseek-harness/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css:116`、`:122-123` |
| 项目自建滚动条 | `src/client/app/workspace/PromptWorkspace.module.css:216-226` |
| 客户端边界与不变量 | `docs/ui-architecture.md:9-27`、`:480-488` |

---

**交付状态**：本轮完成方案修订，代码实施仍未进行。将来按用户明确授权范围执行Wave并回填验证，不把本文件当作实现完成证明。
