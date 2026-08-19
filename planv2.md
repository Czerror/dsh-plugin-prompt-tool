# planv2.md — 架构审查结论与演进计划(dsh-plugin-prompt-tool)

> 状态:现行计划,取代已过期的 `plan.md`。
> 日期:2026-08-20(深度重构后更新)
> 审查基础:全量勘察 `plan.md`、`docs/architecture-v4.md`、`README.md`、`src/`(含 `client/`、`runtime/`)、`engine/`、`preset/anchored/`、`templates/`、`skills/` 与全部测试;`pnpm test` 156 项全部通过。
> 范围:架构、数据流、UI 与测试。模型安全边界的测试技能内容按测试者要求不在本文件讨论范围。

---

## 0. 结论先行

项目架构主线健康:单一引擎接线六层注入、三源合并、配置即状态、失败降级不伤会话、持久事件幂等,这些核心决策全部成立,且测试覆盖扎实。

截至 2026-08-20,深度重构已落地大部分 P1/P2 债务:
- ✅ P1-1 schema 单一权威 + `/meta`
- ✅ P1-2 引擎拆分
- 🟡 P1-3 HostSurfaceAdapter 已建立并优先探测官方 slot,selector 兜底仍在使用
- ✅ P1-4 双编辑面收敛为共享 `PromptConfigList`
- ✅ P2-1 双 YAML 解析器一致性
- ✅ P2-2 技能版本化迁移
- ✅ P2-3 技能扫描缓存
- ✅ P2-4 `writePreset` 原子化
- ✅ P2-5 `web-surface` 去 `process.exit` / 同级 profile 修改
- 🟡 P2-6 测试缺口大部分补齐(settings bridge 已补)

§7 anchored 预设提取与 `customStrategyDir` 已打通;后续增强项为 C6 完整字段拆分、工作台视觉重构与合成 DOM 测试。

---

## 1. 总体评价:保留并强化的架构决策

| 决策 | 评价 |
|---|---|
| `prompt-config-engine.mjs` 作为唯一执行器 + 六层接线 | 单一执行点,降级语义统一,收敛方向正确 |
| 内容与执行分离(yml 配置目录 + settings 数组三源合并) | 数据层可整体替换,`默认四条 < promptConfigsDir < settings.promptConfigs` 合并规则清晰 |
| 持久事件幂等(`source.plugin/kind` 匹配) | 重启/插件重载不重复注入,比进程内 memo 可靠 |
| 单条失败跳过 + `warnOnce`;配置错误挂载期 fail loud | 分级失败语义合理,不伤会话 |
| vendored yaml 进生成目录 | 生成 preset 运行时零外部依赖,方向正确 |
| settings bridge loopback-only + revision 乐观锁 + body 上限 | 本地工具边界清晰 |
| 156 项单测覆盖引擎/渲染/合并/模板/TUI/宿主自愈/写入原子性/选择器集中/settings bridge | 回归保护充足,保持这个标准 |

---

## 2. 问题与债务清单

### P1-1 Schema/枚举存在三处平行真相,必然漂移

> 状态:✅ 已完成。`engine/schema.mjs` 导出 `getEngineMeta()`,settings bridge 新增 `/meta`,客户端已动态加载并删除硬编码枚举。

同一份 schema 当前在四处独立维护:

1. 引擎 `engine/prompt-config-engine.mjs` 的 `KNOWN_*` 集合(权威);
2. `src/prompt-configs.ts` 的 `PromptConfigSpec` TS 接口;
3. `src/client/PromptConfigsEditor.tsx` 的 `LAYERS / STRATEGIES / FILLS / LAYER_FIELD_POLICIES` 硬编码;
4. `README.md` 层能力矩阵与 `promptConfigs.template.yml` 注释。

**方案**:引擎导出 `KNOWN_*` 与层能力矩阵作为唯一权威;settings bridge 新增 `/meta` 端点下发枚举与能力矩阵;客户端表单动态渲染,删除硬编码常量;`PromptConfigSpec` 类型与"模板即合法配置"测试均从该权威生成或校验。

### P1-2 引擎 1254 行单文件,职责过载

> 状态:✅ 已完成。已拆为 `schema.mjs / strategies.mjs / fillers.mjs / layers.mjs / executor.mjs`,`prompt-config-engine.mjs` 仅装配入口;生成目录与源码逐字节一致测试已补。

`prompt-config-engine.mjs` 同时承担 YAML 加载、schema 归一化校验、五种策略 resolver、三个 filler、六层接线、pre-step 合并/插入执行器。

