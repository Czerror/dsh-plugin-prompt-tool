# 代码审查报告：导入导出与模块化重设计

- **审查日期**：2026-09-18
- **审查基线**：`dev` / `7c01458c9a8fadbcb7bf08ace7352325886b9a17`
- **编程语言**：TypeScript、TSX、JavaScript；数据格式为 YAML、JSON、PNG。
- **审查文件**：22 个核心链路文件，见下文定位与入口清单。
- **代码行数**：上述文件合计 10,053 行；这是涉及文件的总规模，不代表每行均做了同等深度审查。
- **问题总数**：16 项（致命 5 / 严重 5 / 警告 5 / 建议 1）；另列用户要求的格式支持缺口。
- **证据类型**：主线程完成 9 组隔离行为探针；其余结论按静态调用链或待验证项标注。

**本轮交付**：按 `dev-expert/references/code-review.md` 整理文字审查报告与模块化建议，不使用 HTML、Mermaid 或其他可视化报告。

## 审查结论

当前实现已经具备可复用的 ST 转换器、转换报告、合并 ID 映射、角色卡应用逻辑和客户端预览状态机。主要问题在于：输入识别分散在页面与 bridge，安装成功条件没有覆盖真实物化结果，导入、导出和复制对资产及身份的认识不一致。

这不是仅增加 `.png`、`.yml` 文件选择器的问题。已复现的数据风险包括：角色卡重导入删除记忆、原生 JSON 配置丢失、文件夹 PNG 损坏、物化删除正文和其他预设资源，以及导出越过预设根读取文件。

建议围绕四项职责深化现有 module：**资产识别与预览、预设安装提交、角色库更新、可移植预设**。复用现有转换及重建能力，保留预设、角色卡、角色记忆和指令文件各自的所有权；这不预设四个新 module 或四层抽象。

## 一、范围与 Spec 一致性检查

用户目标：审查本项目所有资产导入导出，重设计为可复用、模块化结构；预设导入支持文件夹，以及单文件 JSON、PNG、YML 预设或角色卡。

本轮没有新的实施 Spec；对照用户目标、[AGENTS.md](../../../AGENTS.md)、[CONTEXT.md](../../../CONTEXT.md)、三个 ADR 以及已有权威文档审查。新增格式的细节属于待定需求，不倒推为已有格式承诺。

| Scenario | 结果 | 说明 |
|---|---|---|
| 文件夹作为一个完整预设导入 | 不通过 | 文本附件可入包；PNG 编码不一致，真实物化会丢正文或改错本地模块引用 |
| 单文件原生 JSON 预设导入 | 不通过 | 被送入 ST 转换，`promptConfigs` 静默丢失 |
| ST JSON 预设、角色卡、世界书导入 | 已有支持，存在限制 | 转换、报告和多 JSON 合并已存在；类型不明的 JSON 未拒绝 |
| PNG 角色卡从预设入口导入 | 未实现 | 仅角色管理流式入口可解码 PNG |
| YML/YAML 原生预设导入 | 部分满足 | 已支持，但定义选择、ID 与完整候选校验仍有缺口 |
| YML/YAML 角色卡导入 | 未实现 | 角色库不接纳 YAML；预设入口把 YAML 当原生预设 |
| 所有载体都预览、确认并校验版本 | 不通过 | 预设包及小 JSON 角色卡已有预览；角色库的 PNG、大 JSON 直接入库 |
| 导出后在另一 DSH_HOME 完整还原 | 不通过 | Web 仅导出定义；CLI 来源根漂移；复制身份与定义不一致 |
| 角色卡更新保留长期记忆 | 不通过 | 同 ID 重导入删除 `memory.md` |
| 指令文件与预设分离 | 设计必须保留 | ADR-0003：指令正文与策略不进入预设交换包 |

**已确认的格式决策**：用户选择同时支持 ST 角色数据 YAML 与本项目 `converted.yml` 原生角色片段。这两种形状必须分别识别与校验，不能因扩展名相同混作同一结构。是否要求一个文件打包全部附属资源、完整导出的载体仍待定。

## 二、全部资产入口清单

