# 共享控件、文案与 UI 验收

## 控件与焦点

普通输入使用 `TextInput`，搜索用 `SearchInput`，操作用 `Button`，单选用 `MenuSelect`，二态用 `Switch`。`ui/` 持有控件尺寸、焦点、禁用、圆角与危险态；业务页只负责排列。正文和 JSON 编辑器使用共享全宽 textarea，保留手动纵向缩放与 `field-sizing: content`。标签列表保留原始数组，回车或失焦新增，输入法组词期间不提交。

- FormField：以非交互的字段名称和 `aria-labelledby` 关联控件，维护说明与错误关联；MenuSelect 转发 id 与 ARIA 到真实触发器，hint 可内联或使用 HintTooltip。名称及名称旁的空白不会聚焦编辑框或打开下拉，控件内部点击和键盘操作保持有效。
- ImportPreviewCard：导入预览卡，展示服务端同源转换报告与有损信息（warning/info/被排除条目各自滚动容器）；导入预览共用。
- CanvasChoice：短列表直接选，长列表与分组选项使用可搜索的原生对话框。模板与目标模块选择复用原生对话框。
- SearchInput：共用搜索输入，保留搜索图标、清空位置和主题焦点环。
- StatusBadge：状态点和文字由同一 tone 驱动。模块卡将启用状态仅显示在开关，不重复显示状态文字；展开指示与名称共同行排列。
- DialogSurface：预设操作的 portal 浮层；ConfirmDialog 复用 DialogSurface 的警告对话、初始焦点与还焦能力。确认按钮沿用 `.pillButton[data-danger]`，取消按钮的 ref 承载初始焦点与 busy 还焦。
- Menu 在定位完成的可见帧聚焦首个可用项，统一处理上下键、Home/End、Escape/Tab、禁用项及焦点恢复。

工作台通过独立包复用宿主视觉 token。[控件样式](../../src/client/ui/controls.module.css)持有实际尺寸，选用紧凑尺寸的短字段仍须在粗指针环境提供至少 44px 高的命中范围；开关命中区域至少 44×44，轨道尺寸保持紧凑。下拉贴合当前选项文字，展开菜单单独容纳全部选项。字段名称不参与控件宽度和点击范围。路径与长值可换行或在可选择的展开区读取。

fieldset 禁用时 MenuSelect 同时拒绝 portal 中的选择。Tooltip 的键盘说明绑定实际聚焦目标，Escape 关闭说明。

菜单失焦通过 `relatedTarget` 识别自身触发器和 portal 条目，跨 portal 的焦点归属在下一帧复核。焦点复核后再卸载菜单，保留真实鼠标的 click。

表单反馈就地显示，字段错误用 `aria-invalid` 和 `aria-describedby` 关联，单一 live region 播报结果。加载保留已有数据，无可呈现数据才显示骨架；保存仅禁用冲突动作。删除及丢弃使用 `ConfirmDialog`，初始焦点落在取消，请求期间防重复，失败保留对话框，关闭还焦。

## Tabs

所有 tablist 遵循自动激活模式：

- 当前 tab 的 tabIndex 为 0，其余为 -1（roving tabIndex）。
- ArrowLeft/ArrowRight 循环移动；Home/End 跳到首尾。
- 选择后把 DOM 焦点移到新 tab。
- tab 拥有稳定 id 与 aria-controls；panel 使用 role=tabpanel 和 aria-labelledby。
- `nextTabIndex()` 持有纯索引逻辑。

## Dialog、表单与排序

- 模板和目标模块选择由 `CanvasChoiceDialog` 调用原生 `showModal()`，搜索框获得初始焦点，支持 Escape、外点关闭和焦点恢复。其余仍使用 `DialogSurface` 的确认与管理操作沿用 portal 和各自的焦点处理。
- 工作台是宿主原生页面，不声明模态语义或圈住整页焦点；必要的业务弹窗仍由共享 DialogSurface 管理焦点循环。
- 弹窗只操作自己的 ref，不查询宿主页面结构。
- 数值输入在提交点解析，草稿期保留字符串，避免输入中间态跳动。
- 规则排序使用支持鼠标和键盘的上移、下移按钮，按钮名称包含方向及目标规则。
- reduced-motion 下关闭平移和过渡；focus-visible 必须清晰。
- 工作台壳限制内容溢出，程序化定位只滚动 canvas；窄侧栏按容器宽度使用单列与自然换行。

## 文案与字段说明