**方案**:拆为 `schema.mjs / strategies.mjs / fillers.mjs / layers.mjs / executor.mjs`,`prompt-config-engine.mjs` 只做装配入口。同步修改 `preset-write.ts` 的 `ENGINE_SCRIPTS` 复制清单;新增"生成目录文件与源码逐字节一致"的测试断言,防止两处漂移。

### P1-3 客户端用 DOM 选择器挂载,违反"只用官方 API"约束

> 状态:🟡 部分完成。已新增 `src/client/host-surface.ts` 集中所有选择器,并优先探测 `[data-dsh-workspace-slot]` 官方挂载点;selector 兜底仍在使用,合成 DOM 测试仍未落地。

`workspace-mount.tsx` / `sidebar-entry.ts` 依赖 `[class*="centerCol"]`、`[class*="sidebarCol"]`、`[class*="newSession"]` 等宿主 CSS 类名 + 全局 `MutationObserver` 自愈。宿主 UI 一次改版即失效。

**方案**:

- 优先使用官方 slots/入口 API;
- 把所有 selector 收敛进一个 `HostSurfaceAdapter` 接口,集中维护、功能检测、失败降级(入口挂不上时仅设置页可用);
- 补合成 DOM 集成测试,锁定当前宿主版本行为,宿主升级时测试先行暴露断裂点。

### P1-4 两个 UI 编辑面重复实现

> 状态:✅ 已完成。新增共享 `PromptConfigList`,主设置页与工作台统一使用;移动语义统一为同层内移动。注意:原工作台 per-config 分页导航被简化,如需保留可后续在共享组件上加回 `focusedId` 受控模式。

主设置页 `PromptConfigsEditor` 与工作台 `LayerConfigList` 各写一遍列表、表单、校验、保存、脏检测,且移动语义不一致(一个按整数组顺序、一个按层内顺序)。

**方案**:收敛为一套 `configEditorStore` + 共享编辑组件,两个页面只做容器与导航差异;移动语义统一为"层内重排 + order 值同步",避免两种排序模型并存。

### P2-1 双 YAML 解析器

> 状态:✅ 已完成。vendor 版本/来源已记录,`sync:yaml` 脚本存在,双解析器语料一致性测试已补。

`src/` 用 npm `yaml@^2.9`,`engine` 用 vendored 副本。运行时 vendor 是正确决策,但需要:

- 在 vendor 目录记录版本与来源;
- 提供与 `sync:anchored` 同级的升级脚本;
- 加"两解析器行为一致"语料测试(渲染-校验路径与运行时路径不得有语义差)。

### P2-2 技能副本"只补缺失、绝不覆盖"导致技能无法升级

> 状态:✅ 已完成。新增 `skills/manifest.json` 与 `.prompt-tool-manifest.json`,按版本迁移;UI“恢复默认技能”动作仍未做,可列为后续增强。

`profile-skills.ts` 的 `mergeMissing` 使包内 `SKILL.md` 更新永远无法到达已有副本的用户。

**方案**:技能包携带 manifest 版本号,副本按版本迁移;UI 提供"恢复默认技能"动作;删除任何技能时提供显式清理策略,避免旧副本残留。

### P2-3 技能扫描无缓存

> 状态:✅ 已完成。新增 `createCachedSkillsReader()`,按目录 + SKILL.md mtime/size 签名失效;`invalidateSkills` 与目录切换联动。

`list` / `get` 每次同步 `readdir + readFile` 整个技能目录。

**方案**:mtime/stat 失效的进程内缓存;`invalidateSkills` 与目录切换联动失效;单次 `list` 与随后 `get` 复用同一次扫描结果。

### P2-4 `writePreset` 非原子

> 状态:✅ 已完成。改为临时目录 + 整体 rename,失败保留旧目录;生成目录与源码逐字节一致测试已补。跨进程并发锁仍未实现,建议文档标注边界。

`rmSync + mkdir + 逐文件写`,中途崩溃留下不完整生成目录;跨进程并发无锁。

**方案**:写临时目录后整体 `rename`;至少文档标注"同一 DSH_HOME 多实例并发保存"的边界;失败路径保留上一份可用生成目录。

### P2-5 `ensureWebSurface` 越界 + `process.exit(0)`

> 状态:✅ 已完成。已删除同级 profile 修改与 `process.exit(0)`,写前保留 `.bak` 备份;测试已覆盖。

