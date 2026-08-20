# Changelog

## [Unreleased]

### 审查修复：官方对照归一（2026-08-20）

- **anchored persona 语义修正（S 级）**：`complete: true`/`includeRuntimeContext: false`（minimal 语义）与 anchored 的 standard 结构（router-first-turn + planning + context-gate）冲突——官方 assemble 的 complete 恢复机制会抑制 plan-mode 段与 router-persona（Flash 路由人设），永久 runtime-context 抑制使 context-gate 晋升后恢复失效；改为 standard 语义（仅 text），实测 plan-mode/router-persona 保留；新增回归断言（module-configs.test.mjs）。
- **参数定义补全**：`firstTurnWord` 从 write-preset 硬编码 `'we'` 改为 `params.firstTurnWord`（默认 we，anchored preset.yml 显式声明）；`allowKinds` 兼容 YAML 数组写法（flow 序列化，原数组会被 String() 破坏为标量）；`loadPresetContent` 回退链按 `resolvePresetDir(template)` 解析（用户预设优先，index.ts 按当前 presetTemplate 读取）；anchored moduleConfigs 显式化 tool-bootstrap `includeSubagents/promoteOn`（与 context-gate 同步）。

- **writePreset 本地文件复制回归修复**：官方格式预设（agent.cordis.yml 引用 `./xxx.mjs` 相对路径模块）生成目录缺本地文件——恢复模板目录本地文件复制（跳过 preset.yml/agent.cordis.yml/preset.md/agents.md），`official-preset.test.mjs` 恢复 demo-local 断言。
- **merged/order 归一收尾**：executor merged 分组键统一 `merged:<position>`（删 mergeGroup 死引用与 `identity.field==='kind'` 死分支，注释 priority→order）；templates 全面 `priority`→`order`、删 `mergeGroup`（merged=同 position 拼接）；LAYER_LABELS/README 文案同步；writePreset 补 guideCustom 时 router-guide `modelScope=all` 覆盖（双实现漂移修复）。
- **双实现删除**：`buildDefaultPromptConfigs`/`buildPromptConfigFiles` 仅测试消费的旧默认四条构造删除，`prompt-configs.test.mjs` 改断言 writePreset 生成目录产物（12 测试改造为 9+1）。
- **存储分层收尾**：删 `seedSettingsOnce`（首次安装不再写 settings 大文本）与 `restoreOriginals` 死端点（客户端零消费，契约 12→11）；applyState 对 settings 空文本不再覆盖生成目录/模板内容；`settingsEntry` 合并为 `currentSource()` 单一组装；删除旧格式兼容 `normalizeFirstTurnText`/`LEGACY_FIRST_TURN_TEXT` 与 onRegistered legacy 迁移。
- **引擎清理**：`ALLOW_KINDS` 引擎默认统一 `[skill-invocation]`（与 context-gate 一致，anchored 显式声明保留）；删 `DEFAULT_BOOTSTRAP_TOOLS` 死常量与 `tools/execute` 空壳监听；`injectedMemo` 加 4096 会话上限；`custom-fallback` firstTurnWord 三元冗余简化；tool-bootstrap `agentBySession.set` 补 session 判空；router-first-turn 子代理放行参数化（`includeSubagents`）；delegation codex/claude 行对齐官方 `backgroundMode: one-shot`；anchored/liangshen preset.yml 的 promptConfigs 内联 params 删除（writer 从顶层 params 注入，单一配置源）。

### 架构重构（2026-08-20）

