# 模块主语：把「归属」从会话状态拉回操作本身

> ⚠️ **后补注记（不改写下文历史）**：本文是当轮设计记录。其中 §10.2 Q14 的「写以载荷主语为准」与最终实现不同——实际是**读与写都由请求头 `x-module-id` 定位目录**，写端点另在载荷带 `expectedModuleId` 作**一致性校验**（不一致 → 400 `module-subject-conflict`；缺头 → 400 `module-dir-unavailable`，载荷不能替请求头选路径）；以 `docs/adr/0014-module-subject-declared-per-operation.md` 为准。

日期：2026-10-12 · 状态：已评审（用户批准，2026-10-12），待拆计划；尚未动代码
来源：`/improve-codebase-architecture` 评审报告（`%TEMP%\architecture-review-20261012-0251.html`）候选 1／2／5 的合并与更正

## 一、为什么做这件事

一次真实故障暴露的是层次错误，不是一个 bug：工作台打开时，自定义工具卡向 `/custom-tools` 发了一次读，服务端回了 **409 `module-changed`**。追下去发现「**这次读写属于哪个模块**」这一个问题，全仓有 **8 个入口**在回答，其中两个是**猜**：

- 客户端 `src/client/data/bridge-transport.ts:74-83` 有一个模块级可变的 `editTarget`，首帧还没初始化就发出请求；
- 服务端 `src/host/config-store.ts:111` 在请求没声明目标时回退到**启用表首项**。

两者的不同步产生了两种后果：**响亮的**——409；**沉默的**——`/param-overrides` 的 `expectedModuleId` 是可选的，不带它又不带目标头时连 409 都没有，请求直接落到回退目标。

更根本的是：**「当前模块」这个概念不在领域里**。模块按设计是可自由组装的多份（`CONTEXT.md`：模块是可编辑、可激活的载体，也是可被并入的库成员），而 `CONTEXT.md` 的「编辑目标（Edit Target）」把「请求头声明的一次目标」包装成了一个会话状态。领域里真正存在的是「**这次操作的主语**」——它作用在哪张卡、哪个模块的设置上。

## 二、目标

1. **主语唯一且显式**：一次读写的主语由这次操作自己声明，不从任何会话级或进程级状态推导。
2. **服务端不再制造目标**：没有声明就是没有目标；不猜、不回退、不替换成同名模块。
3. **没声明就不调用**：模块没有声明这件事（`module.yml` 顶层键不存在），调用方就不发这次请求；服务端用同一判据做门。
4. **判据收口**：46 个端点不再各自挑选「要不要核身份／核可写／核形状」（候选 5）。

## 三、非目标

- 不改 `module.yml` / `config.yml` 的存储语义与字段：**无数据迁移**（主语是请求侧概念，落盘形态不动）。
- 不动 ADR-0011 的三个问题与「编辑通道不查启用」这条既有决策。
- 不持久化「上次选择的模块」（不引入新的浏览器状态）。
- 声明面只做**顶层键存在性**，不做内容级语义（不判断「声明得对不对」）。

## 四、反目标（做到这些就算失败）

- 任何形式地用「启用表首项」当默认目标——包括把它换个名字下发给客户端当建议。
- 非法 `x-module-id` 静默降级成「未声明」。
- 把「加载失败／读不到」当成「没声明」。
- 为了省一次请求，把 `module.yml` 的内容复制一份下发到客户端，制造第二份真值源（`rules/*.yml`、`_settings.yml` 是**校验投影**，不是判据来源）。
- 在界面里保留一个隐式的「当前模块」，让它从后门变成请求的隐含主语。

## 五、约束

- 单用户本地插件：桥只收 loopback；没有多租户与并发写者的压力，但**性能不是本设计的判据**，一致性才是（首屏多一个 loopback 来回是可以接受的代价）。
- `module.yml` 是模块定义的唯一真值源；`rules/<id>.yml`、`rules/_settings.yml`、`rules/variables.yml` 只是校验投影，缺件或校验失败单向从定义恢复。
- 编辑通道不查启用（ADR-0011）；启用表只管「参与装配」的端点（排序、装配读）。
- 测试准入（`AGENTS.md`）：四条 seam（引擎注入行为、写盘产物语义、bridge 端点载荷、安全与拒绝路径）、独立真值源、断言落在公共接口上；不写墓碑测试。
- 客户端与服务端同版本发布，**不需要**兼容旧客户端。

## 六、已决（用户逐轮拍板）