插件运行时改写 profile `package.json`(含同级 `web` / `dsh-tui` profile),首次自愈后主动退出进程。库代码主动 `exit` 是设计坏味道。

**方案**:当前 profile 补 bundle 的自愈保留;移除同级 profile 改写与 `process.exit`,改为提示文案让用户重启;写入前备份 manifest。

### P2-6 测试缺口

> 状态:🟡 大部分完成。已补 `web-surface`、`profile-skills`、`writePreset`、引擎 `/meta`、settings bridge、选择器集中等测试;`workspace-mount` / `sidebar-entry` 合成 DOM 测试仍未覆盖。

`web-surface.ts`、`workspace-mount` / `sidebar-entry`、`profile-skills`、settings bridge 真实 HTTP 层无集成覆盖。

**方案**:按 fixture Context + 合成 DOM + 临时目录补冒烟测试;P1-3 的 `HostSurfaceAdapter` 先落测试后落实现。

---

## 3. UI 架构意见(依据 `web ui` 技能标准)

当前 `PromptWorkspace.tsx` + 两个 CSS module 功能完整,但视觉仍是"通用设置列表",未把"注入控制台"概念做出来。演进方向:

1. **概念方向:注入信号控制台(industrial/utilitarian)**。六个层级六种主色编码(层级标签、卡片边框、导航选中态统一取色);`pre-step` 增加"消息面槽位预览",把 `before-all / user / after-user / after-all` 画成时间轴,每条配置落在轴上的真实位置可视化。
2. **排版**:配置 `id`、yml 键、路径一律等宽字体,与描述文本形成对比;避免系统默认字体。
3. **组合结构**:改长列表为 master-detail + 右侧注入预览面板——左侧层内列表,右侧显示当前层最终装配顺序(`order → priority → mergeGroup`),把 `LAYER_FIELD_POLICIES` 的"字段在哪层生效"可视化。
4. **动效**:保存时受影响层脉冲高亮;层级切换 stagger 入场;Skills 拖拽排序补齐键盘可达的上移/下移(当前只有鼠标 DnD)。
5. **一致性**:P1-4 双编辑面已收敛为共享 `PromptConfigList`;视觉打磨仍待做。注意当前工作台 per-config 分页被简化,后续若恢复需在共享组件上增加 `focusedId` 受控模式。

---

## 4. 目标架构

```
                    ┌──────────────────────────────────────────────┐
                    │  schema 单一权威(引擎导出 KNOWN_*/能力矩阵)    │
                    └───────────────┬──────────────────────────────┘
                                    ▼
 engine/  schema.mjs · strategies.mjs · fillers.mjs
                 layers.mjs · executor.mjs(装配入口,复制进生成目录)
                                    ▲ 生成目录 = 源码副本(测试锁定一致)
 src/  prompt-configs.ts(数据) · preset-write.ts(原子写入)
       runtime/(settings-bridge + /meta · skills 缓存 · 自愈无 exit)
                                    │
 client/  单一 configEditorStore → PromptSettingsPage(容器)
                              → PromptWorkspace(容器,注入控制台视觉)
          HostSurfaceAdapter(官方 slots 优先,selector 兜底)
```

---

## 5. 实施顺序与验收

| 里程碑 | 内容 | 状态 | 验收标准 |
|---|---|---|---|
| M1 | schema 单一权威:`KNOWN_*`/能力矩阵从引擎导出,`/meta` 端点下发,客户端去硬编码 | ✅ 已完成 | 客户端源码无枚举字面量;新增枚举只改引擎一处;`/meta` 返回与 README 矩阵一致 |
| M2 | 双编辑面收敛为单一 store/组件;按 §3 做工作台视觉重构 | 🟡 编辑面已收敛,视觉重构未做 | 删除重复的保存/校验/脏检测逻辑;Skills 排序有键盘操作;层能力矩阵可视化 |
| M3 | 引擎拆分 + 生成目录一致性测试 + `writePreset` 原子写入 | ✅ 已完成 | 5 个模块职责清晰;生成目录与源码逐字节一致;崩溃中断不留下半成品目录 |
| M4 | 技能版本化迁移与缓存、`ensureWebSurface` 去 exit、补集成测试 | 🟡 核心已完成,集成测试仍缺 | 旧副本可升级;`list/get` 单次扫描复用;插件不再主动退出进程;P2-6 覆盖的模块有测试 |
| M5 | anchored 预设提取为单一预设单元 + 目录结构重设计(§7 / §8) | ✅ 核心完成:策略为引擎内置,默认配置/allowKinds 已参数化到 `preset.yml`;最小模板夹具与 C6 完整拆分为后续增强 | 引擎内置策略参数全部来自单一配置;`writePreset` 可物化任意模板;新旧生成产物行为等价 |

