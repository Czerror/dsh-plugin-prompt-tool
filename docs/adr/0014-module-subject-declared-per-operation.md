# 模块主语由这次操作声明：装配成员资格与写入目标解耦

状态：已采纳（阶段 1／2 已实施；阶段 3 的**服务端**声明面已实施，客户端声明下发（T11／T12）与阶段 4 Agent 侧、TUI 待实施）。

「这次读写属于哪个模块」曾由两处**猜**回答：客户端 `src/client/data/bridge-transport.ts` 的模块级可变 `editTarget`（首帧未初始化即发请求），以及服务端 `src/host/config-store.ts` 的目标解析在请求未声明时回退**启用表首项**。两者的不同步产生两种后果——响亮的 409 `module-changed`，以及沉默的落到回退目标。根源是「当前模块」不在领域里：模块是可自由组装的多份，真正存在的只是**这次操作的主语**。本决策把主语还给操作本身：**读与写都由请求头 `x-module-id` 定位目录**，写端点另在载荷带 `expectedModuleId` 作**一致性校验**；服务端**只按声明解析**——缺声明即无目标（`required` 端点 400 `module-dir-unavailable`），不回退启用表首项，不替换成包内同名模块；**非法声明显式拒绝**而不是静默当「未声明」（三态：`ok` / `absent` / `invalid`，`absent` 只认请求头完全没有）。**实现的实际语义比设计文档的 Q14 措辞更严**：设计文档 §六 Q14 写「写以载荷主语为准」，而实现是「头定位 + 载荷只做一致性校验」（`src/runtime/settings-bridge.ts` 的 `editDir` 只读请求头，`src/runtime/module-subject-gate.ts` 的 `guardModuleIdentity` 只比对载荷）；两者对真实调用方等价（客户端都带且一致），以本节为准。

服务端**桥端点**不再制造目标：`src/host/config-store.ts` 的 `resolveEditDir(moduleRoot, moduleId)` 只在 `<root>/<id>/module.yml` 真实存在时返回目录，否则返回空串；接线函数 `resolveRequestedModuleDir(modulesDir, subject)` 把「未声明」译为无目标。`src/runtime/settings-bridge.ts` 的 route 层在事务边界（loopback／Origin、POST、体积与 JSON 形状）**之后**判非法主语头，命中即 400 `module-identity-invalid`；主语头形状非法时端点 handler 拿不到请求。归属判据收在**一处门**（`src/runtime/module-subject-gate.ts` 的 `subjectGate(tx, key, { write?, format?, declaration? })`，桥上不再留第二份端点名单），固定顺序为：`required` 且无目标 → 400 `module-dir-unavailable`（先于可写校验，无目标报 400 而不是 403）→ 写目标不在用户模块根下 → 403 `module-readonly` → 形状核（默认开）→ 声明面（`src/host/module-declarations.ts` 的 `DECLARED_SECTIONS[key]`，三态 `declaration`：缺省查表／字符串显式覆盖／`false` 显式跳过——今天只有 `/module-variables` 的 `scope: 'global'` 用第三态，全局变量跨模块共享；**仅在有主语、且这次是读时**）：读没声明该节 → 400 `module-not-declared`；写路径（`write: true`）跳过本判据——写一个不存在的节就是创建它，写完它就被声明了；定义不可解析时按既有错误路径冒泡（不降级成本码）→ 身份两条判据。身份两条**任何情况下都跑**（包括 `format: false` 的豁免点）：载荷主语 ≠ 请求头声明 → 400 `module-subject-conflict`（「两个人声明了两个主语」），解析目录或载荷与当次目标不符 → 409 `module-changed`（「处理期间目标被换掉」）。形状核只有两个端点显式豁免（`format: false`）：`moduleDelete`（目标只作在用判据）与 `mutate`（目标只投影 `descriptor.moduleId`）——不读模块内容，坏模块必须仍能删、总闸仍能切；豁免只跳过形状核。未解析目录的 30 个 `none` 端点不调用门。**残余两处（属例外／阶段 4，不在桥的归属判据内）**：`src/index.ts` 的 `activeModuleDir()` 仍按「启用表首项 → 包内默认模块 `DEFAULT_MODULE_ID`」制造目标（TUI 参数写入路径用），`src/host/manifest.ts` 的 `resolveModuleDir()` 对用户目录缺失仍回退包内同名模板——阶段 4 把 Agent 侧与 TUI 的主语改为显式声明时一并收口。写入目标是**任意已安装模块**（含未启用）——「编辑通道不查启用」是 [ADR-0011](0011-module-participation-criteria.md) 的既有决策，本 ADR 不动。