| # | 决策 |
|---|---|
| Q1 | 模块归属的调用**每次显式传主语**；删除 `bridge-transport` 的模块级可变 `editTarget` 与默认头 |
| Q2 | 服务端不再制造目标：`resolveEditDir` 的无参回退删除；**缺声明即无目标** |
| Q3 | 非法 `x-module-id` 头改 **400 显式拒绝**（`bridge-contract.ts:98` 现为静默降级） |
| Q4 | 写**一条新 ADR**：装配成员资格与写入目标解耦；并把 ADR-0011 的消费者表从 4 个补登到实际入口数 |
| Q5 | 顺序：**候选 1（真值源）→ 候选 5（门收口）→ 候选 2（声明面）** |
| Q6/Q10 | `bootstrap` 的**空目标是合法状态**：只回全局段（指令文件卡、session/scope 事实），模块段（`moduleParams`／`moduleFacts`／`overrides`／`variables`）全部缺席；**`describe` 空目标拒绝**（它的主体就是模块段）。合法理由：新环境可能既没有模块也没有指令卡 |
| Q7 | `moduleDelete` 用它声明的编辑目标做「在用」判据；**无声明 = 没有在用模块**（不拒绝），并补契约测试钉住两个方向 |
| Q8 | 把 46 个端点的「无目标语义」固化成显式名单，先写进 §7 文档与契约测试，候选 5 落地时变成门的接口 |
| Q9/Q11/Q12/Q13 | **初始目标为空**，不设默认、不持久化；**无模块时插件等于未启用**：模块类调用一律不发（不是「显示占位后照发」）；用户从现有入口选（模块页列表/编辑）；**彻底删除全局「当前模块」焦点**，工作台按**装配集合**呈现，每张卡/面板自报主语 |
| Q14 | 服务端**由主语解析目标**：写以载荷主语为准、读以请求声明的读取对象为准，头与载荷不一致即拒绝；删除无参回退与客户端全局目标（含 `EMPTY_FIELDS.moduleId` 的 `'ponytail'` 默认） |
| Q15 | 主语可以是**任意已安装模块**（含未启用）；启用表只管参与装配的端点（ADR-0011 不动） |
| — | 「没声明」的判据：`module.yml` **顶层键整个不存在**；`customTools: []` 算已声明 |
| Q6/Q10 追加 | 空主语时 `moduleParams` 与 `moduleFacts` **缺席**（不是空对象）：`editable` 随主语一起消失，客户端据此禁用全部模块类编辑器——这就是「无模块时插件等于未启用」的可见形态 |
| Q13 追加 | 没有「设为主语」这个动作：主语由卡片归属决定。`store.setModuleId`（`use-prompt-tool-store.ts:924`）与 `ModuleSwitcher` 的 active 边框随全局焦点一起取消；模块页只回答「谁参与装配」（启用开关） |
| Q7 追加 | 「被 `personaSources` 引用」的删除保护**已存在且不动**（`src/host/manifest.ts:494-511`，在配置锁内、与编辑目标无关）；Q7 只改「当前编辑模块」那一条判据的来源 |

## 七、事实基线（评审期实测，供 builder 直接引用）

### 7.1 「这次读写归哪个模块」现有的 8 个入口

请求侧 5：`bridge-contract.ts:98`（头解析，非法即当未声明）· `settings-bridge.ts:477` + `index.ts:108`（经 `resolveEditDir`）· `config-store.ts:111`（未声明→启用表[0]）· `module-config-order.ts:67-68`（启用表 `.sort()` 字典序，**与声明顺序首项不是同一个第一**）· `persona-selection.ts:26,43`（`personaSources`，与启用表正交）。
Agent 侧 1：`module-tool-target.ts:32`（每 Agent 装配记录取 [0]，ADR-0011 未登记）。
客户端 2：`bridge-transport.ts:74-83`（全局目标 + 每请求第三参）· `use-prompt-tool-store.ts:297`（唯一写入点，每次 fields 发布即覆盖）。

静默改写现有 5 处：`config-store.ts:112`（→启用表[0]）· `index.ts:85`（→`'ponytail'`）· `settings-bridge.ts:650`（activeDir 空 → `'ponytail'` + `resolveModuleDir` → 命中**包内同名模块**）· `manifest.ts:185`（用户目录缺失静默换包内同名，3 处共用）· `bridge-transport.ts:81`（卡不传第三参 → 用上次 fields 的模块）。

### 7.2 已有的「一半主语模型」