- 官方格式预设兼容：`.agent-presets/<id>/` 官方用户预设（preset.yml 仅 name/description/order 元数据 + 同目录 agent.cordis.yml）可导入/切换——`loadPresetSpec` id 回退目录名，`loadCompositionText` 无 modules/composition 时回退同目录 agent.cordis.yml；`listPresets`/`resolvePresetDir`/`userPresetsDir` 加入 lib 导出；隔离环境实测导入 liangshen 预设通过（清单可见、渲染 363 行、引擎齐全）；新增 `test/host/official-preset.test.mjs`（子进程隔离验证）。
- 模板审查合并 + instruction-hint 抽象完整化：①重叠合并——130/150 双 instruction-hint 模板合一（删 150，130 注释说明 strategy=instruction-hint 快捷写法等价）；②`createInstructionHintResolver` 支持 `params.text` 自定义提示文本（覆盖 agents-instruction.txt 与动态探测），与 env-facts/skill-catalog 同风格可传参（strategies 与 FILLERS 双路径均传 config）；③清理 130 模板死参数 `params.promoteOn/includeSubagents`（引擎无消费方，晋升语义由顶层 `promotion` 字段驱动）；模板 17→16。
- UI 重组：配置管理统一进工作台——新增「预设和配置」页（`PresetsPage`：预设切换/导入 + 全量提示词配置列表），主设置页（settings.section「提示词工具」）**移除**（PromptSettingsPage 删除，配置列表与预设切换全部并入工作台新页；功能设置的预设切换同步移入）。
- 审查清理：移除「从目录导入」提示词配置功能（与「提示词配置目录」promptConfigsDir 动态引用**功能重叠**——目录导入是静态快照且与源目录脱钩，动态目录更优）——删除 `/import-directory` 端点（契约 13→12）、client `importFromDirectory`/`api` prop 及关联代码；「内置模板」**保留**（六层+placeholder 起始素材，非功能重叠）。
- UI 四项：①模板下拉不再挤压说明（importBar 说明列 `minmax(160px,1fr)`）；②预设切换器组件化（`PresetSwitcher`）——主设置页（提示词配置）与功能设置共用；③**导入预设 = 预设定义**（`preset.yml` 配置文件 或 整个预设文件夹 `webkitdirectory`），bridge `/import-preset-package` 按相对路径写入用户预设目录（路径穿越防护），`listPresets` 合并包内+用户、用户同名覆盖，`resolvePresetDir` 用户优先；契约端点 12→13。修复 Node 26 下 `import()` query 不再强制重载 ESM 的测试失效（preset-defaults 改子进程验证 DSH_HOME 动态性）。
- 参数覆盖随预设隔离：新增生成目录内 `prompt-tool.overrides.yml`（writePreset 原子重建时保留），参数类设置（firstTurnAnchor/guideText/subagentFlash/bootstrapMaxTokens 等 8 项）由 UI 写入 overrides 而非 settings，运行时 `applyParamOverrides` 合并进模板 params；bridge 新增 `/param-overrides`（读+写）；settings.yaml 保持总开关纯净；契约端点 11→12。
- UI 预设切换器：/meta 端点附加可用预设清单（`listPresets()` 扫描 preset/ 目录），功能设置新增「预设模板」下拉（anchored + 官方四套），`store.setPresetTemplate` 写入 settings 并重建生成目录；参数类设置（firstTurnAnchor/guideText/subagentFlash 等）从 settings.yaml 移除，由各预设模板 params 提供默认（settings 仅保留总开关/技能/路径配置，用户环境 1.3KB）。
- 存储分层对齐官方：大文本内容（preset.md/AGENTS.md）移出 settings.yaml → 生成目录文件（writePreset 落盘 `preset.md`/`agents.md`）；settings.yaml 只存小配置（用户环境 10KB→2.1KB，web 打开不再全量传输/解析大字段）；旧 settings 值首启一次性迁移（onRegistered 落盘）；文本来源改为生成目录文件优先 → 模板 content 回退；bridge 新增 `/preset-content`（按需读文件）+ `/import-preset`（导入写入，触发重建）；UI 主设置 preset/agents 区改为「**导入配置文件**」+ 只读预览（不再内嵌编辑大文本）；契约端点 9→11。
- library 合并与差异参数化：删除 17 个与现有模块重复/可合并的 `official-*`（tool-pwsh/tool-fs/planning/compaction/delegation 等 11 个与现有一致、official-filesystem=bootstrap-filesystem、official-delegation 的 `__SUBAGENT_FLASH__` token 对官方预设渲染为空可兼容）；**persona 差异参数化**——persona.yml 收敛为 standard 版（仅 text），anchored/minimal/creative 的差异（text/complete/includeRuntimeContext）由 preset.yml `moduleConfigs` 传递（纯数据可参数化）；`applyModuleConfigs` 支持行无 config 时创建节点；**`!!js` 表达式差异不参数化**（YAML tag 经 preset.yml 解析丢失，代码类差异保留独立文件 official-skill-filesystem-cordis）；保留 official-* 6 个（agent-instructions/tool-bash/tool-skill/tool-presentation/tool-cordis/persistent-shell，现有无对应或内容为本地定制）。
- 官方预设模块化导入：从 deepseek-harness 官方源码拆解 4 个预设为模块——`engine/compositions/library/official-*.yml`（23 个官方模块文件，按行块提取；persona/skill-filesystem 按预设分版本），`preset/{standard,minimal,ptc,creative}/preset.yml` 用 `modules:` 清单声明（官方行 + prompt-tool 本地附加行）由插件拼接；`manifest.loadCompositionText` 保留 `composition: ./xxx.yml` 相对路径能力（通用）；`presetTemplate` 切换即用。
- UI 审查建议落地：S1 自定义引导文本行灰显条件补 `!writePreset`（与输入禁用一致）；S2 Anchored Standard 模块行新增「编辑」按钮——受控聚焦（focusId+focusTick）展开下方配置卡片并滚动到可视区，同 id 重复点击可重触发。
- UI 预设分组：内置消息批配置模块行归类到「Anchored Standard(prompt-tool)」分组，并按实际生效配置**动态生成**（预设模板声明什么显示什么；模块缺失不渲染，切换模板自然跟随）；模块行 label 优先取配置 name。
- 修复 UI/TUI 配置计数显示：settings.promptConfigs 仅是用户覆盖层（默认空），实际生效配置在生成目录 `prompt-configs/`（引擎加载源）——新增 bridge 端点 `/prompt-configs` 返回实际生效配置（client 加载时以其为准并同步保存快照），TUI `status`/`config` 命令同样按生成目录优先；契约端点 8→9。
- 技能中心对齐官方策略（参考 dsh-web-ui skill-explorer）：① `listSkillFolders`/`readSkills` 支持 Windows junction/符号链接跟随（dirent.isDirectory() 对 junction 为 false 会漏扫），`SkillEntry`/`SkillCatalogEntry` 新增 `linked` 标记；② client `load()` 加 `loadSeq` 并发保护（慢的旧请求不覆盖新请求，last-good 保留旧数据）；③ Skills 设置新增「刷新技能列表」手动按钮兜底（watcher 失效场景）。
- 技能扫描收敛到官方规范：只有**含 SKILL.md 的一级子目录**才是技能——`readSkills` 跳过无 SKILL.md 的目录（不再生成"SKILL.md 不可读或不存在"坏条目），`listSkillFolders` 过滤点开头隐藏目录（`.git/.github` 等永远不是 kebab-case 技能名）；SKILL.md 存在但名称非法仍保留 `valid=false + issue` 供一键修复；二级子目录由 SKILL.md 引导链接，不参与扫描。
- 参数命名脱离上游影响：anchor 系列参数按功能含义全面改名——`anchorFirstTurn/anchorCustom/anchorText` → `firstTurnAnchor/firstTurnCustom/firstTurnText`，`anchorBuild/anchorInspect/anchorDeep` → `firstTurnBuild/Inspect/Deep`，`customAnchorWord/anchorWord` → `firstTurnWord`（合并）；策略 `anchor-auto` → `first-turn-anchor`；`anchor-fallback` 兼容别名移除（不再归一化，未知策略 fail loud）；`normalizeAnchorText/LEGACY_ANCHOR_TEXT` → `normalizeFirstTurnText/LEGACY_FIRST_TURN_TEXT`；CSS `.anchorInput` → `.firstTurnInput`。完整迁移（无旧格式兼容层），settings 旧键由用户保存时自然覆盖。保留：`anchored`（模板名）、`near-anchor`（配置 id/枚举值，功能含义已符合）、`matchesAnchorWord`（内部函数，功能含义符合）。
- 单一配置源收敛：preset.yml 新增 `moduleConfigs` 段，引擎组合模块行参数（custom-bash 超时/输出上限、router-first-turn 隐藏段前缀、run-code-env 环境变量白名单、context-gate 晋升语义）从 library 组合文件上收到 preset.yml，改参数只动一个文件；新增 `manifest.renderComposition()`（token 渲染 → 行级 config 合并完整链路）与 `applyModuleConfigs()`；修复 `[mnemon:]` 隐式 map 歧义（统一为 `["mnemon:"]`，消除 yaml 库与 cordis 解析器语义分歧）；新增 `test/host/module-configs.test.mjs` 4 条契约测试。
- 跨端契约单点化：新增 `src/shared/bridge-contract.ts`（`SETTINGS_BRIDGE_PREFIX` + 8 端点常量 + `BridgeErrorPayload`），host 注册与 client 消费共用同一来源，消除双定义；新增 `test/shared/bridge-contract.test.mjs` 契约测试（端点齐全、载荷形状、客户端消费路径）。
- 循环 import 修复：`PromptConfigCard` / `PromptConfigForm` / `Field` 等拆入新文件 `src/client/PromptConfigCard.tsx`，`ValidationErrorEntry` 归位 `prompt-tool-types.ts`，`PromptConfigsEditor ⇄ PromptConfigList` 不再互相引用。
- 常量归位：部署路径/序数常量从 `src/config.ts` 移入新文件 `src/host/paths.ts`，消除 host→config 反向依赖面。
- 死字段清理：client store 删除无消费方的 `deepseekAvailable` / `deepseekError`（`deepseekProviders` 保留，模型服务商下拉仍消费）。
- CSS 收敛：`.sectionActions` 单一化到 `PromptUi.module.css`。
- `parseFrontmatter` / `SkillFrontmatter` 从 `preset-core.ts` 归位到 skills 域新文件 `src/runtime/skills-parse.ts`（lib 入口继续导出，测试兼容）。
- 超长文件拆分：技能目录 watcher 拆入 `src/runtime/skills-watcher.ts`（index.ts 633→~560 行）；settings bridge 传输/解析层拆入 `src/client/prompt-tool-bridge.ts`（store 756→~450 行）。