- 用户可见文案统一归 `prompt-tool` 命名空间：zh 常量是唯一事实源，键类型由它派生，en 用 `Record<Key, string>` 强制键集一致；`register` 用官方类型化形式一次注册两种语言。文本量大的 feature 按 `locales.ts` / `locales-params.ts` / `locales-prompts.ts` / `locales-cards.ts` 分区，注册时在 `locales.ts` 合并成同一命名空间，不注册第二套框架。
- 组件树很深，不逐层重建 i18n 上下文：入口组件用注入的 `t`，同一 bind 结果以稳定引用向下传递（页面与卡片按需加 `t` prop）。
- 渲染时才求值（`t('key', params)`），不做模块级缓存；语言切换由 renderer 订阅 locale revision 后整体重渲染跟进。
- 不进字典的内容：provider/model id、文件路径、用户内容、协议 code 与 bridge 错误码；动态拼接用 `{name}` 占位参数。
- 工作台外壳、三个原生入口、模块列表、手动诊断、参数、规则、自定义工具及导入预览使用同一 locale。参数标签按共享键生成 `param.<键>` 词条。用户定义的规则和模块名称保留原值。
- 数据层状态提示仍需按实际调用核对，不以目录归属推定词条已迁移。

- 可见参数名使用简洁简体中文，优先采用 2-6 字的领域名称；不在标签中显示内部键名、英文枚举或括号实现说明。
- 内部键和值、bridge 载荷和 module.yml 保持英文契约；下拉选项通过中文映射展示，未知旧值仍回显原值，不能因汉化丢失编辑能力。
- 布尔参数使用正向短名称，例如「独占」「互斥」「动态运行时上下文」；名称位于开关上方，与输入框和选择框保持相同字段节奏。
- 字段说明统一经 `ui/HintTooltip.tsx`。组件只复用宿主 Tooltip 的视觉 token、内边距、圆角、字号与淡入效果，不调用宿主 Tooltip 的定位实现。
- HintTooltip 通过 `body` portal 与 `position: fixed` 定位：鼠标悬停延迟 500ms 后在指针附近显示并随指针移动；键盘聚焦即时读取控件 `getBoundingClientRect()`，紧邻控件显示（鼠标点击产生的聚焦不锁定说明，失焦后回到悬停延迟）；视口边缘自动翻转或收敛。
- `HintTooltip.module.css` 使用宿主 `--dsw-alias-tooltip-bg` 和静态前景 token，并与宿主尺寸一致；背景混入工作台底色以降低透明度。业务组件不得再使用原生 `title` 或自制 `data-tip` 伪元素。
- 字段错误、只读警告、保存状态和空状态不是帮助说明，继续就地显示，不藏入 Tooltip。

## 样式所有权

共享控件与其 CSS 模块同归 `src/client/ui/`；工作台外壳、层设置及业务 feature 分别持有自己的 CSS Modules。移动控件时一同迁移独占选择器，高频共享形态复用现有 prop。

- 主题颜色只使用 `--dsw-alias-*`；普通控件圆角复用官方 `--dsw-radius-*`，字体、间距和动效由插件共享层持有，不复制宿主静态色板，不写 :root 主题。窗口 chrome 避让继续消费官方布局公开的 `--dsh-*` 几何变量，不读取宿主 DOM。
- feature CSS 不选择宿主 class、id 或页面结构。
- 中性平面边框使用 0.5px；必要的业务浮层用 alias 颜色组合自有阴影，不叠加无意义的中性 border。
- 圆形和胶囊与 corner-shape: round 配对。
- 动画提供 prefers-reduced-motion 分支；不新增组件专用全局滚动条规则。
- 工作台的各面板持有自身间距，避免空容器叠加布局间距。

标题栏及面板几何由宿主持有，工作台填满原生 Slot；业务浮层按[桌面窗口 chrome 契约](../desktop-plugin-contract.md#71-窗口-chrome-让位消费官方-css-变量)让位一次。

## 契约测试

按仓库测试准入判断是否增加常驻用例。规则装配、磁盘写入、Bridge 信任边界、保存冲突和安装分发由其现有核心用例与 `verify:host`、`verify:pack` 覆盖。用例使用最小自建模块，不固定内置模块行为；类型、字段字典、分发内容由各自检查负责。项目命令以 [package.json](../../package.json) 为准，遵循仓库临时目录与隔离 `DSH_HOME` 约定。

### 浏览器验收

自动检查覆盖类型与行为契约。涉及交互或布局时，在隔离的后台浏览器核对桌面及窄容器，验证键盘、焦点恢复、错误状态、减少动态效果和滚动。菜单失焦回归使用原生 pointer 按下与抬起，以覆盖真实 click 的时序。桌面版的专有可用性按目标版本验证。