写载荷里**本来就带主语**：`paramOverrides`／`persona`／`customTools`／`subagentToolPolicy`／`moduleCapability` 都有 `expectedModuleId`（`bridge-contract.ts:167,171,174,199,202`），`rules`（`RulesRequest`）与 `moduleVariables`（`ModuleVariablesRequest`）经各自类型也带。今天的用法是「拿来跟请求头比对的第二意见」，Q14 把它改成**主语本身**。

### 7.3 46 个端点在无目标（`dir === ''`）时的语义

| 类别 | 数量 | 端点 | 现有行为 |
|---|---|---|---|
| 模块类：拒绝 | 11 | rules、paramOverrides、moduleVariables、customTools、persona、charactersImport、moduleMerge、moduleUnmerge、subagentToolPolicy、subagentToolPolicyPreview、moduleCapability | 400 `module-dir-unavailable` |
| 模块类：应拒绝（本轮改） | 1 | describe | 今天 200，且拿**包内默认模块 `ponytail`** 的 `moduleParams`／`moduleFacts` 当当前模块 |
| 空目标合法 | 1 | bootstrap | 今天 200 但同样用包内默认模块填模块段；改为：只回全局段，模块段缺席 |
| 全局类 + 附加判据 | 2 | moduleDelete（在用保护）、promptConfigs（`guardModuleFormat('')` 立即 true → 200 只含指令文件卡） | 见 Q7／Q8 |
| 全局类：不看目标 | 31 | meta、models、modelReasoning、skillsList／Import／Policy／Read／Write／Folders／Create／Delete／ImportDirectory、templates、agentsFile、instructionsPolicy、triggers(410)、personaSources、assetUpload／Release、importModulePackage、exportModule、moduleClone／Duplicate／Open／Enable、moduleConfigOrder、charactersImportStream(410)、toolSurface、contextActivationDiagnostics、ruleDiagnostics | 照常工作 |

guard 在空目标时：`guardModuleFormat` → `true` 不写响应（`settings-bridge.ts:518-519`）· `guardModuleWrite` → 典型 403 `module-readonly`（cwd 比较）· `guardModuleIdentity` → 带 `expectedModuleId` 时恒 409。所有 `guardModuleWrite`／`guardModuleIdentity` 调用点都排在各自端点的 `dir.length === 0` 早退之后，实际不会被触发。**没有任何端点因空目标抛未捕获异常。**

### 7.4 声明面今天没有真值源

`customTools` → `spec.customTools ?? []`（`settings-bridge.ts:1433-1435`）；`subagentToolPolicy` → 读成 `null` 且 200，但 **preview 未声明直接 400**（同一段两个口径，`:1923-1928` vs `:1976-1978`）；人设 `?? null`；变量 `variablesEnabled` 缺省 `true`。客户端只有 `meta.modules[]`（id/name/renderable/enabled）与**仅当前模块**的 `moduleFacts`；`customTools`／`persona`／`rules`／`variables`／`layerSettings`／`moduleConfigs` 的**声明事实没有任何下发点**。

### 7.5 测试面缺口

每个桥测试都自建 `moduleDirectory` 桩（`settings-bridge.test.mjs:231,283,373,504,548,603,629,668,717,754,794`；`module-management.test.mjs:52-55` 的桩还自己重写了回退）；**`resolveEditDir` 全仓零测试引用**，`index.ts:108` 的接线没有回归网；`readEditTarget` 的形状降级无用例；客户端「卡忘传主语」不可测。

### 7.6 热区（最近 80 次提交）

`settings-bridge.ts` 14 次、`index.ts` 10 次（都既热又浅/无网）；`manifest.ts`、`bridge-contract.ts`、`module-package.ts` 各 7。

## 八、留给 builder 的

以下是我**没有**替你定的（我的倾向写在括号里，可以推翻）：

1. **门的接口形状**（候选 5）：端点自报需要（`{ needs: 'read' | 'write', checks: ['declaration'] }` 之类）还是按端点名单表驱动？（倾向：端点自报一段声明，门内部固定顺序：启用表 → 存在性 → 主语一致 → 声明面）。
2. **声明面的下发形状**（候选 2）：`meta.modules[].declares`（顶层键名数组）还是 `/bootstrap` 里带当前主语模块的声明？（倾向前者：一次拿全，粒度就是键名）。
3. **UI 的分组形态**（Q13）：参数、人设、变量、工具策略改成「按模块分组」后，是每模块一块、还是按设置类型分块内再按模块分组？（倾向：按现有页面语义分块，块内按模块分组，与规则列表同形）。
4. **空目标 bootstrap 的全局段清单**：除指令文件卡与 session/scope 事实外还必须有谁？（倾向：只这两类；技能面有独立端点）。
5. **`moduleDelete` 的在用判据**：编辑目标从哪来——请求头（读的主语）还是载荷里带上「当前正在编辑的主语」？（倾向：请求头，与读同一形态）。
6. **新 ADR 的文本**与 ADR-0011 表的补登条数（实际入门数是 8，但 Q14 之后会减少，落地时以那时的代码为准）。
7. **迁移与验收**：测试清单（哪些是四条 seam 上的回归）、验收点（每步停下让用户验收）、以及 `lib/` 与页面的重建方式。

