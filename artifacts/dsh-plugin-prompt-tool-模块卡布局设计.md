# 模块卡布局设计规格

> 版本：v2（2026-09-17，ui-skills 复核）
> 范围：本项目工作台中的"模块卡"一族——能力卡（`ui/EngineModuleCard.tsx`）、层级配置卡（`features/prompts/PromptConfigCard.tsx`）、通用折叠卡（`ui/CollapsibleCard.tsx`），以及它们共用的卡头、展开区与列表容器。
> 方法：实际调用 ui-skills MCP 的 `get_skill`，读取 `ibelick/baseline-ui`、`ibelick/fixing-accessibility`、`ibelick/fixing-motion-performance`。未调用的技能不列为依据。保留 CSS Modules、现有 `clsx` 和 DSH primitives；不引入 Tailwind、Motion 或另一套 UI 框架。
> 关联文档：[前端设计方案](dsh-plugin-prompt-tool-前端设计方案.md)、[页面设计方案](dsh-plugin-prompt-tool-页面设计方案.md)。本文细化模块卡，领域与交互边界以仓库 `docs/ui-architecture.md`、`CONTEXT.md` 与 `docs/adr/` 下三份 ADR 为准。
> 证据基线：仓库 `0bbe9869dca212e73c9fef5872c6a659861e1930`；已安装 `@deepseek-ai/dsh-client-ui-primitives` 为 `0.1.6-alpha.1`。下文 `ui/`、`features/`、`data/` 路径相对 `src/client/`；官方 API 以安装包 `lib/types/*.d.ts` 与 `lib/index.js` 为准，不把宿主源码存在视为已发布能力。
> 本轮只改进设计文档。源码、浏览器行为、主题对比度和屏幕阅读器体验尚未按本方案实测；验收框保持未完成。

---

## 0. 摘要

**什么是模块卡**：工作台里的一条提示词配置、一项能力模块或一组设置，复用 `.configCard`、`.configHeader`、`.configForm` 呈现。统一外壳、信息层级和交互规则，允许正文按字段数量选择合适布局；不强制所有卡片长成同一张表单。

**一句话诊断**：卡头把多个事实与多项低频操作并排堆放，正文错误在折叠后缺少详情；能力卡还存在虚假展开、过宽数字输入和内部键名噪声。现有两种正文布局可以保留，先修正信息与交互问题。

**设计主张**：

1. **先保语义与数据，再调整视觉**。修正 `compact` 虚假展开、补齐真实展开区关联、明确菜单焦点和删除确认、保留保存与只读边界。
2. **卡头有最小高度，可以增高**。识别、状态与操作各有位置；窄容器、长名称和缩放时允许换行，不牺牲信息和命中面积。排序、复制、删除可收进一个菜单。
3. **关键状态常驻，辅助信息按需展开**。冲突、读取失败、未保存和保存中在折叠态可见；完整名称、注入位置和受众不能只留在 `title` 或无说明的 `+N` 内。
4. **复用现有布局而非新增框架**。提示词表单保留既有网格；少量能力参数使用简单堆叠与受限控件宽度，只有字段密度确实需要时才采用网格。不新增万能 Card、StatusBar 或统一十二列布局 API。

**颜色处理**：`--dsw-alias-label-error` 的运行时可用性不能由静态搜索定论。错误文字与边框优先采用已发布的 `--dsw-alias-state-error-primary`，并在明暗主题验证实际样式与对比度；不宣称等价无副作用（见 1.4）。

---

## 1. 模块卡的解剖与现状

### 1.1 骨架

三种卡共用同一外壳：

```
<article class="configCard [moduleCard] [configCardOpen]">
  <header class="configHeader">        ← 卡头：识别区 + 操作区
  <div class="configForm">             ← 展开区（仅展开时渲染）
</article>
```

证据：`ui/EngineModuleCard.tsx:39-81`、`features/prompts/PromptConfigCard.tsx:78-163`、`ui/CollapsibleCard.tsx:16-27`。

### 1.2 三种卡的实际构成

| | 能力卡 | 层级配置卡 | 通用折叠卡 |
|---|---|---|---|
| 卡头左侧 | 名称 + `layer` 胶囊（`:45`） | 拖拽手柄 ⠿（`:91-100`）+ `id · name` | 标题 |
| 卡头元信息 | `meta` 纯文本，内容为模块键（`EngineModuleList.tsx:140`） | **9 个维度拼成一行**（`:63-76`、`:106`） | `meta` 纯文本 |
| 卡头开关 | `topSwitch`（可选，`:22-29`） | 恒有（`:111-125`） | 无 |
| 卡头按钮 | 删除图标按钮（`:73-74`） | 通常 4 个文字按钮；冲突可加重新读取；确认态再增加 1 个取消按钮（`:126-145`） | 无 |
| 删除确认 | 就地换 2 个按钮（`:66-70`） | 就地换 2 个按钮（`:138-142`） | 无 |
| 折叠 | 有 chevron（`:49`） | 有 chevron（`:108`） | 有 chevron（`:23`） |
| 展开区布局 | **纵向堆叠行**（`EngineParamFields.tsx:53`、`:110`） | **12 列网格 + 六分区**（`PromptConfigForm.tsx:109-215`） | 任意内容 |
| 展开区字段标签 | 中文标签 + **内部英文键名**（`EngineParamFields.tsx:113`） | 只有中文标签 | — |

### 1.3 七处布局问题（均带证据）

#### 问题 1：卡头承载量随数据膨胀，且会折行

配置卡的元信息由多个维度拼接：插入点、策略、填充、位置、合并、层内顺序、分组、文件不可用、文件冲突或未保存/保存中（`PromptConfigCard.tsx:63-76`），最终 `chips.join(' · ')`（`:106`）。加上拖拽手柄、开关与低频按钮，`configHeader` 依赖 `flex-wrap: wrap` 容纳内容（`controls.module.css:765`）。