约束不变,延续原 plan.md 的四条:

1. 功能先行、UI/开关最后:任何 UI 只消费既有 settings 数据,不引入新后端状态。
2. 行为等价:重构必须有测试对照;验收用确定性单测,不用模型评分。
3. 只用官方 API:不 fork DSH 内部实现;服务缺失降级、配置错误 fail loud。
4. 注入引擎永不破坏会话:单条提示词配置失败跳过并告警;幂等以持久 session events 为准。

---

## 6. 文档迁移说明

- `plan.md` 已明确标注过期,仅作历史记录保留;开发计划与路线图一律以本文件为准。
- `docs/architecture-v4.md` 中引用 `plan.md` 的行(G6、M5 等)在 M1–M4 随文档同步时改指向本文件。
- `README.md` 若出现指向计划文档的引用,同步更新为 `planv2.md`。

---

## 7. anchored 预设提取结论(2026-08-19 审查)

### 7.1 结论

**应该提取,方向正确——这是原 plan.md"本体与预设分离"原则尚未完成的一半。** 但"单一预设文件"的字面形式不可行:DSH 的 agent 预设是 `agent.cordis.yml` 组合 + 被引用的 `.mjs` 脚本 + `preset.yml` 元数据,脚本是代码,塞进一个 YAML 会失去 lint、单测与加载器兼容性。落地形态是**单一自包含预设单元(一个目录/一个包)+ 一份 `preset-manifest.yml`**。

当前代码层虽已分目录(`engine/` vs `preset/anchored/`),但 `src/` 仍深度绑定 anchored 预设,因此"插件只作为注入引擎、可注入任何模板"尚不成立。已确认的耦合点:

| # | 耦合点 | 位置 |
|---|---|---|
| C1 | `buildCordis` 用字符串标记给 `agent.cordis.yml` 做手术:插入 `router-first-turn` / `prompt-config-engine` 行、给 `tool-subagent*` 注入 Flash persona、给 `tool-bootstrap` 注入 `usePtcMode/bootstrapMaxTokens` | 🟡 已改为模块装配 + token 渲染,不再字符串补丁;仍保留 anchored 结构校验 | `src/preset-core.ts` |
| C2 | ~~`patchToolBootstrap` 是对上游原始文件的字符串补丁~~ 已删除 | ✅ 已删除 | `src/preset-core.ts` |
| C3 | `ROUTER_FLASH_PERSONA` 与 `router-first-turn.mjs` 的 `FLASH_PERSONA` 两份相同文本,需手工同步 | ✅ 已消除,`flashPersona` 由 `preset.yml` 参数下发 | `src/host/manifest.ts` |
| C4 | 默认四条提示词配置是 anchored/router 专属策略,却硬编码在引擎插件里 | ✅ 已迁到 `preset/anchored/preset.yml` 的 `promptConfigs`,writer 只做运行时字段覆盖 | `preset/anchored/preset.yml` |
| C5 | 引擎内置 anchored 专属策略:`anchor-auto / guide-auto / custom-fallback`(`anchor-fallback` 为归一化旧别名);纯注入引擎本不需要 | ✅ 策略为引擎内置,参数由 `preset.yml` 单一配置下发 | `engine/strategies.mjs` |
| C6 | `Config` / settings schema / Web 工作台塞满 anchored 专属开关(`anchorFirstTurn、usePtcMode、bootstrapMaxTokens、subagentFlash…`) | 🟡 已新增 `presetTemplate` 并按模板隐藏 anchored 专属 UI;字段尚未从 Config 完全拆分 | `src/config.ts`、`src/client/PromptWorkspace.tsx` |
| C7 | `context-gate` 的 `allowKinds: [skill-invocation, near-anchor, router-guide]` 依赖 C4 的默认配置身份 | ✅ 已参数化为 `__ALLOW_KINDS__`,由 `preset.yml` 的 `allowKinds` 下发 | `engine/compositions/library/context-gate.yml` |
| C8 | `router-first-turn` 硬编码 `mnemon:*` 段隐藏逻辑——第三方插件行为写死在默认预设里 | 🟡 已参数化为 `hideSectionPrefixes`,默认仍为 `[mnemon:]` | `engine/router-first-turn.mjs` |
| C9 | `test/preset-core.test.mjs` 大量断言 anchored 生成结构,模板可替换后这些测试应迁移到预设包 | ⬜ 未解决 | `test/host/preset-core.test.mjs` |