### 深度重构（dev-expert × code-organizer-dsh-plugin）

- Schema 单一权威：`engine/schema.mjs` 导出 `getEngineMeta()`，settings bridge 新增 `/api/prompt-tool/settings/meta`，客户端枚举改为动态加载。
- UI 编辑面收敛：新增共享 `PromptConfigList`，主设置页与工作台复用同一套校验/保存/移动/复制/删除逻辑。
- 宿主适配层：新增 `src/client/host-surface.ts`，集中全部 DOM 选择器，并优先探测官方 workspace slot。
- `writePreset` 原子化：临时目录 + 整体 rename，失败保留旧生成目录。
- `web-surface` 不再修改同级 profile、不再 `process.exit(0)`，写前保留 `.bak` 备份。
- 技能副本版本化：新增 `skills/manifest.json` 与 `.prompt-tool-manifest.json`，包内技能升级时自动覆盖。
- 技能扫描缓存：新增 `createCachedSkillsReader()`，按 mtime/size 自动失效。
- 删除 `patchToolBootstrap` 死代码。
- `we-fallback` 彻底移除，规范策略名改为 `custom-fallback`；参数 `anchorWord` 改为 `customAnchorWord`，兼容旧参数。
- 锚点/引导策略参数彻底收敛到 `preset/anchored/preset.yml`：`src/config.ts` 默认引导文本改为从 preset 读取，`engine/strategies.mjs` 不再内置重复文案。
- 打包 `files` 移除 `plan.md` / `planv2.md` / `upstream`，纳入 `docs`。
- §7 anchored 预设提取：`anchor-auto / guide-auto / custom-fallback / anchor-fallback` 作为内置引擎策略，参数全部由 `preset/anchored/preset.yml` 单一配置下发；`promptConfigs` 迁到 `preset.yml`；`allowKinds` 参数化为 `__ALLOW_KINDS__`。
- 新增 `presetTemplate` 配置，工作台按模板隐藏 anchored 专属开关，向“模板扩展字段动态渲染”迈进一步。
- 新增静态测试锁定“宿主 CSS 选择器只允许出现在 `host-surface.ts`”，并清理 `sidebar-entry.ts` 中残留的 `[class*="logoRow"]`。
- 新增 settings bridge `/meta` 与 loopback 拒绝测试。
- anchored `buildCordis` 测试从 `test/host/preset-core.test.mjs` 迁移到 `test/presets/anchored/preset-core.test.mjs`。
- 将 `src/engine/` 重命名为 `src/host/`，避免与根目录运行时 `engine/` 混淆。