**「有没有声明这件事」的判据是 `module.yml` 顶层键是否存在**：键整个不存在＝没声明，`customTools: []` 算已声明；不做内容级语义，不判断「声明得对不对」。**服务端这一半已落地**（`src/host/module-declarations.ts` 的 `moduleDeclarations`／`DECLARED_SECTIONS` 与门的声明面检查），且**只写在读侧**：读一个不存在的节是「没有内容可读」，拒绝；写一个不存在的节是**创建**它，放行且写后该节存在（不挡「给已有模块添加第一节」）。声明失效时服务端**每次请求读盘**判定（真值源是定义文件，不缓存声明、不引入声明 revision）；客户端拿到的声明快照将只作「这一步发不发」的准入（**客户端声明下发落地后生效**），且**不引入声明 revision**；快照过期最多漏发一次，靠既有 `/meta` 重读路径恢复。模块类端点在客户端类型层**必须**传主语实参（`src/shared/bridge-contract.ts` 的 `BRIDGE_SUBJECT_POLICY` 是类型约束与服务端归属门共用的唯一名单，`satisfies Record` 覆盖保证漏标即 typecheck 失败）：`required` 缺主语不发请求直接失败，`optional`／`none` 一律省略该头。界面因此**不再有「当前模块」**：工作台按**装配集合**呈现，每张卡自报主语（模块 id 随调用携带，不存会话状态）；没有「设为主语」这个动作，模块页只回答「谁参与装配」。启用表只决定**参与装配**，不再决定写入目标——这正是被取代的 [ADR-0006](0006-module-config-order.md) 那句「以及模型工具既定的首项写入目标」。

## 代价与边界

- **空主语分两类**：`bootstrap` 空目标是合法状态，只回全局段（指令文件卡与 session／scope 事实）——`moduleParams`／`moduleFacts` 键整体**缺席**（不是空对象）、`variables` 缺席、`overrides` 为空、`templatePreStepCount` 保持 `0`；`describe` 空目标拒绝（400 `module-dir-unavailable`）——它的主体就是模块段。两者都不再拿包内默认模块 `ponytail` 兜底（`src/runtime/settings-bridge.ts` 的 `collectDescribeExtras` 只在 `activeDir.length > 0` 时填模块段）。拒绝路径统一同一个码与同一条文案。
- **`moduleDelete` 用它声明的编辑目标做「在用」判据**：无声明＝没有在用模块（不拒绝）；「被 `personaSources` 引用」的删除保护在 `src/host/manifest.ts` 内、与编辑目标无关，不动。
- **跨模块排序不因此改变**：排序携带完整启用集合身份列表与版本，本来就不限定单个模块（`src/host/module-config-order.ts` 的 `readInputs` 按启用表取输入），本轮只改「写入目标从哪来」。
- 主语由**操作**声明，带来的是可预期的请求与拒绝语义，也带来必须显式传参的成本；单用户本地插件下，多一次 loopback 往返与一次读盘是可接受代价，一致性优先于省请求。

## 后续

- **阶段 2 归属门（已实施）**：各端点的空目标早退与三件套判据已收进 `src/runtime/module-subject-gate.ts` 的 `subjectGate`，`BRIDGE_SUBJECT_POLICY`（12 `required`／4 `optional`／30 `none`）就是门的名单与接口；门由 16 个端点调用（28 个调用点，写端点分别核读写两侧），30 个未解析目录的 `none` 端点不调用。
- **阶段 3 声明面**：服务端判据已落地（`src/host/module-declarations.ts` 的 `moduleDeclarations`／`DECLARED_SECTIONS` 与门的声明面检查：**读**端点要的节没声明即 400 `module-not-declared`，**写**路径不查并建立该节）；**待实施**的是客户端声明下发（`/meta` 的 `declares`）与「没声明就不调用」的界面形态（T11／T12）。
- **阶段 4 Agent 侧与 TUI**：8 个模块工具的主语改为工具参数（今日 `src/host/module-tool-target.ts` 仍取装配记录 `[0]`），TUI 同样显式声明；不阻塞前三个阶段。
- **不持久化「上次选择的模块」**，不引入新的浏览器状态，也不把「加载失败／读不到」当成「没声明」。

## 与历史决策的关系

- 取代 [ADR-0006](0006-module-config-order.md) 中「既定首项写入目标」这一句，以及「编辑目标来自请求头」的单一形态：主语现在**读写都由请求头定位**、写端点另用载荷的 `expectedModuleId` 做一致性校验（见上文与 `docs/architecture-params.md` 的「部署设置与编辑目标」一节）；该 ADR 的配置排序（`module.yml.configOrder`、按模块写回、官方 order 语义）与「轻量序号不新建集中副本」的取舍不变。
- 不改 [ADR-0011](0011-module-participation-criteria.md) 的三个问题与「编辑通道不查启用」：启用表仍然只回答「谁参与装配」，本 ADR 只是把「写入目标」从启用表旁路出去。该 ADR 的消费者／入口表按本条补登，并注明表随实现更新。
- 物化与装配机制、模块身份与官方预设边界（[ADR-0005](0005-preset-to-module.md)）不变：主语是**请求侧**概念，落盘形态、`module.yml` 与 `config.yml` 的存储语义与字段都不动，无数据迁移。