### 7.2 anchored 预设功能审查

| 模块 | 功能 | 通用性 | 意见 |
|---|---|---|---|
| `context-gate.mjs` | 未晋升前清空 runtime-context、pre-step 只留 claimed baseline + kind 白名单;epoch 晋升/compaction 重关门 | 通用 | 设计优秀,失败降级为全放行;`allowKinds` 解耦后由模板 manifest 提供 |
| `tool-bootstrap.mjs` | 首轮 Minimal 工具对、晋升后全目录、PTC wire 切换、compaction 受控期、可选首轮 maxTokens | anchored 专属 | 逻辑健壮;头注释"includeSubagents 与 context-gate 同步"与实际(gate=false / bootstrap=true)矛盾,属文档漂移 |
| `router-first-turn.mjs` | 替换 persona(Pro=RL 原句,Flash=router 弱路由)、晋升前隐藏 mnemon 段、子代理放行 | anchored/router 专属 | 子代理放行是为 dsh-mnemon 白名单协作,是部署决策;C8 改为可配置 `hideSectionPrefixes` |
| `custom-bash.mjs` | Windows 同名 `bash` 工具走 subprocess(Git Bash 探测链),保持 Minimal schema | anchored 专属 | 质量高:显式路径优先、超时/中止语义清晰、不静默换 shell |
| `skill-search.mjs` | 移除 9KB 技能目录注入,改为 `skill_search`/`skill_load` 按需工具 | 通用,建议随引擎发布 | 与引擎 `skill-catalog` filler 互补;保持"不能与 dsh-tool-skill 共存"约束 |
| `run-code-env.mjs` | PTC 的 run_code 注入冻结 `env` 全局;白名单 + 敏感名过滤 | PTC 专属 | 安全设计克制;`PATCHED` WeakSet 防重复;测试最完整 |
| `compaction-epoch.mjs` / `shared.mjs` | epoch 晋升机、事件解析、消息工具 | 通用基础设施 | 归引擎包;anchored 脚本与引擎共享 import 契约保持不变 |

缺口:`context-gate` / `tool-bootstrap` 目前无直接单测(只靠生成文件断言间接覆盖),提取时补齐。

### 7.3 三件套目标形态

- **引擎插件(dsh-plugin-prompt-tool)**:六层接线、merge/dedupe/promotion、插值、settings bridge、`/meta`、skills provider、TUI、通用 writer;内置策略仅 `static + placeholder`,fillers 仅通用三件(`env-facts / skill-catalog / instruction-hint`);配置新增 `presetTemplate`。
- **单一预设单元(presets/anchored)**:`preset-manifest.yml` + 完整 `agent.cordis.yml` + `preset.yml` + 脚本 + 默认配置;专属策略为引擎内置,参数由 `preset.yml` 单一配置下发,`customStrategyDir` 保留为自定义模板扩展点。
- **任意用户模板**:同一 manifest 约定,引用引擎行,注入任意提示词配置。

### 7.4 迁移步骤

| 步 | 内容 | 状态 | 验收 |
|---|---|---|---|
| S1 | 新增 `preset-manifest.yml` 约定;`writePreset` 改为通用"复制模板 + 注入引擎 + 渲染配置",删除全部字符串补丁 | 🟡 `writePreset` 已无字符串补丁、已复制模板策略目录;`preset-manifest.yml` 约定尚未引入 | `writePreset` 不引用任何 anchored 专属字符串 |
| S2 | `preset/anchored/*`、`agent.cordis.yml`、`preset.yml`、默认四条配置整体迁入预设单元并补 manifest | ✅ 默认四条配置已迁入 `preset/anchored/preset.yml` 的 `promptConfigs`;`agent.cordis.yml` 仍由模块装配生成 | 包内 `preset/` 只剩引擎;anchored 测试随迁 |
| S3 | 引擎增加 `customStrategyDir` 注册点;anchor/guide/we 策略迁出为模板策略模块 | ✅ 策略为引擎内置,`customStrategyDir` 保留为自定义模板扩展点 | 引擎内置策略参数全部来自单一配置 |
| S4 | ~~删除 `patchToolBootstrap` 死代码~~ 已完成;合并双份 Flash persona;`allowKinds` 改由 manifest 生成;`mnemon:*` 前缀可配置 | 🟡 `patchToolBootstrap` 已删除、Flash persona 已收敛、`hideSectionPrefixes` 已参数化、`allowKinds` 已由 `preset.yml` 下发;preset-core 测试仍含 anchored 断言 | 无重复 persona;preset-core 测试只测通用能力 |
| S5 | settings 拆分:引擎字段 + 模板扩展字段;工作台按 manifest 动态渲染;`presetTemplate` 可切换 | ⬜ 未完成 | 不装 anchored 模板时 UI 不出现 anchored 开关 |
| S6 | 补 context-gate / tool-bootstrap 直接单测;加"最小模板端到端"夹具(证明任意模板可注入) | ⬜ 未完成 | 最小模板仅 static 配置即可跑通全链路 |
| S7 | 可选包级拆分:引擎包 + `@…/dsh-preset-anchored` 双包发布;默认 `presetTemplate=anchored` 保持兼容 | ⬜ 未完成 | 老用户升级行为等价(现有测试全绿 + 新旧产物 diff) |