## 九、顺序（Q5）

1. **真值源**：删全局目标与回退（含 `EMPTY_FIELDS.moduleId`、非法头 400、bootstrap 空目标合法、describe 拒绝），补 `resolveEditDir` 与接线的回归网。
2. **门收口**：46 个端点的语义名单变成一处门的接口。
3. **声明面**：顶层键存在性 + 下发 + 端点同一道门，「没声明就不调用」在界面落地。
4. **Agent 侧与 TUI**：5 个模块工具的主语改为工具参数（`module_import` 用自己的 `targetId`／`targetName`，不在此列），TUI 显式声明（不阻塞前三个阶段）。

## 十、builder check 裁定（2026-10-12）

评审人（只读核对源码）提了 8 个问题，分三堆。

### 10.1 已由前文回答（此处写显）

- **空主语的响应形状**：`moduleParams` 与 `moduleFacts` **缺席**，不是 `{}`（Q6/Q10 的「模块段全部缺席」在字段级就是这两条）。`editable` 随 `moduleFacts` 消失 → `canEditModule` 恒假（`InjectionPointsPanel.tsx:256`、`ModuleSwitcher.tsx:130`）→ 全部模块类编辑器禁用，正好是 Q11 要的「无模块时插件等于未启用」。
- **用户在哪里设主语**：不设。Q13 之后没有「当前主语」这个可设对象，主语由卡片所属模块决定；模块页面负责「谁参与装配」。
- **`personaSources` 引用是否算在用**：已有保护，不在本轮改动面内（`manifest.ts:494-511`）。

### 10.2 我拍的（可推翻）

- **头与载荷谁权威**：写端点主语**必填于载荷**，请求头可缺席、存在时必须一致（此处措辞已被 `docs/adr/0014-module-subject-declared-per-operation.md` 取代：读写都由请求头 `x-module-id` 定位，载荷只作一致性校验）；读端点主语**必填于请求头**。两者都存在且不同 → **新 400 `module-subject-conflict`**（「声明了两个主语」），与 409 `module-changed`（「主语还在但目标已被换掉」）区分开。门不按端点分叉：一个端点属于「模块类读」「模块类写」还是「全局类」由 Q8 的名单决定。
- **「没声明就不调用」做成类型约束**：是。模块类端点在 `bridge-client` 的类型层要求主语实参（名单与门共用同一张表），漏传在 `src/**` 编译期即拦；`test/` 是 `.mjs` 不受类型约束，用载荷断言兜。
- **声明失效**：服务端门**每次请求读盘**（真值源是 `module.yml`，不缓存声明）；客户端拿到的声明快照只作「这一步发不发」的准入，**不引入声明 revision**；快照过期只会漏发一次，重读沿用现有 `/meta` 重读路径（导入、保存、模块页刷新）。
- **测试落位**：服务端门与声明拒绝 → bridge 端点载荷 + 安全与拒绝路径两条 seam（`test/host/`）；客户端「不发请求」→ 沿用既有 `test/client/bridge-client.test.mjs` 的 stub-fetch 形态，断言调用序列与载荷主语。不引入新框架。

### 10.3 用户裁定

- **主语模型覆盖范围**（2026-10-12 拍板）：桥的三个阶段照做；**Agent 侧 5 个模块工具（吃 `MODULE_ID_PARAM` 的 `module_rules_read`／`module_rules_edit`／`module_memory_read`／`module_memory_append`／`module_variables`；`module_import` 用自己的 `targetId`／`targetName`，原 `module-tool-target.ts:32` 的装配记录 [0]）与 TUI 的 `activeModuleDir()`（`index.ts:84-85`）单列第 4 阶段**——工具的主语改为工具参数（模型显式指定模块 id），TUI 同样显式声明。它不阻塞前三个阶段。