| 入口 | 当前行为 | 主要位置 |
|---|---|---|
| 预设单文件导入 | `.json/.yml/.yaml`；非 JSON 被改名为 `preset.yml` | [PresetSwitcher.tsx](../../../src/client/features/presets/PresetSwitcher.tsx#L70) |
| 预设文件夹导入 | 整包上传，全部按文本读取；宿主剥离第一层目录 | [PresetSwitcher.tsx](../../../src/client/features/presets/PresetSwitcher.tsx#L81)、[settings-bridge.ts](../../../src/runtime/settings-bridge.ts#L1646) |
| 预设转换与合并 | 原生 YAML；ST 预设、角色卡、世界书 JSON；多个 JSON 合成一份预设 | [sillytavern.ts](../../../src/host/sillytavern.ts#L216) |
| 角色卡库导入 | 小 JSON 逐张预览；PNG、大 JSON 直接流式入库 | [CharactersPage.tsx](../../../src/client/features/characters/CharactersPage.tsx#L99)、[characters.ts](../../../src/host/characters.ts#L415) |
| 角色卡应用、移除 | 合并到当前预设，记录角色及模块来源，按前缀移除 | [characters.ts](../../../src/host/characters.ts#L559) |
| 模型角色工具 | JSON 文本入库、列出、应用、移除、删除 | [character-tools.ts](../../../src/runtime/character-tools.ts#L63) |
| 世界书 | 独立 JSON 或角色卡内嵌数据导入；没有专用文件导出 | [worldbook.ts](../../../src/host/worldbook.ts#L34) |
| 技能复制导入 | 浏览器文件夹 base64、宿主目录；共用覆盖确认与落盘实现 | [skills-import.ts](../../../src/host/skills-import.ts#L176)、[skill-import.ts](../../../src/client/data/skill-import.ts#L7) |
| 正文保存 | `/import-preset` 实际用于已有 `preset.md` 内容保存，不是完整资产包导入 | [use-prompt-tool-store.ts](../../../src/client/data/use-prompt-tool-store.ts#L841) |
| 指令文件保存 | 独立授权、上下文与内容版本校验；不属于预设文件交换 | [ADR-0003](../../../docs/adr/0003-instruction-files-independent.md) |
| 预设复制、新建 | 用户目录复制或包内模板复制；新目录保留原定义 ID | [manifest.ts](../../../src/host/manifest.ts#L384) |
| Web 导出 | 下载 `<id>.preset.yml`，只包含定义正文 | [settings-bridge.ts](../../../src/runtime/settings-bridge.ts#L1891) |
| CLI 导出 | 整目录复制；优先查找旧 `presets` 根 | [export-preset.mjs](../../../scripts/export-preset.mjs#L40) |
| PNG 提取脚本 | 从 PNG 提取角色 JSON，有另一份独立解码实现 | [extract-st-character.mjs](../../../scripts/extract-st-character.mjs#L31) |

未发现角色卡、世界书、技能的专用文件导出入口；这属于现有能力范围，不自动等同必须新增的功能。本报告的“导入导出”指资产交换，不包含 TypeScript 的模块导入导出语法。

## 三、致命问题（必须修复）

### F01：预设物化破坏导入资产，并删除兄弟预设的本地 engine

**位置**：[write-preset.ts:312](../../../src/host/write-preset.ts#L312)、[write-preset.ts:348](../../../src/host/write-preset.ts#L348)、[write-preset.ts:362](../../../src/host/write-preset.ts#L362)、[write-preset.ts:415](../../../src/host/write-preset.ts#L415)；导入调用方为 [index.ts:543](../../../src/index.ts#L543)。

**证据**：已复现，E09。

原代码中的三个关联行为：

```ts
composition.replaceAll('./engine/', '../.engine/')
// 模板文件复制时跳过 preset.md / agents.md。
rmSync(join(presetDir, entry.name, 'engine'), { recursive: true, force: true })
```

**触发**：导入含 `preset.md`、组合引用 `./engine/review.mjs` 的预设，另一个预设含自己的 `engine/keep.mjs`；按实际导入路径使用 `writePreset('', options)`。

**实际结果**：导入正文消失；组合引用变为 `../.engine/review.mjs`，该文件不存在；兄弟预设的 `engine/keep.mjs` 被删除。

**根因与影响**：writer 把所有 `engine/` 都视作插件旧生成物，没有区分用户本地模块与插件共享引擎；导入正文也被运行时空参数替代。影响完整目录导入和后续重建，且跨出本次目标预设。

**修复建议**：集中预设自有资产规则；物化导入预设时读取自身正文，只重写明确属于插件引擎的引用；移除无所有权证据的兄弟目录清理。不得仅在上传端补复制，因为后续重建仍会重复破坏。

**收益与验收**：目录导入、导出再导入、后续保存共享同一份资产事实；真实 writer 测试断言正文和自有模块保留、相对引用有效、兄弟目录逐字节不变。

### F02：同 ID 角色卡重导入删除角色记忆

**位置**：[characters.ts:326](../../../src/host/characters.ts#L326)，`persistCharacterCard()`。

**证据**：已复现，E03。

**原代码事实**：暂存目录仅写 `avatar.png`、`card.json`、`converted.yml`；整目录替换后删除旧备份，没有保留 `memory.md`。

**触发**：先导入 `memory-card.json`，通过 `appendCharacterMemory()` 写入记忆，再导入同 ID 卡片。

**实际结果**：两次导入都成功；第二次完成后 `readCharacterMemory()` 返回空字符串。

**根因与影响**：来源资产和长期角色记忆被当成一个替换所有者。JSON、PNG、大 JSON 以及模型工具共用该写入 module，均受影响。

**修复建议**：在角色库更新事务内保留独立记忆；对旧头像等资产规定保留或替换语义。保护逻辑放在共享持久化位置，不分散到各调用方。

**收益与验收**：所有入口统一保护长期数据；重导入前后记忆字节一致，写入或交换失败时旧目录完整。不能用“用户导入确认”推定用户授权删除角色记忆。

### F03：原生预设 JSON 被成功转换为空配置

**位置**：[settings-bridge.ts:1743](../../../src/runtime/settings-bridge.ts#L1743)、[sillytavern.ts:221](../../../src/host/sillytavern.ts#L221)、[characters.ts:275](../../../src/host/characters.ts#L275)。

**证据**：已复现，E01。

**原代码事实**：无 YAML 定义时，所有 JSON 都进入 `convertStToPresetWithReport(JSON.parse(...))`；转换器没有区分原生预设、ST 资产与无关对象。

**触发**：单 JSON 含 `id`、`modules` 和有效 `promptConfigs[].text`。

**实际结果**：预设导入返回 200，原 `promptConfigs` 正文消失；纯转换结果为零配置，报告未提示这些配置被丢弃。

**根因与影响**：把“可解析为 JSON”等同于“已识别为 ST 格式”。既影响本轮要求的原生 JSON 支持，也会误接纳未知数据。

**修复建议**：先做基于内容的资产判别，再选择原生定义读取或 ST 转换；未知、互相冲突的结构明确拒绝。JSON 与 YAML 的载体解析和预设/角色卡语义识别分开负责。

**收益与验收**：新格式接入不再增加页面分支；同一原生定义用 JSON/YAML 导入后配置一致，未知对象、数组、null 不生成空预设。

### F04：文件夹内 PNG 被按错误编码写盘

**位置**：[PresetSwitcher.tsx:81](../../../src/client/features/presets/PresetSwitcher.tsx#L81)、[import-files.ts:8](../../../src/client/data/import-files.ts#L8)、[settings-bridge.ts:1851](../../../src/runtime/settings-bridge.ts#L1851)。

**证据**：已复现，E02。

**原代码**：

```ts
await flow.run(await readImportFiles(files, 'text'))
// 宿主 PNG 分支：
writeFileSync(dest, Buffer.from(entry.content, 'base64'))
```

**触发与结果**：目录上传携带 PNG，经过真实 `readImportFiles()` 和 bridge 后返回 200，但写入内容与原始字节不相等。

**根因与影响**：传输契约只有字符串，客户端与宿主对字符串编码的理解不同。扩展名不能证明内容使用了哪种编码。

**修复建议**：先修订共享文件载荷契约，明确文本、二进制及其编码，或以统一原始字节表示后在 host 解码。保留文件路径，验证编码及解码后的大小；不能只将所有输入改成 base64 而维持宿主文本分支不变。

**收益与验收**：PNG、非 UTF-8 附件和文本均可保真传递；真实文件输入到落盘的 SHA-256 一致，不再使用纯文本假附件代替二进制测试。

### F05：导出 ID 可越过预设根定位文件

**位置**：[settings-bridge.ts:1898](../../../src/runtime/settings-bridge.ts#L1898)、[manifest.ts:220](../../../src/host/manifest.ts#L220)。

**证据**：已复现，E08；仅读取临时目录中的合成测试文件。

**原代码事实**：导出 ID 只做非空字符串处理；`findPresetDir()` 直接使用 `join(scanDir, template)` 查找 `preset.yml`。

**触发与结果**：合法 loopback 请求传入 `id: '../outside-preset-root'`，收到 200 及预设根之外的合成 `preset.yml` 正文。

**影响限定**：这是已通过 bridge 的本地请求可利用的目标定位缺口。现有 loopback、Host/Origin 检查仍存在；没有证据将其描述为任意互联网请求可读任意文件，当前出口读取的文件名仍是 `preset.yml`。

**修复建议**：共享定位 module 校验合法预设 ID、候选目录身份与根内归属；Web、CLI 复用同一规则。合法 ID 的最小语法条件已存在于 writer：

```ts
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  throw new Error('非法预设 id')
}
```

该片段只表达已有规则的复用，不是完整补丁；还需验证目标根、目录身份及链接处理。

**收益与验收**：导入、导出、复制不会各自接受不同 ID；上跳、绝对路径、盘符及越界目标拒绝，合法预设仍可导出。

## 四、严重问题（建议优先修复）

### F06：复制预设后目录 ID 与定义 ID 不一致

**位置**：[manifest.ts:407](../../../src/host/manifest.ts#L407)、[manifest.ts:439](../../../src/host/manifest.ts#L439)、[settings-bridge.ts:1908](../../../src/runtime/settings-bridge.ts#L1908)。

**证据**：已复现，E07。

**原代码事实**：`cpSync(source, target, ...)` 后直接返回新目录 ID，定义正文原样保留；导出优先返回正文里的旧 ID。

**触发与影响**：`binary` 复制为 `binary-copy`，导出仍含 `id: binary`。导入端按正文 ID 定位，后续再导入将选择原预设。探针已验证身份错误，未实际覆盖真实用户预设。

**修复建议**：复制操作用 YAML Document API 同步新定义身份，保留注释和未知字段；导出前验证目录身份与定义身份一致。测试覆盖“复制 → 导出 → 导入”且来源目录不变。

### F07：导入成功没有包含实际物化成功，失败不能统一恢复

**位置**：[settings-bridge.ts:1833](../../../src/runtime/settings-bridge.ts#L1833)、[settings-bridge.ts:1877](../../../src/runtime/settings-bridge.ts#L1877)、[index.ts:304](../../../src/index.ts#L304)。

**证据**：回调故障已复现，E04；真实入口捕获物化异常只记录告警，经源码确认。

**原代码事实**：先移走旧目录并写入新目标，再校验组合；物化回调在恢复分支之外。入口回调又将异常转换为日志。

**触发与影响**：物化回调抛错后，目标仍含新版定义，旧版留在备份；真实入口可继续回报 200。导入 ID 校验允许中文/大写，writer 仅接受官方小写 ID，也能使两个阶段分歧。

**修复建议**：由预设安装 module 拥有完整候选校验、物化、交换和恢复；明确传播失败，不能将日志当成功结果。将非法 ID、子代理策略等 writer 校验提前纳入候选验证。

**验收**：注入写入、校验、物化、交换失败；断言旧版保留或完整新版安装，失败响应与磁盘一致，恢复失败保留可定位的恢复信息。

### F08：Web 只导出定义，不能恢复带资源的预设

**位置**：[settings-bridge.ts:1900](../../../src/runtime/settings-bridge.ts#L1900)、[PresetSwitcher.tsx:89](../../../src/client/features/presets/PresetSwitcher.tsx#L89)。

**证据**：已复现，E05。

**实际行为**：响应只有 `id/name/content`，content 等于 `preset.yml`；组合、本地模块、正文和图片均未导出。

**影响与范围**：这是当前明确实现的“单文件配置导出”限制；针对完整可移植预设的目标构成缺口，不将其误称为此前已有完整打包能力的回归。

**修复建议**：区分定义导出和完整资产导出，让网页与 CLI 共用资产规则。完整导出的载体需要产品取舍，不能假设任意资源型预设都可塞进一个 YAML。

**验收**：在另一临时 DSH_HOME 导入并真实物化，正文、资源字节、模块引用均可还原；单定义出口对缺少资源的限制明确提示。

### F09：CLI 优先导出旧预设根的同名数据

**位置**：[export-preset.mjs:40](../../../scripts/export-preset.mjs#L40)。

**证据**：已复现，E06。

**原代码事实**：候选顺序为 `$DSH_HOME/presets/<id>`、`$DSH_HOME/.agent-presets/<id>`、包内模板。

**触发与结果**：新旧目录均含 `cli-check/preset.yml`，分别写入 `Current` 与 `Legacy`；CLI 返回成功但导出 `Legacy`。

**修复建议**：复用当前官方根定位与包内模板回退规则，删除本脚本单独维护的旧根优先级。测试在新旧根共存时只选择当前定义。

### F10：多来源合并进入角色库，却只保存第一份来源 JSON

**位置**：[characters.ts:280](../../../src/host/characters.ts#L280)、[characters.ts:285](../../../src/host/characters.ts#L285)、[characters.ts:341](../../../src/host/characters.ts#L341)。

**证据**：静态调用链确认，未运行独立合并往返探针。

**原代码事实**：转换和合并消费全部 JSON，保存来源时却返回 `jsonText: jsons[0].content`。

**触发与影响**：直接 bridge 或导出函数消费者提交多份 JSON 后，库内转换产物包含多来源内容，`card.json` 只代表第一份。正常 UI 逐卡提交，因此不能声称每次 UI 批量导入都丢来源。

**修复建议**：明确多来源导入语义；允许合并时保存完整来源清单，或明确拒绝角色卡库的合并输入并让预设入口负责组合。不得把当前 card.json 宣称为完整无损导出来源。

## 五、警告与建议

### F11［警告］：定义选择依赖文件顺序，附件可能干扰识别

**位置**：[settings-bridge.ts:1704](../../../src/runtime/settings-bridge.ts#L1704)、[settings-bridge.ts:1712](../../../src/runtime/settings-bridge.ts#L1712)。

**证据**：静态确认，待行为验证。

无 `preset.yml` 时按第一个 YAML 选定义，未限定剥离根之后的顶层；嵌套 `assets/notes.yml` 可能先命中。即使已有定义，仍扫描附属 JSON 的 ST 顺序组，可能要求选择一个与预设定义无关的组。

**建议与验收**：统一根判定、唯一候选选择及“哪些文件参与转换”；调换文件顺序后结果一致；无关附件不影响定义，多候选返回明确歧义。

### F12［警告］：载体和文件大小决定是否经过预览

**位置**：[CharactersPage.tsx:99](../../../src/client/features/characters/CharactersPage.tsx#L99)、[bridge-transport.ts:95](../../../src/client/data/bridge-transport.ts#L95)、[settings-bridge.ts:2156](../../../src/runtime/settings-bridge.ts#L2156)。

**证据**：代码及 SillyTavern 文档确认的现有行为，未运行本轮真实浏览器导入测试。

PNG 和大 JSON 直接入库；小 JSON 才展示报告、选择顺序组并校验预览版本。现行文档明确记载这一限制，因此把它列为统一新入口的改造要求。

**建议与验收**：传输方式只改变读取方式，不改变写入时机；沿用现有状态机覆盖流式路径，验证取消零提交、过期拒绝、选组一致和卸载停止后续批次。

### F13［警告］：原生 YAML 卡应用会跳过非 text 配置

**位置**：[characters.ts:559](../../../src/host/characters.ts#L559)、[characters.ts:604](../../../src/host/characters.ts#L604)。

**证据**：静态确认；对新增原生 YAML 卡支持的影响待行为验证。

应用阶段只保留非空 `text`，会跳过仅使用 `texts`、文件来源或控制行为的配置，返回 count 却仍是源数组长度。当前 ST 转换通常生成 text，不能据此声称现有普通 ST 卡均受影响。

**建议与验收**：明确允许的角色卡配置形状，按该契约校验/保留，拒绝不支持能力；返回真实应用数量。测试逐一断言配置 ID、数量和实际注入行为。

### F14［警告］：文件读取阶段未被预设导入生命周期拥有

**位置**：[PresetSwitcher.tsx:74](../../../src/client/features/presets/PresetSwitcher.tsx#L74)、[PresetSwitcher.tsx:84](../../../src/client/features/presets/PresetSwitcher.tsx#L84)、[use-import-preview-flow.ts:109](../../../src/client/data/use-import-preview-flow.ts#L109)。

**证据**：静态确认，待读取失败与并发选择的浏览器验证。

`file.text()` 在进入 flow 之前执行，外层异步任务没有 catch；读取失败不会到统一通知。两次读取并发时，后完成者可能被 `runningRef` 直接忽略。

**建议与验收**：既有导入流程同时拥有读取、忙期、错误与结束，避免每页增加一套守卫。可控延迟和拒绝的 File 输入应验证反馈、互斥及失败后可重试。

### F15［警告］：UI 文档与真实导入流程存在两处漂移

**位置**：[ui-architecture.md:418](../../../docs/ui-architecture.md#L418)、[ui-architecture.md:435](../../../docs/ui-architecture.md#L435)、[SillyTavern.md:271](../../../docs/SillyTavern.md#L271)。

**证据**：文档与代码、既有测试静态对照。

UI 文档称 PNG/JSON 均预览，代码和 SillyTavern 文档说明 PNG/大 JSON 直接写；UI 文档称过期后保留预览，状态机及现有测试实际关闭预览。

**建议与验收**：实施完成后统一描述最终行为；文档不反向覆盖已经验证的事实。更新时同时核对取消、过期、重试和流式用例。

### F16［建议］：PNG 角色卡解析必须保留，客户端完整解析函数未接入当前上传链路

**位置**：[characters.ts:374](../../../src/host/characters.ts#L374)、[character-card.ts:51](../../../src/client/features/characters/character-card.ts#L51)、[extract-st-character.mjs:31](../../../scripts/extract-st-character.mjs#L31)。

**证据**：定义、引用搜索与实际 client/bridge/host 调用链静态核对；经用户指出表述歧义后补充复核。

**能力结论**：PNG 解析是 ST 角色卡导入的必要能力，当前 PNG 导入确实使用了该能力。`character-card.ts` 文件也并非整体未使用。

当前调用事实：

1. [CharactersPage.tsx:107](../../../src/client/features/characters/CharactersPage.tsx#L107) 调用客户端 `isPngSignature()`，识别 PNG 后以 `bridgeUpload(file, file.name)` 上传原始文件。
2. [bridge-client.ts:23](../../../src/client/data/bridge-client.ts#L23) 将原始文件交给 `charactersImportStream`。
3. [settings-bridge.ts:2168](../../../src/runtime/settings-bridge.ts#L2168) 调用 `importCharacterCardFile()`。
4. [characters.ts:448](../../../src/host/characters.ts#L448) 调用宿主 `decodePngCharacterCard()`，提取 ccv3/chara 角色 JSON 并保留原图，再转换及入库。

**“未调用”的限定**：全仓引用搜索仅发现客户端完整解析函数 `parseCharacterCardPng()` 的定义，当前页面没有调用该函数。这个结论仅针对该函数在当前仓库调用链中的接线，不能推导为“PNG 解析未使用”“PNG 导入不需要解析”或“可以删除整个客户端文件”。

**修订后的建议与验收**：撤回直接删除客户端完整解析函数的建议。重设计必须保留 PNG 角色卡的识别、角色数据提取、原图保留、转换与入库，并接入用户要求的预设导入入口。现有 host 解析具备 chunk 越界检查和 16 MiB 解压上限，可作为复用依据；新链路的解析职责及消费者确认、PNG 正常输入与错误输入行为测试完成后，再评估是否合并重复 implementation。本轮不删除任何解析代码。

## 六、可复用、模块化重设计建议

### 6.1 module 的职责与 seam

| Module | 应拥有的规则 | 应复用的 implementation | 可验证的收益 |
|---|---|---|---|
| 资产识别与预览 | 相对文件根、编码、资产类型、来源唯一性、选组、转换报告和目标版本 | ST 转换与合并、host PNG 解码、preview-revision；客户端保留既有预览状态机 | locality：识别集中；leverage：预设页、角色页、工具与 CLI 复用 |
| 预设安装提交 | 候选完整校验、导入物化、身份冲突、暂存、交换、失败恢复 | 现有 writer 与暂存 rename 做法 | 同一个 interface 验证成功条件及失败恢复，不需搭整个 Web handler |
| 角色库更新 | 角色来源与转换产物更新，独立长期记忆的保留 | persistCharacterCard、apply/remove、模块消费者判断 | JSON、PNG、YAML 与模型工具共享保护；不合并成预设所有者 |
| 可移植预设 | 合法 ID、官方根定位、定义与引用资源、复制身份、导出资产清单 | manifest 定位和 YAML Document API | Web、CLI、复制共享一份资产事实；用完整往返验证 |

这些是职责候选，不是要求新增四层抽象或四个类。预设安装和可移植规则可按实际耦合集中在少量 host 文件，避免一个函数一个 module。没有第二个真实 adapter 的扩展点不预设插件注册体系。

**共享方式**：客户端只收集来源与导入目的，host 识别内容并返回报告；确认后由目标 owner 执行提交。预设定义继续物化到官方目录；角色卡先入独立库或按用户明确目的转换成预设。技能保留自己的导入 module，只复用确实相同的字节/路径处理。

### 6.2 格式支持目标

| 来源 | 建议的内容语义 | 必须保证 |
|---|---|---|
| 文件夹 | 唯一预设定义与相对资源；多 JSON 组合沿用既有明确规则 | 根剥离一次、二进制保真、候选歧义明确、资源可物化 |
| 原生 JSON / YAML 预设 | 同一原生定义的不同序列化载体 | 不经过 ST 转换，不丢 promptConfigs、参数、模块和未知字段 |
| ST JSON / YAML 预设 | ST 提示词和顺序表 | 复用既有转换、选组、有损报告；不执行扩展脚本 |
| JSON / YAML 角色卡 | 角色字段，可含人设、开场白、世界书 | 识别为角色卡；去向由用户操作决定，保留独立角色记忆 |
| PNG 角色卡 | 魔数确认后解出 ccv3/chara 数据与原图 | 受限解码、同源预览、目标身份一致、保留图片 |
| 原生 converted.yml 片段 | 用户已确认纳入支持目标 | 明确 text/texts/文件引用/控制规则能力；按原生角色片段识别，不能直接当作任意完整预设 |
| 未知、矛盾或不完整结构 | 返回带来源定位的错误 | 零目标写入，不生成“成功的空预设” |

单文件导入与完整单文件打包是两个要求。完整预设若引用本地模块、图片或正文，需明确如何携带资源；不自动承诺 JSON、PNG、YAML 三种载体均能无损装下任意预设。

### 6.3 取舍与实施顺序

| 方案 | 收益 | 代价 / 未解决项 | 建议 |
|---|---|---|---|
| 仅扩展文件选择器与页面分支 | 改动表面小 | 保留误判、写入分叉及资产损坏，新增格式放大问题 | 不采用 |
| 集中现有 host 规则，复用转换与 UI 流程 | 与已有行为连续，多个真实调用者共用规则 | 要补真实物化和完整往返回归 | 推荐 |
| 新建通用导入导出框架及动态格式 registry | 提供大量扩展点 | 当前格式数量有限，增加 interface 与维护面 | 暂不采用；出现真实外部扩展需求时重评 |

建议顺序：先以最小回归锁定 F01–F07 的数据与定位风险；随后集中内容识别并接入 JSON/PNG/YAML；再统一预览与提交；最后统一导出、复制及跨目录往返。

具体 interface、目标文件拆分及完整修复代码在实施范围选定后落实。此阶段不提供未经验证的整套替换实现，也不以伪代码冒充已修复。若用户指定修复项，按仓库规则归档旧 PLAN 并创建完整新方案。

## 七、验证证据与测试缺口

### 7.1 已执行行为探针

全部探针直接加载当前 `src`，cwd 为 `D:\AI\workspase\_temp`，使用独立临时 `DSH_HOME` 与合成文件。没有修改 DeepSeek Harness，没有停止或重启 DSH。

| 编号 | 检查路径 | 实际断言结果 | 关联 |
|---|---|---|---|
| E01 | 原生 JSON → 转换器 → 预设 bridge | 200；原配置正文不存在 | F03 |
| E02 | File → readImportFiles(text) → 目录 bridge | 200；PNG 原始字节与落盘不同 | F04 |
| E03 | 卡入库 → 追加记忆 → 同 ID 再入库 | 导入成功；记忆变为空 | F02 |
| E04 | 旧预设 → 新包 → 物化回调抛错 | 新目标保留，旧版仅在备份 | F07 |
| E05 | 带组合与 PNG 的预设 → Web 导出 | 仅返回定义正文，无附件 | F08 |
| E06 | 新旧两个根含同 ID → CLI 导出 | 导出旧根 Legacy | F09 |
| E07 | 复制预设 → Web 导出副本 | 返回原 ID binary | F06 |
| E08 | 根外合成 preset.yml → `../` 导出请求 | 返回 200 和根外测试正文 | F05 |
| E09 | 导入形态 options → 真实 writePreset | 丢正文、局部引用错误、兄弟 engine 被删 | F01 |

运行时探针输出的 `reproduced` 原始条目：

```text
原生 PresetSpec JSON 返回 200，原 promptConfigs 文本丢失
文件夹 PNG 经真实 readImportFiles + bridge 后返回 200，字节不一致
角色卡同 id 重导入成功后，原 memory.md 消失
导入后物化回调抛错，目标保留 New，旧目录只留在备份中，未自动回滚
网页导出仅包含 preset.yml，没有已导入的组合与 PNG 附件
CLI 导出同 id 时优先旧 presets 根，忽略当前 .agent-presets 版本
复制 binary 为 binary-copy 后，导出仍携带原 id binary，再导入会选择原目标
export-preset 接受 ../outside-preset-root 并返回预设根外的合成测试文件
真实 writer 物化时删除导入正文、将自有 engine 引用改向不存在的共享文件，并删除兄弟预设 engine
```

这是问题复现成功，不是修复通过。临时探针脚本及其合成 DSH_HOME 已删除，未留下正式回归测试。

### 7.2 证伪与结论限定

- 纯 YAML 且无附属资产的预设可以工作，不足以推翻带资源预设的失败；F01/F04/F08 均使用实际资源反例。
- 首次角色入库没有旧记忆，不会触发 F02；探针明确采用“先有记忆，再重导入”。
- 正常 ST JSON 成功不代表原生 JSON 被识别；F03 明确输入原生 promptConfigs。
- PNG 魔数选择正确不代表目录上传编码正确；F04 使用真实客户端读取函数及服务端写入结果比较。
- loopback 限制仍在，不能推翻已授权通道中的目标路径缺口；F05 只验证该条件下的根外 preset.yml。
- F10–F16 的动态影响未逐项完成探针，保留静态/待验证标签，不算入 9 组行为复现。

### 7.3 必须补齐的正式回归

优先使用既有 Node test runner、临时目录 helper 和浏览器 smoke。围绕稳定 interface 验证行为，不写静态源码字符串测试替代结果断言。

1. 各单文件格式和文件夹，经同一识别 module 得到正确资产类型；未知输入和多定义歧义拒绝。
2. 预览、选组、取消、版本冲突、流式与小文件行为一致；读取失败、页面卸载停止后续提交。
3. 导入 → 真实物化 → 导出 → 换 DSH_HOME 再导入，验证正文、资源字节、相对路径及复制身份。
4. 写入、校验、物化、交换故障与 Windows 回退，验证旧数据及兄弟目录不受损。
5. 角色卡重导入保留记忆；应用/移除保留模块消费者语义；YAML 卡不静默丢 text 之外的合法配置。
6. 现有安全约束继续覆盖路径穿越、类型、体积、PNG 解压上限、目标版本和 loopback/Host/Origin。
7. 若修改共享提示词生成或角色应用，保留主会话、子代理、压缩后 epoch 与 disposer 的既有行为验收。

现有 [preset-package-import.test.mjs](../../../test/host/preset-package-import.test.mjs) 多数用例没有接入真实安装物化回调；[import-smoke.test.mjs](../../../test/client/import-smoke.test.mjs) 的目录附件为文本，不能证明二进制保真。这两处是优先补齐的测试 seam。

实施后仍需从隔离 cwd 执行仓库规定的 typecheck、lint、完整 test、build 和 diff --check。本次仅产出审查文档，未执行这些发布门禁；不能将历史测试通过率作为本轮验证结果。

## 八、Karpathy 建议与审查总结

**Karpathy 建议**：保留必需的 PNG 角色卡解析能力，先核对新旧入口的实际消费者与职责，再评估重复实现合并；不因单个函数当前未接线便直接删除所需功能。复用既有 ST 转换器、报告、世界书工厂及导入状态机；按“一个预设包含什么”“一个角色更新能替换什么”集中规则。无需新增依赖、万能格式 registry、所有领域共用的事务框架或 UI 内第二套转换器。

**整体评分**：不打分。没有可复核的数值评分基准，严重性与行为证据足以表达风险。

**主要风险**：来源识别和资产所有权不统一，使“成功导入/导出”与“数据完整且可运行”脱节。

**优先修复**：F01 物化资产破坏、F02 角色记忆丢失、F05 导出越界；F03/F04/F06/F07 随同导入主链路集中修复。

**应保留**：单一 ST 转换与报告实现、合并目标 ID 映射、世界书工厂、角色模块消费者回退、已有预览版本协议、技能目录导入事务。

### 已知限制与部分失败

- 本报告为审查与重设计建议，未修改功能代码、公共契约、PLAN、生成快照或依赖；发现问题不等于已修复。
- 用户已确认 YAML 同时支持 ST 角色数据与原生 converted.yml 片段；完整导出载体、独立角色卡导出格式及具体修复实施范围尚未定案。
- 未进行完整浏览器导入端到端、真实运行宿主及完整发布门禁；未测性能，不提出已量化性能收益。
- 初版可视化报告已撤回，不作为交付物。清理其浏览器验证目录的命令被自动审批审查拒绝，原因为 `blocked by policy`，未提供更细理由；残留 `D:\AI\workspase\_temp\pt-io-report-browser-20260918` 和 `D:\AI\workspase\_temp\pt-io-report-20260918.png`，未换通道绕过拒绝。

### 收尾报告

📊 完成度: 100%（本轮审查报告转换） | 主线: 已完成 | 产出: 本文件，含 16 项分级结论、9 组复现证据、格式矩阵与 module 建议 | 待办: 实施范围与格式取舍待定；验证临时目录清理受阻 | 下一步: 用户指定修复项后，归档旧 PLAN，生成新方案并落实回归与修复。