### 7.5 风险

- 行为等价是硬约束:S1–S7 每步都要有"新旧 `writePreset` 产物逐字节 diff"测试。
- 模板动态值只用 manifest 变量替换 + YAML 校验,永不回归字符串特征补丁。
- 模板自带策略加载失败按引擎铁律跳过该配置 + `warnOnce`,不得打挂 preset 挂载。
- `upstream/dsh-anchored-standard` 快照与 `sync:anchored` 归预设包,引擎包不再感知 anchored 上游。
- manifest 声明 `engineCompat` 版本矩阵,不兼容时明确报错。

---

## 8. 目录结构重设计

### 8.1 设计目标

1. 仓库内**任何一行引擎代码都不引用 anchored 预设**;
2. 一个预设单元 = 一个目录 = 可整体复制/发布/替换;
3. `writePreset` 只做三件事:读 manifest → 复制资产 + 变量替换 → 注入引擎文件 + 渲染提示词配置;
4. 生成目录(运行时产物)与源码目录一一对应,可做逐字节一致性测试。

### 8.2 目标目录树(2026-08-19 已落地;最终形态:anchored = 单一参数 preset.yml)

```
dsh-plugin-prompt-tool/
├── package.json                  # files:preset/ + templates/ + skills/ + docs
├── tsconfig*.json
├── tsdown.config.ts
├── pnpm-workspace.yaml
├── plan.md                       # 已过期(DEPRECATED)
├── planv2.md                     # 现行计划(本文件)
├── README.md
├── LICENSE
├── cordis.patch.yml
│
├── engine/                       # ① 插件引擎(根目录,与配置文件夹 preset/ 分离)
│   ├── prompt-config-engine.mjs  # 装配入口(仅接线)
│   ├── schema.mjs            #    schema 归一化 + KNOWN_* 单一权威
│   ├── strategies.mjs        #    全部内容策略:static/placeholder/instruction-hint/anchor-auto/guide-auto/custom-fallback
│   │                         #    (anchor-fallback 为归一化旧别名;锚点/引导文案与正则全部来自 preset.yml 参数)
│   ├── fillers.mjs           #    通用 filler:env-facts/skill-catalog/instruction-hint
│   ├── layers.mjs            #    非 pre-step 五层接线
│   ├── executor.mjs          #    pre-step 执行器(过滤/去重/合并/落位)
│   ├── context-gate.mjs      #    首轮上下文门(引擎通用能力,参数来自预设)
│   ├── tool-bootstrap.mjs    #    工具目录两阶段引导(引擎通用能力)
│   ├── router-first-turn.mjs #    persona/首轮段路由(引擎通用能力,flashPersona 等全部参数化)
│   ├── custom-bash.mjs       #    Windows bash 工具(引擎通用能力)
│   ├── skill-search.mjs      #    按需技能工具(引擎通用能力)
│   ├── run-code-env.mjs      #    PTC 环境注入(引擎通用能力)
│   ├── shared.mjs            #    公共晋升解析与消息工具
│   ├── compaction-epoch.mjs  #    epoch 晋升机
│   ├── compositions/         #    引擎模块库(官方源码重建;清单由参数文件决定)
│   │   ├── library/*.yml            # 23 个行/组模块(带官方 provenance 注释)
│   │   └── source/local/*.yml       # 本地附加模块(7 个),rebuild 时逐字复制
│   └── vendor/yaml/          #    vendored yaml
│
├── preset/                       # ② 配置文件夹:可替换预设模板(参数 YAML)
│   └── anchored/                 #    anchored 预设 = 一个参数 YAML(最终形态)
│       └── preset.yml            #    唯一文件:modules + params(on/off 开关)+ content +
│                                 #    promptConfigs + variables + settingsExtension
│
├── src/                          # ③ 插件宿主侧(TypeScript,构建为 lib/)
│   ├── index.ts                  #    apply 编排:skills/settings bridge/TUI + writer + 内容读取
│   ├── config.ts                 #    引擎级 Config(anchored 旧开关兼容保留,新模板走 settingsExtension)
│   ├── host/                     #    宿主侧数据/生成层(原 src/engine)
│   │   ├── prompt-configs.ts     #    spec 类型、渲染、三源合并、目录加载
│   │   ├── manifest.ts           #    preset.yml 加载 + 变量解析 + __TOKEN__ 渲染 + 类型化深渲染
│   │   ├── write-preset.ts       #    单文件参数驱动的生成目录物化器(零 anchored 字符串)
│   │   └── templates.ts          #    通用模板库扫描(原 runtime/templates.ts)
│   ├── preset-core.ts            #    兼容层:buildCordis(渲染 anchored 单文件模板)/parseFrontmatter
│   ├── runtime/                  #    宿主运行时适配
│   │   ├── settings-bridge.ts    #    loopback bridge(/meta /describe /mutate /configs-validate /import-directory /templates)
│   │   ├── configs-validate.ts   #    权威校验
│   │   ├── skills-provider.ts
│   │   ├── settings-registration.ts
│   │   ├── agents-file.ts
│   │   ├── deepseek.ts
│   │   └── tui.ts
│   ├── profile-skills.ts
│   ├── web-surface.ts
│   └── client/                   #    Web 客户端(store/编辑器/工作台/挂载)
│       ├── prompt-tool-types.ts  #    共享类型(PromptConfigDraft / EngineMeta / LayerFieldPolicy)
│       ├── prompt-tool-store.ts  #    统一 store(含 /meta 加载)
│       ├── PromptConfigList.tsx  #    共享配置列表/校验/保存/移动组件
│       ├── host-surface.ts       #    HostSurfaceAdapter(所有 DOM 选择器集中地)
│       ├── PromptConfigsEditor.tsx
│       ├── PromptWorkspace.tsx
│       ├── PromptSettingsPage.tsx
│       ├── sidebar-entry.ts
│       └── workspace-mount.tsx
│
├── templates/                    # 通用示例模板(六层 + placeholder)
├── skills/                       # 随包技能
├── upstream/                     # anchored 上游溯源快照(仅 review 用)
├── docs/
├── scripts/
│   ├── link-profile.mjs
│   └── sync-anchored.mjs         #    只刷新 upstream 快照,preset/anchored 人工 review 后移植
└── test/                         # 按层拆测试,禁止跨层 import
    ├── engine/                   #    prompt-config-engine 单测
    ├── host/                     #    preset-core/prompt-configs/configs-validate/templates/TUI 等宿主侧单测
    └── presets/
        └── anchored/             #    anchored 引擎能力单测(custom-bash/router-first-turn/run-code-env)
```