后果：关键信息与低频操作争抢宽度。需要减少同时可见的操作并明确换行顺序；换行本身是窄屏与缩放所需行为，不能用锁高消除。

#### 问题 2：同一容器内两套展开区布局语言

| | 能力卡 | 配置卡 |
|---|---|---|
| 容器 | `settingRowStack`（`controls.module.css:272-280`） | `configGrid`（`prompts.module.css:34-39`） |
| 排列 | 纵向一列，`align-items: stretch` | 12 列网格 |
| 字段行 | 标签块在上、控件在下、**每行一条 `border-top`**（`:278`） | 标签在上、控件在下、**无分隔线** |
| 控件宽度 | 被 `stretch` 拉满整行 | 由 `span` 决定 |

后果：数字输入被拉得过宽，每个字段的分隔线增加噪声。最小修复是控制输入宽度、统一标签与字段间距；两种布局本身不构成缺陷，不必为视觉一致迁移全部能力卡。

#### 问题 3：能力卡把内部英文键名显示给用户

`EngineParamFields.tsx:113` 渲染 `<small>{param}</small>`，即把 `temperature`、`maxRounds` 这类内部键直接摆在标签下方。这与 `docs/ui-architecture.md:445` 的约定（"不在标签中显示内部键名、英文枚举或括号实现说明"）直接冲突。

#### 问题 4：卡头的操作按钮尺寸与语义不匹配

卡头按钮存在 36px、30px、28px 三种视觉高度。尺寸差异可以服务不同密度，真正需要统一的是用途、焦点反馈与实际命中区域。删除已有 `data-danger`，不能称其与复制完全同权重；低频操作仍占用大量卡头宽度。

#### 问题 5：删除确认导致布局跳动

确认态把 1 个按钮换成 2 个按钮（`EngineModuleCard.tsx:66-70`、`PromptConfigCard.tsx:138-142`），卡头宽度骤变，右侧所有内容左移。因为 `configActions` 有 `margin-left: auto`（`:786`），位移传导到整个操作区。

#### 问题 6：`compact` 卡存在不可见的状态切换

`EngineModuleCard.tsx:37` 定义 `compact = topSwitch !== undefined`；此时不渲染 chevron（`:49`）也不渲染展开区（`:80`），但**折叠按钮仍然渲染**（`:41`）且仍切换 `expanded`。

后果：点击卡头 → `aria-expanded` 从 `false` 变 `true`，屏幕上没有任何变化。屏幕阅读器用户会被告知"已展开"却找不到内容。这是一个无障碍缺陷。

#### 问题 7：错误状态色的可用性存疑

`.configInputError` 与 `.configErrorBox` 使用 `--dsw-alias-label-error`（`prompts.module.css:117`、`:120`），`.toolSurfaceError` 同样（`tools.module.css:29`）。**如果**该变量无效，后果按严重度排序是：

- `.configErrorBox` 的 `border: 1px solid var(--dsw-alias-label-error)` —— 整条边框声明失效，错误框没有边框；
- `.configInputError` 的 `border-color` 失效，校验失败的输入框与正常输入框长得一样；
- `.toolSurfaceError` 的 `color` 失效，错误文字不是默认的红色。

该变量是否有效需实测，证据见 1.4。

### 1.4 错误状态色变量的证据边界

静态证据与运行时结论分开记录。原稿的全仓库/安装主题搜索记录保留为历史记录，本轮没有重跑其全部范围：

| # | 证据及范围 | 核实方式 |
|---|---|---|
| 1 | 原稿记录：宿主仓库全范围搜索未发现定义 | `--dsw-alias-label-error\s*:`；本轮不据此断言所有运行时来源缺失 |
| 2 | 原稿记录：当时已安装宿主主题搜索未发现定义 | `.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme`；版本与路径会随环境变化 |
| 3 | 原稿记录：官方组件也引用该名称 | 官方使用不保证主题定义完整，也不证明本项目计算样式 |
| 4 | 同族"层级词"变量的命名规律明确，**不含语义词** | `ui-theme/src/styles/design-platform.css:201-209`（亮）/ `:296-304`（暗）只有 `caption`/`dimmed`/`primary`/`primary-bluish`/`primary-dimmed`/`primary-foreground`/`primary-inverted`/`secondary`/`tertiary` |
| 5 | 本轮确认：宿主主题文件声明错误语义色 | `--dsw-alias-state-error-primary`（`packages/client/ui-theme/src/styles/design-platform.css:225` 亮 / `:320` 暗） |

**两种可能的解释**：

- **解释 A**：该变量由更上游的主题在运行时注入，只是未随这些包发布（`ui-theme/src/styles/base.css:1-5` 提到部分基础变量 "defined upstream"，即由上游 deepsuite 主题提供）。此时它有效。
- **解释 B**：它是被误用的变量名。此时官方设置页与本项目的错误态**同时**失效。

本轮没有在已认证的 GUI 读取计算样式。旧稿记录的 HTTP 401 只说明当时探测未获授权，不是主题变量缺失的证据，也不代表本轮再次完成了运行时验证。

**处置结论**：这 3 处优先改用语义明确、随主题发布的 `--dsw-alias-state-error-primary`；修改后检查边框、文字、焦点与背景的组合。变量存在不证明对比度合格，两种错误色也未证明相等。不要覆盖原有可见焦点轮廓，颜色之外还需错误文字与字段关联。

> 验证方法：在错误框元素及其继承作用域读取 `getComputedStyle(el).getPropertyValue('--dsw-alias-label-error')`，同时检查获胜声明、`border-top-style`、宽度与实际颜色；在两种主题重复。仅凭边框宽度为 0 或 1px 无法排除其他 CSS 覆盖，不能据此判定变量来源。

---

## 2. 布局设计

### 2.1 目标骨架