### 8.3 生成目录(运行时产物)对应关系

```
$DSH_HOME/.agent-presets/prompt-tool/          # 由 write-preset.ts 按 manifest 物化
├── preset.yml                                 # ← 所选预设的 preset.yml
├── agent.cordis.yml                           # ← 所选预设的组合文件(参数已替换)
├── engine/                                    # ← 插件 engine/ 全部逻辑(逐字节复制)
└── prompt-configs/                            # ← 预设默认 configs + 目录源 + settings 源渲染结果
```

预设只提供参数与内容,生成目录没有任何模板自带脚本。

### 8.4 `preset.yml`(anchored 现状:扁平参数开关)

```yaml
id: anchored
name: Anchored Standard(prompt-tool)
version: 1.0.0
engineCompat: '>=0.4.2'
meta: { name: prompt-tool, description: ..., order: 5 }
content: { presetText: ..., agentsText: ... }
modules: [context-gate, tool-bootstrap, router-first-turn, prompt-config-engine, ...]  # 23 个模块
params:                               # 直读参数,无任何模板语法
  anchorFirstTurn: false
  anchorCustom: false
  anchorText: ''
  guideCustom: false
  guideText: ''
  guideComplexPattern: '(架构|重构|...)'
  guideWeak: '\nRouter: ...'
  guideDeep: '\nRouter: ...'
  buildPattern: '(开发|创建|...)'
  complexPattern: '(架构|重构|...)'
  anchorBuild: "Start your reasoning with the exact sentence: '...'"
  anchorInspect: "Start your reasoning with the exact sentence: '...'"
  anchorDeep: "Start your reasoning with the exact sentence: '...'"
  injectPrompt: true
  usePtcMode: true
  bootstrapMaxTokens: 0
  subagentFlash: false
  subagentFlashProvider: deepseek-official
  subagentFlashModel: deepseek-v4-flash
  flashPersona: '...'
hostDefaults:                        # 宿主开关默认值(apply 合并进 Config;settings 仍可覆盖)
  writePreset: true
  writeAgents: true
  injectAgentsPrompt: false
  skillsDir: ''
  skillRankBase: 250
  residentAgentsPath: '~/.dsh/AGENTS.md'
  presetDir: '~/.dsh/.agent-presets/prompt-tool'
  presetOrder: 5
  promptConfigsDir: ''
  promptConfigs: []
settingsExtension: { ... }
```

> 参数结构约定(Code Organizer / Premium Web 原则):
> - `preset.yml` 是**唯一入口**:`modules + params + hostDefaults + content` 一次定义即可启用插件全部功能;
> - 优先级 `cordis Config < preset.yml < settings(用户/Web)`;
> - 布尔直接 `true/false`;默认四条提示词配置与 `__TOKEN__` 全部由引擎按 `params` 生成,
>   参数文件不含 `variables` / 模板语法;
> - 用户自定义提示词配置走 settings `promptConfigs`(纯数据)。

### 8.5 旧 → 新路径映射(实际执行结果)

| 旧路径 | 新路径 | 备注 |
|---|---|---|
| `preset-manifest.yml` + `agent.cordis.yml` + `preset.md` + `AGENTS.md` + `configs/*.yml` | `preset/anchored/preset.yml`(单一参数文件) | **最终目标:用户写一个参数 YAML 即可复刻 anchored 全部能力** |
| `engine/*` | `engine/*`(保持) | 拆为 schema/strategies/fillers/layers/executor + facade |
| `preset/anchored/*.mjs` | `engine/*.mjs` | anchored 全部执行逻辑抽象为插件引擎 |
| `preset/anchored/strategies/` | `engine/strategies.mjs` | anchor-auto/guide-auto/custom-fallback 全部内置(`anchor-fallback` 归一化);strategyDir 保留为自定义模板扩展点 |
| `preset/anchored/scripts/flash-persona.txt` | manifest `variables.FLASH_PERSONA` | 文本改为参数传递 |
| `preset/agent.cordis.yml` / `preset/preset.yml` / 根 `preset.md` / `AGENTS.md` | `preset/anchored/` | 预设内容与预设放一起 |
| `src/prompt-configs.ts` | `src/host/prompt-configs.ts` | 纯移动 |
| `src/runtime/templates.ts` | `src/host/templates.ts` | 纯移动 |
| `src/preset-write.ts` | `src/host/write-preset.ts` | 重写为 manifest 驱动,删除全部字符串补丁 |
| `engine/compositions/anchored-standard.yml`(历史拆分) | `scripts/rebuild-composition.mjs` → 从官方 standard/minimal 源码切块 + 声明式补丁重建 `library/*.yml` | 官方行模块即数据源;本地附加模块在 `source/local/` |
| `src/preset-core.ts` | 保留为兼容层 | buildCordis=渲染 anchored 模板;parseFrontmatter |
| `test/*.test.mjs` | `test/{engine,host,presets/anchored}/*` | 按层拆测试 |
| `upstream/dsh-anchored-standard` | 保持根级 | 仅 review 用,引擎包发布不携带 |

### 8.6 不变式(写入测试)

1. `engine/` 内 `import` 只能指向 `engine/` 内部或 node 内置模块——grep 断言无 `../anchored`、无 anchored 专属文本;
2. `preset/anchored/` 只含数据/参数文件(manifest、yml、md),不含任何 `.mjs`——grep 断言;
3. `preset/anchored/agent.cordis.yml` 必须包含 `- id: prompt-config-engine` 引擎行;
4. 生成目录中 `engine/` 与源码 `engine/` 逐字节一致;
5. `writePreset` 输出不包含任何 `__VARIABLE__` 残留(变量替换完成断言);
6. 任意新模板只要 manifest 合法即可通过同一端到端夹具(证明"预设只设参数、引擎可注入任何模板")。
7. 锚点/引导策略的文案与正则只出现在 `preset/<template>/preset.yml`;`src/` 与 `engine/` 不得重复维护同一份默认文案。