```
┌─ 卡头 configHeader ─────────────────── 最小高度，允许增高 ──┐
│ ┌识别区 (可点击展开)──────────────┐ ┌状态┐ ┌操作区────────┐ │
│ │ 配置名称（展开按钮）             │ │状态│ │ [开关] [⋯]  │ │
│ │ 插入点 · 策略；位置/受众按需显示 │ │    │ │             │ │
│ └─────────────────────────────────┘ └────┘ └─────────────┘ │
├─ 状态带 (仅异常时渲染) ──────────────────────────────────────┤
│ ⚠ 文件已在磁盘上被修改，本地草稿未写入。        [重新读取]   │
├─ 展开区 configForm ──────────────────────────────────────────┤
│  注入规则                                      ← 分区标题    │
│  ┌ 提示词表单沿用现有容器网格 ─────────────────────────┐    │
│  │ [配置类型 span3] [消息角色 span2] [插入位置 span3]   │    │
│  │ [合并方式 span2] [顺序 span2] [分组 span6]           │    │
│  └──────────────────────────────────────────────────────┘    │
│  内容                                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [正文 textarea span12]                               │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 卡头：三段式、自适应高度

卡头采用识别、状态、操作三段布局。它们在空间充足时同行；空间不足时元信息先换行，其次操作区另起一行，状态不消失。不要给卡头设置固定 `height`、固定 `max-height` 或截断内容的 `overflow`。

| 区段 | 内容 | 弹性规则 |
|---|---|---|
| **识别区** | 名称与 chevron 组成展开按钮；元信息随名呈现 | `flex: 1 1 auto; min-width: 0`；拖拽手柄与展开按钮为兄弟节点 |
| **状态区** | 至多 1 个状态徽章 | `flex: 0 0 auto` |
| **操作区** | 启用开关 + 一个操作菜单按钮 | `flex: 0 0 auto` |

规格：

| 项 | 值 | 说明 |
|---|---|---|
| 卡头高度 | 单行卡 `min-height: 48px`；双行卡按内容自然增高 | 不因“紧凑”压缩命中尺寸 |
| 卡头内边距 | `8px 12px 8px 14px` | 上下留白随文本增高 |
| 识别区与状态区间距 | 12px | |
| 状态区与操作区间距 | 12px | |
| 名称字号 | 13px / 500 / `--dsw-alias-label-primary` | 官方 `font-xs-strong-13` |
| 胶囊行字号 | 11px | 官方 `font-xxxs-11` |
| 名称过长 | 宽屏允许单行省略；展开区提供可选择、可换行的完整名称和标识 | 不以 `title` 作为唯一读取入口 |

**窄容器与缩放**：用卡片实际可用宽度决定换行，不新增未经测量的 520px 断点。长名称可换行，插入点与异常状态保留；完整次要元信息可放展开区。200% 文本缩放及 320 CSS px 容器下，标题、开关、菜单和错误说明均不裁切、不相互覆盖；长路径使用 `overflow-wrap: anywhere`。是否调整现有 620/720 等断点由实测决定。

实际命中区域目标至少 **24×24 CSS px**（WCAG 2.2 AA 2.5.8 的项目验收目标），触控建议 **44×44 CSS px**。测量按钮、开关和菜单项的真实 hit box，不把 16px 图标或视觉轨道尺寸当作点击区，也不使用会覆盖相邻控件的透明伪元素。

### 2.3 元信息：保留决策信息，避免无意义胶囊

卡头默认用最多 3 个中性事实片段辅助扫描；纯文本已经清楚时不必逐项胶囊化。此数值是视觉预算，不是隐藏关键信息的硬上限：

| 优先级 | 内容 | 呈现 | 颜色 |
|---|---|---|---|
| 1 | 插入点 | 文本或官方 `Tag` | `outline`（默认中性） |
| 2 | 内容策略 | 文本或官方 `Tag` | `outline` |
| 3 | 位置或限定受众 | 用能解释差异的完整短语 | `outline` |
| — | 其余维度（合并/层内顺序/分组/填充） | 在展开区同名字段或只读说明中完整可读 | 中性文字 |
| — | 状态类（文件冲突/保存中/不可读） | **不进胶囊**，走状态徽章与状态带 | 语义色 |

规则：

- 不使用只显示 `+3`、内容只放 `title` 的溢出计数；如确需额外入口，用有明确文字的「配置详情」展开已有正文，不新增第二份详情浮层。
- 非默认受众、异常与只读原因不可因宽度不足静默隐藏。缩放或本地化后允许标签换行，不规定“最多 4 个字”。
- 状态类信息一律离开胶囊行——胶囊是"这是什么配置"的身份描述，不是"现在怎么了"的状态描述。两者混在一起正是当前卡头失控的原因。
- 状态徽章最多 1 个，用现有共享组件 `ui/StatusBadge.tsx`（内部即官方 `Tag`，`StatusBadge.tsx:20`），tone 用 `success`/`warning`/`danger`/`neutral`。

### 2.4 卡头操作：按能力提供开关与菜单

| 操作 | 现状 | 目标 |
|---|---|---|
| 启用/停用 | 自建开关（40×24 与 32×18 两套） | 官方 `Switch`（必填 `label`），常驻操作区最左 |
| 上移 / 下移 | 2 个常驻按钮 | 移入操作菜单仍可点击、键盘触达；复用现有回调，不强加另一套拖拽键盘状态机 |
| 复制 | 1 个常驻按钮 | 移入操作菜单 |
| 删除 | 1 个常驻按钮（就地二次确认） | 移入操作菜单，用**危险色菜单项** |
| 重新读取（文件冲突） | 条件出现的常驻按钮 | 移到**状态带**里（那里才是它该出现的位置） |

配置卡通常显示开关与菜单；没有启停或其他操作的通用卡不凭空增加控件。只有一个删除动作的能力卡可以直接保留有名称的删除按钮，无须再套空菜单。展开按钮不计入低频操作数，不能以“最多两个按钮”为由删除它。

菜单使用已安装的官方 `Menu`，明确 `portal`、`autoFocus` 与受控 `open`；`autoFocus` 默认 **false**，只有显式启用才拥有首项聚焦、方向键导航和 Escape 还焦。危险项设置 `danger: true`，不用跨包 CSS 选择器。触发器使用官方 `Button size="sm" variant="ghost"`，名称为「{名称} 的操作」，声明 `aria-haspopup="menu"` 与 `aria-expanded`。Enter/Space 原生打开；不要在未实现时宣称触发器 ArrowDown 也能打开。菜单选择、Escape、Tab 离开和预设切换的关闭与焦点去向必须在浏览器验证，且 Escape 只关闭最内层浮层。

删除确认：关闭菜单后打开具备警告对话语义的确认面，显示目标名称、影响和取消/删除动作；取消为安全初始焦点，不绑定“任意位置 Enter 即删除”。优先深化已有 `DialogSurface` 与 `useDialogFocus` 的可选 role/描述/初始焦点能力，使该实例提供 `role="alertdialog"`、`aria-modal`、标题及说明关联。当前组件尚不接受这些 props，实施时必须显式补齐和测试，不能写不存在的调用。

已安装 `RiskConfirmation` 实际包裹官方 `Modal`，要求额外的 `acknowledged` 复选框；它不直接提供上述 alertdialog 与既有抽屉焦点管理契约，不因名字相近就替换删卡确认。不要在菜单里再嵌“确认/取消”菜单，也不要同时启用两套焦点陷阱。取消还焦原触发器；删除成功后聚焦下一张卡（无下一张则上一张；列表空则创建入口）；失败保留确认面与就地错误，防止重复提交。

指令文件卡遵守 ADR-0003：文件正文不随预设删除。若没有明确的移除策略操作，隐藏删除/复制项，不能把普通配置删除文案套到磁盘文件。存在 dirty 草稿的「重新读取」会丢弃草稿，也必须先说明并确认；取消保持原文。

### 2.5 展开区：统一字段节奏，保留适合内容的布局

提示词配置保留 `prompts.module.css` 已有 12 列实现及六分区；只有少量参数的能力卡保留堆叠，去掉逐字段分隔线，并限制数字/短枚举的最大宽度。复杂阶段、标签列表和多行内容继续占满可用宽度。不要为此让 `ui/` 导入 feature CSS，或创建通用 span 配置系统。

提示词表单规格（能力卡仅共享间距、标签与控件尺寸）：

| 项 | 值 |
|---|---|
| 列数 | 12 列（`repeat(12, minmax(0, 1fr))`） |
| 间距 | `10px 14px`（行间距 10px、列间距 14px） |
| 响应策略 | 现有代码混用 container 查询及 620/720px viewport fallback；先实测卡片宽度，再修复不生效的窄容器退化，不把 620–960px 六列写成既成事实 |
| 展开区内边距 | `14px 16px` |

**提示词表单宽度参考**（以实际标签与控件可用宽度为准，窄容器全部可退化到一列）：

| 控件类型 | span | 依据 |
|---|---|---|
| 布尔开关（含标签） | 3 | 长标签允许换行，不以“一行四个”为硬要求 |
| 短枚举（官方 `Menu` 单选） | 3 | 现有配置卡用法一致 |
| 紧凑枚举 / 数字 | 2 | 现有 `form.role`、`form.merge`、`form.order` 用法 |
| 中长文本输入 | 6 | 现有 `form.group` 用法 |
| 长文本 / 路径 | 9 | 现有 `form.identity.value` 用法 |
| 多行文本域、列表输入（`TagInput`）、结构化复合控件（阶段编辑器、变量编辑器） | 12 | 占满整行 |

**字段行节奏统一为**（能力卡可继续堆叠，不必替换布局 owner）：

```
┌ 字段 ────────────────┐
│ 标签（12px/500）      │   ← gap 4px
│ [控件]                │
└───────────────────────┘
```

- 字段之间**不用分隔线**，靠网格 `gap` 建立节奏（这正是"更多空间围绕一组，而非组内"的用法）。
- 分隔线只用于**分区之间**（见 2.6）。
- 删除标签下方的内部英文键名（`features/modules/EngineParamFields.tsx:113` 的 `<small>{param}</small>`）；操作帮助走已有 `HintTooltip`。错误、只读原因、保存状态仍内联显示；字段错误用 `aria-invalid` 与 `aria-describedby` 关联。数字输入保留字符串草稿及原校验时机，不因布局改变空值语义。

### 2.6 分区：标题 + 网格

沿用现有 `configSectionTitle`（`controls.module.css:780`）与六分区顺序，规范间距：

| 项 | 值 |
|---|---|
| 分区标题字号 / 字重 | 12px / 500 / `--dsw-alias-label-secondary`（必要时 primary），实测文本对比度 ≥4.5:1 |
| 标题上间距（与上一分区末字段） | 16px |
| 标题下间距（与本分区首行字段） | 8px |
| 首分区标题 | 无上间距、无分隔线 |
| 分区之间 | `0.5px solid var(--dsw-alias-border-l2)`，仅在有分区时 |

间距关系必须满足"**标题离它自己的内容更近**"：16px（上）> 8px（下），当前实现为 `margin: 12px 0 4px` + `padding-top: 10px`（`:780`），实际上下比约 22:14，方向正确，微调即可。

高级元数据继续用原生 `<details>`（`PromptConfigForm.tsx:197-214`），保留可聚焦的 `<summary>` 与完整内容。`open={advancedCount > 0}` 是现有行为，不应泛称“零 JavaScript”：实施时验证用户收起后普通字段更新不会意外重开，不为视觉改造新增第二份展开状态。

### 2.7 状态带

错误与恢复说明位于卡头下方，可换行；普通未保存/保存中用紧邻标题的短状态，不为每次保存插入和删除一整行。折叠不隐藏下列事实：

| 状态 | 触发条件（现有字段） | 呈现 | 操作 |
|---|---|---|---|
| 文件冲突 | `contentConflict === true` | 警告图标 +「磁盘版本已变化，草稿保留」 | 有 dirty 草稿时确认后重新读取；不自动重试覆盖 |
| 文件不可读 | `contentStatus !== undefined && contentStatus !== 'ready'` | 按真实状态显示缺失、超限或不可读 | 重新读取；禁止把失败显示成空正文继续写入 |
| 未保存 | `contentDirty === true` 且未保存中 | 中性「未保存」文字 | 沿用离卡自动保存与列表保存全部 |
| 保存中 | `contentSaving === true` | 中性「保存中」，必要时沿用行内 spinner | 禁用本卡冲突写操作；正文可继续编辑 |
| 状态详情 | `contentMessage !== undefined` | 原样显示可读说明，不只用红色表达 | 不根据消息非空就显示“重试保存” |
| 官方负责人仍在 | `contentOwnerConflict === true` | 「官方指令行仍在，独立来源不注入」 | 信息说明，不标成磁盘冲突，不提供伪修复按钮 |

规格：

- 异常说明按真实状态渲染，正常时不预留空白；错误优先于普通保存反馈，不能遮住冲突与未保存事实。
- 内边距 `8px 14px`，字号 12px，与卡头之间用 `0.5px border-l2` 分隔。
- 同一状态只播报一次。普通异步结果用稳定的 `role="status"` 区域；新发生且阻断操作的错误才用 `role="alert"`。不让徽章、状态带与工作台 notice 重复播报，也不因逐字输入反复播报。
- 操作按钮用官方 `Button size="sm"`。

数据边界：`data/use-prompt-tool-store.ts:205` 中 `contentMessage = draft.error ?? draft.message`，它混合保存错误与读取说明，不能作为独立“保存失败”判定。若实施确需分类重试，先从现有草稿事实透传明确的视图状态，不新增网络请求或解析错误文案。普通失败可沿用现有再次离卡/保存全部重试路径，冲突先解决版本问题。

`PromptConfigCard.tsx:53-59` 当前以 `cardRef.contains(relatedTarget)` 判断离卡。菜单与确认面改为 body portal 后，必须把本卡拥有的浮层纳入逻辑焦点边界；打开本卡操作菜单不应提前提交正文，真正离卡才触发已有保存流程。通过组件自身 ref/回调处理归属，不扫描宿主 DOM；保留保存快照、版本冲突、contextId 与迟到响应保护。

### 2.8 卡片容器与卡间距

| 项 | 现状 | 目标 |
|---|---|---|
| 列表容器 | `configList` gap 10px（`controls.module.css:748`） | 暂保留 10px；只有整页统一密度实测需要时与总方案一起调到 12px |
| 卡片圆角 | 14px（`:755`） | 沿用宿主/总方案选定档位，不仅为整数美观强改 |
| 卡片背景 | `bg-layer-3`（`:756`） | 平面卡保留背景与 `0.5px border-l2`；明暗均验证边界与焦点可见性 |
| 卡片悬停 | 彩色投影 + `translateY(-1px)`（`:760`） | **删除位移与彩色投影**，改为描边由 `border-l2` 加深到 `border-l3` |
| 展开态 | 彩色投影 + accent 边框（`:764`） | 删除投影；仅描边加深 |
| 展开区分隔 | `1px` accent 混色边框 + 顶部渐变（`:796-798`） | `0.5px solid var(--dsw-alias-border-l2)`，无渐变 |

不新增展开高度动画或 `transition: all`，去掉卡片装饰位移、渐变和大面积投影。若保留已有 chevron 反馈，只过渡 `transform`，不超过 200ms，并在 reduced-motion 下关闭。悬停/焦点不改变卡片坐标；展开正文自然推动后续卡片属于正常布局，不承诺“展开后列表位置不变”。菜单与确认面是 elevated surface，使用宿主 elevation，不能额外叠加中性描边；依据宿主 `docs/web-styling.md:24-25`。

---

## 3. 状态与交互

### 3.1 折叠与展开

- 保持"默认折叠、只有创建/定位才自动展开"的既有策略（`docs/ui-architecture.md:408`），这是正确的。
- 名称与 chevron 构成原生按钮，开关、菜单和拖拽手柄必须是兄弟节点，禁止嵌套交互元素。标题层级服从页面，不给每张卡盲目加 `<h3>`。
- `aria-expanded` 与实际显示一致，`aria-controls` 对应稳定且唯一的展开区 id。展开区可保留轻量外壳、折叠时 `hidden`，正文按现有挂载策略处理；不为了补 ARIA 强制挂载全部重型表单。隐藏内容不可进入 Tab 顺序，`compact` 卡没有虚构目标。
- chevron 放在识别区右端还是操作区左端？**放在识别区右端**——它是"展开"这一操作的视觉提示，属于识别区；放进操作区会让用户以为它是第二个按钮。
- `compact` 卡（纯开关卡）**不渲染折叠按钮**，改为静态标题（`<h3>` 或 `<span>`），从根上消除 1.3-问题 6 的不可见状态切换。

### 3.2 启用开关

- 用官方 `Switch`，已发布类型支持 `checked/onChange/label/disabled/title/className`，不假设它支持任意原生输入属性。`label` 为本地化的「启用 {name}」，与可见名称对应。
- 直接写盘开关仅在自身请求未完成或已无写入资格时禁用；仅修改本地草稿、由现有保存队列持久化的开关可继续编辑，不因任何卡保存中冻结整页。只读原因在附近可见，不能只放禁用控件的 hover `title`。未获持久化确认前不伪报已保存。
- 开关结构上位于展开按钮外，不触发展开/折叠；保持文件卡写独立策略、普通卡写预设各自通道。
- system / `writePreset` 关闭等只读边界由既有事实决定；只禁用写操作。仍能展开、阅读、选择与复制文字；只读文本可用 `readOnly` 保持选择能力，其他控件遵循现有 `fieldset` 边界，不把折叠按钮一并禁用。

### 3.3 键盘

| 操作 | 键 | 说明 |
|---|---|---|
| 展开 / 折叠 | `Enter` / `Space` | 识别区按钮原生行为 |
| 列表内移动焦点 | `Tab` / `Shift+Tab` | DOM 顺序与视觉顺序相符；不使用正数 tabIndex |
| 排序替代 | 菜单内「上移 / 下移」+ `Enter` / `Space` | 与点击、拖拽复用同一排序回调；边界禁用并给出原因 |
| 打开操作菜单 | 触发器 `Enter` / `Space` | `autoFocus` 后方向键/Home/End 导航；Tab 离开必须关闭且落在合理控件 |
| 取消菜单 | `Escape` | 只关闭当前菜单，焦点回触发器，外层抽屉仍打开 |
| 危险操作确认 | 聚焦确认按钮后 `Enter` / `Space`；`Escape` 取消 | 使用 2.4 的确认面；无全局 Enter 删除快捷键 |

### 3.4 拖拽

- 保留现有 pointer 拖拽与 `data-drop-before` / `data-drop-after` 落点提示（`PromptConfigCard.tsx:83-85`）。
- 落点提示用 `--dsw-alias-state-business-primary` 的 2px 实线（现有做法正确，保留）。
- 当前已有上移/下移按钮（`PromptConfigCard.tsx:135-136`），所以拖拽并非唯一入口。保留等价按钮/菜单操作即可覆盖键盘和触控，不把没有点击行为的手柄改成假按钮，也不新增已废弃的 `aria-grabbed`。触屏无法 HTML drag 时仍可点击菜单排序。
- 排序后保持当前卡可见且焦点可预测；用单一 polite live region 宣告「{名称} 已移至本插入点第 N 项」。拖拽取消不写入，空列表/单项/首尾边界有确定行为；落点同时有位置线和可读结果，不只靠颜色。
- **顺序是层内顺序**：交互不得暗示跨插入点全局执行先后。上移/下移、拖拽统一受同一插入点与当前策略子集约束；搜索不可让用户无提示地重排不可见条目，应明确当前可排序范围或禁用排序并提示清除搜索。
- **待核实的现有缺口**：`PromptConfigList.tsx:155-182` 在全部视图传 `effectiveLayer=undefined`；`prompt-config-order.ts` 此时按所有层构建视图，未在 helper 中强制同层。不能在方案里写“现有代码已限层”。实施时先补同层、世界书子集、搜索隐藏项与文件策略排序的行为断言，再在共同 owner 修复；不得改六个插入点的运行语义。

---

## 4. 组件映射

| 部件 | 现状 | 目标 | 依据 |
|---|---|---|---|
| 卡容器 | `<article class="configCard">` | 保留，去投影与位移 | 2.8 |
| 卡头 | flex + `flex-wrap` | 有最小高度的三段式，允许增高与换行 | 2.2 |
| 折叠按钮 | 含标题 + chevron | 只包识别区，chevron 归识别区 | 3.1 |
| 插入点/策略元信息 | `configChip` 使用未核实的 `--dsw-alias-label-brand` | 中性文字或官方 `Tag tone="outline"`，不另造品牌色 | 2.3 |
| 次要元信息 | 拼接进卡头长文本 | 展开区完整可读，不新增 `+N` + `title` | 2.3 |
| 状态徽章 | 混在元信息文本里 | 官方 `Tag`（经现有 `StatusBadge`） | 2.3 |
| 启用开关 | 自建 `.switch` 两套（`controls.module.css:614-669`） | 官方 `Switch` | 3.2 |
| 卡片操作 | 多个常驻 `.pillButton`，确认态增多 | 多操作用官方 Button + Menu；单一动作保持直接入口 | 2.4 |
| 删除确认 | 就地换按钮 | 既有 DialogSurface 的受控确认实例，补齐警告对话与唯一焦点 owner | 2.4 |
| 状态带 | 描述仅展开时完整可见 | feature 内复用现有 hint 样式 + 官方 Button；不先建 StatusBar API | 2.7 |
| 字段网格 | 网格 / 堆叠 | 保留各自 owner，统一间距与合理控件宽度 | 2.5 |
| 字段标签 | 中文 + 内部键名 | 仅中文；说明走 `HintTooltip` | 2.5 |
| 展开区分隔 | accent 混色边框 + 渐变 | `0.5px border-l2`，无渐变 | 2.8 |
| 高级元数据 | 原生 `<details>` | **保留**（正确） | 2.6 |
| 拖拽手柄 | `<span aria-hidden draggable>` + 上下移按钮 | 保留补充拖拽；菜单提供点击/键盘替代与结果播报 | 3.4 |
| 错误色 | `--dsw-alias-label-error`（运行时待确认） | 优先 `--dsw-alias-state-error-primary`，验证计算样式与对比度 | 1.4 |

---

## 5. 视觉规格参考（实施时随容器验证）

### 5.1 间距

| 位置 | 值 |
|---|---|
| 卡片之间（列表 gap） | 暂保留 10px；12px 为统一密度候选 |
| 卡头内边距 | `8px 12px 8px 14px`，`min-height: 48px`，自然增高 |
| 识别区 → 状态区 | 12px |
| 状态区 → 操作区 | 12px |
| 卡头 → 状态带 | `0.5px` 分隔线 |
| 状态带内边距 | `8px 14px` |
| 展开区内边距 | `14px 16px` |
| 分区标题上 / 下 | 16px / 8px |
| 字段网格 gap | `10px 14px` |
| 字段标签 → 控件 | 4px |
| 胶囊之间 | 6px |

### 5.2 字号与字重

| 元素 | 字号 / 字重 | token |
|---|---|---|
| 卡片名称 | 13px / 500 | `--dsw-font-xs-strong-13` |
| 胶囊 | 11px / 400 | `--dsw-font-xxxs-11` |
| 分区标题 | 12px / 500 | `--dsw-font-xxs-strong-12` |
| 字段标签 | 12px / 500 | `--dsw-font-xxs-strong-12` |
| 字段值 / 输入 | 12px / 400 | `--dsw-font-xxs-12` |
| 状态带说明 | 12px / 400 | `--dsw-font-xxs-12` |
| 内部标识符（展开区高级项） | 12px 等宽 | `--ds-font-family-code` |

上述字号是参考档位，不是防止换行的上限。通过宿主字体 shorthand/token 使用现有行高，禁止新增负字距压缩标题。正文若在缩放/主题下难读，应提升字号或对比度，而不是缩小到 10–11px 强塞信息；数值顺序等可使用 `font-variant-numeric: tabular-nums`。未测量前不宣称小字号或 tertiary 色满足无障碍。

### 5.3 颜色

| 用途 | token |
|---|---|
| 卡片背景 | `--dsw-alias-bg-layer-3` |
| 展开区背景 | `--dsw-alias-bg-layer-2` |
| 卡片描边（默认 / 悬停 / 展开） | `--dsw-alias-border-l2` → `l3` |
| 分区与状态带分隔 | `--dsw-alias-border-l2` |
| 名称 | `--dsw-alias-label-primary` |
| 胶囊文字 | `--dsw-alias-label-tertiary` |
| 分区标题 | `--dsw-alias-label-secondary`，不足时 primary |
| 落点提示 / 当前项 | `--dsw-alias-state-business-primary` |
| 错误 | `--dsw-alias-state-error-primary` |
| 警告（冲突） | `--dsw-alias-state-warn-primary` |

### 5.4 形状

| 元素 | 圆角 |
|---|---|
| 卡片 | 沿用当前 14px；总方案经验证选定其他档位时同步 |
| 展开区内的输入 / 选择器 | 原生输入按现有档位；官方选择器继承官方外观 |
| 胶囊 / 开关 | 官方 primitive 的圆角；自有圆形元素配 `corner-shape: round` |

---

## 6. 可执行验收清单

本轮文档复核不勾选以下实现验收。用现有浏览器 helper 建立最小确定性行为回归，不用源码字符串匹配替代焦点、保存或排序断言。

| 范围 | 操作/样本 | 通过条件 |
|---|---|---|
| [ ] 重排与缩放 | 320/480/620/720/960 CSS px 卡容器；200% 文本缩放；1280px 浏览器 400% 缩放 | 无页面级横向滚动、裁切、重叠；操作可见可点；长名称/路径与中英文文案可完整读取 |
| [ ] 实际命中区 | 量取折叠、开关、菜单、菜单项、确认按钮的 rect，并点击边缘 | 普通目标至少 24×24 CSS px；触控布局建议 44×44；不覆盖相邻目标 |
| [ ] 折叠语义 | Tab 到普通卡并 Enter/Space；点击 compact 卡标题 | 普通卡 aria-expanded 与面板显示一致、aria-controls 指向唯一节点；compact 标题不可虚假展开；折叠内容不参与 Tab |
| [ ] 菜单与嵌套浮层 | 从卡头打开菜单，方向键/Home/End、Escape、Tab；滚动至视口底部再打开 | 首项聚焦、禁用项不执行、退出还焦/顺序合理；Escape 只关菜单；菜单不裁切、不超出可用高度 |
| [ ] 删除确认 | 对不同名称卡执行取消、确认、失败重试、连点 | 明确目标/影响；取消为初始焦点；一次操作至多一次提交；取消不删；失败保留；成功聚焦邻卡或创建入口 |
| [ ] 指令文件丢弃保护 | 编辑正文后制造版本冲突，点击重新读取再取消/确认 | 取消保留全部草稿；确认后才采纳磁盘内容；读取失败不是空文件；不删除磁盘指令文件 |
| [ ] portal 与自动保存 | 编辑文件，焦点依次进本卡菜单、取消确认、下一张卡；保存期间继续输入 | 卡自身浮层转移不提前写盘；真正离卡复用原保存；只确认请求快照，新输入仍 dirty |
| [ ] 状态与失败 | 折叠卡制造 ready/missing/unreadable、dirty/saving、409、普通失败、负责人冲突 | 折叠仍见真实状态与适用恢复入口；负责人事实不冒充磁盘冲突；contentMessage 不被一概判为保存失败 |
| [ ] 只读与加载 | system、关闭 writePreset、切换预设/上下文、保存中 | 只禁用无资格/冲突写操作；仍能展开阅读；迟到响应不覆盖新上下文；不可读值不降级成可写空值 |
| [ ] 排序 | 同层至少 3 项含不同 order；另一层 1 项；世界书/搜索隐藏项；首尾/单项/取消拖拽 | 拖拽与菜单结果一致；只动允许子集，不跨层；保存后 order/声明位置按既有领域契约一致；焦点保留且只播报一次 |
| [ ] 字段与详情 | 键盘编辑数字中间态、未知枚举、完整名称、details；制造校验错误 | 草稿/默认/未知值不丢；数字控件不过宽；错误紧邻字段且 aria-invalid/describedby 有效；无内部键名常驻噪声 |
| [ ] 主题与焦点 | 明/暗主题、默认/hover/focus/error/disabled，读取计算样式与截图 | 普通文本目标对比度 ≥4.5:1、大字 ≥3:1；识别所需非文本控件/状态边界 ≥3:1；键盘焦点可见且不被卡片裁切；token 存在不等于通过 |
| [ ] 运动与性能 | reduced-motion、展开/收起、列表 hover、长列表编辑一字段 | 无新增高度/布局动画；hover 不位移；展开自然推动后续卡；不新增轮询、持续 will-change 或整表单重挂载 |

记录浏览器与版本、视口/容器尺寸、主题、缩放、键盘或屏幕阅读器、实际值及截图位置。没有运行的项目明确写“未实测”，不以全量单元测试通过替代以上体验验收。

---

## 7. 实施顺序

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 修正 compact 虚假展开、面板关联、字段错误与只读折叠边界 | 高优先级；最小 DOM 行为回归 |
| 2 | 确认删除/丢弃草稿契约；验证 portal 与离卡保存、焦点归属 | 高优先级；数据与焦点风险 |
| 3 | 多操作收进官方 Menu，显式 autoFocus；保留排序替代与边界 | 中；先补菜单与层内排序行为测试 |
| 4 | 状态说明在折叠态可见，区分读取/保存/负责人事实 | 中；不改草稿池与写入通道 |
| 5 | 卡头自适应、长名称与控件宽度、去内部键名 | 中；验证窄容器与缩放 |
| 6 | 去装饰、语义错误色、实际对比度与命中尺寸 | 低至中；以浏览器结果决定密度与 token 取舍 |

获得源码实施任务后，按仓库规则归档旧 PLAN、写明本轮范围/验证/回滚，再逐步执行；每步运行受影响的最小回归，最终执行完整门禁。文档本轮无需构建，以下命令属于后续实施验收，在 PowerShell 7 中运行：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

契约入口：`test/client/style-ownership.test.mjs`、`ui-boundary.test.mjs`、`locale-contract.test.mjs`、`slot-workbench-contract.test.mjs`；行为入口：`test/client/prompt-config-order.test.mjs`、`dialog-focus.test.mjs`、`instruction-drafts.test.mjs`、`instruction-save-flow.test.mjs`。真实 DOM 路径复用 `test/client/module-creation-browser.test.mjs` 等现有浏览器 helper；不因文档增补而新装测试框架。

回滚以单步骤差异为单位恢复 UI，不回滚/覆写用户文件或草稿。测试与脚本 cwd 均为 `D:\AI\workspase\_temp`；浏览器 smoke 使用独立 DSH_HOME 和随机端口，不停止、重启现有 DSH。

---

## 附录：证据索引

| 结论 | 证据 |
|---|---|
| 三种卡共用外壳 | `ui/EngineModuleCard.tsx:39`、`features/prompts/PromptConfigCard.tsx:81`、`ui/CollapsibleCard.tsx:16` |
| 配置卡元信息为多维拼接 | `features/prompts/PromptConfigCard.tsx:63-76`、`:106` |
| 配置卡常态 4 项操作，冲突/确认增多 | `features/prompts/PromptConfigCard.tsx:126-146` |
| 卡头 flex-wrap | `controls.module.css:765` |
| 能力卡展开区纵向堆叠 + 分隔线 | `controls.module.css:272-280`、`EngineParamFields.tsx:53`、`:110` |
| 配置卡展开区 12 列网格 | `prompts.module.css:34-39`、`:41-54` |
| 能力卡显示内部键名 | `EngineParamFields.tsx:113` |
| 与文档约定冲突 | `docs/ui-architecture.md:445` |
| 卡头按钮三种高度 | `controls.module.css:216`、`:787`、`:486-492` |
| `compact` 卡不可见状态切换 | `EngineModuleCard.tsx:37`、`:41`、`:49`、`:80` |
| 三处错误色引用需验证 | `features/prompts/prompts.module.css:117`、`:120`、`features/tools/tools.module.css:29` |
| 宿主语义色正确名称 | `design-platform.css:225`（亮）、`:320`（暗） |
| 宿主文字色命名规律 | `design-platform.css:201-209` |
| 官方 Switch 必填 label、控件 API 范围 | 安装包 `lib/types/Switch.d.ts`；项目用例 `ui/ToggleRow.tsx` |
| 官方 Menu 需要显式 autoFocus、支持 danger | 安装包 `lib/types/Menu.d.ts`；`lib/index.js:1845` |
| RiskConfirmation 依赖 Modal 与确认复选框 | 安装包 `lib/types/RiskConfirmation.d.ts`、`lib/index.js:2514` |
| DialogSurface 现有 role/焦点 owner | `ui/DialogSurface.tsx`、`ui/dialog-focus.ts` |
| 拖拽手柄对屏幕阅读器不可见 | `PromptConfigCard.tsx:93-98` |
| 落点提示用语义色（正确） | `controls.module.css:762-763` |
| 高级元数据用原生 details（正确） | `PromptConfigForm.tsx:197-214` |
| 展开区混合 container / viewport 规则 | `features/prompts/prompts.module.css:31-33`、`:81-116` |
| 全部视图层内排序待核对 | `features/prompts/PromptConfigList.tsx:155-182`、`features/prompts/prompt-config-order.ts` |
| contentMessage 混合 error 与读取 message | `data/use-prompt-tool-store.ts:205`；`data/instruction-drafts.ts` |
| 指令卡 portal 焦点与离卡保存风险 | `features/prompts/PromptConfigCard.tsx:53-59` |
| 注入层独立、指令文件不归预设 | `docs/adr/0002-insertion-points-remain-independent.md`、`0003-instruction-files-independent.md` |

### ui-skills MCP 复核来源

2026-09-17 实际调用 `mcp__ui_skills__get_skill`，参数与落地如下：

| discovery name | 采用的约束 | 本文落位 |
|---|---|---|
| `ibelick/baseline-ui` | 既有 primitives 优先、危险动作确认、错误就地显示、不新增动画/渐变 | 2.4、2.7、2.8 |
| `ibelick/fixing-accessibility` | 原生按钮、可访问名、展开关联、键盘与焦点、错误关联、对比度 | 2.2、2.4、3、6 |
| `ibelick/fixing-motion-performance` | 不动画大面积布局、避免持续 will-change、保留既有技术栈 | 2.8、6 |

这些技能给出审查约束，不证明已安装 primitive 自动满足全部要求。`baseline-ui` 的 Tailwind/Motion 建议不适用于本仓库既有 CSS Modules 与无新增动画任务；遵循其“优先现有 primitives”及 accessibility 的“不迁移 UI 库”要求。WCAG 数值作为实现验收目标，需实际测量，不能当作 MCP 已出具合规认证。

---

**文档结束**。本文只定义布局规格，不含实施授权；实施时按第 7 章逐步推进，每步独立可回滚。
