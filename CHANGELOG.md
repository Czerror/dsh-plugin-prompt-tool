# Changelog

### 删除 characters 兼容面与模块并入（2026-10-24）

- 删除 `charactersImport`／`charactersImportStream`／`moduleMerge`／`moduleUnmerge` 四个 bridge 端点及请求、响应、主语策略与请求形状登记；角色卡导入只走 `importModulePackage`（客户端此前已改走该端点）。
- 删除 host 的 `importCharacterCard`、`importCharacterCardFile`、`mergeModuleIntoModule`、`removeMergedModule`；`src/host/characters.ts` 收为只读的 `src/host/legacy-export.ts`，仅保留导出前的旧私有记忆来源核查。
- 删除 `.characters` 旧库启动提示、`moduleOpen` 的 `/.characters/<id>` 路径分支、预览身份的 `character-card` 类型、客户端角色卡 PNG 解析器与 44 条 `characters.*` 文案；导入对话框去掉 `character` 目的地分支。
- 回归：删除 `characters-protection` 与模块并入用例；角色重导入保留记忆的断言改走 `importModulePackage`；端点清单与契约计数同步（41 端点：required 7 / none 29）。
- 验证：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check`。
- 需重启 DSH 后生效。
- 已知边界：既有模块中的 `meta.mergedModules` 与 `module-<id>-*` 规则不再有撤销入口；导出仍按旧来源核查拒绝无法证明的私有记忆条目。

### pre-step 批执行改在最外层注册（2026-10-23）

- `src/runtime/pre-step-coordinator.ts` 的批执行监听器改为 `{ prepend: true }`：官方 `dsh-tool-skill` 在更内层注册、`await next()` 之后才 append 技能目录，内层过滤拿到的 decision 里没有它，随后外层再 append，`skill-surface` 的 `pre-step-filter` 永远删不掉（隔离 headless 复测 catalog=1）。
- 回归：`test/host/agent-assembly.test.mjs` 新增「先注册的监听器在 next() 之后追加的消息仍会被过滤」；夹具扩展 `beforeCoordinator` 与裸 `rules`。
- 验证：定向用例先红后绿；全量门禁见 PLAN 验收记录。
- 需重启 DSH 后生效。
- 已知边界：无协调器的 standalone 路径（`applyPromptConfigSources` 的 prepend 判据只看 configs）仍不覆盖纯 ruleAction 的 pre-step-filter。

### 回滚契约外 undefined 死防御（2026-10-23）

- 回滚未发布的 `cbf812e9`：`engine/tool-config-engine.mjs` 的 `delegate` / `ask-user` 成功返回值不再做 `undefined` 条件展开，净行为回到 `274a02b3`；删除两条基于契约外桩的测试。
- 依据：`ToolExecutionSuccess.value: JsonValue` 必填（dsh-tools 类型），`ApprovalOutcome` 为闭合联合；两处在官方契约内不可达；本轮未复现线上触发点，真实运行态未触发。本仓已核对的工具返回路径（`module_rules_read` / `module_rules_edit` / `module_variables` / `module_import` / `module_memory_read` / `module_memory_append` / `bash` / `tool_search` / `skill_search`）均已条件展开或字段必填；bridge 载荷走 `JSON.stringify`，undefined 静默丢键属另一类，未在本轮处理。
- 回归：`test/engine/tool-config-engine.test.mjs` 新增 `delegate` / `ask-user` 成功路径的真实 `Context + ToolRuntime` 主路径测试；契约外桩删除后仍有执行器覆盖。
- 保留结论：本轮不新增守卫；若未来宿主放宽 `value` / `answer` 契约，再按真实触发点重新评估。
- 验证：`pnpm test` 884 pass / 0 fail、`typecheck`、`lint`、`build`、`git diff --check` 全过。
- 需重启 DSH 后生效。

### 测试面按 seam 清理（2026-10-23）

- 按 AGENTS.md 测试准入与「不留墓碑」删除 13 条测试、2 个纯原语测试文件、约 13 处墓碑断言；全量测试 895 → 882。
- 删除：`prompt-tool-view` 的 descriptor/base `promptConfigs` 墓碑 2 条；`instruction-card-settings` 重复变体 1 条；`module-declarations` 登记表快照 1 条；`bridge-contract` 前缀常量自证 1 条；`module-subject` 草稿键私有形状 1 条；`rule-steps` 纯 helper 4 条；`template-target` 谓词 1 条；`resource-track` / `official-preset-sources` 两个纯原语文件。
- 收窄：`module-seed` 的 `meta.internal`/`blank` 目录墓碑、`write-module` 的 `.engine`/指纹/`agent.cordis.yml`/旧 `custom-tools` 目录断言、`module-engine-managed-paths` 的旧 `custom-tools` 目录断言。
- 保留：四条 seam 上的主路径/拒绝/边界测试，以及 §12.1 允许的固定卡接线与渲染链路前置纯判据（`layer-cards`、`instruction-cards` 等）。
- 验证：`pnpm --dir $Repo typecheck`、`lint`、`test`（882 pass / 0 fail）、`build`、`git -C $Repo diff --check` 全过。
- 仅测试与变更记录，不需重启 DSH。

### 删除模块改为同卷 rename-aside（2026-10-23）

- 改前 `removeUserModule` 直接 `rmSync` 递归删除；Windows 资源管理器占用模块目录时，UI 报删除失败但目录内容已被清空（2026-10-23 实测）。
- 改后锁内 `rename`，锁外尽力清理；清理失败返回 `backupPath`（清理未完成，残留内容可能不完整），刷新失败以 200 + 结构化 `refreshError` 返回；rename 失败原目录完整不动。删除已提交后不因刷新失败回滚。
- `moduleDelete` 响应增加可选 `backupPath`/`refreshError`；客户端提示残留目录位置并本地化刷新失败。不做回收站、保留期或自动回滚。
- 回归：`test/host/module-management.test.mjs` 覆盖主路径、rename 占用、清理占用、清理中途失败、刷新失败、刷新+备份、锁释放失败。
- 验证：`pnpm --dir $Repo typecheck`、`pnpm --dir $Repo lint`、`pnpm --dir $Repo test`（895 pass / 0 fail）、`pnpm --dir $Repo build`、`git -C $Repo diff --check` 全过；模块删除回归 20 pass。
- 需重启 DSH 后生效。

### layers 注册登记收成一条（2026-10-23）

- `engine/layers.mjs` 新增 `orderedEntry(name, config)`；system-section、conditional、runtime-context 与 placeholder 四处 `ordered` 登记改调它。
- 排序行为不变；`test/engine/layer-order.test.mjs` 覆盖 system-section/runtime-context 两条排序主路径。
- 需重启 DSH 后生效。

### 参数草稿键收进一个 owner（2026-10-23）

- `module-subject` 新增 `paramDraftKey(owner, param)` 与 `ownsParamDraftKey(key, owner)`；UI 拼键与 store 的 `hasRawDraft` 前缀判断改调它。
- 键格式不变（`<owner>:param:<key>`），相似 moduleId 不误判；回归加归属判据用例。
- 需重启 DSH 后生效。

### 指令块标题解析收成一份（2026-10-23）

- 新增 `engine/instruction-blocks.mjs#instructionBlocks`：严格行首 4 种官方指令标题，返回 action/path/index。
- `official-instruction-filter` 改用它替代 matchAll + actionForHeading；`instruction-hint` 的路径提取改用它并排除 removed（顺带修复旧正则对 `Additional`/`Updated` 段大小写不匹配、只提取 `Instructions from:` 的旧问题）。
- hint 不再接受标题前的行首空格；官方格式严格行首，记录为有意收紧。
- 回归：新增 filter seam 测试；hint 补 4 种标题用例。
- 需重启 DSH 后生效。

### v4 来源 kind 收成一份（2026-10-23）

- 新增 `engine/source-kind.mjs`：`pluginKind(owner)`、`pluginOwner(kind)`、`isPluginKind(kind)`；`pluginOwner` 只认 v4 `plugin:<owner>`，`isPluginKind` 兼容旧日志裸 `plugin`。
- `delivery`、`inbox-prepend`、`pre-step-filter`、`append-context`、`layers`、`schema`、`agent-assembly` 共 10 处前缀拼接/owner 解析/旧形态判断改调原语；新增手写声明 `engine/source-kind.d.mts`（只声明 `src/` 消费的 `pluginKind`/`pluginOwner`）。
- 行为逐字不变；回归由现有动作与装配测试承担。
- 需重启 DSH 后生效。

### 每请求模块校验改为 stat 戳（2026-10-23）

- 新增 `host/module-spec.ts#readModulesRevision`：只 stat 启用表/全局 `config.yml`、每模块 `module.yml`、`rules/` 下所有条目，返回源版本戳。
- `agent-assembly` 的模块源检测改为 stat 戳；戳变时再算内容签名（`loadModuleSpec` 剔除 `variables`），内容签名也变才重挂。变量自增/变量-only 编辑因此不触发规则重装配（与旧 `sourceSignature` 语义一致）。全局 `config.yml` 与人设选择仍每次读。
- 签名在 prepare 之后计算，避免重切切片让戳立即过期。
- 回归：`agent-assembly.test.mjs` 补「变量-only 编辑不重挂」；全量 883+ pass。
- 已知边界：内容变但 mtime/size 不变会漏检（与既有 mtime 缓存同风险）；回落到包内模板时戳只覆盖 `<moduleRoot>/<id>`；`templateFile`/`strategyDir`/`configs/` 不在戳内（旧有边界）。
- 需重启 DSH 后生效。

### 指令保存请求身份收进草稿 owner（2026-10-23）

- `instruction-drafts` 新增 `isCurrentSaveRequest(pool, request)`：`saving`/`revision`/`contextId` 一次判据；store 发送前与响应后改调它。
- `applySaveOutcomes` 内部核身份：草稿已重读、切上下文或保存标记已清时，迟到结果不应用（request 缺失的既有行为不变）。
- 回归：谓词矩阵（含手工构造 revision/contextId 不一致）、迟到成功与失败结果；部分成功用例补 saving 在途。
- 需重启 DSH 后生效。

### 压缩包相对路径安全收成一份（2026-10-23）

- 新增 `shared/asset-path.ts#assertSafeRelativePath`：控制字符（`\p{Cc}`）、反斜杠、开头斜杠、空段/./..、段尾空格或点、DOS 保留名、长度一次校验；`maxLength` 与 `reservedRoots` 由调用方声明。
- `asset-archive`、`asset-sources`、`import-source`、`skills-import`、`module-package` 共 11 处调用改用它；删除 `safeAssetPath` 与技能私有 `safePath`。
- 规则取三份的最严并集：`import-source` 与技能导入现在都拒 DEL/C1 控制字符；技能上传入口先把反斜杠归一为 `/`，宿主机目录读取在 POSIX 下新拒字面反斜杠；`com0`/`lpt0` 的旧拒绝面保留。
- 回归：新增 `test/shared/asset-path.test.mjs`；全量 877 pass。
- 需重启 DSH 后生效。

### 清理包：薄封装、零消费者导出与死模块（2026-10-23）

- 删除 host `moduleDeclares`（薄封装；测试改调 `moduleDeclarations(dir).has`）与四个零消费者导出：`normalizeMaxDepth`、`isEditorGroupVisible`、`isModuleCapabilityPresent`、`shouldStreamJsonFile`（含 bridge-client re-export）。
- 删除引擎死模块 `engine/classify-task.mjs` 与不可达的 `kind:'pattern'` 参数分支；`./engine/*` 发布面少一个文件，`./client` 的 `shouldStreamJsonFile` re-export 同时移除——仓外 import 这两处会失败。
- 保留 `skills-provider` / `skills-watcher`（单 adapter，留将来替换官方实现的接缝）。
- 回归：`pnpm test` 871 pass / 0 fail；`typecheck`、`lint`、`build`、`git diff --check` 通过。
- 需重启 DSH 后生效。

### 指令文件身份收进一个 owner（2026-10-23）

- 新增 `host/instructions-policy.ts#instructionFileIdentityOf`：官方 `agent-instructions` 消息 → 本插件指令文件身份；全局路径不依赖基线，项目路径要求可解析的 `baselineIdentity.projectRoot` 与会话 `cwd`，失败返回 `missing-baseline` / `invalid-baseline` / `unknown-path`。
- 协调器删除内联 JSON 解析与身份函数调用，只读 owner 结果；身份不明时按原因 `warnOnce` 一次并放行（不再静默）。
- 回归：`instructions-policy.test.mjs` 身份矩阵；`agent-assembly.test.mjs` 坏基线放行。
- 需重启 DSH 后生效。

### 配置序号尾部分配收成一处（2026-10-23）

- 新增 `shared/module-config-order.ts#nextConfigSequence`：合并现有与保留序号、+10、安全整数检查只此一份；切片恢复、规则事务与排序追加共用，只有缺号/碰号时才计算，已有卡序号与输出不变；host 侧转 `ModuleWriteError`，超限按 400 处理。
- 规则事务新建卡改为跨模块避碰：`module-rules` 通过 `reservedConfigSequences` 读其他启用模块的 projection 序号（含未保存卡的兜底），新卡接全局尾部；任一其他模块定义读不到时跳过该模块，不阻塞当前事务。
- 文档：architecture-params 的序号说明、client 排序注释。
- 需重启 DSH 后生效。

### 桥请求字段表三态化（2026-10-23）

- `BRIDGE_REQUEST_FIELDS` 从 `string[] | null` 改为三态判别联合：`{ body: 'none' }` / `{ fields }` / `{ handler: true, fields }`；删除 `BRIDGE_REQUEST_HANDLER_CHECKED`，表成为唯一登记。
- 新增编译期覆盖：fields 态与 `BridgeRequestMap` 双向对齐，handler 态单向（表键 ⊆ 类型），none 态要求请求类型为 `undefined`；失败分支用 `false` 而非 `never`，断言可真正失败。`triggers` 退役端点的请求类型改为 `undefined`，假契约消失（410 路由保留）。
- 测试名单从表派生，不再手抄 none / handler 集合。
- 需重启 DSH 后生效。

### 技能文件写前校验统一（2026-10-23）

- 新增 `src/host/skills-marker.ts#readSkillMarker`：路径、marker 名、祖先链、普通文件、读后字节与 1 MiB 上限、`writable` 只读位一次校验；frontmatter 解析结果随返回，调用方决定先报冲突还是先报解析。
- `skills-content` 与 `skills-policy` 删除各自的文件级检查；policy 现在与 content 一样拒绝 >1 MiB 文件（此前 `/skill-policy` 能重写 content 拒绝打开的文件）。
- marker 统一只读位检查；content 的既有 `skillWriteRestriction` 仍在前置拒绝，写入边界不变。
- 回归：新增 `test/host/skills-marker.test.mjs`；`skill-policy.test.mjs` 补 >1 MiB 拒绝。文档同步 `docs/skills-management.md`。
- 需重启 DSH 后生效。

### 指令卡壳单一来源（2026-10-23）

- **单一输入**：`instructionShellsRef` 只由 `/bootstrap` 会话段写入；删除 settings descriptor 的 `promptConfigs` 死通道与 `readPromptConfigs`（settings schema 只有 `modulesEnabled`，该值恒空）。
- **字段改名**：`Fields.promptConfigs` → `Fields.instructionCards`，只作投影输出；`patch` 的 `Omit` 同步，`PromptConfigDraft` 类型不改名（仍服务模块卡）。
- **空段清壳**：会话段只要是数组就覆盖（空数组或缺段都清旧壳）；抽 `instructionShellsFrom` 纯函数承载文件卡过滤（非文件身份与非法元素排除，不做 id 名单）。
- **回归**：`test/client/instruction-cards.test.mjs` 新增壳来源两条；`test/client/prompt-tool-view.test.mjs` 锁 descriptor 不再供卡。
- 需重启 DSH 并重建客户端后生效。

### 受众事实收回引擎（2026-10-23）

- 新增 `engine/rule-spec.mjs#audienceOf` / `actionAudiences`：条件树 → 受众集合的唯一判据；`scope.audience` 精确收窄（同节点带 `modelScope: pro|flash` 不算精确），`all` 求交、`any` 保守、`not`/`notAny` 只对精确子节点取补，无法收窄时由调用方保守处理。算子集合从 `COMPOSITE_OPERATORS` 分派，新增算子时测试映射先红。
- 修复（两轴评审）：`not`/`notAny` 对非精确子节点不再取补——`all` 跳过未知子条件、或 `scope` 带 `modelScope` 时，取补会反向排除受众并漏报 append/complete 冲突；现改为返回未知、按两个受众保守处理。
- 宿主 `agent-assembly` 删除 `conditionAudiences` 条件树遍历，`hasSectionAppend` 改为按动作调用 `actionAudiences`：动作级分支条件与规则级 `if` 取交集，规则级 `else` 动作按自带的 `not(if)` 判定，不再叠加 `if`。
- 修复：动作级 `if` 的 `assembly.sections.append` 此前被算作两个受众，与另一受众的 `complete` 误报冲突；`else` 分支的 append 则可能漏判，与同受众 complete 共存。
- 回归：新增 `test/engine/rule-audiences.test.mjs`（13 条，含算子同源映射、非法形状守卫与非精确取补）；`test/host/agent-assembly.test.mjs` 新增动作级与 else 分支两条装配用例。
- 边界：受众事实仍按需派生（纯函数），不写进编译产物；`completeRuleSections` 的 `config.audience` 语义不变。需重启 DSH 后生效。

### Agent 级能力声明原语（2026-10-22）

- 新增 `engine/agent-capability.mjs`：受众判定、Agent scope 声明表、key/scope 变化时的先撤后挂；`mount` 返回 `undefined` 时下次装配重试。
- `present-as` 改用 `capabilityAudience`；`tool-visibility` 的 states/重挂改用原语，restrict/guard 与 failOpen 语义不变。
- 边界：`mount` 返回 `undefined`（执行面依赖未就绪）时保留上一轮声明，不先撤旧闸；原语只收受众判定与声明表，装配层/注册层的受众判定仍用既有 `isDelegated`。不新增动作、配置键或 bridge 端点。
- 回归落在 `test/engine/tool-visibility.test.mjs` 的公共装配 seam（依赖缺失时旧闸保留），不测原语内部状态。

### superpowers 引导改用上游原文（2026-10-22）

- 内置模块正文改为上游 `using-superpowers/SKILL.md` 英文原文（v7.0.1，与本地技能同源），删除中文改写版自加的搜索技巧。
- **Skill Routing 恢复为英文表**：按上游 README 的「The Basic Workflow」七步与「Skills Library」分类整理，技能名与一行描述保持英文原文；此前版本是中文翻译。
- DSH 适配只保留三处：`skill_search` / `skill_load` 调用方式、`superpowers:<name>` 前缀映射、`references/dsh-tools.md` 路径；`SUBAGENT-STOP` 段落保留，同时仍有 `scope.audience: main` 门控。
- 模块版本 1.1.0 → 1.3.0。

### 技能搜索与工具面同口径：any-token 打分（2026-10-22）

- `scoreSkills` 恢复 2026-10-16 的打分制：命中任意 token 即返回，按命中数与精确名排序；长自然语言查询不再回 `No skills match`，与 `tool_search` 一致。`ef30a446` 统一发现引擎时曾回归为 AND 准入，测试已同步改回排序断言。
- `discovery.mjs` 的准入注释同步为「默认 any-token，两个发现面同一口径」。
- 新增回归：`code review 评审 架构设计` 命中 `code-review`，且不把无关技能带出。

### 系统提示段跨模块排序：官方先排，configOrder 覆盖（2026-10-22）

- **瀑布内回填**：`engine/layers.mjs` 以最外层 prepend 监听 `system-prompt/assemble`，在 `next()` 之后按 `configOrder` 重排本插件注册的段/上下文，回填到官方顺序给出的原槽位；平台段与其他插件段位置不动。官方 `order` 仍决定初始槽位，「插入到官方位置」语义不变。
- **判据放宽**：`sameConfigPosition` 对 `system-section` / `runtime-context` 不再要求同官方档位，跨档位可拖；pon 四张卡（order 190/200/201/202）不再被钉死。
- **官方语义变化**：同 order 的共享段原先按段名（sections）或注册次序（contexts）排，现在统一按 `configOrder`；显式注册名与官方档位本身不变。
- **边界**：`complete` 场景平台在瀑布之后才还原唯一段，重排不保证该场景顺序；回填只在本插件注册段之间换位，无法越过平台段；与同层其他 prepend 监听器的相对顺序由宿主决定。
- **验证**：新增 `test/engine/layer-order.test.mjs` 5 条；全量 test/typecheck/lint/build 通过。

### 全量审计修复：运行时装配、安全边界与 sections.append（2026-10-22）

- **F1 组合行 disabled**：模块事实只接受布尔与 `process.platform ===/!==` 受控表达式；disabled 行从 `effectiveModules` 剔除并在装配期跳过，POSIX 不再错误挂载 `tool-git-bash`。
- **F2 run-code-env**：移除首次 apply 固化的 `PATCHED` 闭包；共享 `run_code` 工具只包装一次，按 `exec.agent` 从 WeakMap 取该 Agent 的 keys/ctx；dispose 只撤自己，HMR/晚到工具可复用。官方 arguments 深冻结，未做参数中间件。
- **F3/F4/F8 安全边界**：`env-facts` 只允许安全环境白名单；`instruction-hint` 的 `params.file` 只允许指令文件候选名且 realpath 必须落在 cwd→最近项目根或 DSH_HOME；custom `fs` 五个动作统一 realpath containment，symlink/junction 越界拒绝。
- **F5/F6/F7 静默失效**：官方 recipe 行声明产生一次明确诊断；手改 `customTools` 自动隐含 `tool-config-engine`；`present-as` 缺 `ptcRuntime` 时显式告警，不再静默按 native 跑。
- **F9 shell 执行器**：超时与输出超限给出可诊断 error，显式 1 MiB maxBuffer，正常输出字段不变；Windows 超时尝试 `taskkill /T`，失败退回 `child.kill()`。
- **K3 sections.append**：`assembly` 新增 `target.sections.append`，按段名追加、保留 `order`/`interpolate`、不设 `complete`，同装配 `once` 去重；同受众 known `complete` 在装配准备期拒绝，第三方不可观察 complete 由官方 `assemble` 还原并作为文档边界。
- **测试与门禁**：全量 817 pass；`typecheck`、`lint`、`build`、`verify:host` 39/0、`verify:pack`、`rebuild:module-template -- --check`、`git diff --check` 全通过。`verify:pack` 在 Windows 下补 `tar --force-local`，避免盘符被当作远程主机。
- **生效条件**：需用户重启 DSH 后生效；本轮未停止/重启当前服务，未改宿主源码或 profile。
- **已知边界**：第三方 complete 不可观察；POSIX shell 超时仍只 kill 子进程；env-facts 白名单外键会在挂载期 fail loud。

### 已废弃能力收口（2026-10-22）

- **K1 `stages`**：已按拍板废弃，不恢复阶段状态机；需要渐进披露时用现有通用条件/动作组合自行声明。
- **K2 晋升后 PTC**：已废弃，`present-as` 保持静态 `native`/`ptc` 声明，不按晋升相位重注册。
- **K4 Flash 预算**：`bootstrapMaxTokens` 已随 `tool-bootstrap` 退役；当前 `request-params` 未声明 `modelScope` 时不再按非 Flash 隐式过滤。旧 CHANGELOG 中的「Flash 不等价」是历史迁移记录，不是当前待修项。
- 本轮仅收口文档，不改代码；以上三项不再立 spec 或 PLAN。

### OCR 复核修复：fail-open 判据、指令卡投影与发布门（2026-10-22）

- **工具面判据**：`toolSurfacePlan` 的 `required` 再剔除 `mask.blocks()` 为真的名字——allow∩deny 同名且该名缺席时不再误触 fail-open；`run_code` 排除补直测。
- **执行闸**：装配既无 `tools` 数组也无 `tools:sdk` 段时视为未观察到工具面，不改 `gate.failOpen`；fail-open 告警改用固定去重键，缺项名变化不再各占一条 64 键预算。
- **指令文件探测**：marker 命中最近项目根即停（旧实现会探测到盘根）；删除 `instructionDirs` 不可达回落；宿主 `.git` 判据收进 `src/host/project-root.ts`，指令卡探测与技能扫描共用。
- **客户端投影**：无草稿分支显式清 `contentDirty` / `contentConflict` / `contentSaving`，`params.readStatus` / `readMessage` 与正文、版本一起剥离；`applyView` 与发布路径共用一份投影。
- **patch 契约**：`InstructionFilesPort` 新增 `patchInstructionText(fileId, text)`；`store.patch` 类型不再声明 `promptConfigs`，非正文卡字段不再被静默忽略。
- **发布门**：`verify:pack` 精确断言 `inject` 必需集（`skills/commands/llm/subagents`）；新增 `test/host/entry-surface.test.mjs`（用户批准的准入破例）锁发布入口精确七导出。
- **测试**：新增 allow∩deny、`run_code` 缺项、两面皆缺装配、告警去重、marker 提前停、发布入口导出共 6 条；补强无草稿清视图标记与过期读盘状态两条既有用例；`.hg` 用例改为固定项目根。
- **验证**：见本轮提交与全量输出。需重启 DSH 后生效；`patchInstructionText` 是源码内 API 变化，发布入口不变。
### 发布入口收缩到真实消费（2026-10-21）

- **入口**：`src/index.ts` 的总导出从 149 个降到 7 个（re-export 146→4）——`name` / `inject` / `Config` / `apply`（Cordis 插件协议；`Config` 是配置 schema，缺了它原始 config 会原样传入）+ `loadPromptTemplates`（测试的模板路径锚：`../templates` 只在构建后的 `lib/` 下成立）+ `writeModule` / `userModulesDir`（重物化脚本）。
- **破坏性**：包已发 2.1.0；外部若 import 已删除的符号会直接失败，没有兼容层。
- **测试**：`wave1-safety`、`instructions-policy-endpoint`、`instruction-scope-guard`、`settings-bridge`、`module-management` 共 5 个改为从 src 直连；`module-prompt-configs` 的 `loadPromptTemplates` 保留 lib 导入（路径锚）。
- **发布面**：`verify:pack` 的 smoke 增加 `Config` 与 `loadPromptTemplates`/`writeModule`/`userModulesDir` 断言，并继续检查包内引擎编译与随包技能。
- **验证**：全量 786 pass；typecheck / lint / build / git diff --check / verify:pack 通过。需重启 DSH 并重新安装/链接插件后生效。

### 工具可见面计划：三面共用 fail-open 判据（2026-10-21）

- **判据**：新增 `engine/actions/shared.mjs#toolSurfacePlan`，`required` = 静态 allow ∪ 动态解锁项（去掉 `run_code`），`available` = 装配目录名 ∪ SDK 正文名；缺项即 fail-open。
- **修复**：目录面与正文面原本各算一次 required（正文面不含解锁项，执行闸只在 `tools` 是数组时置位）。现在三面读同一个布尔：`tools` 不是数组时执行闸也随正文缺项放行，解锁项缺项时正文也随目录放宽。
- **行为变化（第三处）**：正文面改为与目录同源的并集判据——静态 allow 里的工具只在目录、不在正文时，正文按名单裁剪（原来整段保留）。
- **告警**：fail-open 时列出具体缺项名字。
- **测试**：新增 `tool-surface-plan.test.mjs` 4 条真值表；`tool-visibility` 补 `tools` 不是数组的集成用例。
- **验证**：全量 786 pass；typecheck / lint / build / git diff --check 通过。需重启 DSH 后生效。

### 层卡片判据收成单一来源（2026-10-21）

- **判据**：新增 `src/client/data/layer-cards.ts#layerCards`，一次给出某模块在某层的卡片（`param` / `capability` / `missingCapability` / `asset` / `add`）；页面层只负责标签、搜索文本与渲染。
- **跨层接口**：`RulesWorkspace` 不再接收四参数谓词 `matchesLayerSettings`，改接卡片数据；`capabilitiesOnly` 由 `kind` 过滤取代，能力补卡按 `kind === 'capability'`。
- **消费点**：渲染、`hasLayerSettings`、搜索视图与 `ModuleCapabilityCreateMenu` 的创建项走同一判据；能力补卡层仍由 `RulesWorkspace` 按能力声明计算（该处未并入）。
- **测试**：新增 `layer-cards.test.mjs` 5 条；客户端定向与全量测试通过。
- **验证**：见本轮提交与测试输出。

### 指令文件卡收成单一 owner（2026-10-21）

- **状态**：正文只由草稿池拥有；`fields.promptConfigs` 改成 (卡壳, 池, 策略) 的投影，新增 `src/client/data/instruction-cards.ts`。
- **删除**：`savedConfigs` / `savedConfigsRef`、`promptConfigsDirty`、`hasPendingVariableRows`、`isAgentsFileCard`，以及 `patch` 里的 complete 互斥分支（卡壳来自 `/bootstrap` 的指令卡快照，卡里没有 complete 字段，分支不可达）。
- **单向流**：`publishInstructions` 与 `publishInstructionPolicy` 内部重投影；`patch` 只把文件卡正文镜像进池；保存后的重载门改用池内未保存草稿数。
- **投影**：剥离卡壳里过期的 `params.text` / `params.revision`，正文唯一来源是草稿池。
- **测试**：新增投影纯函数 5 条（unreadable / 脏标记 / 保存中与冲突 / 过期副本剥离 / 策略覆盖）。
- **验证**：见本轮提交与测试输出。

### 指令文件探测评审修复（2026-10-21）

- **接口**：`resolveProjectRoot` + `instructionDirs` 合成为 `instructionPlan(cwd, markerDirs) → { root, dirs }`，`presentInDir` 收为内部；导出 7→5，宿主调用从三步降到两步，`.d.mts` 只声明 4 个宿主符号。
- **单一判据**：`skills-scan.ts` 的第三份「最近 `.git` 祖先」走链并入同一判据；宿主 `~/.dsh/AGENTS.md` 的识别改用常量拼。
- **文档**：`engine-reuse` 把「唯一判据」限定为候选清单与目录链算法（项目根标记仍由各消费者给）；复制协议段区分判据库与行；`ui-architecture` §12.1 补探测的 seam 覆盖位置；`instruction-hint` 头注释改为只消费执行器。
- **测试**：引擎判据用例压到 3 条（含 UNC，仅 win32 运行）；宿主补 `.git`-only 回归与精准边界断言。
- **验证**：见本轮两个提交的 diff 与测试输出。

### 指令文件探测收成单一判据（2026-10-21）

- **重构**：新增 `engine/instruction-files.mjs`（探测判据 + 引擎侧执行器），`instruction-hint.mjs` 的探测函数迁入；宿主 `agents-cards.ts` 改用同一份候选清单、目录链与选根判据，只保留自己的 `.git` 标记、真实路径校验与展示路径。
- **行为**：宿主 marker 集合不变（仍只认 `.git`），写白名单边界不变。行为变化：根边界——`ancestorDirs` 会探到文件系统根，盘根表示由 `C:` 变为 `C:\`；UNC 前缀不再越级到服务器名。路径拼接由手写 helper 换成 `node:path.join`，Windows 下正斜杠 cwd 的分隔符会归一。
- **验证**：全量 test、typecheck、lint、build、diff --check、verify:host、verify:pack 全绿（见本轮提交）。

### Git Bash 长命令卡片可展开（2026-10-21）

- **根因**：`tool-git-bash` 的 schema 只要求 `command`，没有 `description`。宿主 Bash 卡片把“缺 description”识别成 persistent shell；PTC 嵌套调用带 `parentCallId` 时不走 generic persistent 兜底，于是 `expandable` 为 false。短命令还能从摘要看到，长命令被截断后就没有展开入口。
- **修复**：schema 增加必填 `description`，与官方 bash/pwsh 契约对齐；宿主按标准 terminal card 渲染，长命令可展开查看原文。
- **测试**：新增 `tool-git-bash` schema 契约测试。全量 test 764。

### 工具面作用域与调用事件契约（2026-10-21）

- **作用域**：新增 `engine/tool-scope.mjs#toolScopeSnapshot`，明确区分 `globalNames`（全局层名字，仅供 restrict 的已知名过滤）与 `visible`（agent 可见，含预设/祖先/本层）；`tool-visibility` 与 `tool-search` 均改走该快照，不再各自直接读无 scope 的 `schemas()`。
- **事件**：`engine/history.mjs#TOOL_INVOCATION_EVENT_TYPES` 统一 `tool/call` 与 PTC `tool/ptc-dispatch`；发现/解锁读两类，模型动作与相位晋升仍只看顶层 `tool/call`。
- **执行闸**：allow/deny 合并为同一条 guard，deny 优先；allow 的 fail-open 状态仍由装配结果同步。
- **验证**：全量 test 763 pass/0 fail；typecheck/lint/build/git diff --check/verify:host/verify:pack/rebuild:module-template -- --check 全绿。

### tool-surface allow 不再丢预设工具（2026-10-21）

- **根因**：`tool-visibility` 的 allow 先把 `tools.schemas()`（全局视图）过滤后的名单交给 `restrict`；PTC/预设把 `read`、`write`、`edit`、`glob`、`grep`、`pwsh`、`todo_write` 注册在祖先/agent 层，全局视图没有这些名字，`restrict` 的 allow 反而把它们裁掉，`tool_search` 目录只剩 6 个。
- **修复**：allow 不再调用 `restrict`，执行面由 `guard` 兜底（含预设/祖先与本层工具）；deny 仍用 `restrict` + `guard`。`requireMatch` fail-open 时 allow guard 同步放行。`run_code` 继续作为保留传输豁免。
- **解锁回收**：PTC 下 `tool_search` 的嵌套调用记录为 `tool/ptc-dispatch`，不是顶层 `tool/call`；`fillUnlocked` 同时读取两者，解锁名在下一请求进入 SDK 并通过 allow guard。
- **测试**：真实 PTC allow 保留 `run_code`、拒绝未列 `bash`；PTC harness 增加祖先/预设 scope 工具，锁住 allow/requireMatch/guard 不因全局视图再次裁掉它们。tool-visibility allow guard、deny 消息、PTC dispatch 解锁与 fail-open 断言。全量 test 763。

### superpowers 引导文案重建（2026-10-21）

- **来源**：以 `D:/AI/GitHub/superpowers` v7.0.0 的 `skills/using-superpowers/SKILL.md` 与 `hooks/session-start` 为源，按 `writing-great-skills` / `writing-for-agents` 重写内置模块的常驻提示。
- **文案**：保留 DSH 的 `skill_search` / `skill_load` 按需发现、流程技能优先、计划前 brainstorm、路由表与红旗；以“技能优先”“先查再动手”作 leading word，删掉重复解释与实现细节，保留用户指令优先。模块版本 1.1.0。
- **验证**：YAML 解析、typecheck / lint / test（762）/ build / git diff --check / verify:host / verify:pack / rebuild:module-template -- --check。

### PTC 与工具面收窄兼容（2026-10-21）

- **保留传输**：`tool-visibility` 不再把 `run_code` 当作可裁剪工具。allow 未点名也保留，deny 仍在挂载期拒绝；`restrict` 的 allow 会过滤保留名，避免官方拒绝整条执行闸。
- **可见面判定**：PTC 下 `requireMatch` 以 `tools:sdk` 正文明细与 `tools` 数组的并集为准，`run_code` 不计入缺失；native 行为不变。`tool-surface` 等原生收窄声明因此可直接与 `ptc-mode` 共存，仍由 `tool_search` 按需解锁。
- **技能漂移**：`skills/dsh-module` 的共享参数说明改为以 `ENGINE_PARAM_DEFINITIONS` 为准，移除已退役的 `maxDepth` 与固定键数；补 PTC/run_code 共存语义。
- **验证**：typecheck / lint / test（762）/ build / git diff --check / verify:host / verify:pack / rebuild:module-template -- --check。

### 写盘串行与 CAS 收口（候选 05，2026-10-21）

- **串行原语**：新增 `src/shared/target-queue.ts#createTargetQueue`；agents-cards、module-package、bridge 的 capability/order 队列、client save-queue、agent-assembly、skills-runtime 统一为同 key 进程内串行（后四者是单 key 全链适配）；跨进程互斥只在模块类写路径由 `withModuleLock` 负责，skills/agents 文本无跨进程锁。
- **文本 CAS**：新增 `src/host/versioned-text.ts#replaceVersionedText`；config-store、module-variables、instructions-policy、agents-cards、skills-content、skills-policy、skills-config、module-slices（module.yml）接入统一的「读版本 → prepare → beforeReplace 再核 → 原子替换」，错误码/status 仍由各域提供。
- **边界**：module-package 目录安装、module-config-order 多文件排序回滚与所有 publication/重试语义留在域内；文档见 `docs/ui-architecture.md` §7.3 与 `docs/skills-management.md`。
- **验证**：typecheck / lint / test（756）/ build / verify:host / verify:pack / rebuild:module-template --check 全绿。

### bridge 请求形状统一严格（候选 04，2026-10-21）

- **运行期接受面**：新增 `src/shared/bridge-request-shape.ts`，为 45 个端点声明顶层字段表；所有 JSON 端点未知字段 400 `bridge-request-invalid`。此前 29 个端点静默忽略多余字段。
- **例外**：10 个 handler 已有更具体未知字段错误码/消息的端点保留域内拒绝；6 个 `body:'none'` 端点（含 triggers，不含 ruleDiagnostics）不读体；29 个由统一表拒绝的 JSON 端点里 `ruleDiagnostics` 无字段，任何顶层字段都拒绝。字段表与 `BridgeRequestMap` 通过类型约束和覆盖测试绑定。
- **工具**：模块导入工具复用导入端点字段集；TUI 命令语法不在本轮 JSON decode 内。
- **测试**：新增 45 端点表覆盖、6 none / 10 handler-owned 与宽松端点 400 断言；验证 typecheck / lint / test（738）。

### 规则判定账本归装配实例（候选 06，2026-10-21）

- **owner**：`rule-diagnostics.ts` 改为 `createRuleDiagnosticsLedger()` 工厂；`AgentAssemblyRuntime` 创建时持有账本，`mountRuleSources` 的 `onOutcome` 直接写实例 sink；删模块级 Map、全局 snapshot/dropped 与测试专用 `resetRuleDiagnostics`。
- **端点**：`BridgeDeps.ruleDiagnostics` 注入当前装配快照，`/rule-diagnostics` 只读该快照；无装配/已释放时回空账，不保留上一实例计数。
- **测试**：新增双实例隔离与无账本空账测试；bridge 契约与装配诊断改用注入 ledger/实例快照，不再全局 reset。验证：typecheck / lint / test（735）。

### 工具草稿读改写归 tools-editor owner（候选 07，2026-10-21）

- **owner 收口**：`createToolsEditorDraft`、`readCustomTools`、`insertToolTemplateIntoDraft` 搬进 `src/client/data/tools-editor.ts`；`CustomToolsCard` 只保留渲染/提示，`useTemplatePicker` 改 import data owner，删一条跨 feature import。
- **一致错误落点**：`insertTemplate` 读失败写 `draft.error`（`result.message ?? customTools.loadFailed`），视图的 `editor.refresh` 接线让模板入口插入/失败后立即重渲染。
- **测试**：新增 owner `insertTemplate` 读失败/成功/重复与 SSR 模板插入请求计数；验证 typecheck / lint / test（733）。

### pre-step 来源携带自己的事实（候选 02，2026-10-21）

- **来源接口**：新增 `engine/pre-step-source.mjs`；`PreStepSource` 携带 sourceId/configs/ruleActions/ctx/onOutcome/promotion，`createPreStepSource` 绑定来源 ctx，`composePreStepSources` 检查唯一 promotion owner 并按 rule 分派对象上报。
- **批执行**：`runPreStepBatch({ sources })` 合并来源、始终按配置序号排序；`applyPromptConfigSources(sources, options)` 成为唯一 apply 入口，`applyPromptConfigs` 删除；`inject-text` 动作构造单个来源。
- **协调器 v2**：服务持有唯一 promotion pool/pair 并暴露给来源；`registerPreset(sourceId, source)` 不再改写 `config.resolve`、不再自建 rule→module 映射；`mountRuleSources` 按模块构造来源并复用协调器池。
- **类型**：`PreStepSource`/`PreStepPromotion` 由 `engine/pre-step-source` 声明；协调器删除重复的 `PreStepPromptConfig`，服务版本升 2。
- **破坏性变更**：`applyPromptConfigs` 与 `PreStepPromptConfig` 删除；`runPreStepBatch` 只收 `sources`，`registerPreset` 改收 `(sourceId, source)`，`applyPromptConfigSources` 不再收 ctx。复制引擎的调用方必须迁移到 source。
- **测试**：新增来源合并/ctx 绑定/owner 不一致拒绝与协调器混合来源行为断言；无旧 API 墓碑测试。验证：typecheck / lint / test（731）/ build / git diff --check / verify:host / verify:pack / rebuild:module-template -- --check。

### 清理 03 遗留：condition-facts 与 subject 单一来源（2026-10-21）

- **命名**：`engine/condition.mjs` → `engine/condition-facts.mjs`；更新 import、注释、ADR 与测试引用。它只做 live 条件的文本事实提取，条件判定归 `conditions/*`。
- **单一来源**：`KNOWN_SUBJECTS` 从 `condition-facts` 的 `SUBJECT_FIELDS` 派生，`/meta` 的 `subjects` 与 live 条件使用同一份名单。
- **文档去重**：技能参考的层表不再抄字段矩阵，改为指向 `/meta` 的 `layerFieldPolicies` / `engine/schema.mjs`；保留层入口、策略与 params 语义。
- **测试**：不新增墓碑测试；纯改名/单一来源/文档去重，既有 live 条件回归覆盖行为。验证：typecheck / lint / test（725）/ build / git diff --check / verify:host / verify:pack / rebuild:module-template -- --check。

### 退役声明式 config.subject/match，conditions/* 成为唯一条件模块（2026-10-21）

- **引擎收口**：删除 conditionHit、normalizeMatch/matchScan、config.subject/match 与逐层 subjects/defaultSubject/layerDefaultSubjects；live 条件继续使用 conditions/* 与 condition-facts.mjs（原 condition.mjs）的 subjectTextOf/文本 helper。
- **客户端收口**：删除 MatchFields、PromptConfigMatch、表单条件块与旧 locale；保留 meta.subjects 供 live text.subject / anchor.subject 下拉。
- **契约收窄**：层字段矩阵 9 项；共享 LayerContract 去掉 subjects；宿主 PromptConfigSpec 去掉 subject/match；ADR-0007 补实现状态。
- **测试**：删除 match 专用用例；live text/anchor 条件测试保持绿色。验证：typecheck / lint / test（725）/ build / git diff --check / verify:host / verify:pack。

### 模块安装事务：五条目录创建路径收成一个 seam（2026-10-21）

- **新事务**：`src/host/module-install-transaction.ts` 的 `installModuleDirectory` 拥有暂存、锁、版本复核、备份、交换、回滚与清理；`expectedVersion: null` 表示目标必须不存在，string 表示必须等于该目录版本。
- **五条路径接入**：`writeModule`（整目录）、`installModulePackage`、blank、copy、`ensureModuleSeed`；`writeModule.stageOnly` 删除，包安装不再嵌套第二层暂存。内置模块仍只补缺失，用户副本不覆盖（ADR-0015）。
- **失败语义**：冲突/目标已存在返回 typed outcome 并由调用方映射既有错误；交换失败恢复成功照抛原错误；恢复失败保留备份并返回 `recovery-required`；清理失败返回 `installed + leftoverStage`，不把已落盘说成失败。
- **测试**：新增 `test/host/module-install-transaction.test.mjs`（create/replace/conflict/version-window/build 失败/取消/回滚/清理）；`module-seed.test.mjs` 补「用户改过的内置模块不被覆盖」；包安装装载窗口测试改用新暂存前缀。
- **验证**：typecheck / lint / test（728）/ build / git diff --check / verify:host（39 项）/ verify:pack。

### 条件与动作统一编排（2026-10-21）

- 移除 guide-auto；文本条件支持含端点的 minChars/maxChars，按本批全部真实用户文本分类，模板分支选择静态正文。
- 工具名统一使用 names 条件；append-context 只追加工具后上下文，续跑只走 turn-stop 注入；请求参数只走 request-params，流透传和替换使用 stream-output。
- 九层继续用于展示与规则归属；六层允许 inject-text。工具可见面保留名单、发现与执行闸，受众归 scope，首轮提示拆为普通注入动作。
- 工具提示保留自动常驻名单：tool-catalog 填充器只读引用同规则工具可见面声明，提供 RESIDENT_TOOLS / DISCOVERY_TOOL，正文与投递仍由模块普通规则控制。
- 同步内置模板、工具面模块、工作台字段与文档；旧专用入口直接移除，无兼容层。

### 通用确认条件与投递关联（2026-10-21）

- **确认与注入分离**：`anchor` 支持用户消息、模型推理、模型回答和工具结果，复用现有匹配器；`after.action` 引用同规则动作的实际投递，排除旧输出与 fork 继承误触发。
- **等待与恢复**：默认持续等待，可显式设置正整数 `fallbackAfter`；第 N 个含所选内容块的完整输出未命中时兜底，中断模型消息不计。当前可见上下文变化后重新判断，turn-stop 支持 session 去重并遵守取消信号和续跑预算。
- **直接替换**：移除 first-turn-anchor、anchor-notice 及专属参数入口，无兼容层或自动迁移；guide-auto 保留。投递身份和查询抽到 `engine/delivery.mjs`，普通动作负责正文、位置和来源元数据。
- **编辑与模板**：规则编辑器支持确认来源、关联起点和可选兜底的添加/清除；模板14直接匹配当前用户消息，模板16组合锚句、确认及正文。保存前校验引用、循环和可核验投递身份。

### 引擎契约文档与全行一致性测试（2026-10-20）

- **文档**：`docs/engine-reuse.md` 新增「引擎契约（加载器视角）」：12 个本地引擎行（`./engine/<id>.mjs`，加载器 import + apply）与 3 个官方 recipe 行（`cordis:group` / `@deepseek-ai/*`，无本地文件、加载器跳过）的分类；五条契约（身份/入口/依赖/配置/清理）、失败模式与「不做通用能力注册表」的触发条件。
- **测试**：新增 `test/host/engine-contract.test.mjs`，按 `name` 分类遍历组合源：本地行校验文件存在、`name` 与 id 对齐、导出 `apply`、`inject` 为字符串数组、`configContract.parse` 为函数；官方行校验 `name` 非空且无本地引擎文件。行数从目录读取，新增行自动纳管。
- **清理**：删除 `engine/tool-config-engine.mjs` 中无消费方的 `engineProvider` 兼容导出，并同步 `tool-config-engine.yml` 的行注释（能力提供边界仍保留）。
- **验证**：typecheck / lint（0 warning）/ test（708）/ build / git diff --check。

### 发现引擎：一份搜索实现，两个数据源；工具可见面只消费元数据（2026-10-20）

- **共享实现**：新增 `engine/discovery.mjs`，统一分词（`queryTokens`）、打分（`scoreRows`）、准入排序（`rankRows`）与截断渲染（`renderRows`）。`tool-search` 与 `skill-search` 不再各写一份搜索；两者语义差异（工具 any-token、技能 all-token）由一行 `admit` 钩子决定。
- **互相调用走服务**：宿主 root provide `promptToolDiscovery`（`createDiscoveryRegistry`），adapter 行在 `apply(ctx, config, { agent })` 时按 agent 登记元数据；`tool-visibility` 在首次装配用 `ctx.get` 解析（cordis 的 `get` 不要求 inject），不再 import `createToolSearchDefinition`，也不再自己注册发现工具。
- **声明收敛**：`discovery` 改为 `{ kind }`（`tool`/`key` 可选，只作断言）；工具名与解锁键来自 adapter 元数据。声明了 `discovery` 的模块必须把对应行（`tools` → `tool-search`、`skills` → `skill-search`）列进 `modules`，缺行在装配准备期 fail-loud；运行时解析不到只告警一次并跳过解锁回收，不阻断装配。
- **行语义不变**：`tool-search` / `skill-search` 行仍自己注册工具（单独挂行行为不变），额外登记 adapter 元数据；`skill-search` 的宿主挂载路径不变。
- **破坏性变更**：`discovery` 旧形状 `{ tool, key }`（无 `kind`）现在编译期拒绝；内置 `tool-surface`、模板 80 与根 `module.yml` 已迁移为 `{ kind: tools }` 并在 `modules` 列 `tool-search`。
- **测试**：新增 `test/engine/discovery.test.mjs`（注册表按 agent 隔离/幂等/重复拒绝、准备期缺行校验、共享搜索与渲染）；可见面用例改为注册表元数据驱动，历史读取与模板用例同步迁移。
- **验证**：typecheck / lint / test（707）/ build / git diff --check。

### 删除 tool-pipeline 层无法执行的参数声明（2026-10-20）

- **问题**：该层没有注入通道，`toolNames` / `preDecision` / `denyReason` / `postAction` 没有任何消费者，却仍被声明、校验、归一化（`toolNames` 数组转 CSV），最终只换来一次「层不可注入」告警。
- **修复**：从 schema 的 `editing.params` 与 `normalizeLayerParams` 里删除这四项；客户端不再用 `params.postAction` 决定是否显示结果正文（`tool-result` 内容直接可编辑）。
- **保留**：`agent-request` / `llm-stream` 的层参数仍是 `inject-text` 的真实实现，不动；工具链行为由 `tool-gate` / `tool-result` 动作承担。
- **验证**：typecheck / lint / test / build / git diff --check。

### 工具链裁决拆成 `tool-gate` / `tool-result`，退役 `decision`（2026-10-20）

- **一个动作两套字段表**：原 `decision` 的七个字段由 `phase` 决定哪半被读，另一半被白名单收下却静默忽略。现在拆成两个动作：`tool-gate`（pre：`decision`/`reason`/`toolNames`）与 `tool-result`（post：`action`/`text`/`toolNames`）。
- **写错相位即编译期错误**：错相位字段从「收下不读」变成未知字段；编辑器元数据按 kind 生成，不再给出无效字段。
- **破坏性变更**：`decision` 从 catalog 与引擎删除（编译期 `unknown action`）；模板 60 与根 `module.yml` 已迁移；仓库内没有用户模块使用它。
- **测试**：动作通道、裁决三档、结果处理（replace/block/accept）、预算与规则编译断言全部迁移；新增结果处理主路径用例。
- **验证**：typecheck / lint / test / build / git diff --check。

### 工具可见面统一为 `tool-visibility`，退役 `guard` / `sdk-strip` / `tool-narrow`（2026-10-20）

- **一份声明一个意图**：`tool-visibility` 同时拥有装配目录、`tools:sdk` 正文、执行闸（restrict + guard）、发现工具与首轮提示；`allow` 与 `deny` 对齐官方 `ToolRestriction` 的 and/or，`audience` 只保留 `main`/`subagent`/`all`。
- **条件可撤销**：动作在条件不命中时经 `rule-runtime` 的未命中回调撤销上一轮注册的闸，修掉旧 `guard` 的跨轮粘性（首轮为真后永久留闸）。
- **破坏性变更**：三种旧动作从 catalog 与引擎删除（编译期报 `unknown action`）；`assembly.target.tools` 编译期拒绝并指向新动作；ST 导入的 `enable_web_search: false` 由三条规则改为一条。
- **发现工具与提示**：`tool-search` 改为参数化工厂，常驻集与解锁键来自声明；提示交给既有 prompt-config 引擎执行，正文按声明生成。
- **测试**：新增 `test/engine/tool-visibility.test.mjs`（9 例），PTC 用例迁移到新动作。
- **验证**：typecheck / lint / test / build / git diff --check。

### 修复 `sdk-strip` 的 `requireMatch` 空转，并补 Python SDK 裁剪回归（2026-10-17）

- **问题**：`engine/actions/catalog.mjs` 把 `requireMatch` 列为 `sdk-strip` 的字段（因此进入规则编译白名单），`createMask` 也解析了它，但 `engine/actions/sdk-strip.mjs` 从未消费——规则写 `requireMatch: true` 既不生效也不报错；同名字段在 `assembly` 上却是 fail-open。两动作共用名单时，`assembly` 暴露完整目录后 `sdk-strip` 仍按名单裁正文，模型看到的目录与 SDK 正文不一致。
- **修复**：`sdk-strip` 按与 `assembly` 相同的判据处理 `requireMatch`（只对白名单有意义）：`mask.allow` 中任一工具不在本段正文 → 放弃裁剪、保留完整正文，并沿用同一 warnOnce 方向（"keep the full SDK text (fail-open)"）。`deny` 模式与 `assembly` 的 `required === undefined` 一致，不触发。
- **测试**：`test/engine/actions.test.mjs` 新增两条——(6b) 真实 PTC Python 段：异名工具 `# tools["my-tool"]` 注释保留、被剔工具及其 TypedDict 消失、保留方法仍在；(6c) `requireMatch` 命中时正文逐字节等于裁剪前，不写时照白名单裁剪。Python 分支此前零覆盖，真值源是官方 `renderToolsSdkPy` 经真实 assembly 生成的文本。
- **对齐实测（只读探针，未入库）**：用宿主 HEAD 的 `renderToolsSdk` / `renderToolsSdkPy` 直连对拍，TS 的两张 interface、成员/JSDoc/引号键/`& Record<string, JsonValue>;` 与 Python 的 `class Tools(Protocol)`、`async def`、`# tools["x"]`、footer、TypedDict 可达性均可被当前解析器裁剪；16 项断言 PASS，Python 全裁按设计返回原文。
- **文档**：`docs/engine-reuse.md` 的「工具面收窄」段与 `skills/dsh-module/reference.md` 的动作表补 `requireMatch` 语义。
- **验证**：`typecheck`／`lint`（0/0，315 文件）／全量 test（**700 pass / 0 fail**，本轮 +2）／`build`／`git diff --check` 全绿。

### 新增内置模块 `ptc-mode`：把工具面切成 PTC（`present-as` + `run-code-env`）（2026-10-16）

- **模块内容**（`modules/ptc-mode/module.yml`，随包分发、默认不启用）：声明两行——`present-as`（在 **Agent scope** 调官方 `ctx.tools.presentAs('ptc')`，注册表只贡献保留的 `run_code` 传输与生成的 `tools:sdk` 段）与 `run-code-env`（PTC 下 run_code 程序里的 `process.env` 恒为空，该行注入冻结的 `env` 全局并注册 `## run_code environment` 提示段；只在存在 `run_code` 传输的 scope 生效，native 会话零副作用）。
- **刻意不带规则**（`rules: []`，也不声明 `rule-engine`）：PTC 下模型收到的指引已由官方两侧给足——dsh-tools 的 `PTC_ONLY` 段与生成的 `tools:sdk` 段，加上 `run-code-env` 的环境提示段；插件侧再叠提示只是重复。
- **为什么用插件自己的行而不是官方预设行**：`@deepseek-ai/dsh-agent-tool-presentation` 是官方组合行，而模块的 `modules:` 只能装 `engine/compositions/source/local/` 下的文件；`present-as` 调的是同一个 `presentAs`，语义等价而 scope 不同（本行 Agent scope vs 官方行预设常驻 scope，`modeFor` 沿链路最近者优先）⇒ 不必改会话预设、也不必改 `cordis.patch.yml`（那条只用于进程级默认呈现）。
- **行名必须与引擎文件同名**：这条纪律写进模块注释（`agent-assembly.ts:186-188` 按 `engine/<行 id>.mjs` 找实现，找不到静默跳过）——上一轮 `present-as-ptc` 正是这样被丢掉的。
- **测试与文档**：`test/host/settings-bridge.test.mjs` 的「包内真实模块声明面」循环加入 `ptc-mode`（四 → 五）；`docs/engine-reuse.md` 的 present-as 段指向本模块；`NOTE.md` 目录说明同步。种子化只补缺失目录，已有同名模块（含用户自建的同 id 副本）**不被覆盖**。
- **验证**：`typecheck`／`lint`／全量 test／`build`／`git diff --check`／`rebuild:module-template -- --check`。

### 修复 `present-as` 行名：组合源文件名必须与 `engine/<id>.mjs` 同名，否则被静默跳过（2026-10-16）

- **上一提交的缺陷（自查发现）**：组合源原名 `present-as-ptc.yml`（行 id `present-as-ptc`），而引擎实现是 `engine/present-as.mjs` —— `agent-assembly` 按 **`engine/<行 id>.mjs`** 找实现（`src/runtime/agent-assembly.ts:186-188` 的 `engineModuleFile`），找不到就 `continue` **静默跳过整行**（官方组合行没有 engine 文件属正常，所以这条跳过不告警）。后果是「模块装了等于没装」而毫无提示：`prepareAssembly` 只装出隐含的 `instruction-hint`，`present-as` 从未进入装配。
- **修复**：组合源改名 `engine/compositions/source/local/present-as.yml`、行 id 改 `present-as`，与 `engine/present-as.mjs` 对齐；模块定义声明 `present-as`；约定写进行内注释与模块注释（**行名 = 引擎文件名**）。根 `module.yml` 的可用模块清单由 `rebuild:module-template` 重新生成。
- **三层验证（隔离，不碰运行实例）**：① 链路——模块定义 → 组合源 → 行 config `{enabled: true, mode: ptc}`；② **真实 ToolRuntime + SystemPrompt**：部署默认 native 下工具面 `[bash, read]`、无 SDK 段，跑 `present-as` 行后变 `[run_code]` + `tools:sdk` 段 2245 字符；③ `prepareAssembly` 装出 `[{present-as, mode: ptc}, {instruction-hint}]`（修复前只有后者）。
- **一处记录**：这次是"静默跳过"第二次咬人（第一次是 `requireMatch` 的名字缺失 fail-open）；`engineModuleFile` 的跳过对官方行是正确设计，**故意不加告警**，改由注释与本文记录约定。
- **验证**：`typecheck`／`lint`／全量 test／`build`／`git diff --check`／`rebuild:module-template -- --check`。

### 新增 `present-as` 行：模块可在 Agent scope 直接声明工具呈现（PTC），不必改预设或 profile patch（2026-10-16）

- **起因**：用户问「PTC 能否运行时装配，而不是写进 `cordis.patch.yml`」→ 查证官方入口 `ctx.tools.presentAs` 只接受 **scoped ctx**（`core/tools/src/index.ts:985`：context-global 调用直接抛错，并把进程级呈现指回 `tools` 行的 `mode` 字段），而本插件的模块行恰好挂载在 **Agent scope**（`src/runtime/agent-assembly.ts:390` 的 `agent.ctx.plugin(...)` → `:436` `module.apply(scopeCtx, …)`）⇒ 模块有资格直接声明呈现，这一层此前空着。
- **`engine/present-as.mjs`**（新行）：`inject: ['tools']`，配置契约 `{ enabled（默认 false）, mode: native | ptc（必填） }`。`native` 直接声明；`ptc` 用 `ctx.inject(['ptcRuntime'], …)` 等运行时再声明——等不到就停在 pending 由预设注册表指名报告，**不静默退回 native**（否则「开了 PTC」的部署会悄悄以 native 跑）。`presentAs` 本身就是 effect，本行不另包 disposer；`ptcRuntime` 刻意不进 `inject`（否则 `native` 行被绑死在「部署必须有 PTC 运行时」上，官方同一取舍）。
- **`engine/compositions/source/local/present-as-ptc.yml`**：模块可经 `modules:` 声明它 ⇒ 这是**插件自己的实现**，不是搬官方 `@deepseek-ai/dsh-agent-tool-presentation` 行，因此不触碰「官方工具由会话原有预设提供、模块不重新声明它们」那条约束。与官方行 scope 不同（Agent scope vs 预设常驻 scope，`modeFor` 最近者优先），而**同一 scope 二次声明仍由官方 fail loud**（`module.apply` 抛错会让装配失败，`agent-assembly.ts:436-448` 不捕获、rethrow）。
- **不搬 `skill-surface` 那套**：`skill-surface` 能只拦官方 `dsh-tool-skill` 的**注入产物流**（`source.kind = skill-catalog`），是因为技能目录只是一条消息；PTC 是**注册表呈现模式**，同时决定 tools 数组、`tools:sdk` 段与 `run_code` 程序里的绑定，而 native 下官方 `sdkSection().text` 直接返回空串（拣不到 SDK 正文）⇒ 改装配/拦注入到不了位，必须让 registry 的 mode 变 ptc。
- **未做（留给后续）**：B7 T3 退役 `promoted-code-mode` 时记的净损失之一是「晋升后才呈现 PTC」的时机特性——本行只做**静态声明**，把它接回晋升时机需要「能调 presentAs 的规则动作」或按条件选择行，本轮未实现；两处已无消费者的 `presentAs` 测试桩（`promotion-gate.test.mjs`、`history-full-reads.test.mjs`）也未清。
- **测试**：`test/engine/present-as.test.mjs` 四条——ptc 等运行时且等不到时不声明、native 不依赖运行时、未启用即关闭与非法配置（未知键/非布尔 enabled/缺 mode/非法 mode）挂载期拒绝、契约面（插件名 / `inject` / 配置键集）。
- **验证**：`typecheck`／`lint`／全量 test（**691 pass / 0 fail**，本轮 +4）／`build`／`git diff --check`／`rebuild:module-template -- --check` 全绿。

### 装配刻度表对齐实际宿主：context 档位补全 7 项、取值改容错口径；NOTE.md 目录说明改正（2026-10-16）

- **触发是 PTC 对照**：用户问「PTC 模式启用是否完整对照官方」→ 逐项核对后，PTC 本身的契约四项全部对齐（`tools:sdk` 段名、`PTC_ONLY` 在 policy 组、`run_code` 保留名三处纪律、以及**不依赖预设的部署级启用路径** `tools` 行的 `config.mode`）；漂移出在两处外围，本轮修掉。
- **`src/shared/official-orders.ts` 的 context 档位 3 → 7 项**：官方 `CONTEXT_ORDERS` 在安装的 `@deepseek-ai/dsh-system-prompt@0.2.1-alpha.3` 与 registry 最新的 `alpha.4` 都是 7 项（多 `WORKING_DIRECTORY` 100、`TEAM_IDENTITY` 125、`HARNESS_SOURCE` 200、`WEB_SURFACE` 210），本文件原声明 3 项、注释仍写「官方 `CONTEXT_ORDERS`（3 项）」——那是 `0.2.0-rc.1` 的旧基线。section 侧 32 项经逐项核对与 alpha.2／alpha.3／alpha.4 三版一致，未动。
- **取值口径改为容错**（2026-10-16 用户拍板）：原实现「任一档位名取不到有限数即**整组**返回 undefined」会让旧宿主（`alpha.2` 的 `CONTEXT_ORDERS` 只有 4 项）的刻度**整体消失**——比区间偏窄更糟。改为「取得到值的档位参与 min/max 求界，**一个都取不到**才缺席」：`alpha.2` 得 100–120、`alpha.3+` 得 100–210，两者都是该宿主真实存在的档位区间。代价（已写进注释）：官方**改名**（而非新增）时那个名字会被静默跳过、区间变窄，不再整表缺席。
- **`NOTE.md` 目录清单改正**：删掉不存在的 `preset/`（原文还列着 `pt-standard`/`pt-ptc`/… 五个预设，而仓库、`package.json#files`、用户 `.agent-presets/` 都没有）与已退役的 `engine/compositions/library/`；`skills/` 那条说反了（`skills/dsh-module/` 确实随包分发，技能**库**才由官方根或用户引用目录提供）；补 `modules/` 一行，并写明预设不随包分发与 PTC 的宿主侧启用归属。
- **验证**：`typecheck`／`lint`（0/0）／全量 test（**687 pass / 0 fail**，容错口径在 alpha.2 测试依赖下仍正常下发刻度、测试零改动）／`build`／`git diff --check` 全绿。

### 工具面常驻集纳入 `bash`：Windows 走 `tool-git-bash` 行、POSIX 用官方持久 bash（2026-10-16）

- **起因是用户在自己环境里手工改的模块副本**（`$DSH_HOME\.prompt-tool\modules\tool-surface\`）：它加了 `tool-git-bash` 行并把 `bash` 写进 `allow`，本轮把这份定制同步回随包内置模块与模板。
- **内置 `tool-surface`**（`modules/tool-surface/module.yml`）：`modules` 增 `tool-git-bash`、`allow` 增 `bash`、`description` 与首轮 notice 正文同步。notice 新增：`bash` 跑 Git Bash（`bash -c`，每次新进程），命令执行优先用它、Windows 原生工作留 `pwsh`。
- **刻意不同步 `layerSettings`**（用户拍板）：环境里那份还写了 `layerSettings.tool-pipeline.toolGitBashEnabled: true`，值与能力卡默认相同（组合源也显式 `enabled: true`），但声明它会让模块**覆盖全局开关**、并打破内置模块「只声明 rules/modules」的声明面契约（`test/host/settings-bridge.test.mjs` 断言四个包内模块都不含 `layerSettings`，本轮先被它拦下）。代价是全局关掉该能力时 `allow` 缺 `bash` → 收窄整体 fail-open，这条边界写进了模块注释。
- **同名两条来源，两侧都不缺名**：`engine/compositions/source/local/tool-git-bash.yml` 自带 `disabled: process.platform !== 'win32'`（官方 PTY 后端在 win32 不可用，改用普通 subprocess 的 Git Bash），POSIX 上由官方持久 bash 提供同名 `bash`。`requireMatch` 因此不会因 `bash` 触发 fail-open。
- **notice 正文按 Windows 事实写**：POSIX 上「Git Bash / 每命令新进程」不成立，模块注释标明要分平台改文案得另立分支——不为此引入按平台的注入分支。
- **同步的另两处**：`templates/80-tool-surface.yml` 的 `allow` 与前提注释（模板只带规则、不带 `modules` 声明，用模板建模块要把提供方行自己带进装配）；`engine/tool-search.mjs` 的 `RESIDENT`（模型看到的常驻集清单）。根 `module.yml` 由 `rebuild:module-template` 重新生成。
- **已启用该模块的用户不会自动拿到**：`ensureModuleSeed` 只补缺失目录，已有副本保持原样；要生效得从模板重建模块，或照改自己那份。
- **验证**：`typecheck`／`lint`／全量 test（**687 pass / 0 fail**）／`build`／`git diff --check` 全绿，`rebuild:module-template -- --check` 生成物一致。

### 技能发现文案补两处缺口：空结果指向空参列举、`skill_load` 名字归一（2026-10-16）

- **起因是上一提交的盲测**：两条子代理分别在隔离会话里实测（逐字返回记录已随本轮清理，结论如下），A 覆盖 `skill_load` 六种非法名与 `skill_search` 空结果/空查询共 8 例；B 覆盖四种空结果、空参列举与真名加载注入。**B 的关键发现推翻了「强化段在起作用」的假设**——拦住它「自己去翻技能目录」冲动的，是 `skill_search` 描述里 `call with NO arguments — list every visible skill` 这条**正向入口**；空结果文案本身只把它推向 `skill_load`（它恰恰没有名字）或「问用户」（子代理没有可问的用户）。这与上一提交的判断同向：起作用的是正向入口，不是反禁令。
- **缺口一（空结果没有下一步）**：空结果文案补 `calling skill_search with no arguments lists every visible skill`；`skill_load` 未知名分支维持 `ask the user for it`，两条恢复路径互补。参考 `tool_search`——它的空结果文案自带精确名出路（`unlock it directly by exact name`），技能侧此前缺这一条。
- **缺口二（参数校验缺失）**：A 实测空串 / 纯空白 / 通配符 / 路径分隔符与真正拼错返回**字符级同构**的「未注册」，调用方分不清「输入非法」与「技能不存在」。按 `tool_search` 的 `unlockNames()` 同口径做名字归一：非字符串与去空白后为空走专属返回 `skill_load needs an exact skill name …`；其余路径（注入事件 id、`source.name`、去重判定）一律改用归一后的 `name`，避免注入名与加载名不一致。
- **测试**：空结果断言改为断言新的下一步指引；`skill_load` 空名字新增一例（`''` / `'   '` / `42` / `undefined` 都走专属文案且不查注册表），并覆盖「前后空白仍能命中注册表后正常注入」。
- **验证**：`typecheck`／`lint`／全量 test／`build`／`git diff --check`。

### 技能发现文案改正向表述：删掉「空结果不决议」强化段、准入契约单源（2026-10-16）

- **起因与措辞订正**：用户先纠正我把「模型搜不到就转去 `glob` 翻 `.dsh\skills` 猜名字」判断成可行兜底，明确该行为**绝对不能使用**；随后要求按 `writing-for-agents`／`writing-great-skills` 两条准则优化文案。准则的 negation 条与这两条判断同向：提示层写反禁令会先把被禁行为请进上下文、再用弱修饰符去压它，禁掉的念头反而更可得。
- **删掉 299 字符的 `IMPORTANT` 强化段**（`engine/skill-search.mjs`）：它用 `does NOT mean` / `Never conclude` 讲「空结果 → 技能不存在」这条要防的推断，等于把那句话写进上下文；而 `glob` 类行为一个字不提，才是不给它任何可用措辞。
- **准入契约收成单源**：`skill_load accepts ANY exact name in the registry` 原先在 `skill_search` 描述与 `skill_load` 描述各写一遍，现只在 `skill_load` 描述里陈述一次（`any exact name in the registry works`），并并入「没有命中时向用户确认精确名」这个正向入口。
- **`skill_search` 描述 776 → 383 字符**：删掉 AND 过滤时代的 `1-2 short words work best`（实现早已改成打分排序、长查询不会全灭），空查询一项与 `renderMatches()` 的分支对齐；`skill_load` 因并入正向入口 281 → 326，两工具合计 1057 → 709 字符。
- **运行时文案同向改**：空结果与未知名两份返回不再复述「不代表不存在」，改为正向陈述准入契约并给出下一步（`the user can name one` / `ask the user for it`）。三条测试断言随之更新；`docs/skills-management.md` 的同一句表述同步。
- **验证**：`typecheck`／`lint`／全量 test／`build`／`git diff --check`；仓库内 `does NOT mean` 与 `Never conclude` 归零。

### 捷径注释标记改名：`ponytail:` → `shortcut:`（对齐上游 2a1fe84，2026-10-16）

- **起因**：用户指出 `ponytail:` 注释格式已被上游抛弃，要求全清。**查上游本地源码 `D:\AI\GitHub\ponytail`（main，HEAD `84740e3`）后修正了结论**：上游没有废弃这个约定，而是做了品牌去名化——PR `2a1fe84`「neutral `shortcut:` marker instead of the `ponytail:` brand in code comments」一次改动 30+ 个文件，规则行变成 `- A shortcut with a known limit gets a code comment in this form: \`shortcut: <the limit>, <when to upgrade>\`.`；`ponytail-debt` 扫描器**保留并向后兼容**：`git grep --no-index --exclude-standard -nE '(#|//|/[*]) ?(shortcut|ponytail):'`，输出 `No shortcut debt. Clean ledger.`。
- **仓库内清理（17 处代码注释 + 2 处规则正文 + 1 处 ADR 指向）**：`engine/{compaction-epoch,conditions/subject,executor×2,history×2,layers×2,sdk-strip×2,shared×2,skill-search}.mjs`、`src/host/{instructions-policy,module-layer-settings}.ts`、`src/client/data/use-prompt-tool-store.ts`、`test/host/settings-bridge.test.mjs` 的标记前缀统一改为 `shortcut:`（**保留注释内容**——它们是「为什么这样够用 + 什么时候升级」的说明，删掉就丢了信息）；`modules/ponytail/module.yml` 两处规则正文（主会话 + 子代理副本）按上游新措辞重写，`ponytail:` 债务扫描说明同步改名。
- **技能库同步（`$DSH_HOME\skills`，4 个技能 6 处）**：`ponytail`、`ponytail-audit`、`ponytail-review`、`ponytail-help`、`ponytail-debt` 按上游逐行对齐（引用处改为「`shortcut:`（或较旧的 `ponytail:`）」以保留兼容读法）。本机副本另有中文 `description` 与 `argument-hint`，属本地定制，**未覆盖**。
- **未改**：`CHANGELOG.md` 自身的历史条目（v5.0.0 那两条是当时的真实记录）与品牌名写法（如 `ponytail-debt`、`$ponytail:ponytail`、`No ponytail debt` 类文案）。
- **验证**：`typecheck`／`lint` 0/0／全量 **686 pass / 0 fail**／`build`／`git diff --check` 全绿；仓库内 `ponytail:` 标记归零，5 个技能文件的 `shortcut:` 计数与上游逐文件一致。

### 技能侧按需发现对齐工具面：`skill_search` 打分、截断标注、空结果不否决、`skill_load` 去重（2026-10-16）

- **病灶是提示层而非引擎**：`skill_load` 一直按注册表精确名加载（实测 `ponytail-help`／`dsh-shell-commands` 从未出现在任何一次搜索结果里，仍能加载），但 `engine/skill-search.mjs` 的三处文案把它写成搜索的从属——工具描述「call skill_search FIRST … then skill_load」、结果头 `Matching skills (88)` ＋ `…(68 more)`、未知名「No skill named "X". Run skill_search to list available skills.」。实测后果：模型搜不到就转去 `glob` 翻 `.dsh\skills` 猜名字。
- **两处照搬 `tool-search.mjs` 的既有写法（技能侧此前是退化版）**：① 结果头改 `(显示数 of 命中总数)` ＋ `(truncated at 20 — add tokens to narrow the query)`；② 空结果/未知名文案写清契约——「空结果只说明关键词没命中，不代表技能不存在；已知精确名直接 `skill_load`」，`skill_load` 三种成因（名字不在注册表／发现不完整／不可模型调用）分别给应对。
- **空查询形态刻意不改**：`skill_search` 无关键词时仍列出可见技能（截到 20 条）＋ 截断标注。工具面空查询折叠成分组计数是因为它覆盖 371 个长名工具，而技能是 88 个短名；`superpowers` 那套的 `references/dsh-tools.md` 也把「空查询列全部」写成了既有契约，两边保持一致、不引入隐性冲突。
- **`skill_load` 去重（回答「不依赖搜索是否破坏设计初衷」）**：加载仍按注册表精确名（官方 `skill` 工具同样如此，搜索是发现途径而非准入），但**重复加载不再重复注入正文**——加载前用 `engine/history.mjs` 的 `currentEvents()` 判定该技能是否已在**当前可见上下文**里，命中就只回报「已加载」并跳过 `agent.inject`。口径要点：压缩/位置替换遮蔽掉的注入不算已加载，重新加载照常注入（否则模型会失去正文）；官方 `/名字` 手势写的是同一形状的 `skill-invocation` 事件，一并被去重覆盖。这是「不依赖搜索」唯一真实的 token 浪费路径——猜错名字拿不到正文，而同一技能重复加载会白付一份 1.6–23KB 的正文。
- **匹配保持 AND 准入、只改排序**：`scoreSkills` 仍要求每个 token 都命中（`代码 中文` 这类中文多词查询是既有纪律），精确名命中最前，其次全命中者按命中数、名字序。**没有**采用工具面「命中任意 token 即入选」的口径——技能 description 很短，近似命中会把只沾一个词的无关技能一起倒出来。
- **发现不完整不否决可用结果**：incomplete 读只加一行标注；只有「无命中」时才改措辞（不含「没有匹配」的断言形式），避免把「没读全」变成「搜不到」。
- **测试**：`test/engine/tool-module-mount.test.mjs` 随语义更新（截断标注、空结果契约文案、AND 优先），并顺带修掉测试桩的一处失真——provider 摘要此前把 `description` 统一写成 `'test skill'`，导致按描述关键词搜索的用例名不副实。
- **验证**：`typecheck`（三项目）／`lint` 0/0／全量 **684 pass / 0 fail**／`build`／`git diff --check` 全绿。

### S3／S4 复核：两项都判定不改代码，S4 补一条文档缺口（2026-10-16）

- **S3（BridgeRuntime 按域归属）：实测后判定不改。** ① 23 个成员**没有一个只被 runtime 自己用**（单域直接引用 11／多域 10／仅装配层 2）⇒ 删掉它会分散到 11 个域，**通过 deletion test**；② 11 个域**全部**已声明 `Pick<BridgeRuntime, …>`，人工逐行核对**多声明 0、少声明 0**（「每个域只看到自己需要的面」已经做到）；③ 11 个单域成员里 `capabilityQueue`／`moduleOrderQueue`／`pendingVariableSettings` 是**有状态的真共享点**，搬动要动队列与可变 Map 的生命周期，而 runtime 接口并不缩小（只是换位置）。报告两处描述也不准：`/bootstrap` 实际穿 **4 个 runtime 文件 ＋ host 十个模块**（handler 直用 14 个 BR 出口），不是「两个文件六个 helper」；`params.ts` 直连 host 是 **10/11 个域的普遍形态**。
- **顺带修掉 S3 取证挖出的一处真冗余**（`src/runtime/routes/params.ts`）：refreshOnly 分支先 `readModuleVariables(dir)` 再用 `{ ...state, ...runtime.variableView(dir) }`——而 `variableView`（`bridge-runtime.ts:767-771`）＝ `readModuleVariables(dir, { writable })` ＋ 两个 publication 字段，**两者返回同一类型、`state` 的每个字段都被整体覆盖**（`state` 比它少两个字段，所以也不可能是「保留 state 独有字段」的设计）。改为在**重试发布之后**取一次 `variableView`：行为等价（变量视图本就在发布重试之后取，那次读等于白读），少一次同步读盘、一次展开与一个只被它用的 import。
- **S4（端点请求字段单一来源）：实测比报告更严重，判定不改代码、只补文档。** ① 有请求顶层白名单的不是 8 处而是 **9 处 / 10 个端点**（报告漏了 `bridge-runtime.ts:156` 的集中式 `IMPORT_REQUEST_FIELDS`，它是唯一与契约双向绑定的一处）；② 逐字段对照**7 处与契约逐字等价**，唯一差异是 `moduleName` **白名单更严**（读分支 `allowed=[]`，而契约三字段全可选 ⇒ 类型合法的 `{expectedRevision}` 读请求被 400 拒）；③ **35 个端点没有白名单**（6 个 `body:'none'` 不解析请求体，**29 个 JSON 端点静默接受任意多余字段**——实测 `moduleDelete {id:'ghost',bogus:1}` → 200 且模块真被删）。
  - **为什么不改**：根因不是「双写」，而是**没有任何一层负责「契约字段集 = 运行期接受集」**（主语有 `BRIDGE_SUBJECT_POLICY`、声明面有 `DECLARED_SECTIONS`、形状豁免有 `GATE_POLICY`，请求字段**没有登记表**），事务层明文把载荷语义下放 handler。给 29 个端点补白名单＝新增一层契约 ＋ 把静默接受改成 400（行为变化，且契约没写哪种才对）；删掉那 10 处＝删校验器。两条都按「不为安全而安全」否掉。
  - **补的文档**（`docs/ui-architecture.md` §7.1）：写明「契约字段集 ≠ 运行期接受集」——10/45 的具体位置、29 个端点静默忽略、以及「给契约加字段时同一次变更在不同端点行为相反」；并留档两处契约错位（`paramOverrides` 契约声明 `expectedModuleId?` 而 handler 从不读、`triggers` 契约声明 4 字段而端点恒 410）。
- **验证**：`typecheck`（三项目）／`lint` 0/0（313 文件）／全量 **684 pass / 0 fail**／`build`／`git diff --check` 全绿。

### 修 S6 留档的 L4：`/rules` 不再有两种 500 码（2026-10-16）

- **同一端点的两种失败码（已修）**：`ruleSpec.mjs` 的动态 import 原抄三遍，其中 `refreshOnly` 分支那处**在外层 try 之外**——同一个「引擎编译器不可用」在 `refreshOnly` 请求下经 `bridge-transaction.ts` 冒泡成 **500 `bridge-handler-failed`**，而在写事务路径下是本端点的 **500 `rules-failed`**；`refreshOnly` 恰好是客户端刷新规则编辑器 meta 时走的路径。
- **修法**：① 三处重复收成模块级 `ruleEditorMeta()`（动态 import 仍是一次构造期加载 ＋ ESM 自带缓存，不新增抽象）；② `refreshOnly` 分支把 meta 取值**推迟到组装响应时**，使该失败与其它路径一样落进本端点的 `rules-failed`。**为什么不把 import 挪进 `:165` 那个 try**：那个 catch 的语义是「运行刷新失败」⇒ 返回 **200 ＋ publicationPending**（＝已保存但发布失败），而「编译器不可用」不是可重试的发布问题，落进去会让客户端以为重试有意义。
- **同轮核验并判定不做的**：`engine/rule-spec.d.mts:78` 的 `lifecycle` 必需 vs `src/shared/rules.ts:75` 可选——**看着像缺陷但不是**：三处内联断言导入的是 `src` 侧那份（`instructions.ts:12`），`src` 的消费面也按可选处理，**两边自洽**；引擎声明那份在这个动态路径上根本没被读（绝对 URL 动态 import 绕过 `.d.mts`），不产生可观察行为。按「不为安全而安全」不改。
- **记账的覆盖缺口**：`rules-failed` 与 `meta-unavailable` 在 `test/` **各 0 处命中**，`bridge-handler-failed` 仅 1 处（`bridge-contract.test.mjs:238`，通用 handler 异常、非 rules 路径）。本轮**没补回归用例**——要构造需 mock `existsSync` 使 `packageEngineDir()` 的认领判据失败（`module-dirs.ts:44-49` 在模块内直接调用，hook 面大、还牵连 `module-storage` 的路径判据），成本与这条窄可达路径（`engine/rule-spec.mjs` 缺失或损坏）不成比例；**如实登记而非假装覆盖**。

### S6 复核：实测后判定「不统一加载接口」，顺手修三处文档漂移（2026-10-16）

- **报告的两个前提被实测推翻**：① 「按模块 id 加载引擎模块」的生产点**只有 1 处**——`src/runtime/agent-assembly.ts:121-124`（`join(packageEngineDir(), '<id>.mjs')` ＋ `existsSync`）；`src/index.ts:200` 是**固定文件名** ＋ 相对 `import.meta.url`，不是按 id。② 报告里的「14」是 `engine/compositions/source/local/*.yml` 的文件数，不是 id 加载器能命中的模块数；引擎侧带 `apply` 的模块 **11** 个，其中 3 个的 composition 行由宿主包／cordis group 提供、加载时被静默跳过。
- **判定：不抽「按 id 加载」的接口**。四处动态加载在**路径基准／失败语义／断言形状／缓存**上都不同：按 id 那处「缺件跳过、缺 `apply` 抛」；`index.ts` 那处「失败只 warn 降级」；`bridge-runtime.ts:590`（`schema.mjs`）与 `routes/instructions.ts:164/182/215`（`rule-spec.mjs`）同形（固定文件名 ＋ `packageEngineDir()`）；引擎侧另有 `actions/content.mjs`（按策略名）与 `host-package.mjs`（按宿主包名）。强行统一＝一个覆盖四种错误语义的宽 options ＝**浅接口**，按「不因一处实现设计复杂逻辑」保留内联断言。
- **顺手修三处文档漂移**（`docs/engine-reuse.md`）：① `:92` 的 `read(moduleId) -> { module, global, effective, … }`——`effective` **既不在实现也不在声明里**（`template-frame.mjs:44-47` 读的是 `module`／`global`／`enabled`），删掉；② `:97` 让复制方「调用 `evaluateTemplate()`」——它**不被 `src` 直接使用**，是 `template-frame.mjs` 的 `renderTemplate()` 内部在用，改为指向 `renderTemplate()` 的返回；③ `:75` 的文件归属——`schema.mjs` 的加载点实际在 `bridge-runtime.ts:590`（不在 `settings-bridge.ts`，那是个 73 行纯装配壳、零 `import()`），`rule-spec.mjs` 在 `routes/instructions.ts`，并补上「这些点为何不收成一个接口」与「绝对 URL 动态 import 让 `.d.mts` 不参与、类型由手写断言承担」。
- **留档未改（要动需另起一轮）**：`routes/instructions.ts` 的**同一行抄三遍**，且 `:164`（refreshOnly 分支）**不在 try 内**——同样的失败在那里经 `bridge-transaction.ts` 冒泡成 **500 `bridge-handler-failed`**，而 `:182`／`:215` 是 500 `rules-failed`。三处用的 `RuleEditorMeta` 还是 `src/shared/rules.ts:66` 的副本（`lifecycle` 可选），与 `engine/rule-spec.d.mts:78` 的必需不一致（这条同 S5 的「同名两份副本」）。
- **与 S5 的边界**：S5 管**静态引入**那 14 份声明的准确性；S6 是它的另一半——**动态路径上声明不参与**，类型由手写断言承担。两者都落到了文档。

### S5 复核：实测后判定「零漂移、零冗余」，只落文档（2026-10-16）

- **按用户三条原则逐条量了这 14 份声明**（`engine/*.d.mts` ＋ `engine/conditions/index.d.mts`）：
  - **deletion test**：删任一份 ⇒ `src` 的静态 `import { … } from '../../engine/x.mjs'` 立刻失去类型、退化为 `any` ⇒ 每份都挣饭。12 份只有单个消费者，但那是「一个 import 语句在语法上需要一个同名模块」，不是「一个使用者所以该合并的抽象」——判据在此不适用。
  - **零冗余**：14 份共 **52 个声明符号**，逐个核实后**没有一个是纯冗余**。`src` 直接 import 的是**函数**（形如 `compileRules`／`mountRuleSources`／`isBranchNode`）；其余符号**支撑着被消费符号的签名**——`StandingMountFor` 是 `loadStandingMountFor` 的返回、`MountRuleSourcesOptions` 是 `mountRuleSources` 的参数、`PreStepBatchOptions` 是 `runPreStepBatch` 的参数、`WarnOnce` 是 `createWarnOnce` 的返回、`InjectionConfigSpec` 是 `injectionConfigSpec()` 的返回、`PreStepConfigLike` 是 `PreStepBatchOptions.configs` 的元素类型。**「无人 import 的类型」不等于冗余**，判据是「它是否支撑某个被消费符号的签名」。
  - **零漂移**：动态 `import` 每个 `.mjs`，核对声明里的**值导出逐个存在** ⇒ 0 份漂移。**静态正则探针会误报**：它不跟 `export *` 链，把 `conditions/index.d.mts` 的 `loadStandingMountFor` 报成幽灵（实际由 `index.mjs` 的 `export * from './preset.mjs'` 转发）——要查这类漂移**必须走运行期**。
- **唯一真实弱点**：声明与实现之间**没有机制校验**——`docs/engine-reuse.md:73` 的「新增引擎导出时同步改声明」是纪律不是守卫；签名文字（如 `rule-runtime.d.mts` 的 `ctx: unknown`）的宽化只能靠人看。**但拿不出当下缺陷路径**，故加运行期导出面断言属「为覆盖率而测」（用户判定不做，我原本推荐要加，实测后撤回）。
- **补充实测（同轮取证的后半段，结论要写准）**：名字面稳、**形状面有 4 处已量到的偏差**，且都是「宽化／少写」——`tsc` 一定放行，所以**编译通过不能作为声明正确的证据**：
  - `rule-runtime.d.mts:17` 把 `outcome` 宽化成 `string`（`src` 侧是封闭并集 `RuleOutcomeKind`）⇒ 并集外的值 tsc 拦不住；实测喂 `outcome: 'skipped'` 时 `rule-diagnostics.ts:52` 的 `record[outcome] += 1` 在计数对象上**新增键 `skipped: NaN`**，`JSON.stringify` 成 `"skipped":null` 随端点出桥——**不抛错、不告警**。当下引擎只发并集内的 5 个值，所以没有活 bug；这条是「漂移会以什么方式爆发」的实证。
  - `executor.d.mts:6` 声明 `identityOf(...): string`，实测可返回 `undefined`（调用方靠一句注释「schema 保证非空」活着）。
  - `rule-runtime.d.mts:41` 的 `ctx: unknown` ⇒ 五种错误 ctx 全被 tsc 放行、运行期全炸在深处（好在 `:59` 的 try 会先按逆序释放订阅再抛，不漏资源）。
  - `rule-spec.d.mts:33-38` 的 `PromptConfigCompileOptions`：实现 `schema.mjs:563` 还读一个声明里没有的 `templatePresetRoot`（按声明写就是 excess-property 报错），且 `loadTemplate` 实现按 3 参调用、声明只写 1 参。
  - 另有两处**同名两份副本**：`RuleEditorMeta`（声明 `rule-spec.d.mts:78` 的 `lifecycle` 必需 vs `src/shared/rules.ts:75` 可选）、`RuleOutcomeReport`（声明宽成 `string` vs `src/runtime/rule-diagnostics.ts:19` 的并集），连接只靠注释。
- **落文档**：把上面两条判据写进 `docs/engine-reuse.md` 的声明段——「为什么有些符号 `src` 从不 import 却必要」与「声明的失效方式是静默的、当前无自动校验」，并记下 2026-10-16 的核对结论。
- **验证**：`typecheck`（三项目）／`lint` 0 warnings／全量 **684 pass / 0 fail**／`git diff --check` 全绿（只改文档）。

### C4／C5 复核：实测后判定「只落注释 ＋ 删一处死导出」，不做成员级收窄（2026-10-16）

- **实测证据（Proxy 记运行期属性访问，只读探针）**：`injectionPointSlots` 构造时立即读 `store.fields`／`meta.modules`／`showNotice`／`editorDrafts`；而 `hasLayerSettings`／`matchesLayerSettings` 运行期**只读 `store.meta.modules` 一个属性**——类型面要 8 端口 41 成员（`PanelStore`）。`InjectionPointsPanel` 文件内直接触碰 store 的只有 **14 个成员**，其余 27 个零直接读取：**15 个是转发给子卡的**（`EngineParamField` 13、`CurrentSessionModel` 6、`ModuleCapabilityCreateMenu` 3、诊断卡 1），**12 个在整个面板渲染子树里没有任何消费者**（`ModuleActions` 5 ＋ `ModuleFacts` 的 `getFields`/`subscribeFields` ＋ `NoticePort` 5）。`RulesWorkspace` 同形：30 成员里 13 个零消费者。
- **判定：不做成员级 `Pick`**。把 `PanelStore` 收窄成 41 → 14 个成员名，等于**硬编码一长串成员**、并随子卡声明的面漂移（子卡加一个成员就要回来补一次），而运行期零收益、现有「按域相交」的写法已经表达了归属。改的是**注释**：把上面这份实测依据写进 `InjectionPointsPanel.tsx` 的依赖面注释（并说明为什么仍按域相交）。
- **C5 同样只落注释**：`AudiencePage` 的 `AudienceStore` 是 10 端口并集、本页零读取——但**不能**换成 `InjectionPointSlotsInput['store']`：后者**不含** `RulesWorkspace` 要的 `enqueueRuleTask`／`createTemplateRule`（实施中 typecheck 当场证伪）。注释改为写明「本页零读取 ＋ 面＝两张子面需求之并」，并留下这条反例。
- **删一处死导出**：`InjectionPointsPanel.tsx` 的 `export { isEditorGroupVisible }`——`shared/engine-capabilities.ts` 里的定义仍在，但**全仓零消费者**（`src/index.ts` 也不再导出它）。
- **「同组事实算三遍」的实情（记录，未改）**：`:200-207` 是渲染层自己要用元素（`cards`/`capabilities`/`addable`/`assets`），`:371-374` 与 `:382-386` 是布尔判定（`length > 0` vs `some(matchesLayerGroup)`，且后者**有意**不含 `undeclaredSections`——添加入口不受搜索过滤）。三者调用同一批 helper，但要收只能引入「四类键拼成一个列表」的中间产物：省一次计算、多一个接口，按「不因一处实现设计复杂逻辑」**不做**。
- **验证**：`typecheck`（三项目）／`lint` 0 warnings（313 文件）／全量 **684 pass / 0 fail**／`build`／`git diff --check` 全绿；`rg isEditorGroupVisible` 只剩定义处。

### 人设的读改写收进 owner（C3 第二处，照 tools 样板）（2026-10-16）

- **新增 `src/client/data/persona-editor.ts`**：`createPersonaEditors(drafts, deps)` → `editorOf(moduleId)`，动作 `load(audience, discard?)`／`patch`／`save(audience, remove?)`／`retryPublication`／`scheduleAutoSave`／`cancelAutoSave`。deps 显式：`request`／`getModuleId(audience)`／`isCurrentSubject`／`declares`／`isCurrent`／`isComposing`／`t`／`changed`／`onDeclared`。载体的实例跨渲染缓存（`owners` Map ＋ `sync`），因为它持有 600ms 续存定时器。
- **卡片的三个手写协议动作移走**（`ModulePersonaCard.tsx`：`loadPersona`／`write`／`retryPublication` ＋ 自带的 `saveTimer`），只留两个薄包装 `save`／`retryPublication`——提示文案与「删除失败要抛错」留在 UI 层；`patch` 也改调 owner（字段合并与空受众回收在 owner 里）。
- **两个纯函数一并下沉**：`personaWriteBody`／`readModulePersona` 移到 `data/persona-editor.ts`，**卡片按原路径转出**——它们此前定义在 features 层，而 owner 在 data 层，不搬就是又一处 data→features 反向依赖（与上一轮 `ToolDraft` 同类）。`readModulePersona` 的 `request` 第三参带默认实现，既有测试的两参调用零改动。
- **测试抓到一处我自己的真差异**：owner 的 `load` 初版只判 `isLatest`，**漏了原实现里卡片 `mounted` ref 的判据** ⇒ 卸载后迟到的应答仍会落地。补成 `!deps.isCurrent() || !isLatest(...)`，并让 `cancelAutoSave()` 在卸载时推进序号（原实现用 `mounted` ref 表达同一件事）。
- **新增 `test/client/persona-editor.test.mjs`（4 条直测）**：① 迟到应答不落地（**先落地一次才能造出迟到**——`loading` 守卫会挡住未完成时发起的第二次读，这条是我第一版测试写错、被实现纠正的）；② 读期间草稿被换过就不覆盖、卸载后不落地也不清 `loading`；③ 只改本次受众 ＋ **创建模式不带 `expectedRevision`**（未声明时那次读根本不构造请求）；④ 删除失败要抛错、`cancelAutoSave` 后续存不发请求、未取消时 600ms 自动续存一次、**输入法组合期间不落盘**。
- **判别力实测（两处，先红后还原）**：去掉 `load` 的 `isLatest` 判据、把 `creating` 判据改成恒假 → 「创建模式不带 expectedRevision」用例红；还原后 4 pass。（还原用 Node 逆向替换——`git checkout` 对**未跟踪的新文件**无效，这一点踩过一次。）
- **验证**：`typecheck`（三项目）／`lint` 0 warnings／全量 **684 pass / 0 fail**（改前 680 ＋ 新增 4）／`build`／`git diff --check` 全绿；相关 SSR 用例（`module-asset-subject` 28 条）零改动仍绿，含「未声明一个请求都不发」那条声明面用例。
- **本轮明确不做**（与上一轮同口径）：① `personaSources` 槽仍是卡里的手写读改写——它是**单例**、`revision: string \| null`、读/写都**不带主语头**，与 persona 形状不同，硬塞进同一 owner 会得到浅接口；② 不为 `write`／`save`／`retryPublication` 补序号（入口有 `saving`／`loading`／`!loaded` 守卫，迟到覆盖**未验证**）；③ 不统一脏判定的三种粒度（`:243` 单受众 JSON 比较、`:316` 整 value、`:240` 引用比较各有消费点）；④ 不动 `DraftsPort` 收窄。

### 自定义工具的读改写收进 owner（2026-10-16）

- **新增 `src/client/data/tools-editor.ts`**：`createToolsEditor(moduleId, draft, deps)`——deps 三项（`reader`／`request`／`isCurrent`）＋`changed`／`onDeclared`，动作 `load`／`mutate`／`applyPatch`／`save`／`insertTemplate`。形态照 `rule-drafts.ts` 的最小骨架（载体作位置参数、依赖显式、用 `resource-track.ts` 的 `beginLatest`／`isLatest`），比 rules 少的部分是刻意的：工具没有 CAS 版本、没有冲突分类、没有增量 patch，草稿就是整组工具。
- **目标形状的实测结论（写下来免得再试一次）**：仓库里**没有任何一份现成实现**同时是「显式 deps ＋ 自带载体 ＋ 用原语」——`rule-drafts` 三者齐（但载体走位置参数、deps 接口未导出）、`skill-editor` 缺原语（自己的最新优先是手写 `++state.current.seq`）、`instruction-drafts` 没有工厂（纯函数池 ＋ store 持 ref）。所以样板是「按最小骨架拼」出来的，不是照搬；`docs/ui-architecture.md` 的协议小节据此改为列出各 owner 的实际位置而不是说「一个共同形状」。
- **卡片删掉手写的那一套**：`CustomToolsCard.tsx` 原来的本地 `revision` 计数、`active` 卸载标记、`activeEditor` 判应答过期、`readingTools` 读前快照 ＋ 落地前重算（**净 −63 行**）全部由 owner 承担；保留的是渲染本身——`useState` 镜像、展开态、`patchTool` 的字段键重命名、提示文案。**行为等价**：既有 SSR 用例（33 pass）零改动仍绿。
- **`ToolDraft` 归属下沉**：它原在 `features/tools/CustomToolEditor.tsx`（`= Record<string, unknown>`），而 owner 在 data 层、草稿池的 `ToolsEditorDraft.tools` 本来就是它——改由 `data/workspace-drafts.ts` 拥有，`CustomToolEditor` 转发，**修掉一处 data→features 的反向依赖**。
- **`ToolsEditorDraft` 加 `latest: number`**：原语要求 holder 有该字段；它替代了卡片里那个本地 `revision`。
- **新增 `test/client/tools-editor.test.mjs`（4 条直测）**：读取落地与**迟到应答不落地**、**读期间用户输入优先**且读失败保草稿、保存前空 key 清理（并把它写回 `saved`，否则那行空 key 会让卡片永远是脏的）与失败**不污染 `error`**、卸载后应答不落地。**判别力实测**：去掉 `isLatest` 守卫 → 迟到用例红；还原后 4 pass。
- **验证**：`typecheck`（三项目）／`lint` 0 warnings／全量 **680 pass / 0 fail**（改前 676 ＋ 新增 4）／`build`／`git diff --check` 全绿。
- **本轮明确不做**（都按「不为安全而安全／不为一处不一致设计复杂逻辑」判掉）：① **不收窄 `DraftsPort.editorDrafts`**——它是 6 个消费者的入口，为「不把整池递出去」造 6 套按族的读数面，代价与收益不成比例；② **不动 persona 写路径**（`saveSources`／`write`／`retryPublication` 无序号属实，但入口有 `saving`／`loading` 守卫，能否真并发到「迟到响应覆盖」**未验证**，不为未验证的风险造逻辑）；③ **不动 skills 与原语的对齐**；④ **`EngineParamFields`／`PromptConfigFields` 两份字段草稿槽不動**（前者根本不是协议——没有请求生命周期；后者**当前未接线**：`RulesWorkspace.tsx` 未传 `fieldDrafts`，`fields?.set` 是空操作——这是独立发现，只记账）；⑤ `insertToolTemplateIntoDraft` 仍留在卡片（唯一调用者 `useTemplatePicker` 只持有 `store.editorDrafts`，把 owner 注进去要改它的接口或引入跨模块注册表）。

### 测试桩与端口契约漂移：修漂移、删桩让步、test 类型检查第一批（2026-10-16）

- **三处桩的字段漂移修正**：`module-asset-subject.test.mjs:249`、`rule-steps.test.mjs:143`、`template-target.test.mjs:38` 仍写 `sequence: N`，而 `RulesDraft` 自 `a12a5be3`（`sequence` → `latest`）起只有 `latest`——测试是 `.mjs`、不在任何 tsc 项目内（`tsconfig.json:16-17` 与 `tsconfig.client.json:8` 的 include 都不含 `test/`），所以漂移无声。每处改 1 行。运行期后果（静态推理、未实测）：桩里 `latest === undefined` 会让 `beginLatest` 的 `++` 得 `NaN`、`isLatest` 恒假；当前不红是因为 SSR 渲染不跑 effect。
- **删除生产代码里为不完整桩留的退化分支**（`EngineParamFields.tsx`，+7/−11）：删掉自称「单测桩」的 `subscribeNothing`／`getZero` 与六处 `store.<端口成员> ?? …`／`?.`，改成按完整端口直取。依据：真实 store 无条件提供 `DraftsPort` 四成员（`use-prompt-tool-store.ts:1112/1117/1118/1119`，都在 `storeRef.current` 字面量里）；渲染该组件的两个调用点都在 `InjectionPointsPanel.tsx`（`:248`／`:379`）且传完整 store；该分支**零覆盖**——没有任何测试直接渲染 `EngineParamFields`。
- **桩按「渲染链路实际读取」修正，而非按端口名单堆成员**：用 Proxy 探针实测五个测试文件里桩的渲染期成员访问集（跑完逐字还原），结论是 **6 个桩里只有 (c)(d) 真有缺口**——`rule-steps.test.mjs:127/148` 各补一个 `showNotice`（NoticePort，渲染期真读）；(a) `module-asset-subject:45`、(b) `instruction-card-settings:42`、(e) `template-target:34`、(f) `tool-template-entry:20` 的访问集**已被完全覆盖、无 MISSING**，故不补。三处多给的 `enqueueModuleTask`（不是端口成员，也不在 store 的返回对象 `:1111-1164` 里，只是内部函数）全部删除。
- **`test/` 类型检查分阶段纳入（第一批）**：新增 `tsconfig.test.json`（`extends` client 配置 ＋ `allowJs`／`checkJs`，include 只列 `test/fixtures/**` 与 `test/client/support/**`），并在 `package.json` 的 `typecheck` 串上第三个项目。基础层两个文件的 **38 个错误**（`TS7006` 21／`TS2339` 7／`TS7031` 4／`TS7053` 3…）全部由 JSDoc 真实形状注解清零：`ssr-render.mjs` ＋15/−2、`host-harness.mjs` ＋107/−8（**只加类型，无行为改动**——非注释改动仅一处：`const [inject] = /** @type {[InjectAction]} */ (rule.then)`，而 `InjectAction` 是从 `shared/rules.ts` 的 `RuleAction` 派生的 `@typedef`，不是手抄的第二份形状）。白名单实际命中 **3 个文件**：`host-harness.mjs`、`module-template.mjs`（本就干净、未改）、`ssr-render.mjs`；`any` 只用了 **2 处**（都在 `ssr-render.mjs:47,75`：扁平化模块命名空间的导出值异构，类型由被 import 的模块决定，有一行理由注释）。
- **为什么不全量纳入**：实测把 `test/` 整体纳入 `checkJs` 有 **458 个错误**（`TS7006` 137／`TS18048` 101／`TS2532` 46…，集中在 `module-asset-subject` 139／`rules-editor` 67）。关键是**纳入一个文件会连带检查它 import 的文件**，所以顺序必须是「先基础层 → 再逐个测试文件」；配置的 include 是白名单，加一个文件＝加一行。
- **判别力实测（四处，先红后还原）**：① 三处 `sequence` 修正后三个测试文件 39 pass；② 把 `tsconfig.test.json` 里 `withSsr` 的 `@param` 由 `string[]` 改成 `number[]` → 配置立刻报 `TS7036`（`ssr-render.mjs(78,35)`），还原后 exit 0；③ 去掉桩 (c) 的 `getFields` → `rule-steps` 7 pass / 1 fail（**判别力要挑渲染期即被调用的成员**）；④ 去掉刚补的 `showNotice` **仍是 8 pass / 0 fail**——它是渲染期读取、SSR 不调用，故 `showNotice` 这条断言不是判别力点，如实记录。
- **验证**：`typecheck`（三项目）／`lint`（309 文件 0/0）／`test` 全量 **676 pass / 0 fail**（与改前基线一致）／`build`／`git diff --check` 全绿。

### 草稿池自答「哪些没保存」：一处判据、删死槽与零消费者成员（2026-10-16）

- **`workspace-drafts.ts` 的 `hasWorkspaceDrafts` 换成池自己的 `poolDirty(drafts, moduleId)`**：六分支判据原样搬进池（`rulesDirty`／`variablesDirty`＋`deepEqual`／tools 与 persona 的 `JSON.stringify` 双向比较／`fields` 的文本差异与校验错误），**「什么算脏」的结果一字未改**——由 Wave 1 新补的用例（`test/client/workspace-drafts.test.mjs`）在原实现上先跑绿、改完再跑仍绿来证明。唯一调用点 `ModuleSwitcher.tsx:128`（覆盖导入守卫）随之改指。
- **删一个死槽**：`policies: Map<string, PolicyEditorDraft>` 零生产者零消费者（全仓只命中池自身的类型声明、初始化，与 `hasWorkspaceDrafts` 里那一行读取），连带其判据分支 `policy.saving || JSON.stringify(policy.draft) !== JSON.stringify(policy.saved)` 与 `PolicyDraft`／`PolicyEditorDraft` 两个类型一并删除。**行为不变**：该分支的 `policy` 恒为 `undefined`，从未参与过判断。
- **删两个零消费者成员 ＋ 一个只服务它们的死函数**：`store.dirtyConfigs`／`store.dirty`（`use-prompt-tool-store.ts`）与 `ModuleActionsPort` 的对应声明零读取点（`test/` 也零命中）；它们唯一的使用者是 `configsAreDirty()`，而它自己也零消费者——三者一并删除。收口后 `rulesDirty` 在 store 里的 import 随之悬空删除；`dirtySwitches` 保留，它是开关快照域、池外，`ModuleSwitcher.tsx:129` 读它。
- **实现中实测抓到一处自己的回归**：`poolDirty` 第一版把 `moduleId === undefined` 写成「扫描全部模块」，而原实现是 `undefined` 直接 `false`——Wave 1 的用例当场变红（`actual: true, expected: false`），补回早返回后复绿。**这条正是「先补行为网再收口」的收益**。
- **核实后不加的守卫（用户判定）**：覆盖导入有草稿守卫，而**删除模块**（`ModuleSwitcher.tsx:145`）与**停用模块**（改启用表）没有——用户判定**不加**：删除是用户的显式操作，「删除就是删除」，为它加确认属「为安全而安全」。本轮只留档，不改行为。
- **两处文档口径改正**（`docs/ui-architecture.md`）：① 草稿池表格原写「工具、人设、**策略**、原始 JSON/数字草稿……未存草稿或保存中**阻止预设切换**」——`policies` 既是死的、也确实从未阻止过任何操作，改成「覆盖导入时按模块拦截（`poolDirty`）」；② 同一处与「工具、人设与**策略**只确认提交快照……**策略卸载清除未发送队列**」并连同 `workspace-drafts.ts` 的模块表描述（补上规则／变量／原始字段与 `poolDirty`）、「工作台脏状态包含所有模块规则草稿」一句（随 `dirty` 的删除失效）一并改正。
- **验证**：`typecheck`／`lint`（309 文件 0/0）／`test`（全量 **676 pass / 0 fail**）／`build`／`git diff --check` 全绿；Wave 1 用例在改实现前后各跑一次，均为 2 pass。

### 补 S2 记账的三个覆盖缺口（2026-10-16）

- **`rules-slices-invalid` 从「`test/` 零命中」变为有行为断言**（新增 `test/host/module-slices.test.mjs` 用例）：先探针实测，首版设想的形态**不成立**——① `ensureModuleSlices({ writable: false })` 在切片校验**之前**就返回（`module-slices.ts:308`），永不抛该码；② `readModuleRules`／`readRulesDir` 都走 `ensureModuleSlices`，失败一律转 `recoverCurrent` 重建，**正常路径自愈且不报码**；③ 用**目录**占据切片位置得到的是 400 `rules-invalid`（`assertPlain` 在 `:203`，早于 `:204`）。唯一能稳定复现该码的形态是**恢复写入也修不好的失配**：大小写不敏感文件系统上把 `rules/first.yml` 改名为 `First.yml` —— `existsSync('first.yml')` 仍为**真**，`readdirSync` 给出 `First.yml` → `:202` 的逐字 `files.includes` 命中；恢复写入在 `:278` 因「存在且内容相等」而**跳过**、名字永不变 → `:202` 在恢复里再次抛出并逃逸。用例断言 409 ＋ 码名 ＋ 文案点名 `first.yml` ＋ 切片清单与两个文件字节逐字未变；非 Windows `skip`（大小写敏感盘上造不出该共存形态）。
- **`rules-rebuild-failed` 只在错误对象层断言**（改 `test/host/module-slices.test.mjs` 既有用例的两处断言，原断言逐字保留）：`:352` 的两条路径实测都命中该码——注入的普通 `Error` 走「`persisted === false` ＋ 500」，持续发布故障走「`persisted === true` ＋ 500」。**该码不进任何响应**：`routes/instructions.ts` 在 `error.persisted` 为真时统一回 200 ＋ `publicationPending` ＋ `publicationError`，只在 `persisted` 为假时才透出 `error.status`／`error.code`，所以不做端点层载荷用例。
- **`revisionOf` 有了直接断言**（新增 `test/host/module-write.test.mjs`）：同一输入同摘要、摘要为 64 位小写十六进制、不同输入不同摘要、`Uint8Array` 与等价 UTF-8 字符串同摘要、并与 `node:crypto` 的 `sha256` 十六进制逐字节相等——真值源是 Node 自身，不是从实现里抄常量。同时记账：仓库里 `revisionOf` 有**三份同名不同物**（本文件是字节摘要；`module-package.ts:144` 是「源摘要 ＋ 选组 ＋ 目标身份」的成分拼接；`skills-content.ts:17` 是单技能内容版本），三者用途不同、零互相调用，本轮**不改名**。
- **别名守卫的两个异常分支：一个补上码断言、一个不补**（按仓库测试准入三条判定）：① `serializeWithoutSharedAlias` 的 catch（`module-write.ts:62`，`2ab0e436` 引入、`301225fc` 原样搬家）**已有用例实际走到却只断言了文案**——`test/host/persona-registration.test.mjs:146-148` 的 `next = null` 迭代删掉 `persona` 后 `unknown: *shared` 悬空 → `:59` 的 `doc.toString()` 抛 → 进 catch，内层诊断 `doc.toJS()` 也抛（悬空别名）→ 只给固有文案，原来那句 `/YAML.*引用/` 恰好通过；按准入三条（seam＝安全与拒绝路径、真值源＝契约码与错误协议、断言面＝该文件既有的错误对象）把它补成 `code='shared-alias'` ＋ `status=400`，于是**主路径与异常分支都必须归到同一个 wire 码**，冒成 500 `rules-failed`／409 `module-persona-rejected` 会当场红。② `assertUnownedUnchanged` 的 catch（`:82`）**不补**——它不是真缺陷路径：两个宿主调用点（`module-slices.ts:370`、`module-capabilities.ts:184/226`）**不可达**（`mutate` 之后的 `doc.toJS()` 已在上游 `module-definition-edit.ts:99`／`module-capabilities.ts:154` 先抛裸 `ReferenceError`），只有 `module-variables.ts:119` 可达且属坏输入。yaml 2.9.1 实测：悬空别名（`a: &x 1` ＋ `b: *y`）令 `toString()` 与 `toJS()` **都抛** `Unresolved alias`。「别名炸弹」形态（4×4 纯文本，`maxAliasCount` 默认 100）只令 `toJS()` 抛，同样属坏输入、不补。**记账口径修正**：S2 那节写「三处覆盖缺口」，加上别名守卫实为四处，四处结论即本节四条。
- **本轮实测发现、按原则不修的两处边界**（留档，别当新发现）：① 切片名大小写变体在 Windows 上**不可自愈**——`readProjection` 用逐字 `files.includes`（`:202`）而 `existsSync` 在大小写不敏感盘上为真，该模块**永久**读不出规则，用户需自行把切片名改回；修它要改判据或另立「按期望名重新落盘」策略，属新增设计而非真缺陷路径上的守卫，且本轮授权只到补覆盖。② 客户端 `READ_FIRST_CODES`（`rule-drafts.ts:12`）不含该码 → `:172` 给 `retry='save'`（原地重放），而该失配恢复不了、重放必然再失败；改重试分类是行为变化并需重定交互，交后续轮次。
- **判别力实测（四处，均先红后还原）**：放宽 `module-slices.ts:202` 的逐字判据 → T1 用例红（报「缺少预期异常」）；把 `module-write.ts:16` 的 `sha256` 换成 `sha1` → `revisionOf` 用例红；把 `:352` 的码名改成 `rules-rebuild-failed-x` → T3 断言红；把 `sharedAliasError` 的 status 由 400 改成 500 → persona 用例红（`actual: 500, expected: 400`）。四次还原后 `git diff -- src` 均为空。
- **验证**：`typecheck`／`lint`／`test`（全量 674 pass）／`build`／`git diff --check` 全绿；`git status --short` 只含 `test/host/module-slices.test.mjs`、`test/host/module-write.test.mjs`、`test/host/persona-registration.test.mjs` 与 `CHANGELOG.md`。

### module-storage 按「写事务原语 / 切片投影」拆成两块（2026-10-16）

- **525 行的 `src/host/module-storage.ts` 删除，不留转发层**：`src/host/module-write.ts`（169 行）拥有 **YAML 写事务原语**——跨进程/进程内锁、字节版本摘要（`revisionOf`）、共享引用守卫（`SHARED_ALIAS_CODE`／`serializeWithoutSharedAlias`／`assertUnownedUnchanged`）、`deleteYamlPath`、`withModuleLock` 与写错误协议；`src/host/module-slices.ts`（372 行）拥有**模块定义读写与规则切片投影**——`loadModuleDefinition`／`validateModuleDefinitionText`／`ensureModuleSlices`／`commitModuleDefinition`／`withModuleDefinition`／`readRulesDir`／`lastPublishedModuleDefinition` 与变量／规则标识校验。依赖单向：切片侧 import 事务侧，反向不行。
- **两侧共用项落事务侧**（`record`、`assertPlain`、`canonicalDirectory`、`moduleLocation`、`directoryKey`、`active`、`processLocks`）：它们没有归属方，切片侧只 import；`module-write.ts` 因此有 14 个导出，其中 7 个是这轮为共用而开放的内部符号（`src/index.ts` 从未再导出本文件，公共面不变）。
- **`ModuleRulesError` → `ModuleWriteError`**（`this.name` 同步改）：18 个文件改名（src 17、test 1）。**桥上的码名一律未动**——`rules-invalid`／`rules-conflict`／`shared-alias`／`rules-slices-invalid`／`rules-rebuild-failed` 是 wire 契约。
- **锁目录后缀去 rules**：`lockDirectory` 由 `.<名>.rules-locks` 改为 `.<名>.locks`（如 `.instructions.locks`）；锁语义、token 形状与回收判据一律未动，测试里自拼的锁目录名与 `instructions-policy.ts` 的注释同步。
- **三个死面删除（不搬）**：`decomposeModule`、`ruleSettingsPath`、`ruleVariablesPath`。核实结论：① `decomposeModule` 自 `29839094` 引入，唯一真实调用者是内置迁移器 `host/rules-migration.ts`，该文件在 `1bf1f679`（移除内置迁移器）整份删除，此后只剩定义与 `module-rules.ts` 的再导出——它是那次移除留下的残骸；② 两个路径函数自 `29839094` 引入起只有 `module-rules.ts` 那一行再导出、从未被调用（逐 revision `git grep` 核实），文件名真值源是 `host/paths.ts:77-78` 的 `RULES_SETTINGS_FILE`／`RULES_VARIABLES_FILE`。
- **26 个 src 消费者 + 10 个测试文件改指**（跨两侧的 import 拆成两条；`--eval` 子进程里的模块 URL 字符串同步改）；`test/host/module-storage.test.mjs` 随旧文件名一起改为 `test/host/module-slices.test.mjs`（`ui-architecture.md` 测试表同步），注释与文档里指向旧文件名的引用一并改。行为零变化：投影文本、版本值、锁语义、错误码与文案、CAS 判据一字未动。
- **记账不补的三处覆盖缺口**（本轮只搬家，不扩测试）：`rules-slices-invalid`／`rules-rebuild-failed` 两个码在 `test/` 零命中；`revisionOf` 无直接断言；别名守卫的两个异常分支（`serializeWithoutSharedAlias` 的序列化抛出、`assertUnownedUnchanged` 的 `doc.toJS()` 抛出）无专门用例——既有 `shared-alias` 用例走的都是「比对不等」主路径。
- **验证**：`rg 'module-storage' src test docs scripts`、`rg 'ModuleRulesError' src test`、`rg 'rules-locks' src test docs`、`rg 'decomposeModule|ruleSettingsPath|ruleVariablesPath' src test` 均零命中；`typecheck`／`lint`（307 文件，0 警告 0 错误）／`git diff --check` 全绿。

### 服务名单一真值源：挪到引擎侧，两侧引用（2026-10-16）

- **`engine/service-names.mjs` 是服务名唯一真值源**（配套手写 `engine/service-names.d.mts`，只导两个有名导出）：`PRE_STEP_COORDINATOR_SERVICE`（`'promptToolPreStep'`）与 `toolServiceName(engineModuleId)`（`pt-<引擎模块 id>`，前缀留在函数内部）。三处手抄全部收口：引擎侧 `executor.mjs`／`instruction-hint.mjs` 各 1 处 `getService`、四个 `module-{import,rule,memory,variable}-tools.mjs` 各 2 处（`inject` 依赖与 `get` 各一）；插件侧 `src/index.ts` 四个 `provide` 与 `agent-assembly.ts` 的私有服务名派生（原 `` `pt-${id}` ``）；测试侧 `tool-module-mount.test.mjs` 的「模块 id × 服务名」成对表改为用 `toolServiceName(id)` 派生。`pre-step-coordinator.ts` 的常量定义搬走后**原样 re-export**，`src/index.ts` 的公共面与既有消费者不变。
- **为什么失败是静默的**：服务名对不上时引擎 `getService` 拿不到协调器 → 回退自身的独立执行路径（官方指令逐文件过滤与批协调整体不生效）；模块工具外壳 `inject` 等不到 provider → 工具不挂。两条路都不抛错、不告警，只表现为「功能没生效」，所以手抄必须由一条源级守卫挡住。
- **`test/engine/service-names.test.mjs`（唯一新增守卫）**：扫 `engine/**/*.mjs`（排除 `engine/vendor/**`）与 `src/**`，断言这五个字面量除 `engine/service-names.mjs` 自身外零出现，失败消息带违规文件与行号。行为面仍由 `tool-module-mount` 用例覆盖。
- **三处按原则收回**：① 服务名不做成对象、不引入新命名风格——两个有名导出够用；② 不加「两侧名字相等」的正向绑定断言——共享常量已结构性保证，再断言是冗余；③ `GLOSSARY.md` 只写术语定义，不写文件名／常量名／函数名／绑法（domain-modeling 要求词汇表不掺实现细节）。
- **验证**：`typecheck`／`lint`（306 文件，0 警告 0 错误）／`node scripts/run-tests.mjs test/engine/service-names.test.mjs`（1 pass）／`node scripts/run-tests.mjs test/engine/tool-module-mount.test.mjs`（18 pass）／`git diff --check` 全绿。

### settings-bridge 收门 ＋ 全拆十一域（2026-10-16）

- **`src/runtime/settings-bridge.ts` 1996 → 73 行**：只剩装配——建一次运行时 → 两个 `ctx.inject` 作用域 → 调 11 个域的注册函数 → 返回逐个 dispose。45 个端点 key／路径、响应与错误码一字未变。
- **新增 `src/runtime/bridge-runtime.ts`（782 行）**：共享运行态**只建一次**（descriptor 30s 缓存、`assetSources`、`capabilityQueue`、`moduleOrderQueue`、`pendingVariableSettings`、`warnedOfficialOrders`、change 回调、`register`／`gate`、跨域 helper；`route` 只归运行时内部的注册通道）。各域**零自建状态**——这是拆分最容易出错处（各域自建＝缓存不失效／串行化失效）。
- **（收紧）每域窄依赖**：11 个域各自声明 `type XxxRuntime = Pick<BridgeRuntime, …>`，可见面从整个 runtime（24 项）降到 **1–8 项**；`typecheck` 会拒绝域碰到未声明的面，该域的接口边界因此可被检查。`route` 从域可见面撤出（只有运行时自己的 `register`／`registerAgentRoute` 用），接口成员 24 → 23。
- **（收紧）串行闸成真模块**：`capabilityQueue`／`moduleOrderQueue` 三处形态逐字同构（`queue.then(task)` → 同步重赋链尾 → `await run`；链尾写法 `.then(()=>undefined,()=>undefined)` 与 `.catch(()=>{})` 语义等价；返回值三处都不消费；无状态耦合），因此提成 `createSerialQueue()`（`SerialQueue.run(task)`，注释标明「两个使用者＝真 seam」）；两条队列各一实例并转 `readonly`，三个调用点删掉重赋行、任务体一字未改。
- **新增 `src/runtime/routes/*.ts` 11 个域（1455 行）**：meta／settings／skills／templates／instructions／params／definitions／transfer／lifecycle／characters／diagnostics，与 host 侧模块边界一致；改一个端点只需进一个域文件。
- **过门知识收敛**：`module-subject-gate.ts` 新增静态策略表 `GATE_POLICY`（当前只有 `mutate`／`moduleDelete` 的 `format:false`）与两阶段门对象——`inspect(write?)` ＝读前闸（含声明面）、`authorize()` ＝写前闸（跳声明面、先判可写，逐字等于基线的 `{write:true}`）。26 处调用点全部改为 `runtime.gate(tx, key).inspect(...)`／`.authorize()`，`rg 'subjectGate\(' src/runtime` 只剩门模块自身 4 行（文档／工厂内两次调用／定义）。判据顺序、拒绝码与时机未动。
- **两处如实登记的差异**：① `moduleCapability` 由最后注册改为随 definitions 域注册（路径全 exact 且无重复，观察不到差异）；② 服务重注入时 `pendingVariableSettings`／两条队列／`warnedOfficialOrders`／`assetSources` **现在保留**（基线会重置；descriptor 缓存仍在 attach 时显式清空以对齐基线）——保留这些状态更正确（待发布标记与暂存来源不该因服务重启而丢），但这是行为差异，非静默改动。
- **7 个端点零测试覆盖**（models／modelReasoning／skillRead／skillWrite／templates／promptConfigs／contextActivationDiagnostics）：本轮只做逐行比对，**不为此专门补测**（避免为覆盖率而测）；真改到哪个端点时再补穿过接口的行为测试。
- **并发语义有 check 了**：`test/host/settings-bridge.test.mjs` 新增「模块写队列：两个并发写不交错——后入队的写按先入队者已落盘的结果继续」——同一条 `moduleOrderQueue` 上并发两个 `/module-enable`（第一个卡在既有的重建闸门里），断言①第二个的响应 `value.enabled` 深等于 `[先入队, 后入队]`（第二个写看到了第一个的效果）、②两个 `module.yml` 的 `configOrder` 深等于 `[{card:0},{card:10}]`（append 是「读启用集算 used 再写」的读改写，交错就会碰号）。断言只落在公共接口（端点响应 ＋ 落盘 YAML），不 import `createSerialQueue`、不数 mock。**判别力已验证**：把 `createSerialQueue` 临时改成不串行，该用例两处断言都失败（`['queue-second-19']` vs `['queue-first-18','queue-second-19']`；`[{card:0},{card:0}]` vs `[{card:0},{card:10}]`），随后已还原。
- **验证**：`typecheck`／`lint`（305 文件，0 警告 0 错误）／`test`（**670 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿；归一化行级残差比对显示差异只来自门的调用形态、共享态落点与包装层收尾，无未解释的内容变化。

### 测试入口默认单用例超时 10s（2026-10-16）

- **`run-tests.mjs` 默认传 `--test-timeout=10000`**（调用方显式传则不覆盖，与 `--test-concurrency` 同一写法）。`--test-timeout` 是**每用例**上限、不是整轮上限：全量 4 路并行 ~6.6s，最长单用例远小于 10s，阈值不误伤正常用例。
- **为什么需要**：诊断「子代理跑测试假卡死」时查明**测试自身不死锁**——`withModuleLock` 拿不到锁立即 409、`processLocks(recover=true)` 按 PID 活性回收陈旧 token、runner 对 build 与 test 都用 `stdio: 'inherit'`。真正会假卡死的是三件外部事：① 用例内部 `stdio: ['pipe','pipe','pipe']` 的子进程（`module-storage`／`instructions-policy`／`module-install-lock`／`module-variables`／`persona-selection`）在受限沙箱里打不开管道或等审批；② 并发跑测试时 `tsdown` 的 `clean: true` 互删 `lib/`；③ 没有默认超时，于是 ①② 表现为无限等待。加了超时后它们会变成**带用例名的失败**。
- **验证**：一次性探针（12s 的用例，跑完即删）经 `node scripts/run-tests.mjs <绝对路径>` 得到 `test timed out after 10000ms` 且退出码 1；随后 `pnpm --dir $Repo test` 仍 **670 pass / 0 fail**（6.5s）。探针文件已按精确路径删除。
- **未做（本轮边界）**：不给 runner 加构建串行锁（并发跑测试仍可能互删 `lib/`，但会以失败而非挂住暴露）；不改那几处必须读子进程 stdout 的 pipe 用例；不启用 `--test-force-exit`（本机 Node 支持，若真挂住的句柄让进程不退出，可再加一行强制退出——但那样会掩盖用例泄漏的句柄，故留作备选）。
- **流程约定**：全量 `test` 只在非受限会话跑，交给子代理的 brief 只要求 `typecheck`／`lint`。

### manifest.ts 按簇拆成七个 host 模块（2026-10-16）

- **`src/host/manifest.ts`（1106 行 / 34 导出）删除**，按「变更原因同源」拆成七个 owner，消费方直接 import owner（不留 re-export 桶、不加转发层）：

  | 新模块 | 拥有的面 | 什么时候才改它 |
  |---|---|---|
  | `module-dirs.ts`（82） | `moduleDirExists`／`packageModulesDir`／`packageEngineDir`／`userModulesDir`／`resolveModuleDir`／`isEditableModuleDir` | 部署布局变了 |
  | `module-spec.ts`（113） | `ModuleSpec`／`loadModuleSpec`／`invalidateModuleSpec` ＋ spec 缓存 | `module.yml` 形状变了 |
  | `module-composition.ts`（174） | `applyModuleConfigs`／`assertCompositionArray` ＋ 文本装配（params 由入参给） | 装配规则变了 |
  | `module-params.ts`（203） | `resolveModuleParams`／`buildModuleConfigsFromParams`／`resolveModuleFacts`／`readModuleFacts`／`renderComposition` | 参数语义与事实计算变了 |
  | `module-catalog.ts`（267） | 列举、内置种子、复制/新建/删除、打开目录 | 模块目录操作变了 |
  | `module-definition-edit.ts`（102） | `saveModuleParams`／`readModulePersona`／`saveModulePersona`／`withModuleDefinition` | YAML 事务纪律变了 |
  | `module-capabilities.ts`（229） | 能力创建/移除/声明增删 ＋ 三个类型 | 能力声明模型变了 |

- **依赖单向**：`dirs ← spec ← {params, catalog, definition-edit}`、`composition ← {params, capabilities}`、`params ← capabilities`；新模块之间的 import 全部朝下层，**无环**（第一回合破掉的 C↔D 环是这次能一刀切开的前提）。
- **包公共面不变**：`src/index.ts` 的再导出块只换来源路径，**146 个再导出符号逐一相同**（`scripts/rematerialize-modules.mjs` 从 `lib/index.mjs` 取 `userModulesDir` 不受影响）；5 个跨簇 helper（`asString`／`findModuleDir`／`moduleFile`／`compositionModuleDirs`／`loadCompositionText`）只导出到 host 内部，不进包面。
- **纯搬家**：新旧代码行数各 816 行，逐行比对差异只有 5 处——恰好是那 5 个 helper 多出的 `export` 关键字；逻辑、错误文案、校验顺序与写盘语义一字未改。
- **文档**：`asset-transfer.md`／`architecture-params.md`／`ui-architecture.md` 中指向 `manifest.ts` 的结构性引用改指新 owner（`CHANGELOG`、`docs/adr/`、`docs/superpowers/specs/` 是历史记录，保留原样）。
- **验证**：`typecheck`／`lint`（293 文件，0 警告 0 错误）／`test`（**670 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿；`rg 'host/manifest' src test scripts` 零命中。

### 引擎接口进编译期；打破组合/参数循环（2026-10-16）

- **`src/` 不再靠 `@ts-expect-error` 引入引擎**：给 10 个被 `src/` 静态引入的引擎模块补手写 `.d.mts`（`rule-spec`／`shared`／`interpolate`／`executor`／`branch`／`tool-definition`／`order`／`rule-runtime`／`compaction-epoch`／`conditions/index`），删掉 `src/` 的 23 条 pragma ＋ `test/host/bundled-assets.test.mjs` 那条（`test/` 本不在 tsc 项目内）。加上既有的三份（`template-evaluation`／`template-frame`／`context-activation`），插件侧现在只对**未被静态引入**的模块（如 `schema.mjs`，只经 URL 动态导入）留运行期断言。
- **声明只覆盖插件依赖面**：`compileRules`／`completeRuleSections` 这类结构性入参按 `readonly unknown[]` 声明（引擎本就只做结构校验），`InjectionConfigSpec` 只列编译必产出字段（写全会破坏 `rule-content.ts` 的 `as PromptConfigSpec`）；声明文件不引用 `src/` 类型，跨引擎模块用 `import type { X } from './y.mjs'`。零构建配置改动：不进 `lib/` 打包，`exports["./engine/*"]` 已覆盖，TS 按 `./x.mjs` → `./x.d.mts` 解析。
- **打破组合/参数循环（manifest 拆分第一回合）**：`loadCompositionText` 改成接收**已解析的 params**（去掉形参 `_runtime` 与内部的 `resolveModuleParams` 自调），两个调用点各传自己那一份——`renderComposition` 仍按空 runtime 解析，**行为不变**（旧实现把 runtime 传进来但内部同样用空 runtime）。这条入参边界让「组合文本」成为不依赖参数/事实的纯文本模块，为下一回合按簇拆分（七块 ＋ 删 `manifest.ts`、`index.ts` 重导出改指新路径、包公共面不变）扫清唯一的 C↔D 环。
- **文档**：`docs/engine-reuse.md` 新增「插件侧怎么引入引擎（类型边界）」；`prompt-configs.ts`／`custom-tools.ts` 里「无 `.d.mts` 靠 pragma 引入」的注释改为事实。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**670 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿；`rg '@ts-expect-error' src test` 零命中，`engine/vendor/**` 的 10 条未动。

### 资源编辑器读改写协议：最新优先原语 ＋ 统一序号命名（2026-10-16）

- **新增 `src/client/data/resource-track.ts`**（`beginLatest`／`isLatest` ＋ `LatestSequence`）：六个 owner（rules／variables／persona／instructions／skills／config-order）真正共用的只有这一条策略——**只有最新一次请求拥有落地与清理权**，晚到应答既不写草稿也不清 `busy`/`loading`。序号字段统一叫 `latest`（此前三派：`readSequence`／`sequence`／`seq`）。
- **四家换上新原语与命名**：`rule-drafts.ts`（20 处）、`module-variables.ts`、`workspace-drafts.ts` ＋ `ModulePersonaCard.tsx`（persona 段与 sources 段两套）、`instruction-drafts.ts` ＋ store（`isCurrentInstructionSeq` 改成 `isLatest` 的领域别名）。**运行期零行为变化**。
- **核实后不做**（只读对照表推翻了本来的假设）：六家共享的是**模式**而非可共用代码——请求形状、分域粒度、失败语义各不相同；包一个通用「读改写轨道」需要约 9 个回调，接口比它替换掉的代码还长（浅模块）。发布态派生也**不抽**：rules 把「`publicationError` 非空」也算 pending，variables／persona 只看显式 `publicationPending`，统一它会改变重试入口的显示——这条差异改为写进文档的**有意行为**。
- **两处例外保持原样**：skills 用 `writing` 布尔锁 ＋ session 字符串一致性替代版本/序号（其 `seq` 还与 store 的 bootstrap 覆盖保护耦合）；config-order 的 `generation` 是闭包变量、外部不可观测。
- **修正先前的误判**：迟到丢弃并非零覆盖——`test/client/module-variables.test.mjs:53` 已覆盖「迟到响应不能覆盖新读取」；本轮只补原语自身的判据（`test/client/resource-track.test.mjs`）。
- **投机项判废**：`bridgeCall` 有 18 个消费者但传输只有一条 loopback fetch（没有第二个 adapter，注入点是为不存在的需求造缝）；locales 已是「前缀分区 ＋ zh 键类型强制 en 键集一致 ＋ 六子字典合成」的结构（`locales.ts` 549 ＋ `locales-prompts.ts` 895 行），余下只是文件切分，868 个键的搬迁零行为收益。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**670 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿。

### 客户端 store 端口化；两个受众页合一（2026-10-16）

- **新增 `src/client/data/store-ports.ts`**：按域切十个端口（`ModuleFactsPort`／`DraftsPort`／`ParamsPort`／`VariablesPort`／`SkillsPort`／`InstructionFilesPort`／`RuleEditingPort`／`ModuleActionsPort`／`NoticePort`／`ModelsPort`／`HostApiPort`），每个端口一段注释说明它服务哪些卡。`PromptToolStore` 改成这些端口的**交叉类型别名**——运行期零变化：store 仍是同一个扁平对象，订阅时序与保存队列一字未改。
- **18 个文件 / 19 处 `Pick<PromptToolStore, …>` 全部换成端口交叉**（主/子代理页、注入点面板三处切片、技能页与技能行、规则工作台与模板选择、参数控件、模块页与切换器、能力创建菜单、模型卡、诊断卡、工作台外框、`usePromptToolFields`／`useRuleEditor`）。「这张卡需要哪些面」现在由端口名回答，全仓 `Pick<PromptToolStore, …>` 零命中；`typecheck` 是安全网（端口成员少了或实现漏了都编译失败）。
- **`ModuleVariablesView` 归位**到域模块 `data/module-variables.ts`（原在 store 文件里，端口类型定义要引用它）；store 仍按原名再导出。
- **两个受众页合成一个参数化 `AudiencePage`**：`MainSessionPage.tsx`／`SubagentPage.tsx`（70／76 行、各自的 store 透传清单）删除，受众差异只剩参数表里四样——`scope`、`aria` 文案键、`excludeCapabilities`（子代理页排除 `main-model`）、`audience`。`PromptWorkspace` 按页传 `audience="main" | "subagent"`，SSR 用例断言不变。
- **测试桩按端口写**：`module-asset-subject`／`instruction-card-settings` 两份手抄桩改成「按端口列出要用的面」，并删掉已退场的 `enqueueModuleTask`；**不做** `makeStoreStub` 之类的合并 helper（删除测试判定它是纯转发，只会变成第二份接口清单）。
- **判废**：43 个测试文件仍用「先设 env 再动态 import」——上一轮根惰性化后该约束已消失，改成静态 import 是纯风格 churn、零行为收益，本轮不做。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**669 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿。

### 部署根改成按调用求值；host 用例默认 4 路并行（2026-10-16）

- **去掉「import 时冻结」**：`paths.ts` 的五个根派生量（`DSH_HOME`／`STORAGE_ROOT`／`MODULES_DIR`／`USER_SKILLS_DIR`／`GLOBAL_VARIABLES_FILE`）改成按调用求值的函数（`dshHome()`／`storageRoot()`／`modulesDir()`／`userSkillsDir()`／`globalVariablesFile()`）。部署根仍由平台层 `DSH_HOME` 决定（与官方 `resolveDshHome` 同口径），插件不另立配置项；`storageRootOf(home)` 仍是纯函数。
- **两个名字合一**：`MODULES_DIR` 常量消失，`manifest.ts#userModulesDir()`（32 处调用，其中 7 处是调用期求值的默认参数）改为委托 `modulesDir()`——同一个值不再有两个名字，两处都按调用求值。
- **测试不再受导入顺序约束**：此前必须在 import 之前设 `DSH_HOME`（`run-tests.mjs` 里记着 2026-10-02 的真实事故：某用例在 import 之后才设，把夹具角色卡写进了真实 `.dsh`）。现在后设的环境变量同样被采纳，那个失败模式消失；runner 的兜底默认值继续挡住「从没设过」的情况。若干测试文件与 `config-store.ts` 里描述该约束的注释同步更新。
- **host 用例默认 4 路并行**：`run-tests.mjs` 此前硬性 `--test-concurrency=1`（注释归因于共享 DSH_HOME／模块根与跨进程锁）。根改成按调用求值后实测：4 路与 8 路各跑一次**全绿（669/669）**，全量用时 ~23s → ~6.6s／~4.3s；默认值取 4，可用 `--test-concurrency=N` 覆盖。
- **形状变化**：`index.ts` 的再导出从常量 `USER_SKILLS_DIR` 变为函数 `userSkillsDir()`（对外形状变化，与 `withModuleDefinition` 那次同类）；`instructionPolicyPath`／`skillsStatePath` 的入参名由 `dshHome` 改为 `home`（形参名，调用方按位置传参不受影响）。
- **未做**：不做显式 root 贯穿（审查原建议）——要动几十个签名与全部调用点，换来的是「同进程双根」，而今天只有一个部署根（YAGNI）；`index.ts` 装配处读一次已经让「根从哪来」显式。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**669 pass / 0 fail**，默认 4 路）／`build`／`git diff --check` 全绿。

### 桥测试基底；补导入侧四个缺口（2026-10-16）

- **宿主桩迁移收尾**：`skills-catalog`／`settings-bridge`／`rules-bridge-safety`／`preset-activation-bridge`／`asset-transfer-bridge` 五处手写桩也改调 `makeHostContext`（差异项用 `describe`／`get`／`effect` 选项表达）；全仓手写宿主桩只剩两处**刻意保留**的（`module-subject`／`shared/bridge-contract` 用 `handlerTable()` 拼多次注册与逐端点取 handler），`lib` 派系四个用例仍打构建产物面。各文件自己的 `call` 包装保留（返回形状不同，合并要改十几处断言）。
- **harness 出 `makeHostContext`**：宿主 Context 桩（handlers ＋ settings ＋ webServer ＋ inject ＋ 一次桥调用 `call`）收进 `test/fixtures/host-harness.mjs`，差异项（多 namespace 的 `describe`、带 disposer 的 `effect`、晚到服务）用选项覆盖，不做成配置表。`module-management` 与 `module-package-import` 两个文件的桩先迁移作样板；`handlerTable` 保留给 `module-subject`／`bridge-contract`。**刻意不迁**打构建产物面的四个用例（`wave1-safety`／`instructions-policy-endpoint`／`instruction-scope-guard`／`module-prompt-configs`）——它们与 src 输入不是同一个 seam，强行统一会丢掉「bundle 也能跑」的覆盖；harness 里已写明理由。
- **补四个此前零覆盖的导入侧路径**：① `needs-kind-selection`（原生片段在 native-preset／native-character 间二选一：预览回候选与两种 kind、选定类型后进入 ready、全程零落盘）；② `/characters-import` 未知字段 400 `characters-rejected`；③ 目标在同一请求内被换掉 409 `characters-preview-stale`，原目标与新目标都零写盘（计数式 `moduleDirectory` 桩：两道 `subjectGate` 各含一次身份复核，第 5 次才是端点自己的陈旧性检查）；④ `importCharacterCardFile`（6 行包装入口）与直接传字节同结果。
- **核实后不做**：导出端点与导入端点的参数白名单**不同物**（`id/mode/preview/expectedRevision/memoryChoices` vs `files/sourceId/targetId/targetName/overwrite/sourceKind/expectedSourceDigest/expectedPreviewRevision/promptOrderCharacterId/preview`），SHA-256 校验与 `assertModuleId` 早已共用；合并只会做出一个「假共享」的校验器。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**669 pass / 0 fail**，新增 4 条）／`build`／`git diff --check` 全绿。

### 导入安装器去掉重复转换（2026-10-16）

- **一次安装从三次全量 preview 收到一次 ＋ 两次廉价复核**：`installModulePackage` 原先在链外、链内、锁内各跑一次 `moduleImportPreview`——每次都要全量 decode 上传文件、重算来源摘要、YAML 解析与 classify、ST 转换、规则编译，并**递归读目标目录每个文件**重算目录版本；三次里只有链内那次的内容被用于写盘。现在保留链外那一次（拿转换产物与串行键），链内按当前事实重解目标 id（`-copy` 后缀只看 `existsSync`）＋读一次目录版本＋用**同一个成分函数**重算 revision 与客户端凭据比对，锁内只再读一次目录版本。判据与今日等价（同一次调用内 revision 的其余成分不可能变），代价从「全量转换」降到「一次目录遍历」。
- **revision 的成分只有一个来源**：从 `moduleImportPreview` 抽出 `revisionOf(...)`（源摘要 ＋ 选组 ＋ 目标身份），预览与提交共用——将来加一项成分只改这一处。**公开签名一个都没动**：`moduleImportPreview`／`installModulePackage`／`exportModulePackage` 的形状与返回保持不变。
- **`/characters-import` 去重复解析**：同一请求原先先 `prepareImport(files,'character')` 再 `moduleImportPreview`（后者内部又 prepare 一次），现在一次 preview 同时给出候选状态与转换产物（`report` 取自 `preview.prepared.report`）。端点安全面（两道 `subjectGate`、目标切换 409、写前参数校验）与响应形状未变。
- **未做（用户拍板）**：不新建导入事务模块——四个入口有 10 条真差异（门、`preview` 默认语义相反、记忆预检、钩子、返回形状、失败映射），抽成一个函数只能得到一个宽 options 接口；seam 保持「preview ＋ install」两次调用，新入口／新来源＝加一个调用点＋自己的响应层。`characters ↔ module-package` 的**潜在**环不动：静态图今天无环；导出默认只出一份 `module.yml`，而 `projectCharacterMemories` 的投影发生在模式分支之前、两种模式都要用，剥离不掉——拆它只能给导出接口开角色专用注入口（接口污染），或把整块导出编排搬走（另一轮的量）。
- **新增回归**：`装载窗口：暂存期间目标被外部改动即拒装，外部内容不被覆盖`——在暂存写盘期间往目标目录塞外部文件，断言 409 `module-preview-stale` 且外部内容与目标正文都保持原字节。诚实说明：这条**不是**「改前必红」的判别测试（旧实现靠第三次全量 preview 同样会拒），它的价值是钉住重构不得削弱这条保证。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**665 pass / 0 fail**）／`build`／`git diff --check` 全绿。

### 指令文件草稿补回归网；两处收尾（2026-10-16）

- **`shared-alias` 归入「先重新读取」**：规则编辑器的重试判定抽成 `READ_FIRST_CODES`（`rules-conflict`／`module-changed`／`shared-alias`）——上一轮引入 `shared-alias` 后被旧判定当成「重试保存」，点重试只会重放同一次注定失败的写；现在与版本冲突同列：阻止旧版本再次提交、重试走重新读取（按钮文案本就是「重新读取」）。客户端行为变化，`docs/ui-architecture.md` 的重试契约同步一句。
- **跨进程锁有了真双进程回归**：`test/host/instructions-policy.test.mjs` 原来那条用手工写入的 `<pid>-<uuid>.lock` 伪造活锁，换成真另一个进程持锁（子进程 `withModuleLock` ＋ stdio 握手阻塞）：本进程 409 `instructions-policy-busy` 且目标逐字节零写盘，释放后同一 revision 可写。按「一个 seam 只留一条关键拒绝」，伪造 token 那条删除。
- **指令文件草稿协议补 4 条行为用例**（新建 `test/client/instruction-drafts.test.mjs`）：请求形状与「保存成功只确认请求时的快照」（在途新输入仍算未保存）／冲突保留草稿与旧基线且此后不发注定失败的请求／切上下文保住草稿但不可写、迟到序号不写回／多文件结果各归各（不宣称跨文件原子）。该文件 294 行此前零用例。
- **删两个零消费者导出**：`dirty-state.ts#shouldReloadAfterParamSave`（一行 `switchesEqual` 包装）与 `prompt-config-content.ts#isModuleCard`（一行取反）。
- **未做**：`instruction-drafts` 只补钉子、不改行为（本轮没发现要修的 bug）；真机交互（按钮、焦点、脏提示）按 §12.1 留 Edge smoke，不做断言。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**664 pass / 0 fail**，新增 5 条）／`build`／`git diff --check` 全绿。

### 共享引用守卫收成一处，三条写路径不再无守卫（2026-10-16）

- **四处拷贝合成一份判据**：`config-store`（存储配置）、`manifest`（人设保存）、`module-rules`（规则编辑）逐字相同的「序列化 → 与声明的候选比对 → 不一致即拒」收进 `module-storage.ts#serializeWithoutSharedAlias`；`module-variables` 的变体（只比未拥有字段）改用同文件的 `assertUnownedUnchanged`。`deleteYamlPath` 的两份合并（顺手项：按删除测试它属搬家而非集中）。
- **三条此前完全无守卫的写路径关闭**：`withModuleDefinition`（角色卡并入、来源移除、`/customTools`）新增必填 `{ owns }`，守卫在提交前比对「owns 之外的顶层键」；能力增删（`createModuleCapability`／`removeModuleCapability`）两条直调 `commitModuleDefinition` 的路径各补一行守卫，owns 的 section 键从能力登记表推、不硬编码。此前 YAML 共享引用可让「只改 modules／rules」的编辑连带改掉 persona 等字段并**静默成功**。
- **不变量有了自己的错误码 `shared-alias`**：四处拒绝原先是 `ModuleRulesError` 的默认 `rules-invalid`，客户端只能靠文案分辨；各领域文案逐字保留（含 `toString()` 失败也按共享引用判定的既有语义），并**点名被连带改动的键**，`owns` 少声明的误拒一眼可诊。
- **`/customTools` 归入全桥错误规则**：host 分类优先、端点码兜底（与 `/persona` 同形），此前它把任何错误都包成 409 `custom-tools-rejected`，新 code 到不了客户端。
- **形状变化**：`withModuleDefinition` 的导出签名从 `(dir, mutate)` 变为 `(dir, mutate, { owns })`（`index.ts` 再导出；仓库内三个调用点同轮更新）。
- **未做（已知边界）**：守卫收的是机制不是 seam——提交口有两个（module.yml 走 `commitModuleDefinition`，config.yml 走 `atomicWriteTextFile`），「守卫必然被调用」仍靠调用点自觉；`owns` 是声明式义务，类型系统管不着，结构性做法（只暴露 owned 键的编辑器）代价远超本轮；`/rules` 返回 `shared-alias` 时客户端仍按「重试保存」处理（只对 `rules-conflict`／`module-changed` 走重读），改重试策略属客户端交互，本轮不动。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**659 pass / 0 fail**，新增 2 条：三条 owns 的守卫不变式 ＋ 主路径；`/rules` 过桥返回 400 `shared-alias` 且零写盘）／`build`／`git diff --check` 全绿。

### 指令策略补跨进程锁；指令文件在 rename 前复核（2026-10-16）

- **指令策略写入有了跨进程锁**：`writeInstructionPolicy` 按 `config-store` 的形状取 `withModuleLock(存储根, 'instructions')`，锁包住「读 revision → 校验 patch → 写盘」整段。此前两个共享 DSH_HOME 的进程（TUI ＋ web）可以同时通过 revision 校验，后者 rename 静默覆盖前者、双方都返回 ok。锁被占时返回 409 `instructions-policy-busy`（不是 500），客户端可提示重试；同进程并发请求同样被这把锁挡下。
- **指令文件的 CAS 窗口收紧到 rename 前**：`writeAgentsFile` 增加可选 `beforeReplace` 谓词，`writeAgentsFileChecked` 在其中重读快照、复核 `expectedRevision` 与真实路径——原先的比对发生在写暂存**之前**，写暂存到 rename 之间被外部改写会静默覆盖用户内容。冲突仍映射为 409 `agents-file-conflict` / `agents-file-identity-changed`，不降级成 `agents-file-write-failed`，更不是 500。
- **踩坑记录（方法论）**：让复核失败携带错误码时不能用 TS 参数属性（`constructor(readonly code: string)`）——本仓库直接跑 `.ts`（Node strip-only 模式），参数属性会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，而 `typecheck` **抓不到**（首次全量测试因此红了 11 个文件）。已按 `ModuleRulesError` 的写法显式赋值。
- **已知边界**：存储根若被替换成符号链接或非目录，`canonicalModulesRoot` 抛的是普通错误（500），不再落到结构化 409——这是「配置损坏」而非「并发冲突」，与模块写路径同口径。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（**657 pass / 0 fail**，新增 2 条：锁被占时 409 busy 且目标零写盘、写暂存期间外部改写被 rename 前拒绝且外部内容保留）／`build`／`git diff --check` 全绿。

### 原子替换纪律收回 text-file（2026-10-16）

- **四份手写替换合成一处**：`skills-policy`（技能调用策略）、`skills-config`（技能状态）、`instructions-policy`（指令策略）、`agents-cards`（用户 AGENTS.md／CLAUDE.md 正文）各自维护的「同目录暂存 → 写前复核 → rename → 失败清理」全部改调 `host/text-file.ts#atomicWriteTextFile`；连同既有 7 个调用点，全仓原子文本替换只剩一个实现，暂存名从 5 种形态收敛成 `.目标名.tmp-<uuid>` 一种。
- **一个真缺陷随统一消失**：`instructions-policy` 原实现既没有 `flag:'wx'` 也没有失败清理（rename 失败就在 `.prompt-tool/` 里留下 `<instructions.yml>.tmp-<pid>-<ts>`），统一后由 helper 覆盖；`skills-config` 里裸 `unlinkSync` 的 `finally`（unlink 抛错会穿透 `{ok:false}` 映射）随该段删除一并消失。
- **权限语义改成「精确保留」**：`mode` 从 `writeFileSync` 的 mode（内核会再按 umask 掩一次，只会收窄）改为写后 `chmod`；省略 `mode` 时默认保留目标现有权限位，目标不存在才按 0o644 与 umask 新建。此前 5 个没传 mode 的调用点会把 0o600 的目标换成 `0o666 & ~umask`（POSIX 上真实的放宽），现在收口到 helper 的一处默认值。已解析权限时暂存先按属主可读写建、再设位，设位前不比目标更宽。
- **接口只加两样**：`mkdir?: boolean`（两个调用点原本各自 `mkdirSync`）与导出的 `atomicTemporaryTarget`（暂存名的「造」与「认」同源——`module-storage` 的中断写入清扫改引用它，私有正则删除）。不加「内容没变就不写」：三家判据本就不同（整份文本／两个 frontmatter 键／不做），收进 helper 只能再加参数区分。
- **清理异常吞掉**：helper 的失败清理用 `try/catch` 包住，保证原始错误（版本冲突／rename 失败）总能抛出，与 agents-cards 原实现同口径。
- **未做（已知边界）**：模块目录之外的崩溃残留（技能目录、`.prompt-tool/`、用户指令文件目录）不做自动清扫——它们不进技能清单与模块列表，也不影响后续写入（每次取新的 UUID 暂存名）。「写前自清」与「启动扫描」都评估过：前者要按命名形态删用户目录里的文件，后者要目录级授权，本轮都不做。
- **未做（已排进 PLAN 的 Wave 2）**：`instructions-policy` 仍不取 `withModuleLock`（两个共享 DSH_HOME 的进程可同时通过 revision 校验，后者静默覆盖前者）；`agents-cards` 的 `expectedRevision` 比对仍在写暂存之前、rename 前不再复核。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（655 pass / 0 fail，新增 1 条权限位用例 `test/host/text-file.test.mjs`）／`build`／`git diff --check` 全绿。

### 桥端点注册收进同一个入口（2026-10-16）

- **41 处手抄骨架收成一个 helper**：`settings-bridge.ts` 里 39 处数组内 ＋ 2 处 map 内的 `webServer.register({ kind, path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.x, handler: route({...}) })` 全部换成 `register(BRIDGE_ENDPOINTS.x, spec)`。`webServer.register` 的站点数从 42 降到 **2**（两个 inject 作用域各一个 helper）；45 个端点由 43 次调用覆盖（`skillRead`／`skillWrite` 在 map 内共用一次注册）。
- **收益不是"少打字"**：端点键现在**进类型**——写错键是编译错误；而此前每处手写 `PREFIX + BRIDGE_ENDPOINTS.x` 是一类**静默笔误**的来源（路径拼接错了不会有人报错，只会在运行期 404）。
- **`body` 默认值经核实后省略冗余**：`bridge-transaction.ts` 的 `spec.body ?? 'json'` 确认默认就是 json，因此省略 39 处显式的 `body:'json'`；**`body:'none'` 的 4 条逐字保留**（`templates`／`triggers`／`assetUpload`／`charactersImportStream`——它们要自消费原始流，那里明写"替它们排空流会把要读的数据吃掉"）。
- **一行行为都没改（有形状证据）**：diff 里 206 处删除**全是旧外壳行**、46 处新增**全是注册与 helper 行**，没有一行 handler 正文被动过；`route(...)` 的调用形态、主语策略、各端点状态码与错误码全部保持。
- **测试零改动**：`bridge-contract.test.mjs` 的"所有端点路径全部注册且无多余"（键集＝45 路径）与逐路径扫描、`settings-bridge.test.mjs` 的桩全部原样通过（全量 654 pass）。
- **未做**：不改 `route()` 的签名（那要动 `BridgeRouteSpec` 与 `bridge-transaction` 的四道边界顺序：loopback 403／非 POST 405／32MiB 413／非对象 400，那是行为契约）；不统一约 90 处内联信封（里面混着各端点自己的状态码与条件 code，统一它是**改行为**而不是收骨架）；两个作用域的 helper 仍并存（settings 作用域返回 disposer、tool-surface 作用域返回 void），合并它们需要先统一两处的生命周期归属。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（654 pass / 0 fail）／`build`／`git diff --check` 全绿。

### store 依赖面收窄成能力面；切页与退出时保存（2026-10-16）

- **收窄（零行为变化）**：撤下 8 个零消费者成员（`ensureModelReasoning`／`templatePreStepCount`／`savedSwitches`／`savedConfigs`／`instructionPool`／`dirtyInstructions`／`getInstructionPolicy`／`enqueueModuleTask`）；14 个消费方与 2 个 hook 包装改用 `Pick<PromptToolStore, …>` 显式声明能力面（同文件内复用局部类型），两个纯透传页取子面并集；顺手删掉 `EngineModuleActions` 的死 `store` prop（该菜单只读 `t` 与 `items`）。
- **注意：收窄的是「依赖面」，不是成员数**——壳仍以原名转发，而 `persistBeforeLeave` 是**有意净增**的一个成员，它换掉的是"切页与退出两处各自编排该调哪几个 `persist`"。
- **判别力是单向的**：`typecheck` 抓得住"少列"（漏了就报错，实施中误删 `dirtySwitches` 即被当场抓住），抓不住"多列"（真实调用方传整个 store，它确实有那个成员）。所以"每处只列实际取用"靠逐处核对；两个透传页用脚本核对过 `missing=0 extra=0`。
- **切页与退出时保存**：新增 `store.persistBeforeLeave()`，在 `PromptWorkspace.changePage`（覆盖所有切页路径）与 `onClose`（退出工作台）调用。它只存 **store 能触及的两个域**——全局开关（脏了才发请求，靠新增的已保存快照 ref 实时比较）与指令文件（交给 `persistInstructionFiles` 自己过滤已改动/可写/上下文匹配的文件）。**规则草稿不在此列**：其保存入口是各模块的 rule editor 实例（组件层按 moduleId 现建），store 拿不到；它按 moduleId 留在内存、不会因离开而丢，且有自己的显式保存。失败只提示一次并保留脏标记，**不阻断**离开。Escape/backdrop 收起抽屉不等于收工，不触发保存。
- **已知边界**：`InjectionPointsPanel` 的 `PanelStore` 29 项里 15 项是"整份转发 store 给子卡"漏进页面签名的，真正的收窄要按需分片传参（另一轮）；`persistBeforeLeave` 的 4 行编排无自动化用例（它调用的两个 `persist` 各自有测试覆盖），靠 `typecheck` 与结构审查。
- **验证**：`typecheck`／`lint`（0 警告 0 错误）／`test`（654 pass）／`build`／`git diff --check` 全绿。

### 内部：manifest 导出面收窄，并记录候选 7 的复核结论（2026-10-16）

- 去掉 4 个**零外部消费者**的导出（`asString`／`isRenderableModuleDir`／`normalizeParam`／`loadCompositionText`——逐个 `rg -l` 核实只出现在 `manifest.ts` 自身）：`src/host/manifest.ts` 的导出面 **39 → 35**。跨文件类型检查确认无人引用，**零行为变化**。
- **复核结论：候选 7 不做大改造**。删除测试显示它在赚钱——39 个导出、**22 个消费者文件**，约 90% 的导出有多个消费者（`loadModuleSpec` 13 个、`resolveModuleDir` 11 个…）；按族拆成"发现／参数／人设／能力／组合"会把 22 个消费者需要的知识散到多个文件，与 locality 相反。报告标它 Speculative 是准确的。

### SKILL.md 的合法性收成一份解析（2026-10-16）

- **`src/host/skills-parse.ts` 成为唯一实现**：边界正则、「必须是 YAML 映射」检查、YAML 别名拒绝、legacy 键名单与文案、BOM 口径全在这里；清单扫描、导入、删除、内容读写、策略写入五处共用。`content` 与 `policy` 的 `parseMarker` 保留外壳（读盘、路径与可写校验、各自专有的 name/description 校验），只把合法性判定交给它。
- **修掉的真问题**（评审报告的前提是反的：容忍 BOM 的是 policy 与 content，**只有 `skills-parse.ts` 不容忍**）：带 BOM 的 SKILL.md 此前是「**清单判无效、导入/删除/策略全拒，而编辑器读得开、保存也不消除 BOM**」——同一份文件两个答案。另一处：`skills-parse.ts` 缺 YAML 别名检查，于是清单/导入/删除对含别名的文件「接受」、另两侧「拒绝」。
- **三处行为变化**（均经授权）：① **BOM 都容忍**（读时剥、写回保留）——清单/导入/删除从拒绝变正常工作；② **别名检查补进统一解析**——同三侧从接受变一致拒绝（别名会让「保留注释改写」出错）；③ **legacy 键文案统一**为带 `; use "…"` 修正提示的那条。
- **边界产物 `boundaries: { open, close, tail }`**：每个片段都有明确消费者（`content` 用 `open`/`close`，`policy` 用 `tail`），写回不再各自 slice 边界；不变式 `bom + open + frontmatter + close + tail ≡ raw` 由测试钉住。实施中把 `tail` 的起点算错过一次（旧的 `rest` 是「`---` 之后的一切」而非「从收尾换行开始」），由 `skill-policy` 的行数断言抓出。
- **测试**：新增 `test/host/skills-frontmatter.test.mjs`——解析层直测（BOM 剥离 ＋ 逐字还原）＋ 三条「清单与策略写入对同一文件结论一致」。**判别力实测**：临时去掉 BOM 剥离 → 两条用例变红，且报错正是「带 BOM 的技能应当有效；本轮之前这里是无效」。

### /bootstrap 载荷形状收进共享契约（2026-10-16）

- **顶层附加字段按端点声明**：新增 `BridgeSessionExtras`（12 键，`/bootstrap` 与 `/describe` 共用）与 `BridgeBootstrapExtras`（`/bootstrap` 独有 6 键：`meta`／`overrides`／`globalParams`／`variables?`／`promptConfigs`／`instructions`），以及 `BridgeExtrasMap` / `BridgeExtrasOf<K>` / `BridgeResponse<K>`。事实核对发现两个端点**字段集不同**——`/describe` 不下发会话段，套用同一份会让它声称自己下发并不存在的键。条件存在的 6 个键标 `?` 并注明缺席条件；某个键将来变成必有，只需去掉 `?`，编译器会指出 host 是否补齐。
- **host 构造受编译期约束**：`collectDescribeExtras` 的返回类型由 `Record<string, unknown>` 收紧为 `BridgeSessionExtras`；`/bootstrap` 与 `/describe` 的响应体加 `satisfies`；`loadEngineMeta` 跨 `.mjs` 边界补 `EngineMetaLayerContract` 断言（形状由 `getEngineMeta` 保证，运行期由契约测试兜底）。
- **client 收窄**：`bridge-transport.ts` 里那份 16 键的共用 `BridgeSuccessExtras` 删除；`BridgeResult<T, E = unknown>` 的 `E` 表示该端点的顶层字段（缺省为空），`bridgeCall`／`bridgeUpload` 返回契约的 `BridgeResponse<K>`。效果：**在 `/meta` 上读 `skillCatalog` 现在是编译错误**——此前一份共用类型让任何端点读任何字段都合法。
- **`bridgeViewFromBoot` 改为 extras 原样传递**：旧实现逐字段搬 12 个（本身就是第二份清单，正因如此漏掉了 `meta`／`promptConfigs` 等会话段）。
- **第二道保险**：`test/shared/bridge-contract.test.mjs` 新增「常态下发的顶层键恰好是这 15 个」清单断言，挡住「某段被条件短路、或 `JSON.stringify` 丢掉 `undefined` 键」这类**类型看不见**的漏传。写这条断言时它当场抓出我漏数了 `ok`。
- **判别力实测两处**：① 临时删 host 构造的 `providers` → typecheck 报 `Property 'providers' is missing ... but required in 'BridgeSessionExtras'`；② 用「类型对但运行期没发」的方式（`undefined as unknown as string[]`）→ 清单断言变红（改完均已还原、无残留）。另外标注当场抓出**声明自身**的错误：`meta` 少了一层包裹，按运行期事实改声明而不是改 host。
- **已知边界（下一步）**：契约的 `meta` 段只声明四项共性（`EngineMeta` 的其余字段仍是客户端视图）、`promptConfigs.promptConfigs` 只保证是数组（卡片完整形状是客户端 `PromptConfigDraft`）——两处消费点各按既有事实收窄一次，把完整形状上移契约属独立一轮。

### 恢复层字段矩阵与层标签的镜像守卫，清理 6 处悬空引用（2026-10-16）

- **两条守卫重建**（`test/shared/bridge-contract.test.mjs`）：「客户端层字段矩阵与 /meta 下发的逐层字段键集一致」（**逐层**比对，不只比总键集）与「客户端层标签字典的键集与 /meta 下发的 layerLabels 一致」。它们补的是**「漏了不报错」**的缺口：`LAYER_FIELD_POLICY_KEYS` 是客户端手抄 `engine/schema.mjs` 每层 `fields` 的常量表，engine 是 `.mjs`、`shared` 无该字段的单一来源、也没有生成器，**少一个字段不会 typecheck 报错**；`LAYER_LABEL_KEYS` 漏一层会被 `InjectionPoint` 联合的穷尽约束挡住，但**引擎多一层**只有运行期对拍能发现。断言停在两端的公共接口上（`/meta` 载荷 ↔ 客户端模块导出），**不做**源码字符串对拍。
- **判别力实测**：临时给 `engine/schema.mjs` 的 pre-step 层加一个字段 → 第一条守卫变红且报错精确到层（「pre-step 的字段键集必须与客户端常量表一致」）；改回后 31 例全绿，引擎文件确认无残留。跑不红的测试等于注释，所以这一步是验收的一部分。
- **清理 6 处悬空引用**：`prompt-tool-types.ts:34,109`、`CustomToolEditor.tsx:25,38`、`prompt-config-policy.ts:43,110` 指向的 `test/client/mirror-guards.test.mjs` 与 `test/client/prompt-config-form-layout.test.mjs`，都在 `01336d85`（测试按 TDD seam 收敛，1617 → 289 例）被**整文件删除**——那轮清理了 README/docs 的 36 处引用与 scripts 2 处，漏了 src 里这 6 处。现在：守矩阵与层标签的两处**指向新建守卫**，其余四处改为**陈述真实覆盖**（`test/engine/predicates.test.mjs` 的 `MATCH_LOGIC` 行为断言、`test/host/module-content-assets.test.mjs` 的 `validateDefinition` 断言——两处 import 都经核实）。
- **另修一处行号漂移**：`CustomToolEditor.tsx:28` 引 `tool-definition.mjs:92` 的 fs action 列表，实际已在 `:96`（退役的 delegate 工具列表插在前面）。
- **未做**：不重建被删文件里另外 4 个用例（`MATCH_LOGICS`／`KIND_OPTIONS`／`FS_ACTIONS`／`SCHEMA_TYPES`——今天都有等价的行为覆盖），也不恢复「正则解析引擎源码」那种形态。今天两份定义**值层面无漂移**：9 层 × 11 字段键集与顺序全一致。

### 引擎：机器路径事实单一来源 + 参数 schema 抽公共（2026-10-16）

- **`engine/machine-paths.mjs`（新建）是 `DSH_HOME`／`CWD`／`WORKSPACE` 的唯一取值来源**：此前这条配方在四处各写一遍（`interpolate` 的内置变量、`fillers` 的 env facts、`run-code-env` 的进程环境兜底、`instruction-hint` 的指令文件探测），而且已经分叉——未设 `DSH_HOME` 时前两者按 `<USERPROFILE>\.dsh` 推导，`run-code-env` **不给该键**，于是同一台机器上 `{{DSH_HOME}}` 与 `run_code` 里的 `env.DSH_HOME` 是两个答案。四处改为共用它。
- **有意的行为变化**：`run_code` 注入的 `env.DSH_HOME` 在未显式设置时会得到与插值一致的推导值（此前不落键）。`DSH_WORKSPACE` 仍只认会话 cwd（没有就不落键）——统一的是**取值**，「这个键给不给」仍由各处策略决定。
- **接口只给取值不给策略**：`machinePaths(session, env?)` 返回三个字符串；需要「不可用」语义的调用方自行把空串折回 `undefined`（`instruction-hint` 如此）。无 `process` 的环境不抛（环境与 cwd 退化成空值，与 `run-code-env` 原有的 `typeof process === 'undefined'` 守卫同口径）；`env` 参数有生产消费者（`run-code-env` 的宿主快照），也让测试不必改全局态。
- **`toJsonSchema` 收进 `shared.mjs`**：`tool-search` 与 `skill-search` 曾各有一份逐字相同的私有实现，只差 `meta.items` 一行（skill 版缺）。抽公共时保留该分支，且 skill 侧 `meta.items` 恒为 `undefined` → **零行为变化**。
- **未做（一并记录，免得下次扫描又当新发现）**：`conditions/count.mjs` 与 `actions/registration.mjs` 各有一套「本会话当前轮」状态——两处互不读取，后者是每个动作私有的 `maxPerTurn` 上限（本就不该共享容器），且全仓 yml 无任何 `maxPerTurn`（无生产使用者）。真要启用它时先改喂事件方式：现在每个 `maxPerTurn` 动作各接一条 `ctx.on('session/event')`，与 `trigger.mjs` 明写的「不按规则各接一条」相反。
- **测试**：新增 `test/engine/machine-paths.test.mjs`（三个键的推导 + `run-code-env` 与唯一来源同答案）。

### 晋升相位收成挂载缝的追踪器池（2026-10-16）

- **池 + 统一喂事件**：新增 `engine/promotion-pool.mjs`。`createEpochPromotion` 自己不订阅任何事件（初始相位靠 `status()` 的全量冷扫建立），此前 `executor` **每次 `applyPromptConfigs`** 建两份、`phase` **每个编译谓词**建一份、`instruction-hint` 每次 apply 建一份、`pre-step-coordinator` 插件级两份，各自订阅、各自喂。现在由挂载缝持有池：按 `(promoteEvents, 其余选项)` 缓存复用，**池自己订阅 `session/event` 并统一喂**（订阅随池的归属走，调用方不需要记住"注入时谁喂"）。
- **共用实例的前提是喂事件收敛到一处**：门控模式下 `applyEvent` 的 `steps += 1` 不幂等（非门控才是 `promoted = true`），多来源喂同一实例会让步数翻倍、晋升提前——所以 `executor` 删掉了自己的两行 `observe`（同一条监听里的 `confirmDelivered` 去重记账**保留**）。
- **`executor` 改用既有注入口**：`options.promotion` 这个键早已存在（`:357` 的文档注释、`runPromptConfigBatch` 的 `:320,327` 都读它、托管路径由 `pre-step-coordinator.ts:180` 传入），但独立路径无条件自建并把它盖掉；现在改为 `options.promotion ?? 自建`，`{ main, withSubagents }` 形状不变（三个测试直接传这个形状的替身）。
- **`phase` 谓词从池取追踪器**：编译期没有池，因此把它纳入挂载期绑定——`needsMountContext` 扩展为「含 `preset`，或含 `phase` 且未显式 `subscribe: false`」，`rebindConditions` 在挂载时注入池。订阅模式下谓词**不再提供 `observe`**（池已统一喂，再给入口就是重复推进）；`subscribe: false` 分支逐字保留（每次判定冷扫、不给 `observe`）。
- **未做的边界**：`instruction-hint`（不在 `mountRuleSources` 的 options 链上——它由 `prepareAssembly` 阶段的 `module.apply(ctx, config)` 挂载，早于建池）与 `pre-step-coordinator`（插件级两份）保持现状；将来要并，走 `options.promotion` / `options.promotionPool` 注入即可，引擎不用改。
- **回归**：`test/engine/rules.test.mjs` 新增三条（同配置复用且事件顺序无语义、统一喂使门控步数不翻倍、池自己订阅且释放不代管注入池）；两处含 `phase` 的计数用例改为在绑定之后注入（`rules.test.mjs`、`host/agent-assembly.test.mjs`）。`typecheck`／`lint`／`test`／`build` 全绿。

### 模块事实读取收成单一入口（2026-10-16）

- **`readModuleFacts(target, moduleRoot?)` 是唯一入口**（`src/host/manifest.ts`）：「目录解析 → 定义读取 → 事实计算」三步此前在桥的 `/meta`、`/describe`+`/bootstrap` 与 `prepareAssembly` 三处各自展开，现收成一处。`target` 接受模块 id 或绝对目录（调用方手里是端点已解析的目录时直接传）；**返回事实本身**，不捎带 `dir`/`spec`——三处调用点没有一个用它们，需要目录的调用方自己调纯路径函数 `resolveModuleDir`。
- **`editable` 由入口自判**（判据＝目录在用户模块根之下），不再由调用方传：装配那处原吃默认 `false`，现为真实判据（下游不读该字段，行为不变）。`createModuleCapability` **保留自算**——它要的是刚读盘的那份定义（`loadModuleDefinition` 后 `doc.toJS()`），而入口走 `loadModuleSpec` 的缓存，两者在磁盘刚变化时会不一致。
- **`isEditableModuleDir` 从 `src/runtime/module-subject-gate.ts` 迁到 `src/host/manifest.ts`**：它是纯路径判据（不读盘），住在 runtime 会让 host 侧的入口反向依赖 runtime；gate 的对外行为不变（403 判定逐字保留）。
- **失败与下发口径不变**：入口不 catch（`/meta` 全吞成 facts 键缺席、`/describe`+`/bootstrap` 把层设置/规则错误重抛、装配硬抛）；桥上下发仍锁 5 键，`effectiveConfigs` 不出桥；事实每次现算，不引入缓存（`loadModuleSpec` 那层缓存已覆盖读盘，再缓存 facts 会掩盖组合文件与参数派生）。
- **测试**：新增 `test/host/module-facts.test.mjs` 直测入口——id 与绝对目录两种形态同源、用户根内 `editable` 为真、包内模板为假、定义不可解析时抛出。

### 条件绑定收回挂载缝：`compileRules` 不再接受 ctx（2026-10-16）

- **绑定发生在挂载缝**：`compileRules` 只编译与校验，产物每条规则携带 `conditionTrees`（规则级 `if` 树 + 按动作 id 索引的展开条件）；`mountRuleSources` 在注册前调 `rebindConditions`，用挂载 scope 的 ctx（以及调用方可选传入的 `standingMountFor`）重绑。此前准备期编译时没有 ctx，`preset` 条件的产物恒 UNAVAILABLE，只能由 `agent-assembly` 另存一份原始条件树、逐规则逐动作重编——同一件事两个入口，而 `docs/engine-reuse.md` 的配方对 `preset` 是**静默死条件**。引擎内 `rule-engine.mjs` 的独立入口同样改为在挂载缝绑定。
- **只重绑需要重绑的树**：含 `preset` 的条件才需要挂载期 ctx（其余原语只用节点选项），因此不含 `preset` 的谓词不被覆盖——调用方与测试对这类条件的注入照旧有效。
- **接口变化**：`compileRules` 的 `ctx` / `standingMountFor` 选项被显式剥掉（传了也不生效，免得以为已经绑好）；`mountRuleSources` 的 options 新增可选 `standingMountFor`、签名保持同步（既有调用点零改动）；`PreparedAssembly` 不再有 `ruleConditions` 字段，装配侧不再读产物字段名。
- **回归**：`test/engine/rules.test.mjs` 新增三条用例——规则级 `preset` 命中与「缺事实不命中」、`standingMountFor` 兜底、动作级 `else` 分支里的 `preset`；先确认判别力（临时去掉绑定后 3/3 红）再落地。

### 提示词卡排序收成一份判据，导入顺序改由 configOrder 表达（2026-10-16）

- **拖拽改为一步重排**：拖到目标卡上/下半区 = 插到目标前/后（指针半高判据 `clientY` 对卡片中线，恢复 `41ce6b36` 的原始设计并复用同款 `data-drop-*` 指示线）。此前是「两张卡互换」，在 ST 导入的上百张卡里无法把一张卡直接调到目标位；上移/下移按钮与拖拽手柄的 ArrowUp/ArrowDown 走同一实现。
- **判据唯一**：`src/client/data/prompt-config-order.ts` 的 `sameConfigPosition` 是同档位判据（同插入点＋同位置；`system-section` / `runtime-context` 另要求同官方档位），`reorderToView` 是唯一步重排实现——**资格在可移动集合内判、插入位置在完整数组里算**，不改卡定义、不碰官方档位。页内那份复制判据，以及生产侧零调用的 `moveToView` / `moveWithinLayer` / `viewOrderedIds`（含发不出去的 `order` 交换）一并删除。跨插入点与跨官方档位的目标一律原样返回、不写盘。
- **导入顺序对齐**：ST 转换把 `prompt_order` 名次写进 `module.yml` 顶层 `configOrder`（ADR-0006 的顺序源），`pre-step` 卡不再写 `order = 名次×10`；`system-section` 卡统一官方档位 `100`（官方 `SECTION_ORDERS` 里 `DEPLOYMENT_PERSONA_PREFIX`(0) 与 `PLAN_POLICY`(500) 之间的空档，不与任何官方档位同值）——此前按名次挤官方刻度，`system-section` 卡会随预设条目数落到官方提示的不同段落，且两两不同档、彼此不可排序。多源合并按各来源 `configOrder` 拼接后重新编号。
- **行为变化（已确认接受）**：导入的 `system-section` 卡从「按名次散布在官方刻度」变为「统一在人设前缀之后、`PLAN_POLICY` 之前，同档位内按配置序号排」，因此可被拖拽排序；名次 510+ 的原 `role: system` 卡会前移过 `PLAN_POLICY`。存量已导入模块不迁移，需要时重新导入。
- **回归**：`pnpm --dir $Repo typecheck`、`lint`、`test` 全绿（**635 passed / 0 fail**）；`test/host/module-config-order.test.mjs` 新增一步重排主路径、集合外拒绝（跨插入点／跨官方档位）、卡对象引用不变与双通道 revision 409，并补回历史删除时丢掉的两条不变量；`test/host/module-package-import.test.mjs` 的顺序断言改落在 `configOrder` 上。拖拽落点与指示线属交互，留真机 Edge smoke 核对。

### 空白模板改为引擎内组装（2026-10-12）

- **`modules/blank/` 目录删除，空白模板改由引擎组装**：`cloneBuiltinModule('blank')` 现在用 yaml Document API 在内存生成 `module.yml`（写盘仍是「模块根下临时目录 → 原子 rename」，失败清理临时目录）。公开接口零变化：`/module-clone` 的入参、返回与错误码不变，客户端 `BLANK_MODULE_TEMPLATE = 'blank'` 一行不动。
- **`meta.internal` 机制退役**：模板不再是包内目录，也就不必再对「新建模块」选择器（`listBuiltinTemplates`）与首次种子化（`ensureModuleSeed`）加过滤——`isInternalModuleSpec` 与两处过滤一并删除。生成的定义与包内其它模板字段同构（`id` / `name` / `version` / `engineCompat` / `description` / `meta.source` / `modules` / `order`），不含 `meta.internal`；文件头保留一段注释说明它是引擎组装的内置模板。
- **回归**：`pnpm --dir $Repo test` 全量 **614 passed（0 失败 0 跳过）**；宿主侧改动，**需重启 DSH 后生效**。

### 测试面按 seam 收敛（2026-10-12）

- **删墓碑与恒真断言**：`test/client/` 删 4 处为已删除实现或产物写的墓碑断言（`data-module-create` ×2、`data-template-new-name`、`data-instruction-module`），另删 2 处恒真断言（生产与字典均 0 命中的「选择一个来源模块…」文案、`/global/` 子串）。
- **去真值源自证与重复变体**：契约测试不再复述实现常量——删掉 `BRIDGE_SUBJECT_POLICY` 的 46 计数、11/5/30 计数、逐端点名单快照、两个错误码字面镜像与 `DECLARED_SECTIONS` 逐条快照，以及 `module-subject` 与 `settings-bridge` 之间重复的声明面用例；同时把 `customTools` / `persona` / `paramOverrides` 三节的「读 400 + `module-not-declared` + 零写盘」、未登记端点 200、`paramOverrides` 写 200 建立 `layerSettings` 声明、`scope:'global'` 变量读不受声明面约束等拒绝路径补回。
- **渲染断言收窄到接线与渲染链路**：客户端用例只断言固定卡（指令卡、人设卡）接线与通用规则卡（参数组、变量、自定义工具、子代理策略、资产卡）渲染链路；删掉本轮新增的恒真断言（`aria-haspopup` 恒带）、测试自造形态的 `aria-label` 排除、写死字典正文的 `t('rules.source', …)` 排除与私有 `Map` 形状、`subjectDraftKey` 键形断言。口径同时写进 [docs/ui-architecture.md](docs/ui-architecture.md) §12.1 与 `test/client/support/ssr-render.mjs` 头注释。
- **临时目录纪律**：三处 `mkdtempSync` 与一处 `process.cwd()` 下的临时目录改走夹具的 `isolatedHome` / `tempDir`（自带 after 清理与 `DSH_HOME` 还原）。
- **回归**：`pnpm --dir $Repo test` 全量 **613 passed（0 失败 0 跳过）**——即 `b79f03d7` 这一轮（测试面收敛收尾）修复后的全量结果。

### 人设段并入运行时配装通道（2026-10-11）

- **人设不再接管官方 fiber**：官方把 `deployment:persona-prefix` / `deployment:persona-suffix` 设计成可替换槽位——同名段按 scope 链遮蔽、近者胜（`@deepseek-ai/dsh-scope` 的 `ScopedLayers.merge`），只有同一层内重名才抛。装配现在只在自己的 Agent scope 注册同名段，就替换掉全局部署人设与预设挂在祖先 scope 的 persona 行，不再需要 `fiber.update()` 重载、注册租约重放、`runMaintenance()` 空闲窗口与独立的人设事务。
- **优先级明确**：插件人设优先于其他来源。Agent scope 同层已被注册的声明（例如 `@deepseek-ai/dsh-subagent` 的 per-child persona）在 AgentSetup 窗口内被接住，装配时先撤后挂（保留原 `PromptSection` 作凭据）；窗口之外出现的同层声明撤不掉，装配失败并保留旧装配，由告警说明。
- **继承语义不变，判定更宽**：未声明的字段、段落位置与 `complete` 从最近的已有声明继承（同层被接住的声明 > 祖先官方 persona 行 > 根部署人设）；继承正文直接沿用原 `text`，不重复执行本插件模板。祖先链上没有官方 persona 行时**不再**以「人设原声明未被观察」拒绝整批配装——遮蔽一个不存在的声明本身无害。
- **受众判据统一**：人设与规则改用同一个 `isDelegated`（`delegationDepth > 0`），不再看 `header.origin`；历史、恢复与第三方创建的会话不再出现「规则按主会话、人设按子代理」的受众分叉。
- **行为变化（已确认接受）**：取消「Agent 忙碌时拒绝保存、等空闲重试」的维护锁语义，人设随装配立即重挂；外部对官方 persona 行的改动不再被检测并拒绝，本插件一律优先。
- **回归**：`test/host/persona-registration.test.mjs` 重写为装配期行为断言（主/子受众、三态、同层撤换、无官方声明、候选非法保旧），`test/host/agent-assembly.test.mjs` 的独占用例改为跨来源（规则 × 人设）聚合。

### 内置 superpowers 引导模块（2026-10-11）

- **新增内置模块 `superpowers`（默认不启用）**：把上游 [obra/superpowers](https://github.com/obra/superpowers) v7.0.0 的启动引导（`skills/using-superpowers/SKILL.md` + `hooks/session-start` 注入的那段）DSH 化后常驻注入 `system-section`——「任何回答或动作之前先 `skill_search` / `skill_load`」、流程技能优先、常见路由表与红旗清单。上游靠 SessionStart hook 注入，DSH 没有 hook 通道，改用模块注入。
- **技能正文不进模块**：上游 15 个技能共 43.5 万字符，正确归属是 `$DSH_HOME/skills`（走既有按需发现 `skill_search` / `skill_load` 与技能页策略）。本模块只做引导与路由，不分发也不改写任何技能文件；官方全量技能目录注入仍由 `skill-surface` 拦掉。
- **与 `ponytail` 的消歧**：superpowers 的重流程（brainstorm → 计划 → TDD → 评审）与 ponytail 的最小改动会互相拉扯。正文保留上游「用户指令优先于技能」一句；真要消歧就在工作台停用其中一个，停用即回滚。
- **引导只进主会话（真机实测修正）**：`system-section` 并不等于「只进主会话」——每个 Agent（包括子代理）都各自装配启用表里的模块。重启后起子代理对照实验：第一条子代理的 system prompt 里**确实出现了**这段引导。规则因此加 `if: { scope: { audience: 'main' } }`，对齐上游 `using-superpowers` 自带的 `<SUBAGENT-STOP>`；加门后同一实验里子代理不再收到引导，而 ponytail 的子代理档位标记（它有自己的 `subagent-start` 通道）不受影响。
- **回归**：`test/host/surface-modules.test.mjs` 把新模块纳入既有的定义权威校验与「包内目录只含 module.yml」两条契约，并新增一条正文断言（常驻 `system-section` 且点名两个按需发现入口）。

### 修复启动阻塞与旧会话人设接管（2026-10-11）

- 删除对官方 `system-prompt` 的 Loader 等待覆写及独立人设早入口，避免两级异步服务就绪通知遗漏导致系统提示、工具和子代理级联 pending。主插件自行管理人设运行态，官方核心不依赖可选插件。
- 人设覆盖转到会话期：支持既有会话继承的预设人设、空闲维护窗口内的会话自有官方 Persona，以及新建/恢复子代理的 setup 声明。未知插件直接注册的人设不强行替换，报告边界；保持原会话 scope、历史与共享预设，不事后恢复截断结果。此方案替代下列早入口与启动屏障说明。
- 本节描述的会话期接管（`runMaintenance` 空闲窗口与官方 Persona fiber 重载）已由上面的「人设段并入运行时配装通道」取代；启动解耦本身不变——包补丁仍只注册主插件，官方核心不依赖可选插件。

### 固定系统段受众修复（2026-10-11）

- `system-section` 的 `complete` 与 `suppressRuntimeContext` 现在在注册前匹配主/子受众，避免非目标 Agent 收到空独占段或丢失上下文。同/跨模块按受众校验独占，主/子各一条可共存，同受众冲突拒绝且保持旧配装。独立引擎的受众限定固定效果要求显式真实 `options.agent` 和对应 Agent scope；共享/未知身份路径明确拒绝。
- 修复 ST JSON 预设因末尾未知裸引用残片（如 `{{s}`）而整包报 `Unclosed template expression`：导入与运行保留该普通文本。变量赋值、保留宏、参数和嵌套表达式的闭合与预算校验不放宽；ST 预设、角色卡、世界书导入入口保持。

### 原生上下文、两级变量与人设覆盖（2026-10-11）

- **破坏性格式切换**：内部策略使用 `context-activation`、`params.activation`、`templateEvaluation` 和 `persona.main/subagent`。旧 ST 运行字段、动作 `config.variables`、旧角色/世界书/会话变量能力明确拒绝；重新导入标准来源或经授权显式转换，不自动改写用户目录。
- **完整规则事务**：模型工具改为 `module_rules_read/edit`，保留 then/else/嵌套动作，统一按域 revisions；映射写回不固化编译默认值，删除整规则须显式 `rule:null`。
- **两级持久变量**：`module_variables` 与工作台/模板共用 global/module 存储；空字符串有效，删除模块键才回落全局。普通规则手动建立变量，ST 导入自动登记缺失裸引用为空占位。单模板只写一域、校验全部读取域，真实执行重入不重复提交。
- **独立记忆和导入能力**：`module_memory_read/append` 与 `module_import` 分开注册，使用受控模块目标、官方工具管线与 disposer。记忆不再附带在规则 note，也不自动注入；旧私有记忆标记阻止未经显式处理的分享。
- **统一上下文激活**：显式 batch/history 扫描、具名副键逻辑、候选组与时间窗；读取键只读求值，实际投递才 commit。ST 的 outlet/vectorized/triggers 保留来源并禁用规则，避免静默普通注入。
- **主/子人设各自单选来源**：默认官方，人设卡分别选择一个模块；config.yml.personaSources 只存模块 ID，正文仍属于 module.yml.persona.main/subagent，选择不自动启用该模块的 rules。只读所选受众字段，替代多模块逐字段合并。空文本/false 语义保留，rules/_settings.yml 增加校验投影；官方人设与启用规则的 complete 仍预检，完整配装 prepare/commit/rollback 失败保旧。早入口在官方声明注册/AgentSetup 中应用覆盖与恢复，升级 patch 后需要用户重启 DSH。
- **YAML 补丁升级**：yaml 2.9.0 → 2.9.1，继续使用现有 Document API；同步74份 ESM 分发文件，不更换解析器。
- **文档与模板**：模板不再写动作局部变量；WHO/stateKeys 由变量卡手动建立。参考生成脚本、模块技能和权威说明同步原生格式。旧运行文件删除，仍有效的行为测试迁至新公共接口，不保留旧名墓碑测试。

下列未发布条目记录此前阶段的改动；本节明确替代其中关于旧工具名、ST 会话变量、动作局部变量及扁平人设的行为说明。

### 内置 ponytail 模块对齐上游 v5.0.0

- **规则正文按上游 `skills/ponytail/SKILL.md`（v5.0.0）重建**：5.0 把规则整段重写——`## The ladder` 变 `## The smallest complete change`（六级、平台自带组件优先于原生控件、明确「删功能要一句话点名」），新增 `## Before you write` 的改动面清单（callers / tests / fixtures / config / exports，以及会不会毁数据、会不会让调用方失效），`## Rules` 的散条合并为 bullet 清单，原 `## Output` 与 `## When NOT to be lazy` 收进开头一句与末尾 `Never cut:` 一行；`ponytail:` 债务注释与「同尺寸取边界正确的那版」两条保留。档位表随上游改名 `## Levels` 并逐档重写文案，上游已删的 worked examples 同步删除。
- **DSH 本地适配不变**：档位仍由互斥配置卡持有、不注册 `/ponytail` 命令，停用语义 `Off: "stop ponytail" / "normal mode"` 保留；`version` 跟到 5.0.0，便于与现场副本对照。
- **回归更新**：`test/host/ponytail-module.test.mjs` 的上游锚点按 5.0 重抽（含 `Never cut:` 的完整不懒惰清单），并逐档钉住上游 `## Levels` 文案；子代理只读档仍保持 144 字符的轻量版。

### 主要变化

- **移除内置迁移器：旧格式改为「白名单加载」**（2026-10-10 用户拍板「迁移器可以移除了」「模块可加载，但是只加载支持参数和内容」「不要留墓碑测试」）。删除 `src/migrate-rules.ts`（CLI）与 `src/host/rules-migration.ts`、`src/host/legacy-prompt-params.ts`，以及 `package.json` 的 `bin.prompt-tool-migrate-rules` / `scripts.migrate:rules` 与 tsdown 入口；`prompt-configs.ts` 中只被测试消费的 `mergePromptConfigs` / `renderPromptConfigYaml` 及其 YAML 渲染辅助一并删除。**加载侧**：`assertCanonicalRuleSource` 只校验结构，`promptConfigs` / `triggers` / 退役引擎名 / 旧规则快捷键 / 旧模型键不再阻断加载——未注册参数由 `readModuleLayerSettings` 的键白名单过滤，旧内容不参与执行；装配侧对 `prompt-config-engine` / `declared-triggers` 由「报错」改为「跳过」。**写入侧**仍保留拒绝：`saveModuleParams` 对旧快捷键响亮失败（避免写进读不回的键）。测试按准入原则重写：夹具改为 canonical `rules`，验证已删实现与迁移器行为的用例直接删除（tests 531 → 521），不留墓碑断言。
- **模型路由/采样参数恢复为可写的公共参数，并在装配期真正生效**（2026-10-10 用户拍板「模型相关参数应该还支持」）。`main-model` / `subagent-model` 卡重新出现在引擎参数编辑区：`SHARED_PARAM_KEYS` 不再排除这 10 个键，参数桥的读写/发送/脏检查都按普通参数处理；`/param-overrides` 的 `410 rules-route-retired` 守卫与 `assertCanonicalRuleSource` 的「旧模型键 = 旧规则来源」拒绝一并撤销（`RULE_OWNED_MODEL_PARAMS` 常量随之删除），含模型参数的 `layerSettings` 现在能正常加载、离线迁移也不再删除它们。**关键修复**：此前 `modelRequestConfigs` 只在离线迁移器里被调用，写进 `layerSettings` 的模型参数在运行时无人消费；现在装配期（`prepareAssembly`）把参数转成 `param-model-params` / `param-subagent-model-params` 两条合成 `request-params` 规则，与模块规则一起过 `compileRules`，按受众分别改写主会话与子代理的实际请求，且不写入 `module.yml` / `rules` 切片。未配置模型参数时不产生任何合成规则。
- **移除旧物化目录（`configs/`）的加载器：一切只认 `module.yml` + `rules/`**（2026-10-10 用户拍板「以后一切开发围绕新的模块模式」）。删除 `engine/schema.mjs` 的 `loadPromptConfigFiles` / `promptConfigFileNames` 与它们独占的 `engine/order.mjs#FILE_SEQUENCE`；离线迁移 `prompt-tool-migrate-rules` 不再读取旧物化目录——不再做「定义与旧实际物化内容不一致」的一致性校验，也不再从物化文件名前缀恢复 `configOrder`，迁移一律以 `module.yml` 为准。旧目录仍由 writer 在保存/迁移时清理，本插件不主动删除。
- **修复根 `module.yml` 的生成物漂移**：`pnpm rebuild:module-template` 重新生成——一是模块清单注释的字母序（`tool-search` 归位），二是删掉 `tool-surface-resident` 规则上残留的 `if` 相位门控（组合源已在「打开即收窄」一轮删除该 `if`，根模板漏同步）。此前 `--check` 必然失败，与功能回归无关。
- **新增 `tool-narrow` 动作：规则可直接声明官方 `ctx.tools.restrict()` 收窄工具面**。声明 `{ kind: tool-narrow, allow: [...] }` 即在 agent scope 挂一条实时过滤器，被裁掉的全局工具在模型目录**与执行层**同时消失（`get(name, scope)` 读作不存在），不必再另配 `guard` 守执行面。`allow` 是 fail-closed 白名单（空名单与保留名 `run_code` 在挂载期拒绝），名字按注册那一刻的全局目录过滤、未知名字丢弃并告警。收窄是**静态**的（注册期动作不支持条件，见 `engine/rule-spec.mjs`）；**当前没有内置模块声明它**——`tool-surface` 保持只保留无条件收窄，把它接到按需解锁上的完整方案（`deny`、动态撤销、收窄前目录副本）见 [ADR-0012](docs/adr/0012-progressive-disclosure-restrict.md)。注意它只作用于继承的全局工具，本插件注册在 agent scope 的工具裁不掉。
- **发现工具改名 `dev_tool_search` → `tool_search`**（2026-10-10 用户拍板）：去掉 `dev_` 前缀，与既有的 `skill_search` / `skill_load` 命名对齐。查证结论：官方运行时**没有**同名工具（源码零命中，`tool_search` 只作为 `llm-pi-ai` 测试里的协议类型 `tool_search_call` 出现），`py-types` 的 `RESERVED` 只是 Python 关键字表，唯一硬保留名是 `run_code`；`tool_search` 同时满足 PTC 的裸标识符要求。代价是失去「本插件贡献」的命名空间标记——全局工具名是共享命名空间，近层同名会遮蔽，将来若官方引入同名工具需要重新让位。
- **`tool_search` 现在会主动招呼模型来解锁**：工具描述新增一条 IMPORTANT——任务需要常驻集以外的能力（web 搜索、子代理、任务板、MCP 等）时先来这里搜索并解锁，**不要用现有工具硬凑**；同时内置 `tool-surface` 模块新增 `tool-surface-notice` 规则，在会话最早阶段（`count{user-message,max:1}` + `dedupe: session`）注入一条约 500 字符的「工具面已收窄」提示。此前模型只看到被裁后的目录，没有任何线索提示它还有 154 个工具可解锁。
- **内置 `tool-surface` 模块改为「打开即收窄」**：规则省略 `if`（= 无条件生效），不再等 `promoted` 才收窄——此前首轮（未晋升且未压缩）刻意放行完整目录，收窄要到模型第一次 `tool/call` 或 `assistant/message` 之后才生效，那几轮多付一次完整工具面（实测 46894 字符），且收窄生效的当轮会以「工具已更新 · 移除 N 个」出现在会话流里。代价是模型第一轮就以核心集开局，需要先调一次 `dev_tool_search` 才能解锁目标工具（解锁在**下一步模型请求**即可见，不必等一整轮）。需要旧的渐进语义时给规则加回 `if: { any: [phase{promoted: true}, phase{compacted: true, promoted: false}] }`；`templates/80-tool-surface.yml` 与 `docs/engine-reuse.md` 同步。
- **动作级 `if` / `then` / `else` 与嵌套分支在六个执行点一致按条件生效**（`system-section` / `runtime-context` 的文本贡献、`agent-request`、`llm-stream`、`turn-stop`、`subagent-start`、`subagent-end`），与 `pre-step` 行为一致：此前这些点按规则级 `if` 判定，`else` 与嵌套分支等于无条件执行；`system-section` / `runtime-context` 上只写动作级 `if` 的配置，也从无条件注入变为按条件注入。
- **同模块多条续跑动作共享一份预算**：`append-context`（`mode: continue`）与 `turn-stop` 不再各占一份——同模块每轮合计 1 次、每会话合计 3 次；此前两条续跑动作会让同一轮连跑 2–3 次。
- **去重身份统一到 `identity.value`**：`fill: instruction-hint` 的解析器候选此前不带 `source.plugin`，`dedupe: session` 每步重复注入；现在盖章与查找同源，显式共享身份的卡也不会因分批接纳而重复注入（`pre-step-filter` 的 `blockPlugins` 对显式写了 `identity` 的卡要写 `identity.value`，缺省仍是 `id`）。同时启用的模块声明同一个身份时装配期多一条告警，装配照常成功。
- **ST 世界书入选改为批首一次**：此前每个 flush 段各求值一次，同组两条世界书会在两段里各赢一条（双注入）；现在批首取定合格集合。赢家被外层门控或过滤剥离后，同组不再从后续段补位。
- **原生关键词世界书只扫描本批真实对话消息**：插件注入正文（`append-context`、`skill_load`、子代理注入）与指令文件正文不再触发关键词条目。依赖指令文件正文触发的配置请把关键词写进真实对话，或改用 `constant` 常驻条目。
- **会话变量不得占用插值保留名**：`session_var` 工具与 ST `{{setvar}}` 两条写入路径都拒绝内建名（`DSH_HOME` / `WORKSPACE` / `CWD`）与动态宏名（`time` / `pick` 等）并说明原因；存量会话里已存下的脏键在读取时跳过。
- **`pick` 取值不再随无关正文长度漂移**：seed 只随会话、来源与该次插值正文里的出现序号变化——同一引用在正文长度变化后取值不变，同一正文里多处 `{{pick}}` 仍各自取值（已发布位置的取值会变，这是预期内的）。
- **`rules/` 目录只认名单内的切片**：名单外文件（编辑器备份、同步冲突、`.bak` / `.md`）归用户，引擎不读、不校验、不写、不删——此前会让整个模块报错。删除规则仍清理它自己的切片，中断写入的 `.tmp-<uuid>` 残留仍触发恢复。
- **规则判定计数在 pre-step 协调器路径上不再坍缩成一条**：工作台顶部「N 不可用」对 pre-step 规则真正生效，计数按「模块 + 规则 + 通道」聚合并取每个动作的最终判定；身份超过 512 后只累加已有身份，被丢弃的次数作为 `dropped` 下发（未超限的响应逐字不变）；`instructions.owner.officialInstructions` 不再捏造 `false`，未观察到即 `null`。
- **告警去重改为「每条不同消息一次」**：同一挂载内的不同故障各自可见（上限 64 条不同告警，之后补一条抑制提示再静默）；`subagent-end` 的 observe-only 命中改走 `logger.info`；`after-user` 配置找不到真实用户消息锚点时告警一次并列出配置 id。
- **`st-render` 的 `generationKey` 判据收紧**：空串 `source.plugin` / `source.kind` 与非对象消息不再计入（仅畸形输入有差异）。
- **guard 的子代理侧注册随父 mount 释放一并撤销**：切预设或保存模块后不再按旧 mask 多拦一层。
- **运行时配装切换失败时保留两个原因**：新装配失败与恢复失败同时出现在错误里，「运行时配装更新失败」的报错文本带上具体原因（装配层只说装配这件事，「已保存」由写盘层各自声明）。
- **规则动作卡的参数改为全字段可编辑**：`decision`（工具链裁决）的 `phase` / `decision` / `action` / `reason` / `text` / `toolNames` 由引擎的「动作种子」下发给客户端，规则卡据此逐个渲染出可编辑控件——此前只有 `phase` 与 `decision` 两项，其余只能写 JSON。`match` 刻意不进种子：它只接受函数，而种子要过 `compileRules` 与 `structuredClone`，放进去会让整块规则面板读不出、存不了（该排除由断言锁死）。
- **`officialInstructions` 三态收敛为「观察到才出现」**：当前没有 `true` 生产者，读取口已删除（恒为 `null`，不再捏造 `false`）；bridge 载荷字段本轮保留，删除条件见 `docs/adr/0009-instruction-owner-observed-only.md`。
- **判据与缓存的四处修复**（同一根因：压缩后可见历史变了，而缓存或增量路径还按旧视图算）：`count` 的重建按 `seq` 去重（位置替换后计数不再虚高）、`session` 谓词对非消息类型恢复可用（此前恒真或恒假）、世界书扫描按 `seq` 去重（没有 `id` 的消息不再被重复计数）、锚定确认的缓存随成功压缩失效。
- **`{{pick}}` 的调用点补上稳定来源**：世界书主/副键与 instruction-hint 的三个模板此前省略来源标识，seed 恒为 `sha256([会话, '', 0])`、序号与文本无关；现在同一引用在正文长度变化后取值不变，不同位置各自取值。

### 破坏性变更（升级前必读）

- **内置迁移器移除，旧格式不再自动升级**（2026-10-10 用户拍板）。`prompt-tool-migrate-rules` 命令 / `pnpm migrate:rules` / `--root|--characters-root|--check|--apply|--rollback|--decompose` 全部不再提供；含 `promptConfigs` / `triggers` / 退役引擎名 / 旧规则快捷键 / 旧模型键的模块**仍可加载**，但那些旧内容不参与执行、也不会自动变成 `rules`——旧提示词正文只会留在原文件里，模型看不到它。要升级请按 `rules` 重写定义，或把旧 `module.yml` 交给内置 `dsh-module` 技能由模型改写。旧快捷键的**写入**仍被拒绝（`saveModuleParams` 报错），避免写进读不回的键。
- **旧物化目录不再参与迁移**：旧实例上「`module.yml` 含旧键 + 旧物化目录（`configs/`）存在」的模块，迁移时不再做一致性校验，直接以 `module.yml` 的定义为准；`configOrder` 也不再从旧物化文件名前缀恢复（改由定义里的顺序或规则声明序派生）。若某个模块的定义不完整而内容只存在于旧物化目录，迁移后那份内容不会被恢复——需重新导入或手工补定义。旧目录本身仍由 writer 在保存/迁移时清理。
- **发现工具改名 `dev_tool_search` → `tool_search`（旧会话需重新解锁一次）**：`allowFrom` 的判据是「历史 `tool/call` 的 `data.name` 精确等于声明的工具名」，改名后**旧会话里已解锁的工具会失去解锁依据**，模型需在 `tool_search` 名下重新解锁一次（压缩后同理）。模块层面：只改内置模板不会更新已有副本（`ensureModuleSeed` 只补缺失目录），副本里的 `allow` / `allowFrom.tool` 若停在旧名，`requireMatch` 会 fail-open 暴露完整目录——收窄失效而不报错，需手工同步副本或从模板重建。
- **工具面从第一轮就收窄**：`tool-surface` 的规则不再声明 `if`，因此不再放行「首轮（未晋升且未压缩）的完整目录」——模型第一轮的工具清单就是常驻核心集加已解锁项，需要先调一次 `tool_search` 才知道还有什么可用。想恢复旧行为就在规则上加回 `if: { any: [phase{promoted: true}, phase{compacted: true, promoted: false}] }`。**只改内置模板不会更新已有副本**（`ensureModuleSeed` 只补缺失目录），要用新语义需从模板重新创建模块或手工删掉那条 `if`。
- **`dedupe: session` 的判据改为「每当前上下文一次」**：不再扫持久事件流的全量日志，而是看该身份的消息是否还在模型可见的当前上下文里——被压缩或替换**遮蔽**的历史不再拦注入，条件仍满足时在后续步重新注入一次；此前压缩后不会重新注入（`append-context` 等续跑动作的每轮／每会话预算照旧，不随压缩重置）。完整口径见 `docs/engine-reuse.md` 的会话去重一节。
- **去重身份新增模块维，注入消息 `source` 多一个 `moduleId` 字段**：判定键是（模块，通道，身份），**整模块复制**出的两个副本因此各自注入、不再互相压制；跨模块声明同一身份时的装配期告警同步改成「去重按模块各记一份，两份正文都会注入」。身份字符串本身一字未改（`source.plugin` 仍是 `identity.value` / `merged:<position>`，`source.kind` 仍是 `plugin:<id>`），`pre-step-filter` 的 `blockPlugins` 名单也不需要改；升级前注入的旧消息没有 `moduleId`，仍按保守命中判为已投递，无需数据迁移。
- **`inject-text` 的 `config.prepend` 取消，暂无等价替代**：它此前让该模块的 pre-step 批注册到最外层，是未文档化的后门（`executor` 直读 `config.prepend`）；而 `inject-text` 不接受 `waterfallPosition`，动作级位置无处安放。仓库自带的 `modules/` 与 `templates/` 未使用它。
- **`inject-text` 不再有 `tool-pipeline` 注入通道**：该层从可注入层清单移除（`getEngineMeta().injectionLayers` 为八层；`layers` / `layerOrder` 仍是九层，`tool-pipeline` 只作规则级展示归属）。经 `prepareAction` 绑定 `config.layer: tool-pipeline` 的用法在准备期显式报错，不再静默无操作：工具链的裁决改用 `decision`、追加上下文改用 `append-context`。规则编辑器的注入层下拉同步只列八层。
- **规则级 / 声明级的 `else` 缺同一规则的 `if` 改为编译期拒绝**：`else` 靠 `not(if)` 与 `then` 互斥，没有 `if` 时两支会同时无条件生效（此前静默双执行）；`if` 省略或写 `null` 都在保存 / 导入 / 装配期报错并点名规则与动作。
- **`guard` 的受众组合与取值改为编译期拒绝**：`audience: 'subagent'` 缺 `includeSubagents: true` 时两条受众分支都不注册（任何会话都不生效、零告警）；`audience` 只接受 `main` / `subagent`（省略、`null`、`''`、`all` = 通用），拼错不再静默退化成通用；`includeSubagents` 只接受布尔值，YAML 空值 `null` 也会被拒——写 `false` 或删掉该行。
- **动作与注入配置的未知键、层专属参数、请求参数子键改为编译期拒绝**：动作声明的拼错键与 `inject-text.config` 的未知键报出动作 id 与允许键集合（`decision.toolNames` 拼错此前会连带拒绝全部工具）；带 `kind` 的动作对象写 `if` / `then` / `else` 报「分支必须写成无 `kind` 的节点」（此前分支被静默丢弃）；`params.complete` / `params.suppressRuntimeContext` 只属于 `system-section`，写在其他层出现即拒（`false` 除外）；`request-params` 的 `patch` / `unset` 子键按官方 `LlmCallConfig` 校验，`replace: true` 缺 `provider` / `model`、`replace` 非布尔也拒；`assembly.contexts` 的 `clear` 与 `add` / `remove` 并存被拒（`clear` 必须是布尔）。`variablesDisabled` 是引擎内部标记、不在作者可写白名单里，手写同名键按未知键拒绝。
- **显式 `variablesEnabled: false` 的存量模块升级后不再吃会话变量**：pre-step 消息插值与注册层官方变量都不再并入会话变量——这正是该开关的字面承诺，此前只停一半（声明键引用被剥离、会话值仍注入）。要保留旧行为就把模块顶层 `variablesEnabled` 删掉或设为 `true`；**例外**是 ST 模板宏帧（`params.stMacros`）按 ST `setvar` / `getvar` 语义仍读会话变量。
- **迁移期剔除非法 `LlmCallConfig` 键**：旧 `promptConfigs` 与动作里的 `patch` / `unset` 非成员键（如 `note`）在改写时被丢弃，合法键与值原样搬运。
- **多个判据改为「模型当前可见的上下文」**：锚定确认（`anchor` 谓词）、`session` 谓词的 `present` 镜像、`turn-stop` 的缺省匹配对象、ST 宏 `{{lastusermessage}}` / `{{lastcharmessage}}`、世界书关键词扫描都只认模型可见的历史——被压缩或位置替换**遮蔽**的事实不再算数；按完整历史读的仍是三处（晋升门控的冷启动、`assembly` 的解锁名单、`count` 的 `tool-call` / `turn` 信号）。`count` 谓词因此按信号分视图：消息类信号（`user-message` / `assistant-message` / `assistant-chars` / `tool-result`）按可见上下文计，压缩后重算、`every: N` 的节奏随之重置（可能立刻再命中一次）；`tool-call` / `turn` 仍按完整历史计，重启 / 恢复 / 重挂后的结论不变。宿主没有 surface 时全部退回完整历史（= 旧行为）。归属表与理由见 `docs/adr/0010-two-history-views.md`。
- **世界书递归改为模块级开关，条目级 `recursive` 不再参与判定**：CCv2 的书级 `recursive_scanning` 在 ST 运行期本就不被读取，插件此前却拿它逐条目门控。现在由 `module.yml` 顶层 `stWorldBookRecursive`（布尔，**缺省关闭**）决定本模块的条目是否参与递归重扫；开关按模块生效，递归池与 ST 一样是**全批共享**的。靠导入值递归的模块升级后需显式声明该开关。`min_activations` 经核实是 ST 的全局用户设置、不是条目字段，本插件不复刻。
- **`match` 出现即编译期拒绝**：它只接受函数，而声明路径（YAML / JSON / 导入）写不出函数——此前的报错文案「必须是函数」会把人引向 `structuredClone` 的 `DataCloneError`。分支条件写 `rule.if`。
- **升级动作**：手写 `module.yml`、还原的备份或导入包命中上述拒绝时该模块装配失败——本轮只告警并保留旧装配，不会自动改盘；按错误消息删键，或把字段移到 `rule.*` 或正确的层。

## [2.1.0] - 2026-10-06

### 主要变化

- **内置技能随包分发**：`skills/dsh-module` 随包发布，插件安装与每次启动按「只补缺失」补建到 `$DSH_HOME/skills`——已有同名目录的正文、资源与调用策略保持原样，改过或删过的技能不会被铺回来；补建失败静默跳过，不阻断启动。
- **两个技能合并为 `dsh-module` 一个**：覆盖模块定义（`if → then` 规则、九层注入、条件动作）、模块名与共享参数、外部资源移植与审查。正文改为正向陈述只讲支持项，并写明技能引用的包内文件（`engine/`、`modules/`、`templates/`）的路径基准与定位方式（`$DSH_PROFILE_DIR`；Desktop 部署下需用文件读取工具）；新增「禁用或收窄某个工具」配方（`assembly` + `sdk-strip` + `guard` 三件套）。
- **新增发版前打包完整性门槛 `pnpm verify:pack`**：`npm pack` 出真实 tarball 后与仓库逐文件 SHA256 比对，再装进临时项目跑引擎 smoke（主入口导出、包内 `compileRules`、组合模块库、随包技能），任一失败退出码 1。
- 根 `module.yml` 适配 `if`/`then` 引擎并补全九类动作示例；规则字段旧名 `when`/`do` 的残留说明一并清理。
- 测试套件按 seam 纪律清理：删掉墓碑、自证对拍、实现耦合与超额变体，从 441 条收敛到 418 条（真契约保留，另补角色卡 PNG 解码与技能种子化两类新覆盖）。

### 破坏性变更（升级前必读）

- **`engine/compositions/library/` 整体退场**：官方组合块（`tool-pwsh`、`tool-fs`、`delegation`、`planning`、`compaction`、`tool-web` 等 24 个）已随「与预设彻底解耦」全部删除，模块库现在只有 `source/local/`。模块若还在 `modules:` 里引用这些名字，装配期会直接报 `composition module <名称> not found in source/local`——这些能力由**会话原有的官方预设**提供，模块不需要也不应该重新声明它们；要禁用或收窄某个工具，改用 `assembly` + `sdk-strip` + `guard` 三件套。
- **ST 导入 `enable_web_search: true` 不再组装 web 工具行**：原先 `modules.push('tool-web')` 并写 `moduleConfigs['tool-web'] = { fetch: true }`，现在只在转换报告里提示「联网能力由会话原有预设提供」。`enable_web_search: false` 的三条拒绝规则不变。
- 退役声明式触发器的组合行 `declared-triggers.yml` 删除（该名字写进 `modules` 本就会返回 409 `rules-migration-required`）。

### 验证

typecheck、lint（0 warning，252 文件）、test **418 passed**（0 失败 0 跳过）、build、`pnpm verify:pack`（打包完整性 0 失败）、`git diff --check` 全绿。

## [2.0.1] - 2026-10-05

### 修复

- **子代理页点开含分支的规则卡会让插件崩溃**：`then`/`else` 的每一项都可以是分支节点 `{if, then, else}`（引擎递归展开、可嵌套），而规则卡只把每一项当动作渲染——分支没有 `kind`，动作类型下拉因此收到 `undefined`，在 `props.value.length` 抛 `TypeError`，渲染期异常让**整棵插件树卸载**。命中内置 `ponytail` 的 `ponytail-subagent`（`if.scope.audience = subagent`，只在子代理页可见），表现为「点开子代理配置卡就崩」。引入点是 2.0.0 之前的 `a31932b`（ponytail 两档合并为一张含分支的卡）：旧 UI 从不渲染该分支，所以一直没暴露。
- **JSON 面板不再把合法分支判成非法 JSON**：结构门槛原先要求每个 `then` 项都有 `id` + `kind`，分支永远过不了校验；现按「动作要有 `id` + `kind`，分支要有 `then` 数组」递归判定。

### 主要变化

- **规则卡内部改为条件卡视图（一个条件一张卡，对应它的动作）**：条件与动作合并为同一个「规则」面板（原先分处「条件」「动作」两个页签，看不出对应关系）。规则级 `if` 是一张条件卡，它管住的 `then` 节点在一段竖线作用域里各自成卡——动作卡与**分支卡**（卡头即「当 ⟨条件⟩ → ⟨动作⟩」）。每张卡默认收起、卡头单行省略给出「条件 → 动作」一览，展开才编辑；`×` 删除整张卡，图标取官方 `IconClose` 复制件，与 `TagInput` 的 chip 删除同形态。
- **分支节点成为可视编辑的一等语法**：内嵌 `if/then/else` 可展开编辑、可继续嵌套，不再落到「未知动作 + 裸 JSON」——此前只能手写 YAML。
- **规则级 `else` 首次可编辑**（引擎的 `if/then/else` 早已支持，UI 之前完全没有渲染它）。
- **动作的生效条件在卡头逐字给出**：条件是**路径合取**（根到该动作的所有 `if` 取「且」、`else` 侧取「¬if」），所以不存在「第 i 个条件配第 i 个动作」；要表达「条件 1 → 动作 1、条件 2 → 动作 2」就写同级多条分支。注册制层（`system-section` / `runtime-context`）没有逐轮求值时机，这些层的添加行禁用分支入口并说明原因；作用域带条件时可选动作按 `supportsWhen` 过滤。
- **卡头摘要改为「N 条件 · M 动作（· K 分支）」**，新增动作的唯一性范围从「当前列表」扩到**整条规则**（引擎拒绝重复 id）。
- 删除死代码 `engine/trigger-editor-meta.mjs`（全仓零引用，且 `when`/`do` 退役后仍向 `compileDeclaration` 传 `do:`，一调用即抛）。

### 验证

typecheck、lint（0 warning，257 文件）、test **441 passed**（基线 436 + 5 条新回归）、build、`git diff --check` 全绿；新增 `test/client/rule-steps.test.mjs` 用真实 `modules/ponytail/module.yml` 与真实编辑器目录锁住崩溃路径与卡结构。

## [2.0.0] - 2026-10-05

### 破坏性变更（升级前必读）

- **规则与触发器的声明字段改名**：`when` → `if`、`do` → `then`，并新增 `else`。旧名不再被输入边界归一，撞上就显式报错（`when 已退役，改用 if`）——含旧字段名的模块定义、导入包与手写 YAML 必须先改名。**内联函数路径不受影响**（`registerAction` 的 options、`validateTrigger` 与迁移器输入仍用 `when`/`do`，那里是函数参数而非声明字段）。
- **规则条件动作模型统一**：条件动作收敛为一套模型，卡内布局随之精简（提交 `b1e42cf`）。
- **ponytail 子代理分档改为一张卡**：档位判定用动作级 `if`/`then`/`else`，原先按规则拆分的两张子代理卡片不再存在。

### 主要变化

- **新增两个内置模块**（随包分发，见下方明细）：`tool-surface` 把工具面收窄到常驻核心集、其余由 `dev_tool_search` 按需解锁；`skill-surface` 拦掉官方 `dsh-tool-skill` 注入的全量技能目录，改由宿主侧 `skill_search` / `skill_load` 按需发现。两者默认**不启用**。
- 宿主侧挂载 `skill_search` / `skill_load`，替代 `skill-catalog` 的全量目录注入（实测三个主会话 6 次注入共 78792 字符）。
- `assembly` 动作新增 `allowFrom` 动态白名单，工具收窄因此能跨请求与压缩保留。
- 修复三处**静默失效**：`count` 的 `delegated` 漏导入、`instruction-hint` 组合源缺模板、注入来源未归一为 v4 生产者身份（注入正文会回到下一轮判定输入）。
- ponytail 子代理规则按只读 / 写分档，只读任务不再付完整规则。

### 升级注意

- 内置模块只补建**缺失**的同名目录，已有用户模块不被覆盖；两个新模块需在「模块」页手动启用并重启 DSH。
- `skill-surface` 必须与按需发现配套：删掉技能目录却没有 `skill_search` / `skill_load` 的部署不要启用（模型将找不到任何技能）。
- 模块定义里的旧字段名是本版唯一的强制迁移点，其余行为向后兼容。

### 文档同步：工具面收窄写入权威文档，并清掉重构遗留的旧字段名

- **新增权威章节**（`docs/engine-reuse.md` 的「工具面收窄与按需解锁」）：把三件互相依赖的东西（常驻白名单 + `allowFrom`、发现工具、解锁回收）、`allowFrom` 的判据与「只做加法」的方向性约束、坏数据降级语义、`deny` 与 `allowFrom` 的挂载期互斥、解锁为何能跨压缩保留、模板为何不能声明 `waterfallPosition`、`any` 两支的相位表达、`requireMatch` 的 fail-open，以及**与 `tool-bootstrap` 的分工**（等价声明在受控相位收窄且无解锁通道；相邻 `assembly` 动作各裁一次，A 裁掉的 B 不会加回）一次写清。模块清单补登 `engine/skill-search.mjs` 与 `engine/dev-tool-search.mjs`。
- **修正旧字段名**（`engine-reuse.md`、`injection-point-contracts.md`、`architecture-params.md`、`ui-architecture.md`、`adr/0007`）：规则级 `when` → `if`、`do` → `then`，含 6 个 YAML 示例。**刻意不动**两处：`request-params` 动作内部的 `when` 选项（与规则字段不是同一个东西，已在文档里写明区别）、ADR-0007 的决策正文（改加状态注记，标注字段名已更新）。旧名在声明路径本来就会被显式拒绝（`rule-spec.mjs` 报「`when` 已退役，改用 `if`」），文档滞后会让读者照抄出错的写法。
- **修正过时文件名引用**（`ui-architecture.md`）：项目树与正文里的 `PresetPersonaCard.tsx` / `PresetExportDialog.tsx` / `PresetSwitcher.tsx` 早已改名为 `ModulePersonaCard.tsx` / `ModuleExportDialog.tsx` / `ModuleSwitcher.tsx`；测试表引用的 `test/host/rematerialize-presets.test.mjs` 已不存在，改指 `module-storage.test.mjs` 与 `preset-engine-managed-paths.test.mjs`。
- **验证**：6 个含 `rules` 的文档 YAML 示例**逐个通过 `compileRules`**（这也是改名的决定性证据——保留 `when:`/`do:` 会全部编译失败）；文档路径引用逐条核对，剩余未命中项均为「文档惯用的相对片段」（如 `conditions/subject.mjs` 实指 `engine/conditions/subject.mjs`）或指向官方 DSH 仓库的路径。

### 工具面收窄：`allowFrom` 动态白名单 + `dev_tool_search` 发现入口 + 收窄模板

- **动机**：工具面实测 **156 个工具、描述合计 46894 字符（≈12K token）**，每个请求都付，而多数请求只用到其中几个。构成：MCP 84（GitHub 46 / chart 27 / heroui 6 / context7 2 / ui-skills 2 / sequential-thinking 1）、mnemon 17、task_board 15、ssh 6、核心 34。
- **T2 `allowFrom`**（`engine/actions/assembly.mjs`、`engine/actions/shared.mjs`）：`assembly.target.tools` 新增 `allowFrom: { tool, key }`，运行时从本会话持久事件里筛 `type === 'tool/call'` 且 `data.name` 精确等于 `tool` 的事件，`try/catch` 解析 `data.arguments`，只取 `key` 指向的字符串数组里的字符串项。**这一步是收窄能成立的前提**——没有它，解锁是一次性的（当次请求用完即被裁掉）。
  - **方向性约束**：动态项**只做加法**。`createMask.blocks()` 的语义是「**在** allow 里就放行」，所以动态集合只能解锁、永远不能裁掉任何工具；`allowFrom` 未声明时行为与改动前逐字一致。
  - **坏数据不上抛**：非法 JSON、`key` 非数组、`tool` 不匹配、缺 `arguments`、数组混入非字符串——逐条忽略，其余照常累积。取不到 session 时退回静态名单。`deny` 与 `allowFrom` 同声明在挂载期 fail loud（黑名单与「只做加法」语义冲突）。
  - **隔离**：`tool` / `key` 按参数传进闭包内的解析函数，**不用模块级可变状态**——同一 `prepareAssembly` 会被多个 assembly 动作各挂一次，模块级变量会让它们互相覆盖。
- **T3 `dev_tool_search`**（`engine/dev-tool-search.mjs` + 组合源）：注册一个发现工具，`query` 搜索完整装配目录、`toolNames` 按精确名解锁（解锁名写入持久 `tool/call` 参数，由 `allowFrom` 读回）。照搬上游两处修正：匹配是**打分**而非 AND 过滤（长自然语言查询在 AND 口径下命中零个），描述里显式教解锁路径（模型只会搜、不会传 `toolNames`）。
  - **能力摘要来自运行时截获，不手工维护**：空查询时按前缀把 `ctx.tools.schemas()` 折成分组计数（`mcp__github__*(46) mnemon_*(17) …`，实测 433 字符覆盖全部 156 个工具，相对 46894 字符约 108 倍压缩）。官方注册表只投影 name/description（无分组字段），所以分组在本地折叠。此前那份写死的 `UNLOCKABLE_INDEX` 已删除——工具增删就要改代码，名字写错还会让模型照着错名字解锁。
- **T4 收窄模板**（`templates/80-tool-surface.yml`）：常驻核心集 `pwsh / read / write / edit / glob / grep / todo_write / skill_search / skill_load / dev_tool_search`，并把 `allowFrom` 接到 `dev_tool_search.toolNames`。
  - **相位用 `any` 两支表达**：单个 `phase` 节点**无法**表达「两个相位都命中」——`promoted` 缺省是 `true`（= 只匹配已晋升，不是「任意」），而 `promoted: 'ignore'` 要求同时声明只接受布尔值的 `compacted`。故用 `any: [phase{promoted:true}, phase{compacted:true, promoted:false}]`。实测四态：首轮不收窄、已晋升收窄、压缩后未晋升收窄、压缩后已晋升收窄；差分断言证明两支都不可省（第二支唯一负责「压缩后未晋升」）。
  - **首轮刻意不收窄**：与「首轮保全文」同一取舍——先让模型看到完整目录，再随相位推进收窄；长会话必然进入上面两支，省下的仍是大头。
  - **`requireMatch: true`**：任一 allow 工具缺失（或模型解锁了不存在的名字）就放弃裁剪、暴露完整目录。宁可多给上下文，也不静默裁成空目录。
  - **本模板走规则路径，不能声明 `waterfallPosition`**（那是声明 `triggers` 路径的字段，`compileRules` 会以 unknown fields 拒绝）；需要 `outermost` 时改用声明路径。
- **回归**：`test/engine/actions.test.mjs`（`allowFrom` 主路径 / 坏数据逐条忽略 / 无 session 降级 / 挂载期 fail loud / 多动作不串味）、`test/engine/dev-tool-search.test.mjs`（打分排序 / 分组摘要 / 解锁回报 / 目录抛错降级 / 描述不内联会腐化的清单）、`test/engine/tool-surface-template.test.mjs`（引擎权威校验 + `allowFrom` 与插件写入端的**跨模块契约** + 相位实测覆盖）。
- **验证**：typecheck、lint（0 warn / 253 文件）、test **430 passed（+17）**、build、`git diff --check` 全绿。

### 修复：`instruction-hint` 的组合源缺模板，开关静默失效

- **缺陷**：参数桥的 `params.instructionHint`（UI「指令路径提示」）会把 `instruction-hint` 行的 `enabled` 置 `true`，但组合源 `engine/compositions/source/local/instruction-hint.yml` 只配了 `enabled` / `promoteOn` / `includeSubagents`。而 `instruction-hint.mjs#apply` 的第一行是 `if (!enabled || templateOf(source, 'messageTemplate').trim().length === 0) return`——于是**把开关打开不注册任何转换**：配置合法、零效果、零报错（与 `count.delegated` 的静默失效同类）。迁移路径 `rules-migration.ts:102` 会 `fillMissing` 补模板，所以只有新装的模块走组合源时暴露，表现就是「这个开关没有用」。
- **修复**：四个模板（`projectTemplate` / `globalTemplate` / `suffixTemplate` / `messageTemplate`）随行声明，正文**逐字取自** `templates/policies/legacy-defaults.yml#instructionHint`——与迁移默认值同源，否则「迁移进来的定义」与「新装的组合源」行为分叉。`legacy-defaults.yml` 自身标注「引擎运行时不得读取此文件」，所以必须是实体而非引用。
- **行为**：`enabled` 仍缺省 `false`（opt-in，须在 UI 勾选或直写行配置）；`promoteOn: either` 不动，**首轮仍注入全文**（硬约束保证先入眼），首个工具调用/助手消息之后才换成「路径提示」，后续全文 dump 丢弃；`includeSubagents` 由 `false` 改为 `true`，让子代理同样只拿提示。装配无需手工挂行——`manifest.ts:728`「参数在 ⇒ 装配在」按 `params.module.row` 自动补齐，且 `applyModuleConfigs` 是浅合并，只覆盖 `enabled`，不会冲掉模板。
- **回归**：`test/engine/instruction-hint.test.mjs` 新增一条，直读**线上组合源**并断言四个模板非空、且与 `legacy-defaults.yml` 逐字一致。此前测不出来是因为该文件其余用例都从 `legacy-defaults` 注入模板（文件头 helper），`apply()` 的前置条件在那些用例里**恒被满足**。
- **验证**：typecheck、lint（0 warn / 251 文件）、test **414 passed（+1）**、build、`git diff --check` 全绿；一次性端到端探针（驱动 `buildModuleConfigsFromParams` + `applyModuleConfigs`，走 lib 生产路径）显示合并后 `apply()` 会注册 = `true`，改动前对照 = `false`。

### 技能面收窄：宿主侧提供 `skill_search` / `skill_load`

- **动机**：官方 `dsh-tool-skill` 把全量 `<available_skills>`（`source.kind === 'skill-catalog'`）注入首步，并在每次晋升/压缩后**再次注入**。实测（2026-10-05，三个主会话）6 次注入共 **78792 字符**，即每会话约两块 13KB——而它只是索引，模型能按需搜索就不需要它。
- **实现**：`src/index.ts` 在宿主侧挂载 `engine/skill-search.mjs`，把 `skill_search` / `skill_load` 两个工具注册给所有 Agent（不依赖预设，与 ponytail 走同一条 `agent/created` → 模块装配通路）。
- **降级**：改为**动态导入**而非静态导入。该引擎顶层经 `importHostPackage` 从宿主入口 realpath 解析 `@deepseek-ai/dsh-skill`，静态导入一旦解析失败会让**整个 prompt-tool 插件挂载失败**；现在失败只记一条告警、不挂这两个工具，其余能力照常。
- **配对模块**：`skill-surface`（`$DSH_HOME/.prompt-tool/modules/`）用 `pre-step-filter` 的 `sources` 白名单拦掉 `skill-catalog`。保留清单来自 12 个真实会话的 kind 实测枚举（13 项），其中三个 `plugin:ponytail-*` kind **只出现在子代理**——漏掉会静默废掉子代理的 ponytail 策略。
- **实测纠正**：`keepKinds` 模式在本地确定性探针下**什么都不删**（claimed 基线的对象身份保留规则把所有消息都保住了），`sources` 枚举才是可行写法。
- **真机验收（重启后，四项全部通过）**：①主会话相邻 `request/header` 对比，工具数 **154 → 156**（唯一变量是重启），新增的正是 `skill_search` / `skill_load`；②本轮 `agent/inbox/spliced` 注入链为 `user → agent-instructions → runtime-context → dsh-mnemon`，**无 `skill-catalog`**（重启前同类时机必有，12892–13372 字符）；③重启前后的只读子代理对比，`plugin:ponytail-subagent-readonly` 与 `plugin:prompt-config-engine` 均在、分档判定未变，**未被白名单误伤**；④只读探针子代理实调 `skill_search({ query: "ponytail" })` 命中 6 个技能、`skill_load({ name: "ponytail" })` 注入 5679 字符正文（frontmatter 已剥离）。
- **证据获取方式的一次修正（重要）**：早先试图用「会话日志里有没有 `skill_search` 字符串」来判断工具是否存在，结论**不可用**——该字符串从 2026-09-23 起的旧会话里就出现过（来自技能清单正文，而非工具注册）。可用的证据只有两处：`request/header.tools` 的名字列表（工具面）与 `agent/inbox/spliced.inserted[].source.kind`（注入面）。`request/header` 载荷只含 `config` / `adapterDefaults` / `tools`，**不含消息**，消息一律走 spliced。

### 修复：`count` 谓词的 `delegated` 选项静默永不命中

- **缺陷**：`engine/conditions/count.mjs` 在第 129 行使用 `isDelegated`，但该文件只从 `../shared.mjs` 导入了 `MAX_TRACKED_SESSIONS, extractText, sessionEvents`——**漏了 `isDelegated`**。于是 `when: { count: { …, delegated: true|false } }` 在判定期抛 `ReferenceError`，被 `ruleMatches` 的 try/catch 吞成 `false` 并只告警一次，表现为该选项**配置合法、永不命中、零显式报错**。同语义的 `session.mjs`、`scope.mjs` 都正确导入了，只有 count 漏了。
- **修复**：补上 import。
- **回归**：`test/engine/predicates.test.mjs` 新增「计数类与会话态：`delegated` 双向往返且不抛」——在主会话与子代理两种 `delegationDepth` 上各跑 `delegated: true/false` 与不声明的形态，断言 `count` 与 `session` 两个谓词的受众语义一致（此前 `delegated` 在测试里零覆盖，所以一直没被发现）。

### 修复：注入来源统一为 v4 生产者身份，注入正文不再回到判定输入

- **真机故障**：一次明确只读的子代理派发里**两档并注**——seq=11 注入只读档（144 字符），做完两个工具调用后 seq=28 又注入完整规则（4849 字符）。
- **根因（两个缺口叠加）**：`schema.mjs` 的 `sourceKind` 默认取**裸规则 id**，于是注入消息的 `source.kind` 没有 `plugin:` 前缀。这同时造成两件事：
  1. `pluginIdentityOf(source)` 对裸 kind 返回 `undefined`，`dedupe: session` 的真相源去重只剩「`sourceKind` 恰好相等」一条，两档各自的账互不可见；
  2. 更关键：`userMessagesText` 的注入过滤只认 `source.plugin` 与 `plugin:` 前缀，漏掉裸 kind 的注入消息——**本引擎注入过的规则正文因此会回来参与下一轮 `when` 判定**。只读档正文含「只读」二字，把写档的 `notAny` 在第二轮翻成了真。
- **修复**：`sourceKind` 一律归一为 `plugin:<owner>`（声明的值没有前缀时补上）。一处改动同时让 v4 生产者身份统一、`pluginIdentityOf` 能解析出去重身份、`userMessagesText` 能正确排除注入消息。
- **回归**：`test/engine/prompt-config-engine.test.mjs` 新增「注入来源统一为生产者身份：注入过的正文不得回到下一轮判定输入」——两轮判定，断言注入消息带 `plugin:` 前缀、注入正文不进 `userText`、真实任务文本仍计入。

### ponytail 子代理规则分档：只读 / 写

- **动机**：此前每个子代理都无条件收到完整规则（实测 5044 字符），而只读任务（列目录、数文件、只读分析）的 prompt 本身往往只有 100 多字符——规则里「最短 diff、删除优先、留下可运行检查、标记 `ponytail:` 债务」这些执行层条目对它完全无关。
- **两档**：判别只落在 `pre-step` 层，因为只有它能看到任务文本（`subagent-start` 的载荷仅 `runId/provider/id/local`）。
  - **只读档**（`ponytail-subagent-readonly`，144 字符）：只保留不变量（不得改文件）与观察面（把发现当交付物）。
  - **写档**（`ponytail-subagent-rules`，完整 4849 字符）：`notAny` 只读词，其余一律给完整规则。
  - 两档共用同一张关键词表、算子相反，因此**互补且完备**（不存在两档都不命中）：只认 `PONYTAIL:readonly`、`only read`、`只读` 这类**明确表示整个任务只读**的信号，**不含** `不要修改`/`不要读取` 这类从句级表述——写任务里出现得比只读任务还频繁（`重构这个函数，不要修改测试文件`）。取不到明确信号就按写档，因为误判代价不对称：写任务漏给规则会让代码质量悄悄变差且不会被发现，写档多给 4844 字符只是浪费。
  - 两档都是 `position: before-all`（规则排在任务文本之前）+ `dedupe: session`（每个子代理只付一次）。
  - **首轮守卫 `session: { type: 'user/message', present: false }` 不可省**：`agent/pre-step` 的 `messages` 是「本批被领取的消息」，任务文本**只在首轮那批里**（真机会话实测：任务 `user/message` 只出现一次）。第二轮起 `userText` 为空 → 写档的 `notAny` 翻成真、只读档的 `text` 判假，同一子代理于是先拿只读档、再拿完整规则（真机踩过两档并注）。判据必须钉在任务文本还在的那一刻。
- **档位标记**留在 `subagent-start`（195 字符，无条件）：子代理拿不到 `system-section` 的档位卡，这一行仍是它唯一的档位来源。
- **净效果**：只读子代理的规则开销从 5044 → 339 字符（约 −93%），写档行为不变。
- **投影命名统一到产物形态**：`configs/` 文件名回归 `writePreset` 的固有命名 `<seq>-<ruleId>--<actionId>.yml`（此前被手工去掉 `--inject` 后缀）。六份既有投影正文逐字未变，已用 git HEAD 版本对比验证。
- **回归**：`test/host/ponytail-module.test.mjs` 的注入点断言改为守住分档设计（两档的层/位置/去重/关键词表一致性与互斥完备性、只读档保持轻量、档位卡无条件）。

### 修复：注入消息的 source 改用会话格式 v4 的生产者身份

- **真机故障**：启用含 `subagent-start` 卡的模块后，任何子代理启动都失败——`SessionFormatError: format v4 message requires a producer-owned source kind`，子代理会话只写了 header 与权限事件，连 `agent/inbox/spliced` 都落不了盘。
- **根因**：注入消息的 `source` 写成 `{ kind: 'plugin', plugin: <owner> }`。会话格式 v4 把这种形态列为**退役包装**并直接拒绝（`dsh-session-format-v3-to-v4` 的 `assertV4MessageSources` / `assertV4SourceRowAdmission`），迁移只在读旧日志时把 `plugin` 折进 kind。受影响的是全部插件注入路径：`pluginMessage`（`subagent-start` / `subagent-end` / `turn-stop` / `append-context`）、pre-step 的 `buildMessage`、`inbox-prepend`、`anchor-notice`。
- **修复**：写入一律用生产者身份 `kind: 'plugin:<owner>'`（保留 `plugin` 字段供旧日志与 `blockPlugins` 读取）；读取侧两形态都认——`pluginIdentityOf` 统一取去重身份、`confirmDelivered` 补记、`inbox-prepend` 的防自触发、`pre-step-filter` 的 `blockPlugins`、`userMessagesText` 的注入过滤。
- **回归**：`test/engine/actions.test.mjs` 与 `test/engine/prompt-config-engine.test.mjs` 断言注入消息的 `source.kind` 必须是生产者名，锁死这条格式契约。

### 内置 ponytail 模块重建：对齐上游 4.10.3，并接通子代理注入

- **规则正文按上游 `skills/ponytail/SKILL.md` 重新抽取**：消掉 vendor 旧版的语义漂移（根因修复改为「先 grep 该函数所有 caller，再在共享函数上修一次」、`## Rules` 合并为上游的紧凑段并补回「无可避免的新依赖」、不懒惰清单补回「显式要求」、测试条目补回「no fixtures」），并补上上游的停用语义 `Off: "stop ponytail" / "normal mode"`。DSH 本地适配保留：档位由互斥配置卡持有、不注册 `/ponytail` 命令。
- **接通上游 `SubagentStart` 通道**：新增 `ponytail-subagent-rules` / `ponytail-subagent-level` 两张 `subagent-start` 层配置卡。此前四张卡全在 `system-section`，只在主会话 system prompt 里生效，子代理拿不到规则；现在子代理启动时按上游语义注入同一份规则副本（不声明 `when` = 注入每个子代理，对应上游 matcher 缺省与解析失败时的 fail open）。
- **新增回归 `test/host/ponytail-module.test.mjs`**：守住①`configs/` 投影与 `module.yml` 定义逐字一致且文件名符合 `configOrder` 序号契约，②规则正文含上游关键句且不内联档位表，③注入点映射（常驻 `system-section`、档位互斥组默认 full、子代理走 `subagent-start`）。

### 子代理注入细化：provider / 模型范围 / 任务分类

- **子代理事件暴露 provider**：`subjectOf` 把 `SubagentRunInfo.provider` 投影为 `name`，`names` 谓词因此在 `subagent-start`/`subagent-end` 可用（`when: { names: { allow: [fork] } }`）。缺 provider 时不写该键，判定退回 `UNAVAILABLE`，`not` 不得把它反转成放行。
- **判定前预取子代理 agent**：子代理两层此前在判定阶段拿不到 agent（`wireSubagentEvents` 是在 handler 里才挂上 frame 的），导致 `scope.modelScope`（`pro`/`flash`）与 `scope.audience` **恒不可用、永不命中**——UI 上配了却没效果。现在 `ruleFrame` 接收判定期 `ctx`，按事件 `id` 反查 agent 补齐 `agent`/`session`/`model`；取不到即 `UNAVAILABLE`（fail-closed）。
- **`userMessagesText` 对齐「只扫真实对话」**：它此前只看 `role === 'user'`，而引擎自己注入的消息同样是 user-role（`source: { kind: 'plugin' }`），于是 `text.match` 会匹配到自己注入过的正文（命中判定在去重之前，`dedupe` 挡不住）。现按同项目 `st-world-book.mjs#stChatMessages` 的既有判据排除 `source.plugin` 与非 `user` 的 kind，两处语义对齐。
- **按任务给子代理分类注入的落法**：`pre-step` 层 + `scope.audience: subagent` + `dedupe: session` + `text.match`（或 `first-turn-anchor`）。子代理初始 prompt 以 `source: { kind: 'user' }` 投递（官方 `subagent-in-process-driver`），因此 pre-step 的 `messages` 天然含任务文本；`subagent-start` 层载荷只有 `runId/provider/id/local`，**做不了内容分类**，故保持无条件注入与上游 matcher 缺省一致。
- **文档与模块同步**：`docs/injection-point-contracts.md` 的 `pre-step` 与 `subagent-start` 两行补齐可用事实、落法与边界；内置 ponytail 子代理卡在注释里写明两条细化路径，默认粒度不变并有回归守着。
- **回归**：`test/engine/predicates.test.mjs` 新增 3 条（provider 投影、判定前 agent 反查、`userText` 只扫真实对话）。

### 内置模块：`skill-surface` 与 `tool-surface` 随包分发

- **落点**：包内 `modules/<id>/module.yml`，与内置 `ponytail` 同形——**只放定义**，`rules/` 切片由 `ensureModuleSlices` 运行时生成（带 `_integrity` 指纹）。`npm pack` 打的是**工作区**文件而不是 git 跟踪文件，切片留在工作区就会被打进 tgz；`test/host/surface-modules.test.mjs` 直接锁目录内容。
- **交付形态**：启动时 `ensureModuleSeed` 从包内补建缺失模块，**已有同名目录不覆盖**；两个模块出现在「新建」选择器里，**默认不启用**——装配仍只由 `config.yml` 的启用表决定。
- **`tool-surface`**：组合源 `rule-engine` + `dev-tool-search`，常驻集 `pwsh/read/write/edit/glob/grep/todo_write/skill_search/skill_load/dev_tool_search`，`allowFrom: { tool: dev_tool_search, key: toolNames }` 从持久 `tool/call` 参数回收解锁名，`requireMatch: true`（缺任一工具即 fail-open 到完整目录，宁可多给上下文也不静默裁空）。相位用 `any` 两支表达「已晋升」与「压缩后未晋升」，**首轮刻意不收窄**。
- **`skill-surface`**：`pre-step-filter` 的 `sources` 是严格白名单，14 种实测 kind 里只删 `skill-catalog`。其中三个 `plugin:ponytail-*` kind **只在子代理出现**——漏掉会静默废掉整套 ponytail 子代理策略而主会话看起来正常，回归逐条钉住保留项（含 `skill-invocation`：删了它，按需加载的技能正文也没了）。
- **两个模块是同一行为的两份声明**：同一逻辑另有 `templates/80-tool-surface.yml`（模板路径）。回归断言两者的 `tools` 与相位两支逐字一致——改一边忘另一边只会表现为「某个部署收窄没生效」。

## [1.0.0] - 2026-10-02

### 模块化重构：预设 → 模块，启用即配装

- **数据模型换成「模块」**：一个模块 = `$DSH_HOME/.prompt-tool/modules/<id>/` 一个目录，定义是 `module.yml`，提示词配置切片物化到同目录 `configs/`。存储根由 `.agent-presets/` 迁到 `.prompt-tool/`（宿主从不扫描它）；旧根只读不删，本版本不做迁移。
- **启用表就是配装**：存储根 `config.yml` 的 `enabled: [id…]` 决定装哪些模块——列了 A+B 就装 A+B，每个模块各自贡献自己的提示词配置、引擎参数与能力声明，互不合并、互不改写，因此不再需要「主模块」。模块卡的启用改成滑动开关，点开关即改启用表。
- **运行时装配搬进插件**：每个 Agent 在自己的 scope 里按启用表装配（`agent-assembly.ts`），不再向宿主写 `selectedDefault`——官方默认改为单向跟随，避免把会话预设指向不含官方工具行的空壳；宿主侧预设登记只保留身份。
- **包内官方预设内容整体退场**：`preset/` 目录、官方预设同步生成器与同步链一并删除（相对 0.8.1 净删约 4.1 万行）；模块不再注册为官方会话预设。引擎贡献与组合快照仍随包分发（`engine/compositions/library/`）。
- **独占 system 段（`complete`）补齐两块防护**：写盘门控拒绝「人设 × 配置」与「分两次保存攒出的双独占」，装配前再兜底校验唯一性，并在文案里讲清「其余 system 段全部被抑制」的代价。
- **工作台合并**：预设页与角色卡页合并为「模块」页；卡体统一为「无点击 + 底部按钮」，删除守卫、空态与阻止态收口，模块卡「导出」改为同类图标按钮。
- **命名与文案统一**：导出符号、文件名（`preset-*.ts` → `module-*.ts`）、bridge 端点（`/preset-*` → `/module-*`）与界面中英文文案统一改称「模块」；`writePreset`、`agentPresets`、`PresetDefinition` 等官方契约名保留不改。

> 破坏性变更：存储布局与界面用语都与 0.8.x 不同，旧数据（`.agent-presets/`、`presets/<id>/preset.yml`）不再被读取——升级后需要重新导入模块。

## 宿主 0.2.0 契约重构（2026-09-29）

- 角色卡和世界书工具按执行 Agent 的官方预设绑定读写，拒绝未绑定或非受管目标；晚到宿主服务通过 Cordis inject 等待。
- 预设保存、重建和注册贯通异步结果，失败明确区分已保存与未生效；保留首次 broken 诊断和更新失败时的上一可用注册。默认选择跟随官方 defaultId，移除已退役的 modeSelectionEnabled 判断。
- 控件、图标、菜单定位与关闭行为由插件持有，取消宿主 Client primitives 运行时依赖；样式在 apply/dispose 生命周期安装和释放。
- 启动和 profile 体检均只诊断，安装交给官方插件管理；公开宿主服务类型替代手写影子结构，依赖校验支持范围声明及实际锁定版本。
- 清理 primitives 退场后无源码和类型消费的 20 个浏览器开发依赖；官方组合与开发技能快照同步到 0.2.0-rc.1（4878cdabd8），四套预设 persona 与模块列表未变化。

## [0.8.3] - 2026-09-28

### 依赖收口：声明改宽、release-age 白名单收敛、cordis 与 schemastery 对齐宿主

- **第三方 peer 对齐宿主实际提供的版本**：`@deepseek-ai/cordis` 由 `^4.0.3`（dev 锁 `4.0.3`）升为 `^4.0.4`（dev `4.0.4`），`@deepseek-ai/schemastery` 由 `^3.18.3` 升为 `^3.18.4`。宿主桌面运行时（app.asar 的 release manifest）与 `$DSH_HOME/profiles/node_modules` 里提供的正是 4.0.4 / 3.18.4，而本仓库此前锁在 4.0.3 / 3.18.3——本地类型基线与运行时不一致。`pnpm peers check` 由「`✕ unmet peer @deepseek-ai/cordis`（要 ~4.0.4）+ `✕ unmet peer @deepseek-ai/schemastery`（要 ~3.18.4）」变为 **`No peer dependency issues found`**。
- **peer 范围由精确版改为无上界**：24 条 `@deepseek-ai/dsh-*` 从 `^0.2.0-rc.1` 改为 `>=0.2.0-rc.1`。此前每次 DSH 升一个次版本，24 条 peer 全部落到区间外、插件被判为不兼容；现在 0.2 以上的次版本无需再改声明。取无上界是有意的：宿主只在插件加载时校验，而 DSH 0.2.x 的次版本升级从未破坏过本插件用到的 API。实测该范围覆盖 `0.2.0-rc.1`～`2.0.0`，同时仍把 `0.1.7-alpha.1` 这类已知不兼容的旧版本挡在外面。
- **devDependencies 同步改宽**：29 条同样改为 `>=0.2.0-rc.1`。`pnpm install` 仍解析到 `0.2.0-rc.1`，实际锁定版本由 `pnpm-lock.yaml` 负责，可复现性不受影响。之所以不再用 `^0.2.0-rc.1` 这类 caret：caret 只覆盖同一个次版本（`^0.2.0-rc.1` 到 0.2.x 为止），而 `^0.1.7-rc.2` 这种更旧的 caret 连 0.2.x 都不覆盖，会让本地类型基线与运行时静默错开。
- **`minimumReleaseAgeExclude` 收敛为 pnpm 的当前形态**：`pnpm-workspace.yaml` 由 85 行缩到 82 行，清单从 80 条（历史上逐版本累积、还留着已废弃的 `@deepseek-ai/dsh-agent-presets`）收敛为 73 条、只含当前安装的 `0.2.0-rc.1`。**这份清单不是手工维护项**：pnpm 12 安装时会把 lockfile 拿去比对供应链策略（`Verifying lockfile against supply-chain policies`），当前版本不在清单里就被拒装，随后 pnpm 把整块重写为「只含当前版本」的形态。升级 DSH 的后续动作因此只有「跑一次 `pnpm install`」，不必再逐条增删。

> 更正：本条最初写成「删除失效的 `minimumReleaseAgeExclude`」，是错的。当时只测了 `pnpm config get minimumReleaseAge` 返回 `undefined` 就下了结论，而实际门控在 lockfile 的供应链策略校验里——删掉该块后 pnpm 直接拒装并把它重写回来。

## [0.8.2] - 2026-09-28

### 兼容 DSH 0.2.0-rc.1

- **修复插件被宿主判为不兼容而拒绝加载**：`peerDependencies` 里的 `@deepseek-ai/dsh-*` 原为 `^0.1.7-alpha.1`，`0.2.0-rc.1` 不满足该区间，宿主的 `evaluatePluginCompatibility` 因此报「不兼容（要求 …），运行它可能导致崩溃或数据丢失」。全部 `@deepseek-ai/dsh-*` 依赖（`peerDependencies` 与 `devDependencies`）对齐到 `0.2.0-rc.1`。
- **API 面复核**：插件实际使用的宿主导出（`useAnchoredPosition`、`useDismissOnOutsidePointer`、`Menu`/`MenuEntry`、图标族、`Switch`/`Button`/`Tag`，以及 `InjectFace`/`PropsLocale`/`PropsRuntime`/`Translate`）在 0.2.0-rc.1 中均保留，无需改动 `src/`。
- **宿主要求**：最低版本由 DSH `0.1.7-alpha.1` 提升为 `0.2.0-rc.1`。

## 测试按 seam 收敛（2026-09-27）

- **测试文件 150 → 33、用例 1617 → 289**：按 TDD 的 seam 约定把覆盖收敛到四条公共边界——引擎注入行为（插入点 / 时机 / 次数 / 受众）、写盘产物语义、bridge 端点载荷、安全与拒绝路径。其余整文件删除，含 `test/client/` 的渲染与浏览器 smoke、SillyTavern 转换、预设管理与技能管理用例。
- **删除依据**：只保留通过公共接口验证行为的断言；删掉实现耦合（断言源码文本、渲染 HTML/DOM 结构）与同义反复（期望值由被测代码或测试自建对象重算）的用例。
- **连带清理**：`test/types/` 及其在 `tsconfig.json#include` 中的引用移除；`README.md`、`docs/*` 与 `scripts/*.mjs` 中指向已删测试的 36 处引用同步更新；`test/engine/declarations/` 固件保留（仍被 `engine/*.mjs` 注释引用），但已无执行型消费者。
- **验证**：`pnpm test` 289/289、`pnpm typecheck`、`pnpm lint`（0 warning）、`pnpm build`、`git diff --check` 全通过。

## [0.8.1] - 2026-09-26

### 配置卡导航列贴合页签宽度

- **修复页签与内容面板之间的空白**：展开后的提示词配置卡里，左侧「条件 / 执行 / 内容 / 设置」与右侧面板之间出现约 90px 空白——导航列此前固定 `128px`，而页签按钮已改为贴合自身文案（约 60px），剩余列宽连同列间距一起变成空白。现在导航列按最宽页签收缩（`max-content`），页签与面板之间只保留列间距；≤620px 的横向标签页形态不变。
- 真实 Edge CSS 冒烟的对应断言由「页签窄于导航列」改为「导航列宽 ≤ 最宽页签 + 2px」，直接锁住列不虚胖。

## [0.8.0] - 2026-09-26

自 0.7.2（2026-08-31）起的累积发布，覆盖 342 个提交；完整明细见下方各“0.8.0 明细”段与按日期的主题条目。

### 破坏性变更（升级前必读）

- **BREAKING｜引擎归位插件包**：共享引擎不再物化到 `<预设根>/.engine/`，改由包内 `dsh-plugin-prompt-tool/engine/*` 提供。仍写 `./engine/`、`../.engine/` 的旧预设保存或重建一次即迁移为新形态；已有 `.engine/` 目录不再被引用，插件不主动删除。
- **BREAKING｜技能管理改为注册层屏蔽**：调用策略直接改写 `SKILL.md` 的两个官方 frontmatter 键，受管实体库与链接管理整体退场；技能实体仍归各官方技能根所有，插件不搬迁。
- **BREAKING｜字段声明化与旧兼容退场**：提示词配置与参数字段白名单由声明生成，`enabled` 统一 fail loud；旧参数别名、旧 `worldBook` 段、旧覆盖文件与旧变量兼容全部移除，只经 `pnpm migrate:presets` 一次性离线迁移。
- **BREAKING｜指令文件独立来源**：AGENTS.md / CLAUDE.md 卡与注入策略独立于 `preset.yml`，缺省 `enabled: false`（需在工作台显式开启）；官方指令行仍在时让位、不重复注入。
- **移除旧入口**：`promptConfigsDir`、预设根目录配置、上游 anchored 预设、独立能力卡与旧模块卡形态。

### 主要变化

- **九层注入面（6 → 9）**：新增三个事件层与声明式条件判定（判断原语、组合逻辑、三态键匹配）；`system-section` / `runtime-context` 接入官方装配刻度。
- **声明式触发器引擎**：七类判断原语、四种组合与九类动作；七个内置能力收敛为 `triggers` 声明，未声明即无该行为，不再有专用能力模块。
- **工作台**：引擎设置并入注入层实例卡（条件 / 执行 / 内容 / 设置分栏），统一搜索与创建入口，UI V2 布局与危险操作统一，页签贴合文案宽度；桌面版让开原生窗口 chrome，抽屉与模态均不再落在拖拽带。
- **技能页**：三行摘要卡与独立正文编辑、导入与引用两个目录入口、回收站删除，可用性只以文件声明为事实。
- **角色卡与 SillyTavern**：PNG/JSON/YAML 先预览后写入、同源转换报告、世界书只读诊断，ST 宏与变量赋值族补齐。
- **工程**：测试归一（135 → 87 个测试文件）、真实 Edge CSS 冒烟、profile 解析修复器（`pnpm repair:profile`）、桌面版插件接口契约文档。

### 升级注意

- 升级后需**重启 DSH 服务**才生效。
- 缺省关闭的指令文件注入需在工作台内显式开启。

## ADR-0003 按现状重写并复验注入引擎（2026-09-23）

- **ADR-0003 从 3 行决策句扩写为按现有代码的事实记录**：正文在用户原文件、指令策略全局一份（缺省 `enabled: false`）、pre-step 协调器按会话工作区现场探测、按 `(fileId, revision, surface epoch)` 判定重发、负责人冲突与装配未知一律不注入、`agents-file-*` 卡与 `preset.yml#agentsHints` 的退场边界；并记录被取代的「每预设物化一份」形态（`777b1ff` → `205f847`/`11a9e73`）与「按预设各持一份」属未采纳方向（需新 ADR）。
- **注入引擎复验**：12 个注入链路测试文件定向回归 **105 例全绿**（含真实 cordis 接线、E2E 物化预设 + 引擎 + 协调器）；另以真实 DSH_HOME + 本工作区直接调用 `detectAgentsFiles`，实测探测到 `~/.dsh/AGENTS.md`（global）与 `AGENTS.md`（project）两个候选——显示路径与官方 `dshHomeDisplay` 的 `$DSH_HOME/AGENTS.md` 不同，据此确认本会话由官方注入、插件按负责人冲突让位。
- 未验证边界：真机模型会话端到端（需重启在役服务与真实 API 调用）不在本轮范围。

## 指令策略回到安全缺省（2026-09-23）

- **`enabled` 缺省恢复 `false`（需在工作台显式开启）**：`defaultInstructionPolicy()`、`readInstructionPolicy`（键缺失 = 关闭，只有显式 `true` 才参战）与落键规则一并反转——`true` 现在显式写 `enabled: true`，`false` 视为缺省而删除该键。`dfdac10`「指令文件默认启用」只同步了 README 与部分 UI 架构文档，其余 8 处注释/UI 文案/客户端兜底快照/两份 docs 仍写「默认关闭」，长期自相矛盾；本轮以「安全缺省」定案并统一。
- 语义要点（本轮不变）：策略文件**缺失或损坏一律不参战**（不把损坏当空配置继续注入）；总开关关闭是硬关，`files.<id>.enabled: true` 无法在部署级关闭下单独开启；单文件 `enabled: false` 只关该文件、不影响其余；策略只影响未来注入，不撤回已进入会话历史的内容。
- 回归同步：`pre-step-injection` 的 T15 改为「策略缺失（默认关闭）不注入文件正文」；`instructions-policy` 错误态回退断言改为缺省关闭，YAML 序列化失败用例改用 `enabled: false` 触发删键；`instructions-policy-endpoint` 缺失读取断言改为 `enabled: false`。
- README 指令策略段改回 `默认 enabled: false`；`docs/` 三处原本就写缺省 false，未改动。

## 移除插件状态文件（2026-09-23）

- **删除 `$DSH_HOME/.prompt-tool-state.json` 的全部读写**：`stateFilePath` / `PromptToolState` / `readPluginState` / `writePluginState` 及 `index` 导出整体移除，`ensurePresetSeed` 不再写 `seeded` 标记。
- 移除依据：旧迁移通道退场后该文件只剩 `seeded` 一个字段且**无任何读点**——种子化是否执行由预设目录存在性决定（删除内置预设仍自动补建），状态文件不参与运行时分支；`paramsMigrated` / `legacyAliasHandled` 是已删除迁移通道留下的历史残留键。插件目录模板复制行为不变，仍原子写预设根。
- 已存在的 `$DSH_HOME/.prompt-tool-state.json` 不由插件删除（只停止读写），用户可自行清理。
- 回归换成 `test/host/preset-seed.test.mjs`：种子化补建 / 幂等 / 删除后恢复，以及种子化不写状态文件、DSH_HOME 根下其他文件逐字节不变。

## profile 解析修复器与外来脚本清理（2026-09-23）

- **新增 `scripts/repair-profile.mjs`**（`pnpm repair:profile`）：体检并修复 profile **私有层**的包解析失败。启动日志出现 `skipping profile bundle` 时插件整体不加载、其自愈层也不会运行，这类零号故障只能由独立于插件的工具处理。判据与 dsh 的 `resolveBundleDir` 一致，并额外报出「链接在、目标不在」的悬空形态；只写 `<profiles>/<name>/node_modules/`，按 `link:` 声明重建为绝对 junction，真实文件/目录绝不删除，缺依赖只提示官方通道 `dsh plugin --profile <name> install`。
- **移除 `scripts/link-profile.mjs` 与 `link:profile`**：该脚本由 dsh-web-ui 引入、服务 `@linxin666/*` 家族包并写 `profiles/node_modules` 兜底层，不属本仓库内容。其 `resolveDshHomeArg` 已内联进修复器，用例迁至 `test/host/profile-repair.test.mjs`；`test/host/profile-assembly.test.mjs` 只保留本插件 web 表层自愈的契约用例。
- 文档：README 增「排障：插件未加载时」三步自查。

## 引擎归位插件包（2026-09-23）

- **BREAKING**：共享引擎不再物化到 `<预设根>/.engine/`，改由**插件包**提供——组合行的引擎引用是包名说明符 `dsh-plugin-prompt-tool/engine/<module>.mjs`（`package.json` 新增 `"./engine/*"` 导出）。预设包不再携带引擎，预设根只承载用户数据；`syncPresetEngine`、引擎指纹与物化回滚一并退场。
- 装配期由 `preset-registry` 统一换算（只改内存注册定义，正本 `agent.cordis.yml` 一字不改）：受管配置字段（`configsDir` / `strategyDir` / `policyFile` / `triggersFile`）按历史语义相对 `<预设根>/.engine/` 解析为绝对 `file://`——实测只有该形态对全部受管字段一致有效；需要 `templateFile` 越界校验的引擎行注入 `presetRoot`，相对 `templateFile` 仍按历史引擎位置解析，用户预设与提示词配置无需改写。
- 引擎侧只做基准解耦：`schema.loadTemplate` 接受显式预设根并对裸基准做目录语义归一；`prompt-config-engine` / `tool-config-engine` 的 config 新增可选 `presetRoot`。缺省行为与改动前完全一致。
- **不兼容旧预设**：仍写 `./engine/`、`../.engine/` 的预设不再被特殊处理，保存或重建一次即迁移为新形态；已有 `.engine/` 目录不再被引用，插件不主动删除。
- 升级后需用户重启 DSH 服务生效。

## 预设装配锚点修复（2026-09-23）

- **修复 DSH 0.1.7 下整份预设注册被拒**：官方 `agentPresets.register()` 以调用方 ctx 的 `baseUrl` 建立预设 Loader 树，插件此前把它改写到预设目录，导致组合内的包名行（`@deepseek-ai/dsh-*`）从预设目录起解析、向上找不到 node_modules 而全部 `never started`，`mountPreset` 失败即整份预设注册被拒——表现为预设选择器里 `pt-*` 全部缺失、默认预设 `selectedDefault` 指向不存在的 id（新会话装配抛 `agent-preset/not-found`）。
- 现在注册锚点回归宿主，预设目录内的**本地模块说明符**（`../.engine/*.mjs`）改在装配期换算为绝对 `file://` URL；换算只存在于内存注册定义，正本 `agent.cordis.yml` 保持相对，因此改 `DSH_HOME` 或复制整个预设根后按新位置重新换算。`configsDir` / `strategyDir` / `policyFile` / `triggersFile` 由引擎按 `import.meta.url`（`<预设根>/.engine/`）自解析，不参与换算。
- 取向与官方一致：`editing-cordis-compositions` 要求「Resolve assets from installed packages rather than a preset directory」，`!!js` 仅用于插件配置与 `disabled`（行 `name` 不做表达式求值）。
- 升级后需用户重启 DSH 服务生效；本轮未触碰用户 profile 与预设文件。

## 引擎复审、配置区与 DSH 0.1.7 适配（2026-09-22）

- 适配已发布 DSH `0.1.7-alpha.1`、Cordis `4.0.3`：ConfigForms 与 volatile 设置、显式预设注册、默认选择同步、工具预览 revision lease；官方组合和技能来源更新到 `c36a83ff6b`。
- 修复触发器文本条件、受众限制、压缩后时机、默认顺序与动作预算；声明通道/阶段校验以及黑白名单互斥在边界处明确拒绝不合法输入。
- 保存与运行时共用动作参数校验；预设注册保留历史兼容快照、可选名称及顶层排序。
- 配置编辑区统一顺序数字与官方位置快捷选择，快捷操作清除本字段错误草稿，位置严格早于官方区段；共享层设置分区和窄屏布局保留既有保存通道。迁移已退场能力的客户端验收。
- 升级后需要用户重启 DSH 服务；未操作运行中的服务或真实用户预设。

## 注入层权威性与官方装配刻度（2026-09-22）

- **否决型装配门控改由 `prepend` 取得最外层**：`system-prompt/assemble` 是 waterfall（由外向内、
  最外层监听器的返回值即最终结果），此前三类否决型门控只有「组合行序」这条**不成立**的保证——
  行应用是并发的，行序并不决定监听器顺序。现在位置由声明的 `waterfallPosition: outermost`
  表达（映射为 `prepend: true`），共四处：上下文清空、首轮目录窄化（两条）、名单掩码；协作式
  填充与纯副作用监听器保持普通注册。新增真实 cordis 反例
  `test/engine/assemble-authority.test.mjs`：先注册的 `prepend` 竞争者无法翻越门控；同为
  `prepend` 且注册更晚者仍可翻越——这是该保证的**已知上界**，用例如实钉住。
- **`order` 字段接入官方装配刻度**：只有 `system-section` 与 `runtime-context` 两层把 `order`
  交给官方 `section()` / `context()`，故只在这两层的 order 字段旁提供「插入到官方位置…」下拉
  （区段归纳：section 6 组 + context 1 组，共 7 个区段）。**数值一律运行期求得**：bridge 取
  `systemPrompt` 服务后逐名调用官方 `getSectionOrder` / `getContextOrder`，经 `/meta` 与
  `/bootstrap` 同源下发；任一组取不到有限数时整张表缺席并只告警一次。档位名分组由
  `src/shared/official-orders.ts` 手抄自 `@deepseek-ai/dsh-system-prompt@0.1.6-alpha.2`
  （section 33 项 / context 3 项），官方新增或改名时 `test/shared/official-orders.test.mjs` 先红。
  下拉只是快捷填值入口，数字输入仍是唯一真相与唯一写入通道；其余六层显示「不对应官方装配位置」
  说明，不展示任何档位数值。
- **新增可选的来源黑名单**：`pre-step-filter` 动作的 `blockPlugins` 按 `source.plugin` 做
  **大小写不敏感的精确等值**屏蔽（不做子串/正则/glob，要覆盖某插件须写全名）。默认不启用，
  未声明或空名单等于关闭；与 `sources` / `keepKinds` 正交可共存；`reject` 步原样透传，过滤
  自身异常时保留全部消息。**UI 与参数目录入口尚未接入**（按 2026-09-22 拍板延后），当前只能经
  预设顶层 `triggers` 段声明。

## 专用能力模块退场：触发器声明统一时机与可见面（2026-09-22）

- **删除七个专用能力模块**：`context-gate`、`tool-bootstrap`、`tool-filter`、`anchor-turn`、
  `deliberation-gate`、`progress-reminder`、`promoted-code-mode`，连同各自的组合源 yml、
  能力卡、一键配方（`ENGINE_RECIPES` 清空）与全部专属参数键一起退场。首轮窄化、
  来源过滤、工具名单、锚句、深思门与进度节拍改由预设顶层 `triggers` 段**声明**表达：
  `writePreset` 物化为 `<预设目录>/triggers.yml`，`declared-triggers` 行读入、编译并注册。
  声明由预设提供，引擎不带默认（文件缺失 = 没有声明，不注册、也不让预设挂载失败）。
- **机制统一**：判断面是 `when`（`phase` / `source` / `count` / `session` / `text` / `names`
  / `preset` 谓词与 `any` / `all` / `not` / `notAny` 组合），执行面是七类动作
  （`inject-text` / `assembly` / `decision` / `append-context` / `guard` / `sdk-strip` /
  `request-params`）；不再为每个能力写一个专用模块。
- **已作为声明迁移（不是放弃）**：`bootstrapMaxTokens`（首轮输出封顶）→ `request-params`
  动作的 `patch` / `unset`（与 `agent-request` 层同源，含按值释放）；`personaSectionsOnly`
  （首轮 sections 白名单）→ `assembly` 动作的 `target.sections.keep`。
- **净损失只有两项**：`stages` 渐进披露（多级阶段窄化、`phase_advance` 推进工具与阶段状态
  段——按拍板放弃，它只是触发器机制的一个应用，需要时可用「多条件 + 多触发 + 多动作」自行
  声明）；`promoted-code-mode` 的**「晋升后才呈现 PTC」时机特性**（PTC 呈现不再由晋升相位
  触发，需要 PTC 的预设直接装配官方 `tool-presentation` 行）。
- **未迁移项（尚未处理，未写声明；既不是「已迁移」，也不是拍板放弃的净损失）**：
  `workspaceLine`（晋升后给 persona 段追加工作目录行，幂等；`engine/tool-bootstrap.mjs:323-339`，
  调用点 `:415`）与 `phase1FirstCallInstruction`（受控相位给保留下来的段追加首调指令，幂等；
  `:439-444`）都要**改写已有段正文**，而 `assembly` 动作只能整段 `sections.add` / `remove` /
  `keep`（`engine/actions.mjs:386-391`）⇒ 两项都没有等价声明，待产品/引擎侧决定补哪种原语。
  另记一条已知边界：`request-params` 动作无条件走 `matchesAgentScope`（`actions.mjs:691`），
  未声明 `modelScope` 时按「非 Flash」隐式过滤（`engine/shared.mjs:117-120`），而原预算监听
  没有模型过滤（`tool-bootstrap.mjs:466-483`）⇒ **Flash 模型下 `bootstrapMaxTokens` 不等价**
  （对拍用非 Flash 模型，该分支未覆盖）。
- **连带精简**：能力卡从 11 张减到 4 张（`subagent-tool-policy` / `str-replace-editor` /
  `tool-config-engine` / `tool-git-bash`），共享参数从 71 个减到 30 个；`toolFilterAllow/Deny`
  与「主过滤下发子代理 `delegation.toolFilter`」的兼容通道整体删除（子代理工具面只由
  `subagentToolPolicy` 实例策略授权）；`instructionHint` 改由 `instruction-hint` 行承接。
- **SillyTavern `enable_web_search: false`** 改为产出三条声明（`assembly` 呈现剔除 +
  `sdk-strip` 裁 `tools:sdk` 正文 + `guard` 执行层拒绝，共用同一份 `deny`），在 PTC 下同时
  获得 SDK 正文裁剪与执行层拒绝（旧 `tool-filter` 实现没有这两者）。

## 字段声明与能力开关统一（2026-09-22）

- **字段声明取代手写白名单**：`run-code-env`、`tool-git-bash` 的配置键白名单与逐字段归一化改由 `engine/fields.mjs` 的字段声明（各模块导出的 `configContract`）派生；未知键、错类型、缺必填仍在挂载期 fail loud，逐字段的归一化结果与错误消息与迁移前逐字一致（含 `run-code-env` 为空数组与 trim 后为空的两条既有文案）。
- **`enabled` 统一为 fail loud 的能力开关**（本轮唯一行为变更）：非布尔值（如 `enabled: "yes"`）在这两个模块的挂载期抛 `enabled must be a boolean`；`run-code-env` 原本已如此，`tool-git-bash` 由此前的「行在组合里即启用」改为「显式 `enabled: true` 才注册」，其组合源 `engine/compositions/source/local/tool-git-bash.yml` 已补 `enabled: true`，既有装配结果不变。其余待收敛模块的开关语义在后续轮次随各自声明迁移。
- **`disabled:` 不是能力开关**：它只用于平台条件（如 `tool-git-bash` 的 `!!js process.platform !== 'win32'`）、树内子项与命名禁用变体（`tool-bash-disabled.yml`）；能力启停的唯一事实源是 `config.enabled`，UI 可管理的开关也只走后者。

## 引擎默认值下沉到模板/预设（2026-09-22）

- 可配置默认值不再内置引擎：锚定轮正文、深思门控拒绝文案、节拍提醒正文、锚句确认词，以及节拍间隔/深思下限/每轮上限/门控回退步数/阶段预放档/推进工具名与描述/阶段状态模板/shell 超时与输出上限/run_code 环境变量白名单，全部改由组合源 `engine/compositions/source/local/*.yml`（及各预设 `moduleConfigs`）提供；引擎缺必填键在装配时响亮失败，显式空文本表示该能力不注册。
- 开关语义统一为「未声明 `enabled` = 关闭」：`anchor-turn` / `deliberation-gate` / `progress-reminder` / `tool-filter` / `run-code-env` 由此前的默认开启改为按组合源显式 `enabled: true` 开启；`context-gate` 同规则（组合源已显式开启，既有装配行为不变）。
- 移除 `we` 字面兜底：`custom-fallback` 策略与物化 `prompt-injector` 时都不再回退到 `we`，空值即不做词确认（只走未命中兜底注入）；确认集合仍从锚句文本自动派生。
- placeholder 的 `envKeys` 白名单与 skill-catalog 空结果文案同样归配置；安全边界常量（敏感环境变量正则、自定义工具环境变量白名单、http 执行器超时护栏）与官方扩展点语义缺省保留在引擎内，不下沉。

## 本层共享设置去掉卡片底色（2026-09-22）

- 「本层共享设置」不再套中性底色加内边距的卡片外观，与「高级元数据」共用同一 details 行样式；默认折叠、展开才渲染内容、同层多卡同源同步的行为不变。系统提示段这类把主要设置放在共享区的层，得到与高级元数据一致的紧凑观感。

## 去重模型入口与层内模板入口（2026-09-21）

- 「主模型」通用参数分组退场：`main-model` / `subagent-model` 这类已有专属编辑器的组不再进 `layerParamCards`，代理请求层与子代理启动层只保留模型路由卡这一个模型编辑入口（同一批字段不再渲染两遍）。
- 层设置区顶部新增「插入本层模板」入口（`data-layer-insert-template`），与顶部九层模板菜单共用同一个浮层与按层过滤；页面未注入回调时不渲染。
- 新增 `templates/75-subagent-end.yml`：子代理结束层此前没有任何模板，该层在引擎里只观察不注入（命中仅留一条 observe 记录），模板默认关闭，注释写明这一点并指向 66-subagent-start 做真正的注入。

## 参数在 ⇒ 装配在（2026-09-21）

- 预设 `params` 里出现登记参数键、或 `moduleConfigs` 里出现能力行键时，装配入口（`loadCompositionText`）与模块事实（`resolvePresetModuleFacts`）用同一份派生 `impliedModulesForParams` 自动补齐对应模块：`effectiveModules` 与编辑卡如实反映，`declaredModules` 仍是磁盘事实，组合源自带默认值不算信号。参数存在的能力不再出现「参数写了、运行时却不生效、编辑卡也消失」的休眠状态。
- 「移除能力」相应改为完整移除：模块声明、该能力的显式参数与行配置（拥有顶层数据段的能力连数据段）一起删除，重复删除仍幂等；未登记的自定义键与其他能力的数据不动。

## 关联开关与层内创建（2026-09-21）

- 已有主功能开关与子代理参与开关的能力统一同排：主开关在左、子代理开关在右，键盘顺序与视觉顺序一致；其余参数顺序、开关独立保存和字段集合保持。
- 顶部创建菜单只保留九层注入模板；能力模块、连锁组合、自定义工具与工具模板、变量创建内置对应层设置。空层与空资产保留可达入口，两页共用同一套归属与只读规则。

## 本层引擎设置界面整理（2026-09-21）

- 设置内容占满实例卡宽度，参数按具名分组呈现；短控件在宽面板双列，长文本、列表和阶段配置整行，640px以下容器改为单列。
- 能力名称与移除动作独立对齐，移除按钮具备明确可访问名称；资产沿用自己的标题，减少重复层级。保留搜索隐藏、默认折叠、只读与原有保存语义。
- 阶段工具输入的DOM标识包含设置实例身份，同层多实例不再产生重复标识；真实CSS回归覆盖宽窄布局、键盘展开和就地校验。

## 九层计划复审修复（2026-09-21）

- 投递去重缓存区分 `plugin` 与 `kind` 身份，与持久恢复保持一致；官方系统段组装不提前执行尚未通过前置步骤资格判断的 ST 模板。
- 受管字段按 writer 最终合并分支记录来源；显式局部覆盖仍可编辑，投影字段指向预设参数，来源元数据不进入可写定义。
- 工具创建由常驻页面立即写入共享草稿，连续创建与切页不丢失，不受设置区折叠控制；半成品仍由用户显式保存。
- 统一搜索接入真实层设置，支持中文参数名、技术键与能力名；有实例保留承载卡，无实例显示不写盘的设置入口。设置匹配不扩大批量启停范围。
- 只读预设的模板变量与预设模型不可修改，当前会话模型选择仍独立可用；无设置层不生成空壳，变量折叠立即生效并保留。

## 引擎设置并入注入层实例卡（2026-09-20）

### 形态变化

- **独立卡片退场**：工作台不再渲染能力卡、提示词生成默认值卡、工具管线共享设置卡，
  以及人设、模板变量、模型路由、委派深度、自定义工具、子代理工具策略这些单例卡。
- **引擎设置嵌进实例卡**：每张提示词配置实例卡的表单里新增默认折叠的「本层引擎设置」区，
  内含该层参数分组（只列确实装配的能力与不依赖装配的专用编辑组）、已装配能力清单
  （含二次确认的移除入口）与该层归属的资产编辑器；同层多卡显示同一份值，任一处修改同步。
- **无实例卡层的兜底容器**：工具链层这类通常没有提示词配置卡的层，用一张**不写盘**的
  「本层引擎设置」容器承载同一份内容（不创建配置对象、不触发保存）；该层出现实例卡后设置
  也出现在卡内。
- **两页只剩受众视图**：`engineLayerSlots` 返回 `renderLayerSettings` / `hasLayerSettings`
  两个注入点，`MainSessionPage` / `SubagentPage` 不再拼装任何单例卡，也不再注入能力卡插槽。

### 保持不变的语义

- 引擎运行时行为、九层顺序、参数缺省与空值语义、bridge 载荷与写盘边界均未改变。
- 提示词配置实例卡保持多实例、平铺、排序/拖拽/批量启停/搜索与保存语义。
- 未完成输入与错误态的跨渲染点同步沿用既有草稿广播通道；同层多卡的镜像控件 DOM id
  带「层 + 卡身份」，互不冲突。
- 对子代理不生效的能力（如 `tool-filter`）连参数与装配条目一起不进子代理页设置区。

## 九层编辑面补齐：统一装配、统一搜索与受管字段来源（2026-09-20）

### 九层编辑面

- `EngineLayersPanel#engineLayerSlots` 成为层内卡片的唯一装配入口：页面只声明受众视图、搜索词
  与页面编排，`beforeCards` / `commonCards` / `moduleCards` 三个片段由该函数产出；单例卡
  （人设、模型路由、模板变量、工具与深度、自定义工具）与能力卡共用「层归属 + 搜索词」两段可见性
  判定，页面不再各自手写层名。
- 工具管线共享设置区按真实能力 card 分八组渲染参数：六个本层能力组（工具过滤、工具呈现、编辑器、
  深思门、执行后提醒、工具配置）加两个登记的跨层相关设置（首阶段工具目录、子代理授权）。
  参数键仍由 shared 定义派生，镜像控件的值与草稿键与能力卡同源，一次修改只保存一次。

### 共享参数的同步语义

- store 新增 `getDraftRevision` / `subscribeDrafts` / `publishDrafts`（既有 `subscribeFields`
  同一模式的窄广播，草稿本身仍只有一份）；参数控件改为从共享草稿派生并订阅，未完成的数字输入与
  字段错误在两处渲染点实时同步，一次失焦只提交一次保存。真实 Edge smoke 覆盖两处渲染点的半成品
  同步、错误播报、单次保存与迟到响应不覆盖新编辑。

### 统一搜索与层空态

- 搜索词由页面持有并同时下发给列表与层装配：配置实例按标识、名称、枚举中文标签与局部参数键匹配；
  能力卡与共享设置区按能力 id、参数键与 `param.<键>` 中文标签匹配，共享设置区还按分组标题匹配。
  过滤只影响展示，不写盘、不改写保存载荷。
- 选中注入层且该层没有内容时显示层空状态与新增入口，不再当成「无匹配」；`world-book` 策略视图
  保持原有的无匹配 + 清除筛选语义。

### 受管字段来源

- 新增 shared 契约 `managed-config-fields`：登记 `near-anchor` / `router-guide` 被 `writePreset`
  覆写的字段与其唯一来源参数（含计算结果与缺省跟随语义）。实例卡渲染只读来源面板
  （字段中文名 · 来源参数键 · 当前生效值 · 派生标注），不再只给一句提示，也不留下会被重建覆盖的
  写入口；普通自建策略配置仍可编辑自己的局部 params。

### 规模回归

- 合成 184 卡（pre-step 120 + system-section 64）覆盖：渲染数量与身份、层内 order 顺序、
  复制/上移/启停/删除只作用于目标实例（其余实例保持同一引用）、同名局部参数不串值、切层与受众
  切换不丢草稿。
- host 侧 184 卡保存往返：数量、身份、顺序与未修改字段逐条保真，文档注释与未知顶层键保留，
  二次编辑只替换 `promptConfigs`。

## 引擎缺陷修复与九层编辑归属契约（2026-09-20）

### 引擎修复（R6—R8）

- **自定义策略真正生效**：`strategyDir` 在引擎入口统一解析为绝对 URL，相对写法不再让整行挂载抛 `ERR_INVALID_URL`；
  runtime-context 的模板专属策略与 placeholder 一样注册成函数 provider 并按 assembly 调用 resolver，模板模块
  抛错只让该条为空并告警，不再出现「配了没效果也不报错」。
- **深思门适配当前宿主**：深度代理从已撤销的 `assistant/chunk` 改为 durable `turn/start`（建立每轮预算）+
  `assistant/message`（只读 `message.content`，不读同一事件的 stream delta，避免双计）；冷扫与实时共用同一个
  事件处理函数，重启前后判定一致。
- **阶段目录保留推进工具**：渐进披露的 keep 集合加入本模块注册的 `stageAdvanceTool`，注册、`{{advanceTool}}`
  提示与目录裁剪同源；它不参与阶段工具缺失校验，被外层策略挡掉时不复活，也不触发「缺失即放开完整目录」的降级。

### 九层编辑归属与参数闭环（T12、T13）

- 引擎 `LAYER_ORDER` 成为九层顺序唯一权威，`getEngineMeta()` 下发 `layerOrder`；共享契约新增 `EngineLayer`、
  `ENGINE_LAYER_ORDER` 与 `ENGINE_EDITOR_GROUP_MAP`（能力组 + 专用编辑组的主归属与 `relatedLayers`），
  `/meta` 与 `/bootstrap` 只下发可序列化白名单字段，前端对旧宿主缺字段退化到共享层序。
- 七个锚定/引导内容键（`buildPattern`、`complexPattern`、`firstTurnBuild`、`firstTurnInspect`、`firstTurnDeep`、
  `guideWeak`、`guideDeep`）并入共享参数定义，旁路键清单只剩 `promptConfigs`；新增 `pattern` 值类型按
  `new RegExp(value, 'i')` 在写盘前拒绝非法正则，读回、脏检测、中英词条随现有派生链生效。
- 角色卡合并写盘复用共享层序，删除 `src/host/characters.ts` 里的第二份九层清单。

## 会话 id 来源修复与官方依赖对齐（2026-09-18）

- 官方 `0.1.6-alpha.2` 删除了 `SessionListState.current`（当前选中会话移出 Session Controller），客户端 `currentSessionId` 因此恒为 `undefined`：工作区指令文件卡整体不可见、不可写，模型选择卡 `selectable` 恒 false，预设切换恒返回未应用。
- 当前会话 id 改由 `ctx.uiSession.adapter.current` 的作用域绑定读取（`scopeOf(binding.ctx)`，退化用绑定的作用域 `key`），不再依赖已删除字段；类型上也不再自行声明官方字段，官方再次变动时类型检查会报错而非静默降级。
- 宿主侧读取放宽：拿不到会话工作区时回退部署进程 cwd，并如实标记 `source: deploy-cwd`，工作区指令文件卡不再凭空消失；**写通道白名单不随之放宽**，回退不构成写授权。
- 漂移根因：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 只放行了 `alpha.1`，pnpm 最小发布年龄机制因此拒绝安装 `alpha.2`，开发依赖被长期钉在旧版本。该清单已随升级更新，并补入 `dsh-client-store`／`dsh-client-ui-session`／`dsh-skill-filesystem`。
- 开发依赖对齐运行时实装版本（26 个官方包升到 `0.1.6-alpha.2`），并补上三处此前未声明的依赖：`@deepseek-ai/dsh-client-store`（session-controller 的类型声明引用了它却无人声明，配合 `skipLibCheck` 使类型检查对快照漂移永久失效）、`@deepseek-ai/dsh-client-ui-session`、`simple-icons`。
- 新增防复发回归：以官方真实快照形状（不含 `current`）构造，断言仍能取到会话 id。

## 导入导出模块化（2026-09-18）

- 原生 JSON/YAML、ST 来源、PNG、文件夹与 ZIP 共用内容识别和预览；原始上传不再直接入库。
- 安装先完整校验并物化候选，保护正文、自有模块和兄弟预设；目录身份、复制 ID 和目标版本统一检查。
- 角色更新保留记忆与用户文件；原生片段支持自包含配置，自动记忆具有独立来源证明。
- Web/CLI 共用 ZIP 与定义导出，拒绝越界、链接、损坏和超限；分享时排除可核验自动记忆，历史歧义须明确选择。
- 共用导入面板覆盖来源、目标、资源、覆盖确认、过期重预览和批次控制；导出显示范围与依赖限制。

## 0.8.0 明细 · 2026-09-17

### 预设直接命名与技能完整性修复（2026-09-18）

- 包内预设统一 `pt-*` 目录与 id，初始化按目录独立补建；已存在的定义与资源保留。删除运行时官方占用探测、模板名反查与复制后改名。
- 保存使用当前预设自身定义；启动同步宿主实际默认，避免界面编辑的预设与新会话挂载不同。
- 技能导入整批验证标记和路径，剥离浏览器容器外壳。同名先列出冲突，确认后只覆盖授权目录；成功不积累内容版本，失败同时恢复覆盖项和清理新增项。
- 新建失败只清理本次目录；引用目录保存不再误比 JSON 与 YAML；调用策略写入统一官方键并保留注释与正文。
- 技能遮蔽标记采用当前会话真实注册表结果，文件事件直接失效候选；TUI 展示和查找统一声明名。
- 角色卡模块来源保留到最后消费者移除，共用模块的回退不再依赖移除顺序。
- 增加真实 handler、registry、filesystem provider 与浏览器确认回归；修复浏览器端口文件写入期间的 EBUSY 等待竞态。

### 创造模式对齐官方命名（`creative` → `cordis`）与官方保留名表（2026-09-18）

- **模板对齐官方命名**：包内模板 `preset/creative` 改名为 `preset/cordis`（`id: cordis`，`skills/` 随目录移动）。
  官方那个「创造模式」预设的 id 就是 `cordis`，改名后本地模板与官方同名，`rebuild:composition` 的
  `cordis → creative` 目标覆盖表随之取消，官方 `cordis` 的行改为逐行拆解。
- **官方语义保留名表**：`cordis` / `minimal` / `ptc` / `standard` / `creative` 一律视为保留名，与运行时探测、
  宿主服务结果取并集 ⇒ 种子化与工作台「新建」在创造模式模板上产出 **`pt-cordis`**
  （与 `pt-standard` / `pt-ptc` / `pt-minimal` 同族命名）。
- **生成物 id 收口**：种子化与「新建」复制后同步把 `preset.yml` 的 `id` 写成目标目录名，消除目录名与 id 不一致
  （此前 `pt-standard/preset.yml` 里仍写着 `id: standard`）。
- **补建保护**：补建循环遇到目录名属于保留名的旧目录时跳过并告警，不再让一次白写中断其它预设的重建；
  宿主服务就绪后拿到更全的占用集合时会补建缺失的安全副本。
- **官方漂移同步**（`dsh-0.1.6-alpha.2`，`ddefc45f`）：`cordis` persona 新增四段（`plugin_manager` 用法、Creator 模式下的
  UI 插件目标、`cordis_inspect_*` 只读探查、MCP server 与 installed bundles 约定）；`standard`/`ptc`/`cordis` 末尾新增
  `tool-plugin-manager` 行（前两者 `disabled: true`）；`cordis` 两个技能正文精简。新增库模块 `tool-plugin-manager`
  与 `tool-plugin-manager-disabled`，引擎快照与 `test/fixtures/dsh/current` 离线快照（含 PROVENANCE 指纹与来源提交）同批更新。
- **用户数据**（不入库）：本机 `.agent-presets/creative` → `pt-cordis`，四个 `pt-*` 预设按新模板重物化，
  默认预设切到 `pt-standard`。

### 预设 id 安全化：与宿主内置预设重名时自动落到 `pt-` 前缀（2026-09-18）

插件生成的用户预设不再可能落在「被宿主内置预设遮蔽、永远不会被挂载」的 id 上：

- **根因**：宿主 agent-presets 的发现根顺序是「shipped（内置）根 → 配置根 → 用户根」，**靠前的根赢同名 id**，
  用户预设根里与内置同名的目录永远不会被挂载。本机的 `standard`/`ptc`/`minimal` 三个目录正因此长期失效——
  连角色卡的 4 条 `chara-ponytail-*` 注入配置一起静默失效（解压最近 24 个会话取证：`system/message` 全无注入正文）。
- **默认值**：激活预设默认 id 从 `standard` 改为 `pt-standard`（插件 config 与客户端 Fields 默认值同源，
  `shared/preset-ids.ts#DEFAULT_PRESET_ID`）。
- **生成路径**：首次种子化（`ensurePresetSeed`）与工作台「新建」（`cloneBuiltinPreset`）在模板名被内置占用时
  生成 `pt-<模板名>`，bridge 返回实际 id 供界面显示；`writePreset` 的输出目录命中占用集合时 **fail loud**，
  不再静默产出永不挂载的目录。
- **激活路径**：runtime 的 `presetTemplate` 在首次加载、settings 变化与工作台切换时归一化；命中占用即改写为
  安全 id，写回插件 settings、同步宿主 `agent-presets.default` 并重建生成物。
- **模板名与输出名分离**：`writePreset` 早已支持 `outputId`，本轮才真正用上——`pt-standard` 输出仍渲染包内
  `standard` 模板，包内模板目录与既有用例不受影响。
- **占用探测**：以宿主 `agentPresets.settings()` 的 `trust === 'system'` 为准；服务不可用时用
  `profiles/**/node_modules/@deepseek-ai/dsh-agent-presets/presets` 的目录名兜底；两者都不可用则不避让（旧行为）。
  只读 id 名，不读其他部署根的预设内容。
- **测试**：新增 `test/host/preset-id-safety.test.mjs`；`user-presets` / `write-preset` 各补行为用例
  （种子化与新建落到安全名、空占用集合时行为不变、输出撞名不写盘、模板名与输出名分离）。
- **未做**：工作台遮蔽标记与存量撞名目录的自动迁移/清理（用户明确不要标记；存量目录另行确认后清理）。

### 技能停用改为文件层调用策略（2026-09-18）

「技能停用」从注册层屏蔽改为改写技能文件自己的调用策略键——**因为注册层屏蔽在本插件的真实装配下不生效**：

- **根因**：官方注册表按 `[全局层, ...scope 链]` 依次合并、**最近层无视优先级直接胜出**；官方 `dsh-skill-filesystem`
  由预设的常驻组合挂在预设层，而本插件的提供方在 profile 全局层，rank 0 的影子候选必然被预设层候选覆盖。
  在运行中的 DSH 上真机验证：写入两端屏蔽记录后，会话的技能目录仍列出该技能。
- **停用语义**：改写该技能 `SKILL.md` 的官方两个键（模型端 `disable-model-invocation`、用户端 `user-invocable`），
  两端独立控制；恢复写显式 `false` / `true`。只用 yaml Document API 改这两个键，注释、未知字段、其余键与正文逐字
  保留；内容无变化不落盘，写盘先同目录暂存再原子 rename，失败时原文件逐字节不变。
- **状态文件升到 v4**：`skills/.system/prompt-tool/skills.yml` 只保留引用目录 `folders`；v3 的 `blocked` 屏蔽表弃用
  （读取时忽略、写入时删除并把版本抬到 4，其他版本号仍拒绝）。
- **写入范围与边界**：调用策略对所有来源可写（写的就是该技能自己的文件）；只读来源、符号链接目标、无 frontmatter
  的技能会如实报错而不是静默失败。`/skill-block` 端点改为 `/skill-policy`，并新增身份校验——提交的 `path` 必须命中
  服务端当次扫描的同名条目，否则 409，界面加载后被替换过的同名技能不会被误改。
- **界面**：徽章与开关文案改为「改写该技能 SKILL.md 的 frontmatter」，不再宣称注册层语义；两端都不可用才置灰。
- **测试**：新增 `test/host/skills-policy.test.mjs`（写入行为与全部拒绝条件）与 `test/host/skill-policy-e2e.test.mjs`
  （写入后真实注册表候选的调用策略随之变化）；删除已无对象的 `test/host/skill-block-shadow.test.mjs`；技能相关用例
  与客户端 fixture 一并改为调用策略事实。

### 角色卡模块按需装配与回退（2026-09-18）

把「类角色卡」注入任意预设时不再固定追加四件套模块，改为按卡的实际需要装配，并让移除对称回退：

- **装配由卡与内容决定**：卡顶层 `modules` 声明优先（ST 转换产物自带六件套声明，ST 卡行为不变）；未声明时只补必需项——
  `prompt-config-engine` 始终补齐（缺失会让 `promptConfigs` 静默失效，此前无人检查），卡含 `world-book` 策略配置时补
  `world-book-tools`。手写纯文本卡（例如 ponytail 规则卡）因此只得到 `prompt-config-engine`，不再被塞进
  `session-var-tools` / `tool-config-engine` / `tool-filter` 等用不到的模块。
- **来源可追溯**：应用时把「本次由该卡新增的模块」差集写进 `meta.characterModules[<卡 id>]`，重复应用与已有记录求并集；
  预设原本就有的模块不会被记成卡引入的。
- **移除正确回退**：按记录回退模块，回退前检查消费者——其他已导入卡仍引用（各自的记录或 `converted.yml` 声明），
  或预设内容仍需要（还有 `promptConfigs` / `world-book` 配置 / `params.stMacros` / 顶层 `customTools` /
  非空 `toolFilterAllow|Deny`）时保留。改造前应用过的老卡没有记录，移除时不回退，宁可留下模块也不误删。
- **ST 导入路径不变**：`convertStToPreset` 仍按 ST 语义写入自己的模块清单（宏与状态变量确实需要变量通道），
  两条路径的差异见 `docs/SillyTavern.md`。
- **回归**：`test/host/characters.test.mjs` 新增 9 条用例（纯文本卡零追加、声明优先、世界书自动补、回退与记录清理、
  两张卡共用模块不夺走、预设自带模块不动、`tool-filter` 消费者保护、重复应用与移除幂等、判据纯函数）。

### 第四轮审查修复（2026-09-18）

对第三轮改动做完整审查（含 13 组变异实验 + AST 级断言检查）后的修复：

- **回归保护补齐**：新增 `test/host/skills-candidates-refresh.test.mjs`，用真实 `SkillRegistry` + 插件
  provider + 真实 reloader + 真实引用目录做端到端验证（新增技能、改写描述、删除技能三种变化，并带
  「不失效候选就看不到」的负向对照）；补覆盖导入中途失败的回滚用例（已进回收站的旧技能必须放回）。
- **指纹判据加强**：判据加入 `ctimeMs`（`utimes` 改不动它），修掉「等长改写 + 还原 mtime」导致的漏失效
  —— 这个问题在做端到端用例时真实复现过。
- **失效不再有盲区**：状态文件读失败的窗口里，引用目录的变化同样会让候选缓存失效（此前该分支提前返回）。
- **失败可诊断**：覆盖导入回滚把「技能未放回原处」与「回收站残留空容器」分开报告，不再让用户去找一个
  其实已经恢复的技能；watcher 无法监听某个目录时报告一次（此前静默跳过，覆盖不完整对调用方不可见）。
- **提示不再丢语境**：导入失败提示恢复「导入技能目录失败：」类别前缀，并剥掉服务端已有的同义前缀、
  对空串兜底——空串会让通知整条不渲染。
- **清理**：`trashSkill` 自带目录名校验并去掉无人读取的返回字段；6 个测试 stub 删除已从契约移除的
  `invalidateCatalog`；`skills-import` 测试改从 `src` 导入；开关语义抽成可单测的 `scopeAfterToggle`
  并补往返用例；修正三处注释（`Math.max` 的下溢方向、`blockScopeFor` 的参数含义、rank 并列的判据）。

### 第三轮审查修复（2026-09-18）

对第二轮改动做完整审查（含变异验证）后的修复：

- **修复回归：引用目录里的技能现在能进模型侧候选**。第二轮把缓存失效拆成「清单」与「候选」两级时漏了
  一条路径——引用文件夹里新增 / 删除 / 改写技能不改变状态文件快照，于是官方注册表的候选缓存永不失效，
  界面能看到新技能而模型看不到。现在候选缓存按「状态快照 + 引用来源指纹」判失效，两者任一变化都重扫。
- **状态文件消失不再静默**：文件被删除或移走时按用户重置处理，但会留下一条告警（此前不声不响清空）。
- **覆盖导入的回滚更稳**：单条回滚失败不再中断其余条目，失败消息同时保留原始原因与需要手动恢复的路径；
  回收站容器创建失败会自我清理，不留「只有 record.json」的空条目。
- **回收站记录统一**：删除与覆盖导入共用同一个 `trashSkill`，字段统一为 `folder` / `source` / `origin` /
  `deletedAt` / `files`（此前导入条目用 `at`，删除条目没有 `origin`）。**注意**：第二轮之前由覆盖导入写入的
  历史回收站条目用的是 `at`，插件不读取回收站记录、也不做迁移，这些条目仍可人工恢复，只是时间字段名不同。
- **指纹包含文件大小**：保留 mtime 的复制或还原不再让清单漏失效。
- **清理**：`blockedCandidate` 去掉无人传入的形参、`get()` 去掉不可达的兜底；`invalidateSkills` 声明提前；
  去掉与用户技能根重复的递归监听；删除 settings-bridge 里零调用的 `invalidateCatalog` 依赖与
  无消费者的 `degraded()` 访问器；导入失败提示不再叠两层前缀。
- **回归测试**：刷新装配新增「引用目录指纹变化」与「状态文件被删除」两条；rank 并列补到三个元素
  （删掉排序次键时正序与反序都必须失败）；指纹降级取值改为精确断言；上传入口补回收站断言；
  新增 `trashSkill` 失败清理用例与扩展字段回退优先级用例。

### 第二轮审查修复（2026-09-18）

对上一节改动做第二轮完整审查后的修复：

- **覆盖导入不再永久删除旧版本**：`/skills-import` 与 `/skills-import-directory` 覆盖同名技能时把旧目录
  移入回收站（记录 `origin: import-overwrite`），结果返回覆盖数量，成功提示如实说明——批量导入没有逐项
  确认，被替换的旧版本必须仍可人工恢复。
- **六类技能根的变化都会被看见**：清单与候选缓存改用根指纹（目录集合 + 标记文件时间）判失效，在用户根、
  项目根、agents 根、内置根或引用文件夹里手工增删技能后下一次读取即反映；watcher 也补上了用户根、
  agents 根与内置根（项目根随工作区变化，由指纹兜住）。
- **状态读失败不再清空设置**：读取失败时保留上一次有效状态、只告警一次，文件修好后自动恢复。
- **「两端不可用」页签覆盖完备**：技能自身声明两端都不可调用时不再只出现在「全部」。
- **屏蔽开关**：忙期点击给出提示（不再静默丢弃），界面 busy 改为并发计数，避免一个操作结束就提前放开开关。
- **协议与死代码清理**：删除无消费者的 `skillsDirExists`（含 settings 字段）、describe 里的 `skillBlocked`
  下发，以及 `SKILL_SOURCES` 的中文 label——来源标题的唯一真相是字典。
- **回归测试**：刷新装配改用真实状态文件 + 真实 watcher 实测（含坏文件降级与恢复），补 rank 并列、
  内置根缺省负向、影子 rank 装配、文件夹引用失败恢复路径与根指纹用例。

### 注册层屏蔽的审查修复（2026-09-17）

对「注册层屏蔽」一轮做完整审查后按结论逐条修复：

- **安全修复：导入来源必须是绝对路径**。`/skills-import-directory` 之前只校验 `path` 是字符串，空串落到
  `path.resolve('')` 会退化成**进程工作目录**——实测会把整个 cwd（含任意可读文件）复制进用户技能根，
  成为一个可被模型加载的技能。现在端点与实现两层拒绝空、纯空白与相对路径，拒绝时不读盘也不写盘。
- **引用目录变化会刷新清单**：watcher 同时监听状态文件与引用文件夹，之前「状态快照没变就提前返回」
  让引用目录里新增或删除的技能永远留在清单缓存里；现在任何文件系统事件都失效缓存，只有状态变化才重挂 watcher。
- **「已停用」只收两端都关的技能**：只关模型端的技能之前会同时出现在「用户」与「已停用」两个页签；
  状态徽章也按端区分（模型端已停用 / 用户端已停用 / 已停用）。
- **技能页文案全部走字典**：来源分组标题与来源筛选不再直接使用共享常量里的中文标签，英文界面不再出现中文。
- **屏蔽开关并发**：写盘期间置 busy 并忽略重复提交，避免连点两次都用旧状态重算整个 scope 后互相覆盖。
- **清理**：移除客户端里与服务端载荷不符且无人消费的 `skillBlocked` / `skillsRootExists` 字段、孤儿字典键
  与孤儿样式；`settings-bridge` 的错误类改为显式字段赋值（构造器参数属性会让 Node 的 strip-only 类型剥离
  直接拒绝加载该文件，测试只能依赖构建产物）。
- **回归测试**：新增 `test/host/skill-block-shadow.test.mjs`（真实 `SkillRegistry` 验证影子候选压过官方六档、
  按端调用标志、`get()` 不返回正文，并带 rank 250 的负向对照）、`test/host/skills-scan.test.mjs` 与
  `test/host/skills-refresh.test.mjs`；同时修掉多处恒真断言（缺失的 `indexOf` 锚点、快照键存在性、
  bootstrap 空值自证、语料守卫过弱）。

### 技能管理改为「注册层屏蔽」（2026-09-17）

技能管理**整体替换**上一节的受管实体库模型（契约见 [docs/skills-management.md](docs/skills-management.md)）：

- **实体留在原地**：技能继续放在官方各自的技能根里（项目 `.dsh/skills`、项目 `.agents/skills`、
  已添加的技能文件夹、`$DSH_HOME/skills`、`~/.agents/skills`、官方内置），插件不搬迁、不建链接、不建实体库，
  **不改任何 `SKILL.md`**。
- **停用 = 注册层屏蔽**：插件提供者为被停用的技能名返回一个 rank 0、模型与用户调用同时关闭的影子候选，
  官方候选在同层合并时被压掉——模型目录不列、`skill` 工具拒绝、`/名称` 也不可用；删除记录即恢复。
  已知限制：屏蔽按技能名全局生效，同名技能在任何工作区都会被一起压掉。
- **管理页重构**：按来源分组展示全部技能，标注来源优先级、调用状态与「是否被同名技能遮蔽」；
  单开关停用/恢复；新增创建、两种导入（宿主机目录复制 / 浏览器文件夹上传）与**技能文件夹引用**（只登记路径，
  不复制文件，按自定义来源优先级注册）；回收站删除只作用于用户技能根，整个目录移入
  `.system/prompt-tool/.trash/`。
- **移除**：排序与「技能排序基数」（插件不再控制注册顺序）、一键修复、受管实体库与目录链接，
  以及 `/skill-fix`、`/skill-toggle`、`/skills-config`、`/skill-policy` 四个端点。
- **模型与用户两端独立屏蔽**：`/skill-block` 接受 `scope`（`all` / `model` / `user` / `none`），技能页每行
  两个开关——只关模型端时用户 `/名称` 仍可用，只关用户端时模型仍可加载，两端都关才是完全停用。
  界面上的状态徽章始终显示技能自己的 frontmatter 声明，插件屏蔽只体现在开关上（技能文件一个字节都不改）。
- **不再内置任何技能**：移除包内 `skills/` 目录（原 `sandboxmod`、`web ui`）与发布清单里的 `skills` 条目，
  同时删除旧的安装副本账本 `.prompt-tool-manifest.json`（本机若仍存在可直接删除）。技能一律由你创建、
  从目录复制导入或添加文件夹引用；插件不再有安装副本、内容哈希账本或自动更新。
- **状态文件**：`$DSH_HOME/skills/.system/prompt-tool/skills.yml`（`version: 3`，只含 `blocked` 与 `folders`），
  Document API 写入保留注释与未知字段，损坏或含别名时拒绝覆盖。
- **迁移**：上轮的实体库迁移用 `node scripts/migrate-skills.mjs --rollback "<备份目录>\migration.json"` 回滚；
  该脚本不再是运行时代码。

### 技能实体库与链接管理（已被上一节取代）（2026-09-17）

技能管理改为**单一受管实体库**（契约与迁移步骤见 [docs/skills-management.md](docs/skills-management.md)）：

- **实体集中在 `$DSH_HOME/skills/.system/`**，启用项通过该根下的目录链接（Windows junction）暴露；
  `skills.yml` 成为启停、顺序、rank 基数与调用权限的唯一管理来源（`version: 2`）。
  **完全停用只取消链接**，实体、资源与调用策略全部保留；`SKILL.md.disabled` 方案废弃，
  不再读取、不转换、不创建。
- **模型 / 用户调用权限**各自独立开关：写 YAML 并同步实体 frontmatter 的
  `disable-model-invocation` / `user-invocable`，正文、未知字段与注释保持；外部工具改动这两个字段后
  按 YAML 恢复并各提示一次偏差。
- **管理操作**：新增创建（标准 frontmatter，默认启用）、回收站删除（只移动 `SKILL.md` 到
  `.system/.trash/`，实体目录保留）、宿主机目录导入与浏览器文件夹导入（一次性复制，不再保留目录引用），
  列表新增**来源筛选**；外部目录不再是第二发现根。
- **稳定身份贯穿**：目录/调用/选择/开关/修复/删除/拖拽一律按受管 `id`（相对 `.system` 的路径）定位，
  注册给模型时按 frontmatter `name` 去重；技能顺序与 rank 与设置同属一次保存，
  技能通道失败时技能字段保持 dirty。
- **包内 `skills/` 不再自动同步或按内容哈希回滚**：它是用户可显式导入的资源；`.prompt-tool-manifest.json`
  账本不再写入，也不删除既有文件。
- **一次性迁移** `scripts/migrate-skills.mjs`：默认只读预览，`--apply` 先完整备份再搬迁实体、写 YAML、
  建链接（含嵌套子技能各自的根链接），`--rollback <migration.json>` 校验哈希后复原。
- **缺陷修复**：单个未定义 YAML 别名不再中断整批扫描；缓存签名覆盖完整相对路径；
  watcher 同时监听实体库与状态文件；写盘统一走跨进程锁与可回滚事务（`.system/.skills.lock`）；
  技能身份允许 `constructor` / `prototype` 等 `Object.prototype` 上的名字（真实技能库存在 `prototype` 技能，
  旧黑名单会让整库读不出来），记录容器改为无原型对象，仅 `__proto__` 仍被拒绝。

### 删除入口视觉统一（2026-09-17）

- **预设卡删除按钮**改为与角色管理页同款的垃圾桶图标按钮（`IconTrashOutline16` + 图标按钮形态，
  含 `aria-label`「删除预设：{name}」），不再是卡片底部的文字胶囊；「使用中」禁用与二次确认流程不变。
- **危险按钮统一为「描边染红」**：所有 `data-danger` 按钮共用同一形态——透明底、error 混色的文字与描边，
  hover 时描边加深并带极淡红底（`.pillButton[data-danger]`）。
- **删除确认对话框**（预设、角色卡、能力、配置等共用 `ConfirmDialog`）的「确认删除」改为与「取消」
  同一个 `.pillButton` 胶囊（尺寸、圆角、字号、描边一致），只以 `data-danger` 区分主次。
  此前确认按钮走官方 `Button variant="outline" data-danger`，而官方 Button 没有 danger 变体，
  渲染结果既不染红，也与取消按钮不同高。人设卡的「移除」按钮同样从无效的官方 `Button data-danger`
  换成本地胶囊，全项目不再存在「看着危险、实际不染红」的按钮。

### ab2c5e1–21e8761 全量审查修复

- 预设目录整体预览和提交，保留附件与多 JSON 合并；换组重预览期间取消能失效迟到响应。
- 子代理策略标签直接失焦会保存最新值；保存响应只确认对应快照，再次失焦的修改串行落盘，失败保留草稿；重新启用复用共享可用骨架。
- 子代理页接通受控筛选和新卡展开定位，工具管线正确显示策略等本层能力。
- 世界书递归预算包含延迟层级推进；空宏副键保留未命中约束；诊断不再混入普通提示词的 committed 记录。
- 历史子代理策略继续保留既有授权，能力卡显示实际装配；创建或保存补齐声明，删除同时清除策略。修正此前“模块声明是唯一开关”的不准确说明。
- 策略缺文件降级只检查文件错误码，现存损坏策略不会因错误文案含 ENOENT 被静默忽略。
- 转换报告的全量分类计数及兼容告警不受展示截断影响；恢复移植引擎的上游 MIT 版权和许可声明并随引擎分发。
- 增加真实浏览器失焦、保存竞态、导入取消与筛选创建回归，以及世界书、策略错误、历史装配和报告截断行为测试。

### 子代理工具策略卡改为「单一开关 + 自动保存」（2026-09-17）

- **布局简化（用户要求）**：卡片不再有「启用策略（初始化）」「保存」「停用策略」三个按钮，只剩**一个启用开关**；
  开关旁显示状态（已启用（N 档）/ 已关闭）。
- **开启**：写入可用骨架并立即落盘（唯一写入路径，无手工保存）。
- **关闭**：删除 `preset.yml` 顶层 `subagentToolPolicy` 段并落盘，**保留模块声明**——于是能力卡不会消失、
  用户可随时再打开；引擎在策略文件缺失时降级为官方委派行为（不注册 shadow，也不阻止预设启动）。
- **关闭即只读**：策略编辑区包在 `fieldset[disabled]` 里，关闭时卡内所有可编辑控件禁用并整体淡化；
  打开后立即可编辑。
- **自动保存复用既有设计**：焦点离开策略编辑区即写盘（与配置卡/指令文件卡同款 `onBlur` + `relatedTarget`
  语义），不使用防抖定时器；存在无效角色卡绑定时先不写盘，用户修正后失焦即保存。
- **测试**：新增 `test/engine/subagent-tool-policy-degrade.test.mjs`（缺文件降级不注册 shadow、损坏内容仍 fail loud）；
  `subagent-policy-save` 增加"关闭后不再产出策略文件且预设仍物化成功"；`settings-bridge` 的关闭语义断言改为
  "只删段、保留模块"；`scope-create-separation` 增加卡片设计契约（无三个按钮、单开关、fieldset 只读边界、
  失焦保存复用）。
- **注意**：客户端改动需刷新工作台页面；关闭开关后子代理回到官方委派行为（不再读策略文件）。

### subagentToolPolicy 改为模块类型能力（2026-09-17）

- **能力化**：`subagent-tool-policy` 登记进引擎能力目录（`displayLayer: tool-pipeline`），于是它像其他能力一样：
  在「添加能力 / 工具模块」菜单里可创建、在模块列表里有独立能力卡、可用「删除引擎能力」二次确认移除；
  子代理页与主会话页都能操作（子代理页不再有"创建了却对子代理无效"的 `tool-filter`，见下）。
- **启用即写入可用骨架**：`EngineCapability` 新增可选 `ownSection`（顶层数据段 + 骨架）；
  创建该能力时若 `preset.yml` 顶层 `subagentToolPolicy` 段缺失，直接写入可用骨架
  （`ceiling.allow` = read/write/edit/glob/grep/bash，一个 `default` 档全放行，`modelExpansion` 开启且
  `requireApproval: true`），保证"模块在 ⇒ 数据在"，不会出现 shadow 行读不到 `subagent-tools/policy.yml` 的空档。
- **删除即一并清段**：移除该能力时同时删除模块声明与顶层 `subagentToolPolicy` 段（策略是结构化数据，
  留在磁盘上无法被任何 UI 编辑）；其它能力仍保持"删除只移除模块、参数留作 dormant"的既有语义。
- **卡片位置**：策略编辑器唯一入口 = `subagent-tool-policy` 能力卡内部（页面经 `EngineModuleCards` 的
  `renderCapabilityExtra` 插槽注入，避免 feature 间反向依赖）；「工具与深度」卡只保留递归深度与入口提示。
- **模块声明成为唯一开关**：`resolvePresetModuleFacts` 不再因顶层段存在而隐式追加
  `subagent-tool-policy`；`isEngineCapabilityPresent` 以 `declaredModules` 判定。这修掉了一个真实缺陷——
  旧逻辑下"段在、模块不在"的半状态会被判成"已装配"，导致能力菜单永远补不上模块声明；现在启用会补齐声明，
  且不覆盖既有策略内容。
- **子代理页排除仅主对话能力**：`EngineModuleActions` / `EngineModuleCards` 新增 `excludeCapabilities`
  与 `hint` / `emptyHint`；子代理页排除 `tool-filter`（主对话常驻过滤，对子代理不生效），并在菜单区提示
  "子代理工具面请用「子代理工具策略」"。
- **修正说明文字位置与文案**：该说明原先挂在工具栏（`.configActions` 是 `flex + margin-left:auto`），
  会把按钮行挤偏；现改为由 `EngineModuleCards` 渲染在能力卡列表上方，工具栏只放按钮。
  文案同步改为指向能力卡本身（"由「subagent-tool-policy」能力卡管理（在本菜单里创建）"），
  不再指向已迁走的「工具与深度」卡；中英文同步。
- **测试**：新增 `test/host/subagent-policy-capability.test.mjs`（7 条：目录登记+骨架校验、启用写骨架与物化、
  幂等、半状态自愈、删除清段、残留清理）；`engine-module-cards` 夹具改为同时声明 `declaredModules`；
  `scope-create-separation` 增补子代理页排除能力的菜单/卡片断言；`tools-preview` 的入口断言改为"编辑器由
  页面注入能力卡"。
- **注意**：历史预设若处于"段在、模块不在"的半状态，打开卡片保存或从菜单启用即可补齐模块声明；
  客户端改动需刷新工作台页面。

### 工具过滤卡只保留总开关（主/子代理分离）（2026-09-17）

- **移除「子代理同过滤」开关**：删除引擎参数 `toolFilterSubagents` 及其
  `tool-filter.includeSubagents` 参数桥绑定、中英文标签与开关键集合成员。主会话与子代理已分离——
  主对话的工具过滤不再下发给子代理，子代理工具面一律由实例级 `subagentToolPolicy` 授权，
  因此 `tool-filter` 能力卡只保留「启用工具过滤」（`toolFilterEnabled` → `tool-filter.enabled`）。
- **引擎侧保持兼容**：`engine/tool-filter.mjs` 仍接受 `includeSubagents`（缺省 `false`），
  `moduleConfigs` 直写仍可生效，只是不再有 UI 绑定；已把开关打开过的用户预设会在其
  `tool-filter` 行留下 `includeSubagents: true`，本轮**不自动改写用户预设**——需要子代理不继承
  主对话过滤时，删除该行级键即可。
- **文档与模板**：`docs/engine-reuse.md` 明确"`tool-filter.includeSubagents` 是引擎兼容键但不再有
  UI 绑定"；`preset.yml` 根模板的工具集段落注释改为"只作用于主对话 tool-filter 行"。
- **测试**：`engine-param-schema` 的参数读回/装配回显用例改用 `toolFilterEnabled` 与 `workspaceLine`，
  并新增「引擎保留但 UI 不绑定」白名单（仅 `tool-filter.includeSubagents`），仍禁止其他模块遗漏引擎键；
  `module-configs` 的"参数桥优先于 moduleConfigs 直写"用例改用 `tool-filter.enabled` 验证同一机制。

### 子代理页创建入口对等 与 过滤/新建严格分离（2026-09-17）

- **子代理页补齐与主会话同款的创建入口**：`SubagentPage` 接入合并创建菜单 `EngineModuleActions`
  （引擎能力 / recipe、按插入点层级的模板、工具模板、模板变量）、能力卡 `EngineModuleCards`（含二次确认删除）、
  自定义工具卡 `CustomToolsCard` 与模板变量卡（复用 `TemplateVariablesModuleCard`）。此前子代理页只有
  「新建」按钮一条链路，缺少能力模块、自定义工具、按层模板与变量入口——因为全仓库唯一调用
  `createEngineCapability` / `removeEngineCapability` 的组件是 `EngineModuleList.tsx`，而子代理页不引用它。
- **模块列表只保留一个创建入口**：移除「配置列表 + 新建模板」包装里残留的独立「新建」按钮
  （`ConfigListWithTemplates` 只被子代理页使用），模板插入统一走工具栏合并菜单的
  「添加模板 · 层级」/「添加工具模板…」/「添加模板变量」。
- **新建即可见（受众代入，而不是改过滤）**：新增纯函数 `createConfigFromTemplate(entry, configs, scope)`
  承载模板派生（id 去重 + identity 跟随 + `instruction-hint → placeholder` 降级 + 受众代入）。子代理列表
  新建的配置写 `audience: subagent`，主会话列表新建的配置清除模板自带的「仅子代理」限制回落公用，避免
  「提示已插入、列表里却没有」的静默消失；两条路径都不触碰过滤状态。
- **过滤 / 新建严格分离（用户指定纪律，回归断言锁定）**：过滤下拉与搜索词只由用户手动改变，任何创建、
  复制、删除路径都不写入 `viewFilter` / `innerViewFilter`；新建只做两件事——展开新卡并滚动定位到它。
  新增 `src/client/ui/reveal-card.ts`（`scrollToCreatedCard`：`block: 'nearest'`，节点未就绪按上限重试后
  静默退出），配置卡加 `data-config-id`、能力卡加 `data-module-card-id` 作为稳定锚点。
- **重复创建同一能力不再失效**：定位信号由「能力 id」改为 `{ id, token }`，token 每次创建递增，因此同一
  能力连续创建两次都会重新展开并滚动定位（旧实现第二次因 `revealKey` 值不变而不展开）。
- **置顶卡片位置修正与过时文案**：`beforeCards`（人设、模板变量等单例卡）渲染在过滤行之前，与"置顶固定
  卡片"的注释语义一致；`configList.emptyPreStep` 不再声称"作为 settings 覆盖层，切换预设后仍保留"——实际
  写入激活预设 `preset.yml`（与 ADR-0001「预设定义即权威」一致），中英文案同步改写。
- **指令文件卡作用域收敛**：`ConfigListWithTemplates` 只在 `scope=main`（或缺省）时下发指令文件卡相关
  props，子代理页不再渲染同一指令文件（AGENTS.md / CLAUDE.md 及其 .local 变体）的第二编辑入口。
- **测试**：新增 `test/client/scope-create-separation.test.mjs`（10 条断言：受众代入、id 去重与 identity
  跟随、策略降级、子代理作用域可见性与仅主会话配置隔离、过滤写入点唯一、定位信号与滚动实现、复制不改受众、
  子代理页入口对等且不下发指令卡、置顶卡顺序、空状态文案）；`engine-module-cards` 的展开用例改用新的
  `{ id, token }` 信号并补「同一能力重复创建仍展开」断言。
- **注意**：这是客户端改动，需刷新工作台页面生效。

### 移除上游预设、只保留引擎移植（2026-09-17）

- **上游引擎核查（只读）**：`xiaobright/dsh-anchored-standard` 已于 2026-09-10 正式冻结（HEAD `dda23ef`，
  `FAREWELL.md` 声明不再接受 issue/PR），本地内联快照当时已同步到该提交，**没有待移植的上游引擎更新**。
  上游最后一批引擎修复——`751fd67` 的 `session.snapshotEvents()` 兼容、`78b4cbd`/`babc933` 的 Git Bash
  路径运行时推断与 Windows workdir 归一、`b74543b`/`e3d330b` 的 instruction-hint 幂等 id 与建议式措辞——
  在本地 `engine/` 中均已用更强的实现覆盖（`engine/shared.mjs#snapshotEvents`、`engine/tool-git-bash.mjs`、
  `engine/instruction-hint.mjs`）。
- **下线内容**：删除内置 `preset/anchored/`（含其内容资产）、`upstream/dsh-anchored-standard/` 内联快照与
  `REVISION`、`scripts/sync-anchored.mjs` 与 `package.json#scripts["sync:anchored"]`。上游预设本体不再随包
  分发，**引擎移植全部保留**：`engine/` 与 `engine/compositions/source/local/` 的 anchor-turn /
  deliberation-gate / progress-reminder / context-gate / tool-bootstrap / promoted-code-mode / tool-git-bash
  等仍按预设 `modules` 声明按需装配，行为不变。
- **默认模板迁移**：`presetTemplate` 默认值由 `anchored` 改为 `standard`（`src/config.ts` 的 `Config` 与
  `PromptSettingsSchema`、`src/index.ts` 的回退字面量、`src/host/write-preset.ts`、`src/host/manifest.ts`、
  `src/runtime/settings-bridge.ts`、`src/client/data/prompt-tool-fields.ts` 与 `prompt-tool-view.ts`）。
  内置模板集合收敛为 `standard / ptc / minimal / creative / custom`，`listBuiltinTemplates()` 与首次种子化
  跟随目录自动生效。
- **兼容层收敛**：`src/preset-core.ts` 删除强绑定 anchored 模板的 `buildCordis()` 与 `ANCHORED_TEMPLATE_DIR`
  （`src/` 内零生产调用，仅测试消费），保留 `loadPromptConfigFiles` / `mergePromptConfigs` /
  `renderPromptConfigYaml` 导出；`src/host/prompt-configs.ts` 同步删除只为它服务的 `BuildCordisOptions` 类型。
- **测试迁移（不弱化断言）**：新增测试夹具 `test/fixtures/preset-template/`（只被 `test/` 引用的模板：锚定/门控
  模块装配 + params + 三条提示词配置，**不含任何提示词正文**）与安装器 `test/fixtures/preset-template.mjs`
  （`installFixturePreset(presetRoot)` 对应 `writePreset` 的 presetDir 解析根，`installFixturePresetInHome(dshHome)`
  对应 `resolvePresetDir` 的 `$DSH_HOME/.agent-presets` 根）。`write-preset` / `module-configs` /
  `prompt-configs` / `rematerialize-presets` / `wave1-safety` / `instructions-e2e` 等改由夹具或官方基型
  `standard` 承载原断言；原 `test/presets/anchored/anchored-presets.test.mjs` 内容是 tool-git-bash / persona
  层 / run-code-env 的引擎行为测试（与预设无关），迁移为 `test/engine/preset-engine-modules.test.mjs`；
  buildCordis 专属测试文件与 `test/presets/` 目录删除。
- **文档**：README 顶部改为「只移植引擎能力，不再分发上游预设」，删除 `pnpm sync:anchored` 命令并更新许可段；
  `preset.yml` 根模板去掉 `upstream:` 段、示例引用改指现存内置预设；`templates/14-first-turn-anchor.yml` 与
  `templates/15-guide-auto.yml` 注释不再引用 anchored；NOTE.md 目录清单同步。
- **注意**：用户 `DSH_HOME/.agent-presets/anchored/` 既有的种子化副本与生成物**不会**被本插件删除（插件只写
  自己拥有的目录）；不再需要时可在工作台预设页手动删除该目录。默认模板改为 `standard` 后，新建与重新物化
  的预设以 `standard` 为基础；`standard` 模板自带 `promptConfigs: []`，因此不再自动生成 near-anchor /
  router-guide / prompt-injector 三条卡片——需要锚定/引导/注入时按参数开关或在工作台按需添加配置卡。

### 预设补建串内容修复（2026-09-17）

- **「切换预设后注入内容不变」的根因（P1）**：`applyState` 的补建循环为「非激活且需要
  重渲染」的预设调用 `writePreset` 时透传了 `options.promptConfigs`——它承载的是**激活
  预设**的编辑上下文（settings 覆盖层），而 `writePreset` 把该覆盖层当最高优先级。于是
  目标预设的 `prompt-configs/` 被写成激活预设的内容：切换预设只是换了个目录，里面装的
  还是旧预设的提示词。更糟的是补建产物带上渲染标记后 `needsPresetRender` 返回假，污染
  **不会再被重建**（这正是「持久不变」的来源）。
- **触发面是系统性的**：`needsPresetRender` 在组合文件缺失、含旧布局引用、或缺渲染版本
  标记时返回真。09-15 引入 `RENDER_VERSION = 4` 后，所有旧组合同时命中第三条，下一次
  重建就对**全部非激活预设**执行补建，批量写入激活预设的配置。
- **修复**：补建路径显式传 `promptConfigs: []`，目标预设一律以自身 `preset.yml` 加包内
  模板默认渲染。这与 `materializeImportedPreset`（导入预设）同源——该路径 08-22 就已这样
  处理并留有「settings 覆盖层属于激活预设的编辑上下文，不得污染导入预设」的注释，补建
  循环当时漏改。
- **回归**：新增 `test/host/preset-materialize-isolation.test.mjs`，从插件入口驱动补建，
  断言目标预设「自身配置在、激活预设的配置 id 与正文一个字都不在」。修复前该断言**真实
  复现**了污染（目标目录同时含 `standard-only` 与 `anchored-only`）。
- **注意**：已被污染的既有产物不会被自动纠正——需重新开启「写入预设」并让全部预设重建
  一次（重建会按各预设自身的 `preset.yml` 重新渲染）。

### ST 转译完整性修复（R7–R14，2026-09-17）

按 `PLAN.md` 的 P1+P2+P3 修复世界书触发键宏、ST 条目级条件字段读取与未复刻能力的可见性。

- **世界书触发键宏（R7/K1）**：ST 在匹配前对主键与副键执行 `substituteParams`，而此前只有
  配置正文/`params.text` 参与「未定义自定义宏登记」，键里的 `{{user}}` 之类卡内无源宏按字面量
  参与匹配——实测素材 5 条条目的 key 含 `{{user}}`，其中 1 条（`V0.66.png#25`，仅含该键且非常驻）
  完全失效且无任何提示。现在 `params.keys` / `params.secondaryKeys` 与正文共用同一份排除集
  （运行时宏、内置路径变量、已登记变量）与同一张变量表：无源宏登记为空占位并逐条产出可定位的
  `st-key-macro` warning（进入 `needsReview` 与 `meta.stWarnings`）。未赋值时键渲染为空、由引擎
  `filter(Boolean)` 丢弃，不误触发；在「模板变量」赋值后按既有匹配路径生效，运行期零引擎改动，
  不猜测 `{{user}}` 的值。转换器版本升 `st-to-preset/3`。
- **世界书条件字段（R8/K2·K3）**：ST 的 `delayUntilRecursion` 与 `useGroupScoring` 此前完全
  未读取。现在两者按 ST 1.19.0 源码语义落地：延迟到递归按**层级池**求值
  （`world-info.js:4753-4762`/`:4860-4868`：非递归 pass 抑制、sticky 例外、层级只增不减、
  层级满足的那次递归 pass 即解锁），组内评分按 `getScore` 等价实现
  （`:428-473`/`:5292-5328`：只统计命中键数、只有显式开启的条目被严格低于最高分淘汰、
  未开启者不被淘汰但计入最高分、组内有 sticky 命中时整组跳过）。新增诊断原因码
  `delay-until-recursion` 与 `group-score-lost`（带分数与最高分）。两个开关未开启时
  求值路径与既有断言逐条一致，字段缺省不产生新诊断。测试内保留 ST 算法抄写夹具对拍。
- **角色过滤与自动化字段（R10/R11/K6·K7）**：`characterFilter` 的真实形态是嵌套对象
  `{ names, tags, isExclude }`（`world-info.js:2125-2132`、`:4815-4843`），此前完全未读取。
  现在原样保留到 `params.stWorldBook.characterFilter`，并在两个维度至少一个非空（ST 实际
  启用过滤的条件）时告警「按角色过滤不受支持」——本项目预设与角色在导入期绑定，没有运行时
  切换角色这一层，因此不实现过滤、也不据此跳过条目（避免静默丢失）。`automationId` /
  `outletName` 改为蛇形 + 驼峰双读（ST 独立世界书是顶层驼峰），非空 `automationId` 保留事实
  并告警「依赖 STscript 自动化」，无主键且非常驻时文案明确「不会自动注入」；`outletName`
  沿用 `unsupported-controls`。空值与缺省零噪音（素材实测非空值 0，不新增噪音）。
- **prompts[].system_prompt（R12/K7）**：按 ST 1.19.0 源码核实（`openai.js:1240-1257`、
  `PromptManager.js:1723-1729`）确认 `system_prompt` 只是「内置/全局 prompt」的管理位
  （不可删除、不参与导出、不在 append 候选），**不改变发送角色与位置**。因此不做层改判：
  把 `systemPrompt: true` 写入 `params.stSource` 并记 info 诊断，层归属仍按 `role`
  （素材 48 条中 38 条 role=system 进 system-section、10 条 role=user 进 pre-step，
  分类与定位稳定）。
- **depth_prompt 与扫描字段开关（R13/R9/K8·K4·K5）**：`extensions.depth_prompt`
  （`{ prompt, depth, role }`）此前被整体丢弃，素材 13 张卡带该字段且无任何来源元数据。
  ST 只在群聊自动注入它，本项目没有群聊，因此保留为一条**默认禁用**的 pre-step 配置
  （`st-depth-prompt`，来源标注 + `degraded` + 原因码 `depth-prompt-group-only`），
  用户可手动启用，正文不进模型上下文；同时登记 `depth_prompt` 与 `creator_notes`
  两个内容变量。世界书扫描开关随之接入 `matchCreatorNotes` /
  `matchCharacterDepthPrompt`（对齐 `world-info.js:294-320`/`:5664-5666` 与
  `script.js:4626-4634` 的来源字段）：仅在条目显式开启且变量有值时并入扫描文本，
  未开启时不并入，既有触发面逐字不变。
- **未复刻能力与降级对照（R14/K9）**：`docs/SillyTavern.md` 新增「未复刻的 ST 能力与降级对照」
  表，逐行给出 token 预算（`world_info_budget` / `budget_cap` / `ignoreBudget`）、
  `forbid_overrides`、`min_activations`、ST 全局开关、位置枚举（`ANTop` / `ANBottom` /
  `atDepth` / `EMTop` / `EMBottom` / `outlet`）、`vectorized`、`triggers`、`automationId`、
  `characterFilter`、`extensions.depth_prompt`、群聊、跨进程粘滞时间窗与扩展脚本扫描的实际
  处置（等价 / 降级 / 保留事实 / 不支持）与**真实诊断码**，不把「已降级」写成「等价」。
  真实验收：素材 17 个文件全部转换成功；`{{user}}` 键条目在赋值前后从 0 条恢复到注入
  （`V0.66.png` 的 lore-25/39 同时生效），注入批次经官方 `@deepseek-ai/dsh-session`
  持久化与重载无非法角色。

### 导入确认、诊断可信度与会话完整性修复（2026-09-17）

按 `PLAN.md` 的 R0–R6 修复三提交审查发现的 1 项 P1 + 6 项 P2 与历史角色出口缺陷 H0。

- **pre-step 角色出口（H0，P1）**：宿主把本批消息逐条写成 `user/message` 事件，事件校验要求
  `role === "user"`；此前 ST 导入与旧配置声明的 assistant 角色会被原样写出，产生宿主无法重新加载的
  会话日志。现在执行器在**唯一出口**兜底为 user（配置声明与策略 patch 都覆盖），保留正文、只告警一次、
  原角色记入 `source.requestedRole`；ST 转换在**导入期**逐条降级（示例对话/开场白/备用开场白/prompts/
  世界书），原角色保留在 `params.stSource.role` / `params.stWorldBook.role`，条目按 degraded 记录
  （原因码 `assistant-role-downgrade`）而不宣称等价。引擎仍接受 `role: assistant` 作为输入，
  但 `/meta` 的 `roles` 只提供可发出角色、`acceptedRoles` 另行列出可加载的旧值，工作台对旧值显示降级提示。
  验收走已发布 `@deepseek-ai/dsh-session` 的「注入 → 持久化 → 重新加载 → 派生请求」真实回放。
- **导入确认生命周期（F1，P1）**：角色 JSON 导入在等待确认时把 `busy` 一直置真，导致确认/取消按钮
  全部禁用、导入无法结束。现在阶段分为读取/预览 → 等待确认 → 提交，只有提交阶段禁用按钮；同一份预览
  只完成一次（连点确认最多一次提交），提交失败保留文件与预览（再次确认即重试），取消只跳过当前文件，
  目标切换与页面卸载都会结束等待并让迟到响应失效。预设包与角色卡共用同一状态机。
- **导入入口 fail closed（F7，P2）**：两个导入端点此前不校验 `preview` 类型，`preview: "true"` 会被
  当作提交并真实写盘。现在 `preview` 只接受布尔、`expectedSourceDigest` / `expectedPreviewRevision`
  只接受 SHA-256 十六进制摘要、`promptOrderCharacterId` 只接受有界非空字符串，`files` 容器与条目类型
  错误一律 400；校验全部发生在建目录、备份、写盘与重建之前，错误请求零副作用。
- **选组与预览版本闭环（F2/F3，P2）**：选组优先级固定为「请求显式选择 → 文件内 character_id →
  全局组 100001 → 仅一组回退」，显式选择找不到即报错、重复 character_id 拒绝；首次预览歧义时返回
  `needs-order-selection` 候选（无报告、无凭据、确认禁用），选组后重新预览才 ready。新增
  `previewRevision` / `expectedPreviewRevision`：绑定文件、实际选组、转换器版本与目标身份（含目标
  当前内容），提交重算不符即 409 且零写盘，预览期间目标被改动同样失效；换文件/换组立即失效旧状态，
  乱序响应按请求序号丢弃。
- **报告身份同源（F4，P2）**：多文件合并的最终 id 只由合并分配一次，报告 `targetId` 消费同一份映射
  （`targetIndex` 关联），并附 `sourceName` / `sourceFileIndex`；来源身份与目标身份分字段，
  被排除条目不再带伪目标。
- **有损信息完整可见（F5，P2）**：预览卡不再只显示前 20 条：warning、info 级降级与被排除条目
  各自成区并带来源/目标定位，长列表在可聚焦容器内滚动；服务端截断时明确给出已展示数量与来源总量，
  不再出现「有损计数大于零但界面宣称无需检查」。
- **诊断快照真实性（F6，P2）**：世界书诊断快照改为 `selection.diagnostics` 与会话最近快照引用同一
  对象，commit 阶段追加记录或越限置 `truncated` 都写回同一份事实（此前复制布尔值，67 条常驻配置在
  commit 时越限仍报 `truncated: false`）；最近一次求值总是替换快照（含空集合），并新增 `evaluated`
  区分「尚未求值」与「已求值但本次为空」。
- 兼容与边界：旧 `preset.yml` 的 `role: assistant` 仍可加载；旧直连导入调用（无预览版本凭据）仍按
  文件摘要工作，但要求新的选组覆盖时必须重新预览；PNG/大 JSON 流式导入保持即时入库、不经过预览。
  未做真实 DSH 会话 smoke，运行中的 DSH 需用户自行重启后生效。

## 0.8.0 明细 · 2026-09-06

### ST 导入行为修复（2026-09-16）

- 按官方嵌套 prompt_order 解析启停/顺序；保留纯赋值卡、模板与原始开关，禁止导入期执行禁用卡赋值。角色应用和多文件合并保留局部变量，补充示例对话。
- ST 宏顺序求值支持数字/数组 add、local/global 分表、inc/dec 和嵌套边界；会话内状态与有界解析不执行扩展代码。普通官方变量修复局部串值、重复大小写注册、值清洗、空白引用和动态宏冻结。
- ST 世界书修复主副键逻辑、顶层 entries、extensions 字段、历史扫描窗口、概率、分组、会话内粘滞/冷却/延迟和最终正文顺序；与原生 world-book 约定分开。不能无损表达的深度/system角色及扩展能力报告兼容提示。
- skills 刷新合并用户独有文件，暂存后备份切换；失败恢复旧目录，仅独有文件不触发重复备份。
- 旧 ST 转换产物需从原素材重新导入才能恢复丢失的模板和字段；不自动覆盖用户预设或重启 DSH。兼容边界见 docs/SillyTavern.md。

### ST 变量赋值族与配置名称的 YAML 安全往返（2026-09-16）

- **补齐 ST 变量赋值族**：此前只识别 `setvar`/`getvar`，`{{addvar::POV_rules::…}}` 这类"分卡拼规则块"的写法会被当作普通引用剥离，随后 `{{POV_rules}}` 只拿到空占位——**内容静默丢失**（实测明月秋青 v5.0：19 个变量全空、8 处引用被剥离并告警）。现在赋值族按 ST 语义落变量表（`setvar`/`setglobalvar` 覆盖、`addvar`/`addglobalvar` 追加、global 并入同一张表），读取族 `getvar`/`getglobalvar` 改写为 `{{k}}`（含 `::默认值` 语义），`incvar`/`decvar`/`trim`/`ERA` 只剥离。该预设重导后 19 个变量全部有值（`POV_rules` 462 / `anti_rules` 267 / `thinking_chain` 381 字符），告警归零、卡片数 102→89（纯赋值卡不再产出空文本卡）。
- **配置名称/路径改为 YAML 安全标量**：`renderPromptConfigYaml` 里 `id`/`name`/`configKind`/`group`/`sourceKind`/`form`/`templateFile`/`fill`/`identity` 的用户字符串统一交给 `yaml` 适配器决定引号，替代此前只覆盖数字/布尔/null 的手写规则。裸写破坏往返的两种真实形态都会让**整个预设无法挂载**：数字形状（`name: "1"` → 解析回 number，触发 `name must be a non-empty string`）与特殊起始字符（`[主控制器]全能世界书`、`{{user}}档案`、`[new]剧情生成器[...]` → YAML 解析报错）。

### 运行时事实官方变量化与配置渲染引号修复（2026-09-16）

- **运行时事实改为官方变量注册**：`lastusermessage`/`lastcharmessage`/`charifnotgroup`/`time`/`date`/`weekday`/`isotime`/`isodate` 注册为官方 `systemPrompt.variable()`，按每次 assembly 求值——修掉这些宏在 `system-section`/`runtime-context` 里被注册期冻结的问题（此前 `{{lastUserMessage}}` 在该层渲染为空串）。
- **已声明内容变量同样走官方通道**：官方插值两层里被引用且已声明的内容变量注册为官方变量，值 = 会话变量覆盖 ?? 声明值（与 pre-step 的优先级链一致）。非法官方名（中文/大写/连字符）按确定性规则改写为 `sv_<slug>_<hash>` 别名并同步改写文本引用；注册失败的名字退回静态解析并告警。
- **保护集合与白名单剥离**：静态 pass 不再替换上述名字（否则又会在注册期被吃掉），出口剥离只放行已注册官方名、其余引用照旧剥离。`random/pick/roll/chance` 不注册——它们是"每次出现各算一次"的求值宏，继续由引擎内联处理。
- **配置渲染引号修复（既有致命往返缺陷）**：`renderPromptConfigYaml` 把数字形状的 `id`/`name`（ST 导入的模板名常见 `"1"`、`"2"`）裸写成 `name: 1`，重新解析成 number 后触发引擎 `name must be a non-empty string` 校验 → **整个预设挂载失败**。现在按需加单引号；已物化的用户预设执行一次 `pnpm rematerialize:presets` 即修复（本机 v18-8 已修复：41 张官方插值卡全部可加载）。

### ST 入口归一与官方插值通道出口清洗（2026-09-15）

- **入口归一**：ST 宏形态 `{{roll 1d6}}`（空格）/ `{{roll:1d6}}`（单冒号）在导入期归一到本项目语法 `{{roll::1d6}}`；引擎侧同样归一一次，手工写入与旧预设的内容一并受益。跨行 `{{//注释}}` 的剥离修复（原正则 `[^}]*` 遇到正文里的 `}` 就断，含 JSON 示例的注释块会被留下）。
- **ST 字段宏 → 内容变量**：`{{description}}`/`{{personality}}`/`{{scenario}}`/`{{persona}}` 登记为顶层同名内容变量（值取卡片字段并过一遍 ST 清洗；字段缺失但正文引用时补空占位）。**不写进模型人设段**：ST 的 `{{persona}}` 指用户人设，与 dsh 顶层 persona（助手人设）语义不同。
- **官方插值通道出口清洗（修崩溃）**：官方对我方注册的 `system-section` / `runtime-context` 文本做严格插值，畸形引用、未注册名、值为 undefined 都会抛错并让整轮组装失败；后者在 0.1.6 没有 `interpolate:false`。现在交给官方之前，本项目宽容解析后残留的引用一律剥离（成组引用整段剥离、含花括号的畸形段只中和开括号），并以 `warnOnce` 记录样本。受影响的真实场景：预设卡里写 `{{未登记名}}`、`{{}}`、`{{//` 跨行段或大写内置名 `{{DSH_HOME}}`。
- **内置路径变量在静态层解析**：`{{DSH_HOME}}`/`{{WORKSPACE}}`/`{{CWD}}` 此前只在 pre-step 通道解析，在 section/context 里会原样残留并被官方判畸形引用（与 f26986b「内置变量保留」的既有意图不符）。现在两条通道同源解析。

### 宿主预设策略感知与预设内嵌技能漂移检查（2026-09-15）

- **默认预设同步感知 `modeSelectionEnabled`**：官方关闭模式选择时 `defaultId` 回落 `config.default`，用户保存的 `agent-presets.default` 不再决定新会话。插件改为跟随「生效默认值」（优先读服务 getter `agentPresets.defaultId`），此时不再写 `default`、也不再假装同步成功，只在首次触发时告警一次并指明改 `cordis.patch.yml` 的 `agent-presets.config.default` 或重新开启模式选择。开关缺省（含旧版宿主）行为完全不变。
- **`rematerialize:presets` 增加预设内嵌 skills 漂移检查**：官方 cordis 谱系的 `skill-filesystem-cordis` 行按 `<预设>/skills/` 读取技能，该副本只在建预设时由 `ensurePresetSeed`/`cloneBuiltinPreset` 复制一次，`writePreset` 与重新物化都不管理它——包内技能更新后用户副本会静默过期（例如技能正文仍引用已删除的官方包）。脚本默认比对包内模板并报告缺失/内容不同/预设独有文件，不覆盖、不删除；显式 `--refresh-skills` 才刷新，且先把原目录改名为 `skills.bak-<时间戳>` 以便回退。

### 官方组合跟随 DSH 0.1.6-alpha.1 与 PTC 命名统一（2026-09-15）

- 官方 master（`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，`dsh-v0.1.6-alpha.1` 之后）把组合嵌套行 `workflow-worker-thread`（`@deepseek-ai/dsh-workflow-worker-thread`）改名为 `workflow-ptc`（`@deepseek-ai/dsh-workflow-ptc`）。旧包已被上游删除（源码树与 npm 都只到 `0.1.5-rc.2`），继续生成旧行会让预设在该宿主上解析失败，故本次升级没有中间兼容版本。
- 同步 `preset/creative/skills/editing-cordis-compositions/SKILL.md` 与 `test/fixtures/dsh/current` 离线快照（10 个文件与官方逐字节一致，指纹表与来源提交已更新），重建 `engine/compositions/library` 的 22 个官方模块：只有 `delegation`、`delegation-ptc` 的正文变化，其余为来源 commit 头刷新。
- **行为变化**：`tool-ralph` 在 standard、ptc、cordis 官方预设中一律 `disabled: true`，本插件生成的预设随之默认不再向模型暴露 `ralph` 工具与对应 workflow engine 行（此前默认开启）。需要该工具时按官方配方复制预设并在 preset 中去掉这两处 `disabled`；PTC 预设在改名后额外禁用了无消费者的 `workflow-ptc` 行。
- 依赖基线抬到 `0.1.6-alpha.1`：`^0.1.5-rc.2` 按 semver 预发布元组规则不匹配该版本，必须显式改范围；组合快照与宿主版本绑定，旧宿主请先升级 DSH 再切到本版本（不提供双读或自动迁移）。

### 官方模块跟随最新上游

- 默认 `rebuild:composition` 核验官方 master 的远端 HEAD，拒绝落后 checkout、预设局部修改和无法核验的网络状态；不修改宿主源码，不回退旧版本。生成模块记录实际分支与 commit。
- 本次核验 master 为 `c291e7961a515f6d7af9304e7fd1d257929aef26`；其预设文件与目前最新发布 rc.2 相同，模块正文无变化。官方分发快照出处更新为 master，不虚构版本升级或按落后的 npm latest 标签降级。
- 离线数据移至 `test/fixtures/dsh/current`，保留实际提交与文件指纹，测试不再硬编码 rc.2 或单一提交；宿主依赖基线从 package.json 的明确发布版本派生，不重复写死常量。

### 组合模块直接重命名与来源纠正（破坏性变更）

- `library` 只生成固定官方输入原样的 22 个模块；本地补丁改为 `source/local/tool-bash-disabled.yml` 与 `persistent-shell-posix.yml`，本地模块共 19 个，不再在官方生成器维护字符串补丁。
- 删除 `library/persona.yml` 与生成登记。`renderComposition` 直接按预设顶层 `persona` 字段生成官方行，不再向 modules 清单隐式补回人设模块；内置预设、ST/角色卡继续共用字段契约。
- 官方模块去掉不一致的 `official-` 前缀，`present` 模块改为 `tool-present`（官方 row id 不变）。本地 `bootstrap-filesystem`、`custom-bash`、`code-presentation`、`cot-drip` 分别直接改为 `filesystem-editor`、`tool-git-bash`、`promoted-code-mode`、`progress-reminder`，同步源码、配置和 UI。
- 删除旧 `str-replace-editor` 组合别名，不提供任何旧名映射或自动迁移。`tool-bash`、`persistent-shell` 现在只表示原样官方行；本地适配使用明确后缀。旧预设模块清单必须由用户显式更新；工具名、既有参数键与消息来源类别不变，模块身份使用新名，既有会话历史不改写。
- 渲染契约升至 v4；官方快照由重建脚本生成，行为测试验证官方行同构、人设直接渲染、旧名拒绝、参数桥和本地适配，用户服务切换由用户安排。

### 独立指令来源审查修复（2026-09-14）

- 修复普通预设卡因 `params.file` 被误判为独立指令卡而丢失；授权根与候选文件统一真实路径，允许目录链接作为工作区或 DSH_HOME，同时保留越界拒绝。
- 指令策略按原始字节计算 revision，非法 UTF-8 与 YAML 转换异常返回不可读状态；修复 null 文件覆盖无法局部更新，被 alias 引用的 null 锚点则明确拒写以免连带改坏其他字段；隔离端点测试的文件基线。
- 协调器保持在 prepend 门控内侧，迟到接管不绕过已有 gate；预设 resolver 保留来源 ctx，HMR 按服务实例重新登记，空预设同样支持迟到与重挂。
- 修复策略读取的迟到响应覆盖其他预设、工作区往返丢失文件草稿基线，以及保存全部忽略部分文件失败；独立来源总开关由用户显式操作，默认仍关闭。
- 补充上述反例的行为回归，删除无消费者旧入口；真实浏览器 UI 与模型会话 smoke 仍单独列为未验证，不以测试全绿替代。

### 独立指令文件来源：统一 pre-step 执行与文件版本可见状态（2026-09-14）

- **单一 pre-step 执行器（W3）**：新增宿主侧协调器 `src/runtime/pre-step-coordinator.ts`，用一个 `agent/pre-step` 监听器统一执行预设来源与独立指令文件来源；`engine/executor.mjs` 抽出 `runPreStepBatch` 作为唯一批执行算法，`prompt-config-engine` 行在协调服务可用时只注册来源、不再自建执行路径，服务缺失（引擎被复制到无宿主目录）时仍可独立运行。协调服务迟到/消失时先撤旧再启新，任一时刻每个 scope 只有一个执行器；来源作用域沿用 `@deepseek-ai/dsh-scope`（父 scope 对子代理可见、兄弟不串、dispose 即释放）。与 `context-gate` 共挂时门控仍在更外层。
- **文件版本可见状态（F4）**：独立指令文件按 `(fileId, revision, surface epoch)` 判定候选资格，可见面以 `session.deriveMessages()` 为准（缺失时回退持久日志 + 最后一次成功 `compaction/end`）。修复「首次注入后文件更新/压缩后不再注入」：同版本已可见不重复、内容变化注入新版本一次、成功压缩后同版本恢复一次、失败压缩不重放、`reject`/缺锚点不确认、重挂与恢复从持久记录重建。已注入过的文件被清空/删除/超限时只发一次带身份的失效通知，历史正文不撤回。
- **负责人冲突与未知装配**：引擎行从物化组合读取「本 mount 是否仍挂着官方 `@deepseek-ai/dsh-agent-instructions`」，协调器据此整体跳过文件正文注入（同一正文只由一方注入）；该 Agent 的 scope 里没有任何已注册 preset 来源（没有引擎行/引擎未注册）时按未知处理，同样不注入。两者都通过 `/bootstrap`、`/prompt-configs` 的 `instructions.owner.officialInstructions`（`true/false/null`）上报工作台。
- **独立策略生效**：`$DSH_HOME/.prompt-tool/instructions.yml` 的启停、层内序号、位置、晋升、受众与模型范围现在真正决定注入行为（此前只做存储与回显）；默认 `enabled: false`，需用户显式开启。策略只影响未来注入，不撤回已进入会话历史的内容。
- **生成目录不再物化文件卡（W4）**：`writePreset` 删除 AGENTS 探测与 `agents-file-*` 卡合成、删除 `agentsFiles` 选项；`preset.yml#agentsHints` 不再是运行时开关（字段保留仅为兼容既有用户预设解析，不迁移、不删除）。既有生成目录里的旧文件卡在运行时被跳过，重新物化一次后即消失。

### 指令文件读写加固：读取一致性与显式保存（2026-09-14）

- **读取收口（F1）**：`/bootstrap` 与 `/prompt-configs` 共用同一份指令文件快照（正文、文件身份、字节版本 SHA-256、读取状态一次取回）；此前只有单读端点附正文，工作台用 `/bootstrap` 拿到空草稿，随后一次保存会把真实 `AGENTS.md` 清空。
- **普通卡正文不再被剥离（F2）**：`stripContentText` 只对内容资产（preset.md 注入卡）剥离文件通道正文，普通 `static`/`placeholder` 卡的 `text`、`texts`、`params.text` 完整往返——修复一次普通保存就丢卡片正文。
- **只写改动过的文件（F3）**：保存载荷改为单文件请求 `{sessionId, contextId, fileId, expectedRevision, content}`，只提交读取就绪、有基线版本、上下文匹配且正文相对基线有改动的文件；未修改文件不写盘，旧副本不再覆盖外部新版本。
- **冲突与失败不丢草稿**：外部改动（`agents-file-conflict`）、目标身份变化、当前不可读、工作区上下文过期（`agents-file-context-stale`）都返回 409 并保留草稿，卡片显示冲突态并提供「重新读取」；保存成功只把**请求时快照**记为基线，期间继续编辑仍保持未保存。
- **文件与预设解耦**：文件卡正文不参与预设 debounce 自动保存，预设切换不隐式保存也不清空文件草稿；文件卡正文与卡片定义都不写进 preset.yml；文件写入不再触发预设重建。
- **UI 不再有静默丢弃的开关**：文件卡正文框按读取状态只读，插入点/角色/消息表单/填充来源/去重等绑定在卡片内标注为固定，避免改动被静默丢弃（行为策略待独立策略存储接线后放开）。
- **独立指令策略存储与工作台策略控件**：`src/host/instructions-policy.ts`（`$DSH_HOME/.prompt-tool/instructions.yml`，默认 `enabled: false`）用 Document API 保留注释与未知字段、内容版本乐观并发、严格字段白名单、损坏文件拒绝写入；新增 `/instructions-policy` 端点（省略 `policy` = 读取，写入带 `expectedRevision`），文件卡的启停、顺序、位置、晋升、受众与模型范围改走策略，不再写 preset.yml。**注意**：注入侧尚未消费策略——运行时接线（W3/W4）完成前，这些字段与启停只做存储与回显，不改变实际注入，也不撤回已进入会话的内容。

### AGENTS.md 改为探测生成的文件卡（2026-09-14）

- **文件即真相**：插件不再写任何常驻内容——删除 `writeAgents` / `residentAgentsPath` 设置轴、`src/runtime/agents-file.ts` 受管块读写与 TUI/UI 开关；`$DSH_HOME/AGENTS.md` 恢复为用户完全自有的文件。
- **探测到才生成卡**：`writePreset` 每次重建都探测用户级 `$DSH_HOME/AGENTS.md` 与工作区 cwd→项目根链的 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md，为**每个已存在文件**生成一张 `agents-file-<路径哈希>` 卡（`pre-step` + `position: after-user`，对齐官方 `@deepseek-ai/dsh-agent-instructions` 的插入点）；文件不存在就不生成卡。
- **卡内编辑框直接编辑该文件**：读配置时服务端把文件正文附在卡的 `params.text`（客户端提升到「自定义提示」编辑框），保存走新端点 `/agents-file`（按 `fileId` 命中服务端探测白名单才写盘，未知 id / 非字符串内容 400 拒绝），写盘为 tmp + rename。
- **参数不落预设**：文件卡是生成目录产物，`/param-overrides` 写 preset.yml 时整卡剔除（`preset.yml` 只保留用户自己的卡）；卡片定义与正文都不进预设。
- 注入内容 = 该文件正文：卡保持 `fill: instruction-hint`（填充来源「指令提示」），`engine/instruction-hint.mjs` 的 `params.file` 分支每次注入时重读文件（`Instructions from: <显示路径>` 头 + 全文），文件缺失/不可读/空则不注入；`params.text`（自定义提示）优先，`params.scope`（all/global/project）保留无 file 时的区域提示；删除 `agentsInstructionPath` 物化文件通道。
- 空白模板 `custom` 用 `preset.yml#agentsHints: false` 保持显式空组合；回归测试见 `test/host/agents-cards.test.mjs`（探测/卡形状/写盘/白名单）与 `test/host/write-preset.test.mjs`（各模板生成且不落 preset.yml）。

### 移除预设根目录配置（2026-09-14）

- 删除 settings 轴 `presetDir` 与「预设和配置」页的「预设根目录」输入行：预设根固定为官方 `$DSH_HOME/.agent-presets`（`host/paths.ts#DEFAULT_PRESET_DIR`），不再从 settings/descriptor 读取，也不再经 `registerSettingsBridge` 的预设根回调透传。
- 客户端 `Fields`、脏检测快照、保存 ops 与 zh/en 文案同步删除该键；旧 settings.yaml 里的 `presetDir` 值不再被读取（schema 不含该键，无运行时迁移），自定义根下的预设需自行移回官方预设根。

### 前端审查修复：预设切换事务与交互缺陷（2026-09-14）

- 预设切换改为事务：当前预设草稿保存失败（含被跨预设守卫拒绝）时取消切换并保留草稿；切换成功后等待 settings 写入与随后的静默 load 完成才返回，不再出现「已切到新预设、界面仍是旧预设数据」的可编辑窗口。
- 新增 `loadedPresetRef` 写盘守卫：预设切换/首次加载完成前，参数、promptConfigs 与模板变量保存一律拒绝并提示，旧预设字段不会带新 `presetTemplate` 写入目标预设；目标预设数据成功应用（或重新加载成功）后自动恢复写入。
- 模板变量插值开关保存时随同传入新值，修复开关与保存在同一事件中触发时落盘旧 `enabled` 的问题。
- 子代理工具策略读取失败进入显式错误态并提供重试，不再把失败降级成「未启用策略」——修复随后「启用并保存」会用新策略整体覆盖磁盘既有策略的数据风险。
- 技能列表筛选保留命中项的祖先节点：搜索或状态筛选只命中嵌套子技能时，父节点作为树容器保留，子技能不再从渲染结果里消失。
- 工作台抽屉（`aria-modal`）补齐首尾 Tab 焦点循环（焦点位于 portal 弹窗内时由弹窗自行接管）；角色卡图片选择器收窄为 PNG，与解析范围一致。

### 参数链路修复与模板变量来源收敛（2026-09-14）

- 预设级模板变量只读取顶层 `variables`，删除从 `params` 猜测内容变量的旧兼容；嵌套 `params.variables` 不受支持，旧数据不迁移、不删除。清空变量后不会由旧键重新生成，空字符串与局部变量覆盖仍保留。
- 保存模板变量不再删除同名引擎参数，显式 `false` 和 `0` 保留；阶段工具列表为空或含空工具名时在保存前拒绝，不写盘、不重建。
- `cotDripEvery: 0` 与 `deliberationMinChars: 0` 透传到组合，分别禁用节拍和取消深思下限；`maxDepth` 数字字符串与数字共用归一化，普通委派与实例工具策略同步生效，非法字符串保存期拒绝。
- 自定义 `presetDir` 贯穿预设初始化、切换、参数及内容读取、物化和管理端点；同名预设不再被默认根遮蔽，换根时重新读取内容。

### 技能管理框架：磁盘即状态，管理数据移出 settings.yaml（2026-09-14）

- **停用策略改为文件事实**：停用 = 技能目录里的 `SKILL.md` 改名为 `SKILL.md.disabled`（启用 = 改回）。官方 `dsh-skill-filesystem` 与本插件都只认未加后缀的标记文件，因此一次改名同时让两条发现链路消失/恢复该技能——修复上一版「关掉的技能仍由官方 provider 提供给模型」的遮蔽问题；热生效、可逆、可手工还原，卸载插件后仍是普通技能目录（与 Fishquito7/dsh-skill-mcp-panel 的停用约定一致）。
- **技能管理抽离 settings.yaml**：新增 `$DSH_HOME/skills/.system/prompt-tool/config.yml`（官方用户技能根的 `.system` 段被 `skipSystem` 忽略，永不会被当成技能），承载附加技能根 `dirs`、展示顺序 `order`、rank 基数 `rankBase`；`skillSwitches` 不再是配置（由磁盘标记派生）。写入使用 yaml Document API 保留注释与未知字段、内容无变化不落盘、YAML 损坏时拒绝覆盖；文件变更由技能 watcher 热加载，手工编辑即时生效。
- **移除全部旧参数/旧内容迁移（本项目不含任何迁移代码）**：删除 `scripts/migrate-presets.mjs`、`scripts/migrate-skills.mjs` 及其 npm script 与测试；删除运行时迁移 `src/host/migration.ts`（旧布局归档 / 旧 `preset.yml` params / `prompt-tool.overrides.yml` 通道）、`migratePersonaLoaderConfig` 与启动重建时的旧 persona 组合修正、旧 `official-tool-cordis` 模块移除、旧 `worldBook` 段 → promptConfigs 迁移、旧容器兼容快照（`legacyAliasHandled`/`aliasOf`）、`.pt-seeded` 旧标记迁移。`scripts/rematerialize-presets.mjs` 只做当前契约的重新物化（`--no-migrate` 参数一并移除）。升级旧数据需自行整理。
- **旧键彻底移除**：settings schema 与 loader config 不再声明 `skillSwitches`/`skillOrder`/`skillsDirs`/`skillsDir`/`skillRankBase`（旧值不会被读取或迁移）；客户端 `Fields` 去掉 `skillSwitches`，启停状态直接取 `skillCatalog[].disabled`（TUI 同源）；`PresetSpec.worldBook` 字段与 `prompt-tool.overrides.yml` 保留逻辑删除。
- **链路改道**：新增 bridge 端点 `/skill-toggle`（启停）与 `/skills-config`（顺序/目录/rank），`describe`/`bootstrap` 直接下发技能配置事实；客户端保存与批量启停、TUI `/prompt-tool skill` 全部改走磁盘标记；`/skill-fix` 对停用态照常修复并保持后缀；包内技能版本升级保留用户的停用态。
- **移除 `skills/manifest.json`**：包内技能不再有手写版本清单，改为**内容哈希账本**——`$DSH_HOME/skills/.prompt-tool-manifest.json` 记录每个技能部署时包内容的 sha256，包内容哈希未变就不碰副本（用户本地改动保留），变了才整体覆盖；包根探测锚点从「有 `skills/manifest.json`」改为「同时有 `package.json` 与 `skills/`」（`src/host/paths.ts`）。旧格式账本读不出哈希，升级后首次启动会按当前包内容重铺一次包内技能（停用态仍保留，本地改动会被这一次覆盖）。

### 技能安装副本改到 $DSH_HOME/skills（2026-09-13）

- 包内 `skills/` 的安装副本从 `$DSH_HOME/profiles/<profile>/skills` 改到 `$DSH_HOME/skills`——官方 `dsh-skill-filesystem` 的 `user-dsh` 技能根。副本跨 profile 共享，官方 provider 与本插件从同一目录发现技能；版本化覆盖语义不变（包内技能按 `skills/manifest.json` 升级覆盖，用户自建技能保留）。旧副本目录不再使用，也不清理。
- 当时已知后果：官方 provider 从同一目录注册同名技能，且预设层遮蔽宿主层（`dsh-skill` 注册表规则），因此「技能开关」只对插件自己的注册生效，关掉的技能仍会由官方 provider 提供给模型。**已被上方「技能管理框架」一节的磁盘标记停用修复**。
- `resolveProfileSkillsDir(ctx, sourceDir, warn)` 更名为 `resolveSkillsDir(sourceDir, warn)`（不再依赖运行上下文，目标由 `host/paths.ts#DSH_HOME` 解析）；UI「默认副本」提示、配置注释与 `test/host/profile-skills.test.mjs` 同步更新，测试断言目标为 `$DSH_HOME/skills` 且不再写 profile 目录。
- 修技能 watcher 的目录删除洪泛：被 watch 的目录删除/改名后 Windows 会持续上报事件（实测每秒十万级），防抖计时器被反复重置导致进程无法退出（表现为 `pnpm test` 挂死不退出）、CPU 满转。事件回调先确认目录仍存在，目录消失就关闭该目录的 watcher；新增 `test/host/skills-watcher.test.mjs` 用子进程断言删除后能自然退出。

### rc.2 收尾：官方 locale、模型元数据与同步结果（2026-09-13）

- 悬浮入口补计划约定的交互细节：位置存储键固定为 `dsh-plugin-prompt-tool:trigger-position`（兼容早期 `:floating-trigger` 旧键），夹取时保留 8px 视口边缘留白；`@deepseek-ai/dsh-client-ui-sidebar` 在几何探针下线后失去最后一个消费方，从 `dsh.client.inject`、peer、dev 与 lockfile 移除。
- 官方 locale 词典接入：新增 `src/client/locales.ts`（zh 为键集事实源、en 用同键集类型约束，`locales-params` / `locales-prompts` / `locales-cards` 按 feature 分区后合并注册），经 `ctx.effect(() => registerPromptToolLocale(ctx.locale))` 注册与释放；工作台入口、设置页、六页外壳与技能/预设/角色/工具页面文案迁移到官方 `prompt-tool` 命名空间（含子代理「工具与深度」模块卡、实例级工具策略与自定义工具卡），slot 注册声明 locale namespace，设置 tab 标题改用动态 thunk；新增 `test/client/locale-contract.test.mjs` 守卫（键集一致、注册可释放、关键 UI 文件无硬编码长文案）。
- 模型档位来自官方元数据：新增 bridge 端点 `/model-reasoning` 与 `ModelReasoningView`（`known` / `efforts` / `defaultEffort`），模型路由卡不再硬编码 `off / low / high / max`；无推理能力时不虚构档位，已保存但不在目录中的值保留回显，目录只作展示不作授权白名单。
- 默认模型同步可等待、可观察：新增 `ModelSyncResult`（`synced / unchanged / unavailable / failed` + 安全消息）随预设保存响应返回，UI 能分别显示「预设已保存」与「默认模型同步失败/不可用」并可重试；模型目录缓存在官方 `llm/adapters-updated`、服务重挂与显式刷新时失效，provider 单点失败不清空其他成功分组。
- 验证补充：无同级官方源码的消费安装 smoke（tarball 安装后 21 个 peer 与 10 个 client inject 包全部解析到 `0.1.5-rc.2`）；隔离 `DSH_HOME` + 随机端口的真实宿主 smoke（客户端 module boot graph 含本插件、插件 client bundle 正常下发、完整 profile 的 manifest 未被改写）。

### DSH 0.1.5-rc.2 组合对齐与依赖基线（2026-09-13）

- 依赖基线精确到 `0.1.5-rc.2`（Cordis `4.0.2`）：peer 范围 `^0.1.5-rc.2`、dev 精确锁定、移除全部指向 `../deepseek-harness` 的默认 `overrides: link:` 与失效版本例外；新增直接依赖 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-agent-default-model` / `dsh-subagent` / `dsh-tool-subagent` / `dsh-package-manifest` / `dsh-client-locale`（dev）与 `semver@7.8.5`，每个都有真实消费者。
- 新增 `scripts/verify-host-contracts.mjs`（`pnpm verify:host`）：报告每个直接官方包的声明范围、安装版本与解析目标，拒绝非 `node_modules` 解析（源码 link）、dev 版本漂移、未声明的官方 import 与缺少 peer 的 `dsh.client.inject`。
- 组合重建改用固定 fixture `test/fixtures/dsh/0.1.5-rc.2/`（tag `dsh-v0.1.5-rc.2`、commit `fb2c4b9e`，逐文件 SHA-256 登记在 `PROVENANCE.md`），不再读取开发机同级官方源码；生成产物记录来源 tag 与 commit。
- 对齐官方 rc.2 组合漂移：`present`（`@deepseek-ai/dsh-tool-present`）进入 standard / ptc / creative 的行序；官方 minimal 已删除 `filesystem` 组，内置 Minimal 同步为单 shell 工具基型。
- `bootstrap-filesystem` 改为本地模块 `engine/compositions/source/local/bootstrap-filesystem.yml`：Anchored 与既有用户预设仍可显式引用（`fs-local` + `str-replace-editor` 同隔离域、旧 `str-replace-editor` 别名不变），不再声称来自官方 minimal。
- 新增 `test/host/version-contract.test.mjs` 锁定版本判定与解析来源，`test/fixtures/.../PROVENANCE.md` 指纹用例锁定固定输入未被本地 master 污染。

### 悬浮入口恢复，移除官方右侧栏（2026-09-09）

- 恢复 `shell.overlay` 悬浮入口：`FloatingTrigger`（左上角按钮）+ `WorkbenchOverlay`（body portal 右侧抽屉）+ `SidebarGeometryProbe`（`sidebar.footer.action` 几何探针，输出 `--pt-sidebar-edge`）+ `PromptToolWorkspaceController`。
- 抽屉经 body portal + `position: fixed` + `z-index: 1000`（触发器 1100）置顶，修复弹出悬浮层被宿主「对话/轨迹」顶部导航栏遮挡的问题。
- 官方右侧栏实测不适合本项目：移除 `ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` 两段注册、`PromptToolTab` 与 `sidebarRightTabs` inject；`@deepseek-ai/dsh-client-ui-sidebar-right` 退出 peer/dev 与 `dsh.client.inject`。
- 依赖恢复：`@deepseek-ai/dsh-client-ui-layout`（`shell.overlay` 声明）与 `@deepseek-ai/dsh-client-ui-sidebar`（`sidebar.footer.action` 声明）进入 peer/dev 与 `dsh.client.inject`，版本对齐 `^0.1.5-alpha.1`。

### persona 全量迁移到官方 dsh-persona 行（2026-09-09）

- `preset.yml` 顶层新增 `persona` 段（官方 `@deepseek-ai/dsh-persona` 行 config 同构：`prefix` / `suffix` / `complete` / `includeRuntimeContext`），替换旧的 `promptConfigs` 人设配置卡；`renderComposition` 对 `modules` 清单预设自动前插官方 persona 行，顶层段是行 config 的唯一数据源（段内省略键删除库行默认值，修复未声明 `suffix` 的预设继承库行标准 suffix 的行为缺陷）。
- 运行时移除 persona 专属分支与子代理 persona 卡合并语义：`deployment:persona-prefix` / `deployment:persona-suffix` 按普通 system-section 处理，子代理独立人设走 `moduleConfigs.tool-subagent.persona`（官方 per-child persona，不继承主会话）；`engine/layers.mjs`、`src/host/{manifest,characters,sillytavern,write-preset}.ts` 同步。
- 新增 bridge 端点 `/persona` 与工作台「预设人设」卡（`src/client/features/persona/PresetPersonaCard.tsx`）；提示词配置卡删除「人设」开关（「动态抑制」保留为普通 system-section 参数）。顶层 `persona.complete` 与提示词配置「独占」互斥，写盘前 400。
- `scripts/migrate-presets.mjs` 离线迁移旧人设卡：prefix/suffix 拆分、`complete` / `includeRuntimeContext` 合并、子代理卡 → `tool-subagent.persona`、多卡全删、写盘前备份；运行时无兼容层。
- SillyTavern 转换与角色卡导入改用顶层 persona 段（含 system-section 时 `prefix: ''` + `complete: false`）。

### 0.1.5-alpha.1 全量对齐（2026-09-09）

- 依赖声明统一为 `^0.1.5-alpha.1`（peer + dev），新增 `@deepseek-ai/dsh-client-ui-sidebar-right` 与 `@deepseek-ai/dsh-client-ui-slots` 依赖边；`dsh.client.inject` 改声明右侧栏包，移除已无引用的 `dsh-client-ui-sidebar`。
- 工作台从自建 `shell.overlay` 抽屉迁移到官方右侧栏：`ctx.sidebarRightTabs.register`（tab type + guide 入口盒）+ keyed `sidebar.right.pane.tab`（body）；删除 FloatingTrigger / SidebarGeometryProbe / WorkbenchOverlay / workspace-controller / Workbench.module.css，不再自建 portal、几何探针或面板互斥事件。
- `ToggleRow` 改用官方 `Switch`，删除自建 checkbox 与配套 CSS 开关样式。
- 新增 `test/host-contract.test.mjs`：锁定客户端 slot 面、版本声明、非 pre-step 五层注入时序与已移除宿主 API（`conversation.details.tool`、`session.events`、`tool/code-dispatch`）。
- P3 评估：`openPath` 已走宿主原生打开器；`ctx.workspaceFiles` 与 DSH_HOME 路径域不匹配；`client-resources` 资源 tab 暂不采用（详见 [docs/ui-architecture.md](docs/ui-architecture.md) §4.4）。
- 清理右侧栏迁移残留：`dsh.client.inject` 与 peer/dev 依赖移除已无引用的 `@deepseek-ai/dsh-client-ui-layout`（原 `shell.overlay` 抽屉的宿主包），`pnpm-workspace.yaml` / `pnpm-lock.yaml` 同步删除 `ui-layout`、`ui-sidebar` 两条死 override；SillyTavern 转换的注释与文档同步 `dsh-persona` 新字段名（`prefix`）。

### 官方宿主契约对齐修复（2026-09-09）

- 对齐官方 `dsh-persona` 契约升级：`config.text` → required `config.prefix`（+ 可选 `suffix`），系统提示段名 `deployment:persona` 拆为 `deployment:persona-prefix` / `deployment:persona-suffix`。`engine/compositions/library/persona.yml`、五个内置预设的 `persona-main` 卡、层识别与 UI/角色卡判定同步更新；旧段名由 `scripts/migrate-presets.mjs` 离线迁移，不保留运行时兼容。
- 新增 `migratePersonaLoaderConfig`：渲染路径与启动重建都会把用户目录旧 `text:` 的 `dsh-persona` 行就地迁移为 `prefix:`，手写或旧产物预设无需逐个手动切换。
- 组合产物写入 `# prompt-tool:render v2` 契约标记；启动重建据此重刷用户目录旧产物（仅 `modules`/`params` 格式预设，手写预设不覆盖）。
- 修复全局 junction 安装（`npm-global/@deepseek-ai/dsh` → 真实包目录）下 `Cannot find module '@deepseek-ai/dsh-tools'`：宿主包解析改为 realpath 优先（`engine/host-package.mjs`），`tool-config-engine` 与 `subagent-tool-policy` 共用。
- Creative 不再复制 `tool-cordis`：该行注册进程全局 `cordisInspect` provider（id `Service`），与官方 shipped「创造模式」(`cordis`) 预设同时挂载会重复注册；该能力由官方预设提供。

### 框架验收缺口修复

- 参数流程文档改为条件发送语义；参数与提示词配置保存共用预设队列，旧响应不再重载覆盖新草稿。
- Bridge 严格区分空请求与畸形 JSON，拒绝错误参数、提示词配置和变量结构；所有依赖当前预设的写端点统一拒绝 system 预设，并允许配置的自定义 `presetDir`。
- 工具面局部样式迁入 CSS Modules，并使用 DSH 语义 token 与 `0.5px` 中性边框。
- JSON 请求继续限制为 32 MiB；角色卡原始流独立上限修正为 64 MiB，并覆盖边界与超限清理测试。

### 模型路由选择器

- UI 移除独立服务商下拉，仅保留模型选择；模型目录按服务商分组展示，选中项内部同步 `provider` 与 `model`，主会话和子代理路由共用同一完整目录。

### 内置预设与组合库对齐

- Anchored Standard 内联快照同步到 `180184c`：核心双工具/晋升配置显式收敛到 `preset/anchored/preset.yml`；通用 `instruction-hint` 引擎补齐 cwd→项目根完整探测、建议式措辞和随机 UUID，避免宿主重启竞态下确定性消息 ID 冲突。
- DSH 最低运行版本统一为 `0.1.2-alpha.4`，依赖范围同时接受当前 `0.1.3-alpha.1`；会话历史读取继续只走正式 `snapshotEvents()` API。
- `context-gate.instructionHint` 改按 `session.deriveMessages()` 的模型可见 surface 去重：重挂不重复，压缩未覆盖或失败时保持，确被遮蔽后重新提示；晋升与 PTC 仅在成功 `compaction/end` 后重置。
- 删除内置 `preset/liangshen` 与专属回归；严格门控、延迟注入等通用引擎参数继续保留为用户预设 opt-in 能力。
- 对齐 DeepSeek Harness `0.1.2-alpha.4` 四套官方预设：PTC 使用 `mode: ptc` 与禁用 `tool-workflow` 的 delegation 变体；Creative 恢复 Cordis 官方行顺序并更新内置编辑技能。
- `rebuild-composition` 改为从 `standard/minimal/ptc/cordis` 全量重建：本地模块自动发现并只保留在 `source/local/`，官方切块/变体只生成到 `library/`；装配发现跨目录同名即失败，另加官方行语义覆盖校验、孤儿文件清理、失败安全替换，并清除模块间串入的下一段注释。
- 新增内置预设顺序/变体、组合去重、source/local 与 library 分工、通用 instruction-hint 复用回归；完整测试 `437 pass / 0 fail`。

### 子代理页入口回归修复

- 工具与深度卡恢复 `maxDepth` 递归深度下拉，入口回归子代理页；主会话工具管线卡不再重复展示该参数，避免双入口。

### 渐进披露 UI 修复

- 修复 `stages` 点击「添加阶段」后空草稿被保存重载立即清除的问题；未完成阶段保留在 UI，名称与工具集填写完整后仍按原校验写入 `preset.yml`。

## 0.8.0 明细 · 参数 / Bridge / Engine 重构（2026-09-01）

### L2 参数、Bridge 与 Engine 重构

**参数契约与路径安全（Wave 1）**
- 参数保存前**全量校验**：`validateEngineParamValues` 覆盖全部 `ENGINE_PARAM_KEYS`
  （布尔/数值/字符串/列表/maxDepth/stages），未知键（旧内容别名等）保存期响亮失败，
  不再运行时自动兼容旧参数。
- 移除旧内容参数别名 `guideComplexPattern`（PARAM_KEYS 与 writePreset 回退读取一并删除）。
- 生成文件名统一 **4 位零填充前缀（`0000-`）**：prompt-configs / custom-tools / 校验预览，
  超过 10 条后字典序仍稳定。
- 提示词配置 / 自定义工具 ID 做**安全文件名校验**（禁路径分隔符 / Windows 保留字符），
  物化前 fail loud，防越出生成目录。
- `manifest.ts` 严格 YAML 解析（带文件上下文）、composition / 模块路径 containment、
  `preset.yml` 增量写原子化（tmp + rename）。

**Bridge、存储与异步安全（Wave 2）**
- loopback Origin 校验补全 scheme/host/port：Origin 端口必须与本桥 Host 端口一致，
  防本地其他端口服务跨站。
- `installDefaultModelRoute` 支持 `saveSelection` 返回 Promise 并捕获拒绝（不再
  unhandledRejection）；模型查询超时改用 AbortSignal。
- AGENTS.md 受管块 / profile manifest / skills 副本全部原子写（tmp + rename），失败保留旧文件。
- 角色卡 PNG 解压设置输出大小上限（16 MiB 防 zip bomb）；三文件（avatar/card/converted）
  临时目录整目录原子替换。
- skills-watcher 递归监听嵌套技能目录；bridge-contract 增加端点级请求/响应类型映射。

**Engine / 前端 / 脚本 / 文档（Wave 3）**
- `createPromptConfigs` 拒绝重复 ID；`templateFile` / 相对 configsDir 只允许预设根内。
- engine 各 session Map 增加上限（4096 会话清空防无界增长），保持 epoch / waterfall 语义。
- 前端：允许主动清空全部 `promptConfigs`（初始化期空数组仍受守卫）；世界书筛选视图的
  移动/排序只作用于可见集合；抽屉关闭焦点还给触发器；几何探针不假设宿主父节点层级。
- 技能设置「目录与来源」以 `skillsDirs` 完整配置列表为展示源；仅空配置时展示 profile
  默认副本，新增目录不再因 `activeSkillsDirs` 尚未刷新而漏显。
- 悬浮触发器几何真动态：探针直读官方 AppFrame 侧栏轨道（inline
  grid-template-columns 第一段，锚点 = 官方公开 data-sidebar-collapsed 属性，
  不 querySelector 宿主），覆盖折叠 56px rail / 拖拽 264–420px / 断点自动折叠
  全部形态；删除侧栏几何死常量（旧 36 系误判 rail 控制盒为列宽——折叠态按钮
  实际压进 rail 5px，12 系 footerActions 容器口径补偿）；28px 按钮圆缘与
  侧栏右缘相切贴靠（GAP 0：命中区贴线，可见图标因居中偏移与侧栏保持 5px
  微呼吸），CSS 回退 56px（折叠 rail 宽）首帧即折叠态相切位置；transitionend
  兜底轨道过渡结束重读。
- 修复展开态按钮不跟随：几何锚点原用官方折叠标记属性——它是条件属性
  （展开态被 React 移除），爬链落空后 update 直接跳过。锚点改为官方布局根
  的恒定特征 inline grid-template-columns（折叠/展开/拖拽全形态都写，永不
  缺省）；契约测试加防回归断言（禁止条件属性作锚点）。
- 新增离线迁移脚本 `pnpm migrate:presets`：旧 worldBook → promptConfigs、旧扁平模型键 →
  顶层段、旧覆盖文件并入 params；dry-run / 备份 / 失败非零。
- `rebuild-composition` 改为备份 + rename 的失败安全替换。

**不再自动兼容旧参数**：旧参数（`guideComplexPattern` 等）、旧 `worldBook` 段、
旧覆盖文件统一走 `pnpm migrate:presets` 一次性离线迁移；运行时不读写旧结构。
## [0.7.2] - 2026-08-31

### 统一中文发布说明

- Git 标签、GitHub Release 与版本更新说明统一使用简体中文。
- 运行时代码与 0.7.1 相同，继续提供 DSH 0.1.2-alpha.2 兼容迁移。

## [0.7.1] - 2026-08-31

### 迁移 DSH 0.1.2-alpha.2

- 官方 DSH peerDependencies 与 devDependencies 升级到 0.1.2-alpha.2。
- 使用静态 settings namespace 字面量，移除对已删除的 `settingsNamespace()` 运行时导出的依赖。
- 使用官方 `ctx.settings.installSection()` 接管 settings 注册、配置来源切换与 provider detach 回退。
- 删除重复的 settings 注册自愈层，并同步更新 Host 测试桩与 bridge 调用。

## [0.7.0] - 2026-08-30

### 工作台入口改为左上角悬浮按钮（2026-08-30）

- `shell.overlay` 继续负责工作台生命周期，但可见触发器通过 `createPortal(..., document.body)` 落在对话界面层，避开 AppFrame/工作台侧边栏的裁剪；`sidebar.footer.action` 只渲染自有几何探针。
- body portal 浮层容器的纵向位置对齐 DSH-better-sidebar 展开按钮：默认 `top: calc(3px + env(safe-area-inset-top))`，标题栏兼容态跟随 `--dsh-title-bar-strip`；按钮本体保持 28×28px。
- `ResizeObserver` 读取真实侧边栏边缘，跟随 264px 起步宽度、用户拉伸及 56px 折叠 rail；浮层使用 `position: fixed`、动态 left 加 10px 间距与 `z-index: 60`，保留 token 驱动的 hover / active / focus 样式。
- 右侧抽屉、Escape / 背板关闭、与 taskboard/ssh 的互斥事件以及设置页 tab 保持不变。
- 契约测试锁定 `sidebar.footer.action`、`settings.plugins.tab` 与 `shell.overlay` 三条官方注册边，并验证几何探针与顶层触发器。

### 官方 Agent 预设设置与提示词工具双向同步（2026-08-30）

- 补齐此前缺失的反向通道：监听 Host `settings/updated`，当官方
  `agent-presets.default` 变化时，回写 `prompt-tool.presetTemplate`；随后复用现有
  SettingsScope watcher 执行内容重读、目标预设物化、内置工具重挂与 Web descriptor
  失效。官方设置菜单切换后，提示词工具的预设状态现在会同步跟随。
- 正向同步增加权威当前值比较：`prompt-tool.presetTemplate` 与
  `agent-presets.default` 已相同时不再写入，避免双向事件回环和重复 rebuild。
- 正常 settings attach 时以官方 default 为共享事实反向对齐；旧布局迁移时仍由插件
  修复已失效的旧 `prompt-tool` default，两条路径互斥，避免启动期异步写竞态。
- 对官方设置中本项目无法解析/编辑的 shipped 或第三方预设保持不跟随，并输出明确
  warning，避免把无效 `presetTemplate` 写入后导致生成失败。
- 新增行为测试：官方 default 从 anchored 切到 creative 时仅回写一次本项目设置，
  相同值重复通知不重复写入，反向同步后不再正向写回官方 namespace。
- 验证：typecheck / lint / test 385 pass 全绿；真机完成 `beta-2-42 → creative → beta-2-42` 双向切换，兼容快照 10 个文件零改写。

### 修复 Windows 切换 Anchored 时 pwsh 重复注册（2026-08-30）

- 根因：Anchored 同时装载普通 `tool-pwsh` 与 Minimal 的 `persistent-shell`；重建脚本
  注释声称保留 `persistent-shell` 的 Windows 整组禁用，但实际 PATCHES 只加入了
  `shellPath` 补丁，导致 `persistent-pwsh` 在同一 tools scope 再次注册 `pwsh`。
- `rebuild-composition.mjs` 为 `persistent-shell` 补回组级
  `disabled: !!js process.platform === 'win32'`，并从官方源重建组合库；Windows 只启用
  普通 `tool-pwsh`，POSIX 继续使用持久 shell。
- 已原地修复当前 `DSH_HOME/.agent-presets/anchored` 与 `prompt-tool` 生成物；官方
  `ensureStanding()` 在挂载失败时会删除 standing cache 并 dispose 半挂载 scope，下一次
  切换会重新读取修复后的文件，无需重启。
- 新增组合互斥回归断言，锁定普通 pwsh 与 persistent-shell 的平台守卫。
- 验证：typecheck / lint / test 381 pass 全绿。

### 旧会话兼容预设改为一次性快照（2026-08-30）

- 移除日常 `rebuildPreset()` 热路径中的 `prompt-tool` 别名同步：普通预设切换只重建
  当前目标，不再创建、更新或复活旧会话兼容目录。
- 兼容快照仅在检测到真正旧容器（目录无根 `preset.yml`）的升级场景处理一次；
  `.prompt-tool-state.json` 写入 `legacyAliasHandled: true` 后永久结束兼容创建，
  用户删除快照后不会自动恢复。
- 迁移器改用结构判定：无根 `preset.yml` = 旧容器；有根 `preset.yml` = 已生成的
  兼容快照，不得归档为 `prompt-tool.bak-*`。
- `listPresets()` 继续隐藏 `prompt-tool`，它只用于历史会话按旧 id resolve，不进入
  普通预设下拉或补建循环。
- 保留 `writePreset({ aliasOf: true })` 作为一次性快照生成器：复制源 `preset.yml`
  参数源并写入固定 id/name，日常切换不调用。
- 新增回归：兼容快照不被迁移器归档、普通列表隐藏、已处理状态下初始加载/官方
  默认切换均不创建或复活 `prompt-tool`。
- 验证：typecheck / lint / test 385 pass 全绿；启动与两次官方设置切换期间兼容快照 10 个文件的 SHA-256、长度、时间戳零变化。

### 官方 slot 工作台全面迁移（2026-08-30）

- 客户端 UI 从「自建 React root + MutationObserver + 宿主 CSS 选择器」整体迁移到官方
  SlotRegistry：`sidebar.footer.action` 侧边栏入口、`shell.overlay` 右侧抽屉工作台、
  `settings.plugins.tab` 基础设置页三个注册共享同一 controller。
- 删除 `workspace-mount.tsx` / `sidebar-entry.ts` / `host-surface.ts` 及全部宿主 DOM
  选择器（`centerCol` / `logoRow` / `data-pane` / `data-dsh-workspace-slot`）；焦点、
  显隐、卸载回收全部由官方 slot 生命周期接管。
- 抽屉常驻挂载（CSS 显隐），store 状态跨开关保留；Escape 关闭 + 背板点击关闭 +
  与 taskboard/ssh 的 `dsh-panel-activate` 兼容互斥保留。
- `settings.plugins.tab` 提供基础开关（writePreset / writeAgents / injectAgentsPrompt /
  presetTemplate）直读直写官方 SettingsScope；预设下拉数据来自 `/meta`。
- `dsh.client.inject` 新增 ui-renderer / ui-layout / ui-sidebar / ui-settings-plugins
  四个声明包；代码 inject 新增 `slots` 服务。
- 新增 slot 契约测试（三槽位注册、无宿主 DOM 依赖守护）与 facade inject 边更新；
  验证 typecheck / lint / test 379 pass 全绿。

### 前端迁移官方 slot 系统（2026-08-30）

- UI 挂载全面迁移到官方 SlotRegistry：`sidebar.footer.action`（Settings 旁侧边栏
  入口）+ `shell.overlay`（右侧抽屉工作台，接受浮层/抽屉形态）+
  `settings.plugins.tab`（官方设置面板插件 tab：writePreset / writeAgents /
  injectAgentsPrompt / presetTemplate 基础开关）。三个注册共享同一个
  `PromptToolWorkspaceController`，生命周期由 `ctx.slots.inject` + `ctx.effect`
  接管，HMR / 卸载自动回收。
- 删除自建 DOM 挂载层：`workspace-mount.tsx`（createRoot + MutationObserver +
  CSS 选择器）、`sidebar-entry.ts`（DOM 自愈插入）、`host-surface.ts`（全部宿主
  选择器集中层）。官方 skill 文档明确禁止操作 `document.body` 与硬编码宿主选择
  器，本次迁移彻底消除该违规。
- 新增 `slot-workbench.tsx`：抽屉面板常驻挂载（CSS 显隐 + transform 动画），
  store 状态跨开关保留；Escape 关闭 + taskboard/ssh 兼容互斥事件保留。
- 依赖边扩展：`dsh.client.inject` + peerDeps + devDeps 增加
  `dsh-client-ui-renderer` / `ui-layout` / `ui-sidebar` / `ui-settings-plugins`
  （pnpm workspace link 本地官方仓库，版本 0.1.2-alpha.1）。
- 测试更新：新增 slot 契约测试（三槽位注册 / 无 DOM 挂载 / 入口家族几何 /
  抽屉样式 / 依赖边）+ `no-host-dom.test.mjs`（客户端装配层无宿主 DOM 依赖守护）；
  删除 `sidebar-entry-layout.test.mjs` / `host-surface-centralized.test.mjs`。
- 验证：typecheck / lint / test 379 pass 0 fail（_temp junction 下执行）。

### 修复模型数值参数保存反馈与参数文档漂移（2026-08-30）

- `/param-overrides` 写盘前新增契约层数值校验：主/子代理 `temperature` 必须是有限
  数字，`maxTokens` 必须是正安全整数；UI 字符串与 preset.yml 手写 number 两通道统一。
  留空仍表示删键回落默认；空白串、非数字串、布尔误填与越界值返回
  `400 overrides-invalid-value` 并逐字段提示，不再静默丢弃。渲染层保持宽容，
  不会因配置错误阻断 preset 物化。
- `savePresetParams` 修复极简 preset.yml（无 `params` / 模型段）时保存模型参数的
  YAML `deleteIn` 异常：旧扁平键与空值模型段清理改为存在性守卫，500 变为正常落盘。
- 参数文档同步：桥端点数修正为 25；`stagePreUnlock: 0` 明确为保留合法档位；
  `savePresetParams` JSDoc 与空值删键实现一致；`variables` 空字符串占位键保持
  有意设计，继续写入 `variables.yml`，供内部世界书工具动态登记与调整。
- 新增 `/param-overrides` 数值参数回归测试（非法值不落盘 + 合法 string/number 双通道）。
- 验证：typecheck / lint 全绿，376 测试通过（全部在 `D:\AI\workspase\_temp` junction 下执行）。

### 修复 /prompt-tool 命令标识符与保存失败反馈（2026-08-30）

- `skill` 与 `config` 子命令支持带空格的技能目录名 / 提示词配置 id：动作固定
  取最后一个 `on|off|toggle` token，内置 `web ui` 技能不再落入 usage error。
- 预设参数保存失败不再吞错后返回 success：`savePresetParam` 失败会传播到
  `CommandResult:error`，用户能看到具体写入/重建失败原因。
- usage 补齐 `guideEnabled`，并标注技能目录名与配置 id 可含空格。
- 新增 3 个回归测试（带空格 skill、带空格 config、保存失败返回错误）。
- 验证：typecheck / lint / build 全绿，375 测试通过。

### 对齐侧边栏入口家族样式（2026-08-30）

- 「提示词工具」侧边栏入口与任务看板、记忆系统家族统一：36px 行高、
  24×24 图标盒、18×18 图标与 1.5 描边；hover / active 改用通用
  `--dsw-alias-interactive-bg-*` token；折叠侧边栏时渲染为 36px 圆形按钮。
- 入口补齐 L2 语义属性 `data-dsh-plugin="prompt-tool"` 与
  `data-dsh-part="sidebar-entry"`，便于皮肤与插件面板统一识别。
- 新增静态回归测试，锁定家族几何、token 与折叠态样式，防止后续漂移。
- 验证：typecheck / lint 全绿，372 测试通过。

### 修复预设官方切换与切换前双重建（2026-08-29）

- 客户端补齐 alpha.1 官方 `agentPresets.select(sessionId, presetId)` 通道：
  当前会话为空时立即按官方 API 重组；会话已有内容时保留官方拒绝原因，并只更新
  后续会话默认预设，不再误报「当前已切换」。
- 声明 `remote.agentPresets` / `remote.session` / `sessions` 服务注入边，修复真机点击
  切换时 `cannot get property "remote.agentPresets" without inject`。
- 切换前保存当前未落盘配置卡时，`/param-overrides` 新增 `rebuild:false`：
  只写 preset.yml，不立即重建；settings 切换目标预设后再统一重建，消除切换前
  “保存当前预设 + 切换目标预设”的连续两次全量重建延迟。
- 验证：typecheck / lint 全绿，371 测试通过；Edge DevTools 真机确认
  `/api/agentPresets/select` 200、切换后 `/settings/mutate` 与 `/bootstrap` 正常。

### 修复引擎参数 0 值、保存竞态与未知键落盘（2026-08-28）

- `stagePreUnlock: 0` 修正为合法档位并保留落盘；UI 未设置默认显示 1，与引擎
  `undefined -> 1` 语义区分。`variables` 空字符串占位键保持原设计，继续写入
  `variables.yml`，不受引擎参数空值删键规则影响。
- 参数保存改为专用队列 + 发起时快照：成功后只标记该快照为已保存；请求期间继续
  编辑不会把新草稿误标为已保存，也不会被保存后的静默 reload 覆盖。脏检测改为
  SwitchSnapshot 全字段结构化深比较，修复大量参数键漏比较。
- `/param-overrides` 增加引擎参数键白名单，未知键与 `overrides.promptConfigs`
  误用 fail loud，避免写入读回/参数桥都不消费的死键。provider 自动预选不再在
  无模型名时被固化写入 preset.yml。
- `bridgePost` 增加桥载荷 runtime guard：成功必须包含 `value`，失败必须为
  `ok:false`，异常形状不再被直接 cast 成成功类型。
- 客户端 `Fields` 增加编译期 `EngineParamKey` 覆盖断言，并补齐
  `phase1FirstCallInstruction` / `stageAdvanceDescription` /
  `toolFilterSubagents` / `strReplaceEditorMaxOutputChars` 的读回、保存与 UI
  编辑入口；`guideEnabled` 保留 undefined 跟随语义。
- 验证：typecheck/lint 全绿，370 测试通过（新增未知参数键拒绝回归，更新
  stagePreUnlock=0 保留回归）。

### 修复 /configs-validate 64KB 上限与切换后参数源不同步（2026-08-28）

- `/configs-validate` 同样承载全量 promptConfigs（129 卡实测 70KB），此前沿用默认
  64KB 上限被静默截断为 400「unreadable JSON body」——保存按钮的权威校验在
  beta-2-42 上必失败。改为 8MB 预设包级上限 + 超限显式 413。
- `/bootstrap` 与 `/describe` 的激活预设参数源收敛到服务端 runtime 目录
  （getPresetConfigsDir），不再从 30s TTL 的 descriptor 缓存读 presetTemplate——
  切换预设后参数（presetParams）与配置列表/参数覆盖（promptConfigs/overrides）
  同源，消除旧值残留。
- 验证：typecheck/lint 全绿，369 测试通过（新增 /configs-validate >64KB 回归）。

### 修复自动保存空数组清空大预设配置卡 + 内置预设不恢复 + 开关 revision 冲突（2026-08-28）

- **数据摧毁根因**：L1 把 dirtyConfigs 从 JSON.stringify 比较改成引用比较后，
  store 初始化时 fields=EMPTY_FIELDS.promptConfigs（模块级常量 []）与
  savedConfigs=useState([]) 是两个引用不同的空数组 → 误判 dirty=true →
  挂载 800ms 后自动保存把空 promptConfigs 写进 preset.yml，beta-2-42 的
  129 张配置卡被一次清空。修复：promptConfigsDirty 对「两个空数组」判不脏，
  persistConfigs 对空数组（且无内容资产）直接跳过写盘双保险。
- **内置预设永不恢复**：ensurePresetSeed 此前 `seeded=true` 即 return，误删的
  内置预设永久消失。改为每次启动幂等补建缺失内置模板（existsSync 跳过），
  .pt-seeded 只作旧标记迁移。
- **全局开关打不开**：settings 注册重建（fiber reload）会把 namespace revision
  归零，客户端旧 revision 触发 settings-conflict。enqueueSave 冲突时自动重试
  一次不带 expectedRevision（官方语义 = last-write-wins），不再卡死需手动重试。
- 验证：typecheck/lint 全绿，369 测试通过（更新种子化/删除恢复行为断言）。

### 修复切换预设后配置卡出现慢 20+ 秒（2026-08-28）

- **根因**：客户端 `load()` 每次工作台加载都 `settings.ensure()` 触发宿主全量
  describe mirror RPC（官方遍历所有 settings namespace + 深度克隆 + schema
  序列化，插件多时十几秒），切换预设后配置卡要等这条 RPC 才出现。服务端写路径
  （writePreset 渲染 129 卡）实测仅 62ms，参数桥不慢。
- **修复**：`/bootstrap` 响应本就携带 settings descriptor（value/base/revision），
  客户端直接用它作 fields 主源，`load()` 不再 await 宿主 describe mirror；
  revision 只在首次建立、之后由 mutate 应答维护（避免 30s descriptor 缓存把
  revision 倒退导致下次保存 409）。
- 验证：typecheck/lint 全绿，369 测试通过。

### 修复 64KB 桥上限：大预设保存静默失败与切换卡顿（2026-08-28）

- **根因**：beta-2-42 实测 129 张配置卡，`promptConfigs` 序列化 70.2KB > 64KB
  默认桥上限。`readBridgeBody` 超限返回 `body: undefined`，`/param-overrides`
  handler 把写请求误判为「无载荷=读取」→ 保存静默失败，`load()` 回滚后 UI
  闪回，表现为切换预设/创建配置卡缓慢卡顿。
- **修复**：`/param-overrides` 与 `/import-preset` 写分支改用预设包级上限
  （8MB）+ 超限显式 413；客户端保存失败可被正确报告而非静默截断。
- **性能配套**：切换预设时 `persistConfigs({ reload: false })` 免双次全量
  load（保存后由 settings.mutate 回调统一静默刷新）；`PromptConfigCard` 全面
  memo 化 + `PromptConfigList` 稳定回调（编辑/拖拽 hover 只重渲受影响卡片）。
- **验证**：typecheck/lint 全绿，368 测试通过（新增 >64KB 载荷落盘回归测试）。

### UI 框架设计与性能修复（L1/L2/L3，2026-08-28）

- **L1 热路径修复**：dirty 检测弃用每渲染 JSON.stringify 大数组，改引用比较
  （patch 路径从不原地 mutate）；JsonField 同步 effect 依赖序列化结果而非对象
  引用（父级 patch 不再重置未提交 JSON 草稿）；PromptConfigList 显示顺序
  viewOrderedIds 由每卡 O(n log n) 收敛为列表顶层一次计算 position map
  （O(n log n) 总计）；内容资产（preset.md/agents.md）自动保存从逐条
  /import-preset 合并为单次批量请求（服务端只触发一次重建，此前每次保存 2-3 次
  rebuildPreset）。
- **L2 读取聚合**：新增 `/bootstrap` 端点（25 个端点），工作台加载/保存后刷新由
  5 个串行请求（/meta、/describe、/param-overrides、/preset-variables、
  /prompt-configs）合并为 1 个聚合请求；describe/meta/overrides/variables/
  prompt-configs 各端点保留供 TUI 与测试复用共享实现；`loadPresetSpec` 增加
  mtime+size 缓存（写盘路径与外部编辑均正确失效）。
- **L3 订阅式 selector 化**：store 返回引用稳定化 + `getFields/subscribeFields`
  订阅通道；新增 `usePromptToolFields`（useSyncExternalStore + 消费侧 ref 缓存）；
  页面组件（FeatureSettings/ConfigListWithTemplates/SubagentPage/PresetsPage/
  PresetSwitcher/CharactersPage）memo 化并订阅 fields 引用，父级 loading/notice/
  page 变化不再级联重渲染；技能设置页拆分为 SkillsSettings.tsx + SkillRow memo
  组件（开关/筛选/拖拽 hover 只重渲染受影响行）；PromptWorkspace.tsx 由 646 行
  收敛至 ~250 行。
- **验证**：typecheck/lint 全绿，367 测试通过（含 /bootstrap 契约测试与批量
  /import-preset 回调断言）。

### 修复 liangshen 预设缺 prompt-config-engine 行（2026-08-26）

- **根因**：liangshen modules 缺 `prompt-config-engine`（promptConfigs 执行器行）——
  persona-main 配置文件正常生成（10-persona-main.yml 在盘），但组合内无执行器装配
  → 人设段不注册、人设卡不生效。其余 5 个预设（anchored/standard/minimal/ptc/creative）
  均含该行，仅 liangshen/custom 遗漏（custom 无 promptConfigs 无影响）。
- **修复**：liangshen modules 补 `prompt-config-engine`（code-presentation 后，与
  anchored 同序）；writePreset 路径重写自动生效（name=../.engine/…、
  configsDir=../liangshen/prompt-configs）。
- **防回归**：liangshen 测试补断言（执行器行存在 + name/configsDir 重写正确）。
- **验证**：typecheck/lint 通过，351 测试通过。

### 子代理独立人设 = 配置卡（system-section + audience=subagent，替换主会话人设）（2026-08-26）

- **源码定稿**：`assembleContextFor(agent)` 注入 `{ agent, scope: agent }`——
  `AssembleContext.agent` 运行时可用，section text 函数可按 agent 判定子代理。
- **实现**：schema system-section 开放 audience；wireSystemSections 识别子代理
  persona 卡（audience=subagent + 人设段标记）并入 persona-main 段 text 分支——
  子代理装配 = 子卡文本（替换，不继承）；无子卡 = 静态文本（继承）。同名段不
  重复注册，complete/suppressRuntimeContext 透传不变。
- **删除**：`subagentPersona` 参数桥（4493fd7 恢复内容逆操作），配置卡为唯一入口。
- **验证**：typecheck/lint + 349 测试（+4：audience 放行/替换分支/继承/scope 过滤）。

### 子代理 persona 恢复官方 per-child shadow（2026-08-26）

- **源码核实**（E:\Documents\GitHub\deepseek-harness）：`tool-subagent` 行
  `config.persona` = 官方 per-child persona（子代理 scope 同名 `deployment:persona`
  段 shadow 全局）；`PromptSection` 无 audience、同名段重复注册抛错、AssembleContext
  仅不透明 ScopeKey——promptConfigs 配置卡无法承载 per-scope persona shadow，
  上一条"子代理 = pre-step 配置卡（继承+追加）"修正作废。
- **恢复**：`subagentPersona` 参数桥 + 子代理模型卡文本域（官方 shadow 机制，
  替换语义，自由编辑）；主会话仍为 persona-main 配置卡（mainPersona 删除有效）。
- **验证**：typecheck/lint/test 三连（347 + 恢复断言）。

### 人设参数桥移除：主会话 + 子代理一律配置卡模式（2026-08-26）

- **删除**：`mainPersona` / `subagentPersona` 参数桥与 UI 输入框全链移除（契约
  ENGINE_PARAM_KEYS/WRITER_PARAM_KEYS、writePreset 覆盖分支、manifest delegation
  persona 渲染、index runtime 透传、store/bridge 字段、模型路由卡两个输入框、
  preset.yml 与 5 个预设键、测试 2 条、README/docs）。
- **配置卡模式**：主会话人设 = persona-main 卡 text（唯一入口，无覆盖层）；子代理
  独立人设 = 新建配置卡（layer=pre-step + audience=subagent，继承主会话 persona 并
  追加专属段；无子代理卡 = scope 链继承，行为不变）。子代理 persona 语义变化：
  per-child shadow 整体替换 → 继承 + 追加。
- **验证**：typecheck/lint 通过，347 测试通过（-2：mainPersona 覆盖 + 子代理
  persona 渲染测试删除；audience=subagent 装配过滤已有测试覆盖）。

### 引擎模块审查修复：timer 清理 + config 校验一致化 + skill-search 测试（2026-08-26）

- **修复**（tool-config-engine）：shell 执行器 kill timer 无 clearTimeout——正常完成后 timer 残留到超时点；保存句柄 + 回调清理。
- **一致化**（custom-bash / run-code-env）：补 validateConfig + ALLOWED_KEYS，未知 config 键 fail loud（与其余 6 个引擎模块对齐）。
- **测试**（skill-search）：新增 6 用例覆盖 skill_search 匹配/截断/降级与 skill_load 注入/空 body/缺失分支（此前零直接测试）。
- **验证**：typecheck/lint 通过，349 测试通过（+6）。

### 移除浏览器验证模块：page-check / delivery-gate（2026-08-26）

- **删除**：`engine/page-check.mjs`（headless Chrome 页面验证：截图/DOM smoke/console/selector + `{js:}` 本地引擎）与 `engine/delivery-gate.mjs`（交付 gate：file/UTF-8 + headless smoke 复用 page-check + evidence 清单）及组合行（library/source/local 各 2 个 yml）、引擎测试 2 个。delivery-gate 代码级依赖 page-check（`import { pageCheckRun }`），故整链移除。
- **参数桥**：`pageCheckBrowserPath / pageCheckTimeoutMs / pageCheckLite / pageCheckRetry / pageCheckDescription / deliveryRequireSmoke / deliveryDescription` 7 个引擎参数键从契约（engine-params.ts）、装配（manifest.ts / preset-core.ts）、UI（EngineModuleCards 验证分区）、store/bridge、preset.yml 注释、docs（engine-reuse / architecture-params）全链移除；rebuild-composition MODULES 清单同步。
- **验证**：typecheck/lint 通过，343 测试通过（-12：page-check 8 + delivery-gate 4）。

### 保存后静默刷新：不再闪 loading / 滚动跳动（2026-08-25）

- **修复**：所有保存路径（参数失焦保存 / 模块列表自动与手动保存 / 开关保存 / 技能目录 /
  预设切换）后的 `load()` 改为 **silent**（不 `setLoading`、不触发骨架屏条件渲染）——
  保存后 UI 不再「刷新闪动」、滚动位置不再因 loading 重渲染风暴跳动。
- **保留**：首次挂载 / 手动刷新 / fixSkill 等非保存路径仍完整加载（loading 骨架）。
- **验证**：typecheck/lint 通过，355 测试通过。

### 模块列表自动保存：任意 UI 修改统一提交（2026-08-25）

- **自动保存**：模块列表的提示词配置修改（顶端总开关/卡片字段/增删/拖动排序——全部经
  `patch({ promptConfigs })`）debounce 800ms 后自动走 `persistConfigs` 写盘——与手动
  「保存」按钮共用同一保存逻辑；编辑中间态直存（跳过校验），手动按钮保留校验路径。
- **自愈**：保存成功 `load()` 更新 savedConfigs → dirty 消失；连续修改 debounce 合并；
  保存中再编辑下一次自动保存续写。
- **验证**：typecheck/lint 通过，355 测试通过。

### 预设切换即保存：模块列表未保存修改自动提交（2026-08-25）

- **修复**：切换预设（setPresetTemplate）前若模块列表有未保存的提示词配置修改
  （fields.promptConfigs ≠ savedConfigs），先 await persistConfigs 提交到当前激活预设，
  再执行切换——此前直接切换导致 load() 重置 fields、未保存修改丢失（UI 提示
  「有未保存修改 / 放弃修改 / 保存全部」但切换不联动保存）。
- **实现**：persistConfigs 返回 Promise（可等待）；setPresetTemplate 转 async +
  dirty 检测；已保存/无修改路径行为不变。
- **验证**：typecheck/lint 通过，355 测试通过。

### 角色卡导入自动开放 persona complete（2026-08-25）

- **修复**：applyCharacterToPreset 导入含 system-section 段的 ST 卡时，自动将激活预设
  persona-main `complete: true` 置 `false`（开放）——此前官方 complete 会抑制导入的
  character-definition / system-prompt / post-history 段（ST system prompt 层级开放
  需求；ST 转换自身已有 `moduleConfigs.persona = { complete: false }`，导入路径漏处理）。
- **语义**：返回 `personaOpened: true`（幂等，已开放不重复）；纯世界书卡不触碰；
  suppressRuntimeContext 不受影响。
- **测试**：+1（开放/幂等/纯世界书反向三场景）；355 pass/0 fail。
- **验证**：typecheck/lint 通过，全量测试通过。

### 主会话人设参数化：mainPersona 直接设置（2026-08-25）

- **能力恢复**：`mainPersona?: string`（41db0da 迁移后不消费的参数重新参数化）——writePreset
  渲染 persona-main 配置时非空覆盖 text；与子代理 `subagentPersona` 对称；空值 = 模板默认。
- **链路**：ENGINE_PARAM_KEYS/WRITER_PARAM_KEYS 完整透传（runtimeOf/index/preset-core/
  reloadPresetParams/initialRuntime）+ store/bridge fields + 模型路由卡（主对话）人设输入
  （persist 条件发送 + 读回）。
- **测试**：+1（persona-main text 覆盖/空值保留）；354 pass/0 fail。
- **验证**：typecheck/lint 通过，全量测试通过。

### 锚定确认词归一：确认词 = 锚句派生属性（2026-08-25）

- **同功能归一**：`firstTurnText`/`firstTurnBuild/Inspect/Deep`（锚句）与 `firstTurnWord`（确认词）
  本质同功能——确认词是锚句的派生属性。writePreset 渲染 prompt-injector 时自动派生确认词集合
  `anchorWords`（锚句信号词，小写去重）；`firstTurnWord` 降级为显式覆盖（非空优先，旧预设兼容），
  模板默认改空。
- **缺陷修复**：deep 档锚句（Let me think…）与自定义锚句（非 we 开头）此前因固定确认词 we
  确认失败退化为兜底注入——派生后按锚句实际信号词确认。
- **引擎**：anchor-match prefix 模式从「仅首词」改为「确认词集合任一前缀命中」（any 语义，
  world-book 不受影响）。
- **测试**：+2（writePreset 派生/覆盖断言、引擎多词确认行为含 deep/自定义/不匹配三场景）；
  352 pass/0 fail。
- **验证**：typecheck/lint 通过，全量测试通过。

### 世界书条目归一补全：角色卡记忆条目同源（2026-08-25）

- **第三处手写收敛**：`characters.ts` 的 `buildCharacterMemoryEntry`（角色卡导入/记忆同步的
  world-book 记忆条目）改调 `buildWorldBookEntry`——工厂 id 缺省不写，id 仍由调用方加
  chara-<卡>- 前缀。ST 导入 / 模型工具 / 角色卡记忆三通道结构同源。
- **验证**：350 pass/0 fail，typecheck/lint 干净。

### 世界书条目结构归一：ST 导入与模型工具共用工厂（2026-08-25）

- **能力归一**：`host/worldbook.ts` 新增 `buildWorldBookEntry(input)` 条目结构工厂——`strategy/layer/position`
  固定值与 params 键集单一权威；ST 导入（sillytavern.ts）与模型工具（world_book_upsert）改调工厂，
  删除双处手写条目结构。
- **测试**：+3（工厂字段权威 / 工具形态 / ST 转换同构断言）；350 pass/0 fail。
- **验证**：typecheck/lint 通过，全量测试通过。

### 内容策略模块化：能力归一 + 边界清晰（2026-08-25）

- **任务分类器归一**：新增 `engine/classify-task.mjs`（`createTaskClassifier`：ready/classify/isComplex）——锚定三档判定与引导复杂判定共用，删除 strategies.mjs 双处内联正则实现。
- **引导开关独立**：新增 `guideEnabled`（undefined = 兼容跟随 `firstTurnAnchor`）；`router-guide.enabled` 与 useCustom 不再硬绑锚定开关；TUI 可独立 toggle。
- **自定义文本契约统一**：锚定策略与引导策略统一读 `config.params.text`（useCustom + text 契约）；`firstTurnText` 保留为存储键，writePreset 映射 `text: params.firstTurnText`，引擎兼容回退。
- **测试**：+1（引导开关独立用例）、prompt-configs 断言改 text 契约键；347 pass/0 fail。
- **验证**：typecheck/lint 通过，全量测试通过。

### 后端参数框架：契约单一来源 + 文档化（2026-08-25）

- **契约收敛**：新增 `ENGINE_PARAM_KEYS`（引擎参数键唯一权威数组）+ 与 `EngineParams` 接口的双向相等断言（多/漏任一键 typecheck 报错）；`PARAM_KEYS` 改为从 `ENGINE_PARAM_KEYS` 派生（+ 锚定内容键 + promptConfigs），消除手动同步漂移（历史事故：漏 25 键混入 variables.yml）；`strReplaceEditorMaxOutputChars` 并入契约层。
- **映射收敛**：`MODEL_SEGMENT_MAP` 单一来源——`loadPresetSpec` 展平与 `savePresetParams` 迁移共用，删除双处字面量。
- **透传防护**：`WRITER_PARAM_KEYS` 与 `PresetWriterParams` 双向相等断言（防 Pick 漏键，历史事故：stageAdvanceDescription）。
- **契约测试**：新增 `test/host/param-contract.test.mjs`——PARAM_KEYS 派生一致性 / 每个引擎参数键有装配消费（防「加键没装配」）/ MODEL_SEGMENT_MAP 段目标唯一。
- **文档**：新增 `docs/architecture-params.md`——分层、参数流、空值语义规则表、variables 双通道（PARAM_KEYS 排除 vs 世界书占位登记）、新增参数 checklist。
- **验证**：typecheck/lint 通过，全量测试通过。

### 参数桥优先：移除 moduleConfigs 作者锁定（2026-08-25）

- **语义变更**：`renderComposition` 合并优先级从「moduleConfigs（预设作者锁定）> 参数桥」翻转为「**参数桥（params/UI）> moduleConfigs > 行默认**」。moduleConfigs 降级为「参数桥未覆盖键的行级直写通道」（ST 导入等仍可用），不再锁定覆盖 UI 可管理参数。
- **修复**：`toolFilterSubagents` UI 开关被模板 `moduleConfigs.tool-filter.includeSubagents: false` 静默覆盖（实测确认开关无效）——桥优先后开关生效，新增契约测试防再犯。
- **清理**：anchored/custom 模板删 `moduleConfigs` 段（值 = 库行默认，行为等价）；根模板段改注释说明；`/describe` 不再回传 moduleConfigs，客户端删除「预设锁定」提示（EngineModuleCards / store / bridge）。
- **保留**：liangshen 模板 moduleConfigs（真实覆盖，非库默认）；sillytavern.ts ST 导入直写通道。
- **验证**：typecheck/lint 通过，全量测试通过。

### 子代理页 UI 同步主会话结构（2026-08-24）

- **SubagentPage**：子代理引擎模块卡（子代理模型 + 工具与深度）从配置列表 beforeCards（列表内部）移到**列表上方独立区块**（configList 容器，与主会话 PromptConfigsEditor 同构）。
- **子代理独有保留**：子代理模型卡（含 subagentPersona）、工具与深度卡（toolFilter / allowKinds / maxDepth）；主会话引擎模块（tool-bootstrap / context-gate / 工具管线）不在此重复（避免双入口）。
- **测试**：315 pass/0 fail。

### 模板归一：16 → 11 个（2026-08-24）

- **A 组 pre-step 通用**：10-pre-step 合并 11-merged-a（mergeMode）与 13-anchor（configKind）——插入后改字段即可，注释说明两种变体；删除 11/13。
- **B 组 placeholder**：18-placeholder-env-facts 合并 17-instruction-hint 与 19-skill-catalog——fill 下拉可切换三种数据源（env-facts / skill-catalog / instruction-hint），参数合并（envKeys + limit/fields/providers + emptyBehavior/emptyText + text）；删除 17/19。
- **C 组 runtime-context**：30-runtime-context 合并 31-placeholder——strategy 可切 static/placeholder（fill=skill-catalog 演示）；删除 31。
- **保留**：三种 strategy 模板（first-turn-anchor/guide-auto/custom-fallback，params 有专门编辑区）、system-section、agent-request、llm-stream、tool-pipeline、subagent-maintenance（真实功能模板）。
- **测试**：templates.test.mjs 16→11（文件名列表 + merged/configKind 断言 + placeholder fill 断言更新）；315 pass/0 fail。

### 移除「主会话人设」模板（2026-08-24）

- **templates/21-persona-main.yml 移除**：人设段开关化后（system-section 卡内「人设段」开关）无需专用模板——新建 system-section 卡开开关即得人设段；templates.test.mjs 回退 17→16 并移除 persona-main 断言。
- **测试**：315 pass/0 fail。

### system-section 人设段开关化（A 方案，2026-08-24）

- **PromptConfigCard**：system-section 层 `sectionName` 文本输入改为「人设段」开关（开 = sectionName=deployment:persona 官方 shadow，触发人设徽标/相位先行/子代理继承；关 = 可选自定义段名输入，空则引擎回退 id 注册为普通段）——消除「删了 sectionName 人设失效」的坑，语义与 complete/suppressRuntimeContext 开关统一。
- **测试**：315 pass/0 fail。

### 补「主会话人设」模板 + 人设功能定位核查（2026-08-24）

- **定位**：主会话人设功能在 `41db0da`（人设彻底模块化）从 `params.mainPersona` 迁移为 `promptConfigs.persona-main`（system-section 段，sectionName=deployment:persona）——编辑入口 = 模块列表「主会话人设」卡，非独立参数。根 preset.yml 的 `mainPersona` 注释为迁移残留（已确认引擎/参数桥/UI 均不消费）。
- **补模板**：新增 `templates/21-persona-main.yml`（主会话人设模板：sectionName=deployment:persona + complete + suppressRuntimeContext），此前模板库只有通用 system-section 模板，无法「新建」人设卡。
- **模型路由卡 meta 文案**：状态描述改为操作引导（「未设置：展开选择模型（当前继承宿主默认 X）」）。
- **测试**：templates.test.mjs 模板数 16→17 + persona-main 断言；315 pass/0 fail。

### 引擎模块卡移到模块列表上方独立区块（2026-08-24）

- **PromptConfigsEditor**：模型路由 / tool-bootstrap / context-gate / 工具管线从模块列表 `beforeCards`（列表内部）移到**上方独立「引擎模块」区块**（sectionHeading + configList 容器），与注入内容配置（模块列表）明确分层；模板变量卡保留在模块列表内。
- **测试**：315 pass/0 fail。

### tool-pipeline 层 5 卡合并为「工具管线」大卡（2026-08-24）

- **合并**：code-presentation / delivery-gate / tool-filter / delegation / page-check 五张 tool-pipeline 层卡合并为一张「工具管线」卡（layer chip = tool-pipeline），内部分区标题（configSectionTitle）：呈现（usePtcMode）/ 过滤（白/黑名单）/ 委派（递归深度）/ 验证（page-check + delivery-gate）。
- **说明**：合并原因是五者本质都是工具设置（tool-pipeline 层）；分区标题保留模块名便于定位。topSwitch compact 模式保留（供未来单开关卡复用）。
- **测试**：315 pass/0 fail。

### 纯开关卡开关置顶——不折叠（2026-08-24）

- **EngineModuleCard 支持 `topSwitch`**：纯开关卡（code-presentation / delivery-gate）开关直接渲染在 header 顶层右侧（configHeaderActions，同模板卡启用开关位），不再需要展开/折叠；卡片无 chevron、无 configForm。
- **测试**：315 pass/0 fail。

### 排版：卡片 header 两行化 + 纯开关卡并排（2026-08-24）

- **header 三行 → 两行**：新增 `configTitleRow`（name + 层 chip 同行），`configMeta` 独立下行——EngineModuleCards 全部卡 + PromptConfigCard（含人设 chip）统一；`configChip` 去 margin-left（间距由 row gap 承担）。
- **纯开关卡并排**：新增 `configCardRow`（flex 均分）——code-presentation（usePtcMode）与 delivery-gate（requireSmoke）两张纯开关卡并排一行，缩窄各占 50%；其余多字段卡保持整行。
- **测试**：315 pass/0 fail。

### 模型路由/工具与深度全部模块卡化——无独立固定卡片（2026-08-24）

- **ModelRouteModuleCard**（新，EngineModuleCards.tsx 导出）：模型路由（官方 agent-default-model 层）从 CollapsibleCard 固定卡改为**模块卡形态**（configCard + chevron，scope 参数）——主会话页并入 PromptConfigsEditor `beforeCards`（EngineModuleCards 前），子代理页并入子代理配置列表头部。
- **DelegationToolsModuleCard**（新，EngineModuleCards.tsx 导出）：工具与深度（toolFilter 白/黑名单 + allowKinds + maxDepth）模块卡化——子代理页并入配置列表头部（同一 params 桥扁平键，与主会话引擎模块卡同一来源）。
- **PromptWorkspace**：删除 ModelRouteCard / SubagentSettings 固定卡组件；FeatureSettings 只保留路由状态 chips；ConfigListWithTemplates 支持 beforeCards 透传。
- **测试**：315 pass/0 fail。

### 修复：层筛选下拉后卡片全消失（2026-08-24）

- **PromptConfigList**：过滤行（关键字输入 + 层下拉 + 批量开关）不再依赖 `scoped.length > 0`——选中层无配置时下拉仍可见（此前整个过滤行消失，无法切回「全部」）；空状态文案按 `effectiveLayer` 判定（选层后显示「本层还没有自定义配置」而非「还没有自定义配置」）。
- **EngineModuleCards**：选中无引擎模块的层（runtime-context / agent-request / llm-stream / world-book）时显示提示行（引擎模块分布在 pre-step / system-section / tool-pipeline），不再静默全消失。
- **测试**：315 pass/0 fail。

### L2-B：渐进披露（stages）编辑器——tool-bootstrap 卡内嵌阶段编排（2026-08-24）

- **UI 全链路补全**（此前引擎/参数桥/PARAM_KEYS 已支持，UI 层缺失）：bridge Fields +4（`stages: StageDraft[]`（name + tools 逗号分隔草稿）/ `stagePreUnlock` / `stageAdvanceTool` / `stageSectionTemplate`）；store load（引擎形态 `[{name, tools: string[]}]` → 草稿）+ persist（草稿 → 引擎形态；空 = 不声明，保留模板默认两相窄化）+ SwitchSnapshot/EMPTY 同步。
- **tool-bootstrap 卡内新增「渐进披露」编辑区**（system-section 层）：阶段列表（名称输入 + 工具 TagInput + 上移/下移/删除 + 「+ 添加阶段」，空名称或空工具集的行不写入）、预放档数（0 = 默认 1）、推进工具名（空 = phase_advance）、阶段状态模板（`{{stage}}/{{stageName}}/{{unlocked}}/{{total}}`，空 = 不注入）。
- **测试**：P1 回归扩展 stages 数组参数桥断言（tool-bootstrap 行含阶段名/工具集/预放档）；315 pass/0 fail。

### 引擎模块卡归类 6 层注入层级 + 固定卡片去重并入模块列表（2026-08-24）

- **引擎模块卡归类 6 层**：EngineModuleCards 每张卡标注注入层级 chip（configChip）——context-gate → pre-step（注入门控）、tool-bootstrap → system-section（装配相位）、code-presentation / tool-filter / delegation / page-check / delivery-gate → tool-pipeline（工具管线/呈现/委派/验证）。
- **层筛选联动**：模块列表层筛选（viewFilter）从 PromptConfigList 提升为受控（未传时内部 state 兜底，子代理页独立实例不受影响）；选中层时模块列表只显示该层配置 + 该层引擎模块卡（'all' 显示全部、'world-book' 不显示引擎卡）。
- **固定卡片去重删除**：主会话页「工具与深度」固定卡退役——工具集白/黑名单 → 新增 **tool-filter 模块卡**（tool-pipeline 层）、递归深度 → 新增 **delegation 模块卡**（tool-pipeline 层）、allowKinds 去重（context-gate 卡已有，原固定卡与模块卡双入口消除）；`ModelToolCards` 拆出 `ModelRouteCard`（模型路由卡，官方 agent-default-model 层保留独立固定卡，scope 参数供主会话/子代理共用）。子代理页保留工具与深度卡（子代理作用域配置）。
- **默认折叠**：引擎模块卡全部默认折叠（tool-bootstrap 不再 defaultExpanded），降低初始高度。
- **测试**：315 pass/0 fail。

### 参数 UI 可编辑性补齐：PARAM_KEYS 补全 + 晋升门控卡片（2026-08-24）

- **P1 修复**：`PARAM_KEYS` 补全 25 个参数键（门控/渐进披露/验证工具 + strReplaceEditorMaxOutputChars/toolFilterSubagents）——此前新增参数不在集合内会被 write-preset 当作**模板变量**混入 variables.yml 污染注入，且 /param-overrides 读取不返回；回归测试断言新增键不进 variables.yml/配置 params、参数桥正确合并进组合行。
- **L2-A：晋升门控 UI**——管线参数卡片新增两卡：①晋升门控（promoteGate / promoteAfterFirstResponse / personaSectionsOnly / workspaceLine / instructionHint 开关 + maxPromoteSteps 数字草稿，0=引擎默认 4）；②首轮工具集（bootstrapTools / compactionTools 标签输入）。store fields/paramPatch/保存体 + bridge Fields/EMPTY 全链路同步。
- **测试**：315 pass/0 fail（+1 P1 回归）。

### 引擎模块卡片组：管线参数卡片退役，模块 config 统一卡片管理（2026-08-24）

- **EngineModuleCards**（合并入模块列表：PromptConfigList `beforeCards`，与模板变量卡同款**可折叠模块卡**——configCard + configToggle + chevron，点击展开 configForm）：tool-bootstrap / code-presentation / context-gate / page-check / delivery-gate 五卡，moduleConfigs 的 UI 化，字段全部经 params 参数桥扁平键落 preset.yml（后端零改动）。
- **tool-bootstrap 卡**：bootstrapMaxTokens（数字+开关）、promoteGate / promoteAfterFirstResponse / personaSectionsOnly / workspaceLine（开关）、maxPromoteSteps（数字）、bootstrapTools / compactionTools（标签输入）。
- **code-presentation 卡**：usePtcMode 开关；**context-gate 卡**：allowKinds / messageSources / deferredSources（标签输入）+ deferredGraceSteps（数字）+ instructionHint 开关；**page-check 卡**：browserPath / timeoutMs / lite / retry；**delivery-gate 卡**：requireSmoke。
- **退役**：旧 PipelineStatusCards 杂项区删除；固定大卡版引擎模块组删除，改同列表可折叠卡片。
- **测试**：315 pass/0 fail。

### 参考 dsh-router-standard 新建验证/交付/渐进披露模块（2026-08-24）

- **page-check**（engine/page-check.mjs + 可选行）：headless Chrome 页面验证——截图（会话工作区 .dsh-shots）+ DOM smoke + console/pageerror 提取 + title/selector + `{js:}` 本地 VM 引擎；单飞锁 + 强制树杀（win32 taskkill / POSIX kill 组）+ 自动重试降分辨率（router v1.9.1/v1.14 实弹教训）；config 全参数化（browserPath/timeoutMs/lite/retry/description）。
- **delivery-gate**（engine/delivery-gate.mjs + 可选行）：交付 gate——file-exists/nonempty/utf8 + headless smoke（复用 page-check）+ evidence 清单校验（kind ∈ file/page/image/run/test/text/external，visual 必须 reviewed）；requireSmoke 默认 true。
- **tool-bootstrap stages 模式**（渐进披露）：`stages: [{name, tools}]` 声明激活多级阶段窄化——当前阶段 + 预放（stagePreUnlock）；phase_advance 推进（工具名参数化）；调用更高阶段工具 = 直达；阶段状态 durable tool/call 推导（无文件、resume/reload 恢复、compaction 不重置）；阶段文案 stageSectionTemplate 参数化（引导类内容一律 promptConfigs，引擎只注入动态 stage-status section）。
- **参数化原则落实**：验证工具描述/阈值、阶段定义/文案全部 params 桥 + moduleConfigs 可配；不新增硬编码工具模块（gitbash 由既有 custom-bash 覆盖，不做）。
- **测试**：314 pass/0 fail（+18：page-check 纯函数/沙箱/URL/注册、delivery-gate 校验矩阵、stages 窄化/推进/直达/冷启动/compaction 保持/参数化）。

### 参数桥取代组合 token + PTC 呈现拆独立模块（2026-08-24）

- **参数桥**：`buildModuleConfigsFromParams` 取代 `renderEngineTokens` / `renderTemplateVariables` 的 `__TOKEN__` 文本渲染——params 扁平键直接构造模块行 config 对象合并（无占位符、无文本往返、类型直达）；组合库全部文件去 token（str-replace-editor 行默认 16000 显式化、delegation 组按子行 id 嵌套合并、tool-filter 行默认不过滤）；合并优先级 `moduleConfigs > params 参数桥 > 行默认`。
- **PTC 呈现拆出**：`engine/code-presentation.mjs` 独立模块行（晋升后 `tools.presentAs('code')`，compaction/end 释放）——「只要 PTC 不要 bootstrap」= modules 只挂 `code-presentation`；tool-bootstrap 专注目录窄化/封顶/门控；6 预设 modules 加 code-presentation 行。
- **门控参数全可自定义**：`promoteGate` / `promoteAfterFirstResponse` / `maxPromoteSteps` / `bootstrapTools` / `compactionTools` / `personaSectionsOnly` / `workspaceLine` / `messageSources` / `deferredSources` / `deferredGraceSteps` / `instructionHint` 全部支持 params 扁平键（参数桥直达模块行）；`BuildCordisOptions` 同步。
- **注释收敛**：内置预设去参数注释，统一在根 preset.yml 示范模板逐项注释。
- **文档**：docs/engine-reuse.md（引擎复制协议 + 晋升门控模块配置参考）。
- **usePtcMode 默认 false（opt-in）**：PTC (Code Mode) 呈现不再默认开启——引擎 `code-presentation` 默认 false；src 层（writePreset/buildCordis/apply/TUI/UI store/bridge）全部透传 undefined 由模板/引擎默认兜底（不再强制 true）；**预设内设置保持原本**（ptc/standard/minimal/anchored 显式 true、creative false、liangshen 经 moduleConfigs true）；liangshen 修复拆行漏网——`moduleConfigs.tool-bootstrap.usePtcMode`（失效键会 fail loud）移至 `moduleConfigs.code-presentation`。
- **测试**：296 pass/0 fail（参数桥断言、code-presentation 呈现/释放/子代理/默认 false 零注册、组合库无 token、liangshen 行序与 usePtcMode 归属、buildCordis 默认关闭/显式开关）。

## [0.6.2] - 2026-08-23

### 模型参数提取到 preset.yml 顶层 model / subagentModel 段（2026-08-23）

- **设计**：params 中 10 个模型键（`modelProvider`…`subagentMaxTokens`）提取为顶层 `model` / `subagentModel` 段（`provider/name/reasoningEffort/temperature/maxTokens`，官方 `agent-default-model` 同构）——params 瘦身 33→23 键（锚定/引导/开关可读性恢复），模型设置 UI 卡片与顶层段一一对应。
- **读取**：`loadPresetSpec` 顶层段展平进 params 扁平键（消费方统一读 `modelProvider` 等，writePreset/端点/UI 零改动）；双读（段优先 + 扁平键兜底）。
- **写入**：`savePresetParams` 模型键写顶层段 + 清理 params 旧扁平键（保存即迁移）。
- **模板/文档**：preset.yml 顶层段注释；README params 一览更新。
- **测试**：读取展平 + 保存迁移断言（289 pass/0 fail）。

## [0.6.1] - 2026-08-23

### 模型参数提取到 preset.yml 顶层 model / subagentModel 段（2026-08-23）

- **设计**：params 中 10 个模型键（`modelProvider`…`subagentMaxTokens`）提取为顶层 `model` / `subagentModel` 段（`provider/name/reasoningEffort/temperature/maxTokens`，官方 `agent-default-model` 同构）——params 瘦身 33→23 键（锚定/引导/开关可读性恢复），模型设置 UI 卡片与顶层段一一对应。
- **读取**：`loadPresetSpec` 顶层段展平进 params 扁平键（消费方统一读 `modelProvider` 等，writePreset/端点/UI 零改动）；双读（段优先 + 扁平键兜底）。
- **写入**：`savePresetParams` 模型键写顶层段 + 清理 params 旧扁平键（保存即迁移）。
- **模板/文档**：preset.yml 顶层段注释；README params 一览更新。
- **测试**：读取展平 + 保存迁移断言（289 pass/0 fail）。

### 动态宏补齐（ST 宏扩展：roll/random/pick/chance/time/date 等）

- **插值引擎扩展**（interpolate.mjs）：支持带参数宏 {{name::arg}}——{{roll::2d6+3}}（骰子表达式，非法原样）、{{random::a,b,c}} / {{pick::a,b,c}}（列表随机选）、{{chance::50}}（百分比概率）、{{time}}/{{date}}/{{weekday}}/{{isotime}}/{{isodate}}、{{newline}}/{{pipe}} 字面宏；大小写不敏感，system-section 注册期同样可用。

### 子代理状态/记忆维护模板（ST 智能特性委派落地）

- **新模板 templates/70-subagent-maintenance.yml**（audience=subagent，pre-step，默认关闭）：ST 角色状态跟踪 + 关系记忆委派给子代理——引擎确定性（插值/匹配/注入）+ 子代理智能判断 + 确定性工具边界写入（session_var / world_book note 含 chara- 归属）。模板库 15→16。

### promptConfigs 模板合并进 preset.yml（单一来源）

- 删除 promptConfigs.template.yml（与根 preset.yml 的 promptConfigs 段重复）；preset.yml 补全：通用字段全参考（group/exclusive/templateFile/dedup 等）、world-book selectiveLogic、策略参数参考（first-turn-anchor/guide-auto/custom-fallback）。parity 语料清理。

## [0.6.0] - 2026-08-23
### 自定义宏自动登记 + 会话变量工具（ST getvar/setvar 语义落地）（2026-08-23）
- **转换登记**：ST 转换时扫描卡内文本，未定义的 `{{自定义宏}}`（非内置/非运行时宏）自动登记为预设 `variables` 空值占位——插值替换为空不留字面，模板变量卡片可编辑默认值。
- **会话变量引擎**（`engine/session-vars.mjs`）：变量挂在 session 对象（`SESSION_VARS_KEY` 字符串常量）——.engine 引擎实例与插件进程工具实例（不同模块副本）操作同一会话即共享数据，无跨实例同步问题；插值优先级 `resolved > 会话变量 > params > 配置 variables（含预设）`（executor 合并）。
- **会话变量工具**（`session_var`，ctx.tools 注册）：`list / get / set / clear`——模型可维护角色状态（{{心情}}、{{接受值}} 等），对应 ST `/var` 命令 + 正则/STscript 更新语义。
- **测试**：session-vars 单测、pre-step 会话变量注入集成、转换登记（空值占位/不登记运行时宏与内置）（287 pass/0 fail）。
### ST 运行时宏支持（修复两个预设的未解析参数）（2026-08-23）
- **隔离分析**（`D:\AI\workspase\_temp\analyze-st-unresolved.mjs`）：夏瑾 beta-2-42 与 明月秋青 v5-0 各发现 2 个未解析参数——均为 ST 运行时宏：`{{lastusermessage}}` / `{{lastcharmessage}}`（大小写变体）与 `{{charIfNotGroup}}`。
- **插值引擎扩展**（interpolate.mjs）：ST 运行时宏（大小写不敏感）——`lastusermessage` → 会话最后 user/message 事件文本、`lastcharmessage` → 最后 assistant/message、`charIfNotGroup` → 空串（dsh 会话 header 无角色名，单角色会话统一空，不残留字面）。`interpolateVariables` 从 session.events 提取；`interpolateStatic`（system-section 注册期无会话）替换为空串——不残留、不触发官方 unknown variable。
- **测试**：动态宏提取（最后消息/大小写变体/变量优先）+ 无会话空替换（284 pass/0 fail）。
### 插值引擎拆分为独立 interpolate.mjs（shared 瘦身）（2026-08-23）
- **拆分**：`interpolateVariables` / `interpolateStatic` 从 shared 迁出为 `engine/interpolate.mjs`（纯函数、无依赖，与 anchor-match 同级纯能力包）；`shared` 保留上下文/文本/配置工具（12 个导出）。
- **消费方**：`layers.mjs` / `executor.mjs` import 源改为 interpolate（依赖方向不变，无环）。
- **测试**：新增 `test/engine/interpolate.test.mjs`（variables 优先 / 内置 DSH_HOME/WORKSPACE/CWD 兜底 / 未注册保留字面 / 中文键）（282 pass/0 fail）。
### world-book 卡片 selectiveLogic 下拉 + useRegex 开关（2026-08-23）
- **UI**：world-book 策略参数补全——`selectiveLogic` 下拉（0 任一 / 1 副键全排除 / 2 部分排除 / 3 副键全包含，对齐 ST `world_info_logic`）与 `useRegex` 开关（此前仅转换层支持，UI 未暴露）。
- **引擎**：`MATCH_LOGIC` 细分 `NOT_ANY`（主键命中且至少一个副键未中）——ST 2 号语义此前与 1 号合并为 not，现精确区分；resolver 映射 0→any / 1→not / 2→notAny / 3→all。
- **测试**：notAny 单元用例（279 pass/0 fail）。
### 锚定匹配引擎（anchor-match）：拆解 fallback，world-book 选择性触发落地（2026-08-23）
- **新引擎 `engine/anchor-match.mjs`**（纯函数、无依赖）：主/副键、大小写、整词、正则、组合逻辑（`any`/`all`/`not` 对齐 ST `world_info_logic` AND_ANY/AND_ALL/NOT_ALL）、匹配模式（`scan` 全文 / `prefix` 开头锚定）。
- **custom-fallback 拆解**：`matchesAnchorWord` 迁移为 matcher prefix 模式（`{ keys: [firstTurnWord] }`）——锚定能力成为引擎能力，行为不变（回归测试通过）。
- **world-book selective 落地**：`selectiveLogic`（ST 0/1/2/3）→ `any`/`not`/`all`；转换层不再丢弃 `selectiveLogic`（写入配置 params）；无键/constant 恒注入语义保留。
- **测试**：anchor-match 单元（any/all/not × 选项 × prefix）+ world-book 集成（副键全中/排除/任一）（278 pass/0 fail）。
- **未做**：scan_depth 递归扫描（引擎无条目间递归概念，需要时再加深度选项）。
### 合并 text / texts 编辑框为单一内容框（对齐官方 text 单字符串语义）（2026-08-23）
- **依据**：dsh 官方（`packages/core/system-prompt/src/index.ts` L67/L84）prompt 条目 `text` 为单字符串（或函数 provider），多段靠多条 section（order 拼接）——无 `texts` 数组概念；`texts` 是我们引擎的自研扩展。
- **合并**：模块卡片表单的 text / texts 两个编辑框合并为「内容（注入文本；空 = 不注入；变量 {{key}} 插值）」单框——普通配置保存统一写 `texts: [整块]`（单段，对齐官方语义；变量为空只留空位不整段消失）；`text` 字段保留兼容读取，编辑后归一。
- **内容资产兼容**：prompt-injector / instruction-hint（`config.id` / `fill` 判定）编辑仍写 `text`（生成目录文件通道 params.text，行为不变）。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。
### 修复 Variables 卡片「删除（清空）」失效（2026-08-23）
- **根因**：`clearAll` 先 `setTemplateVariables({})` 再调 `saveTemplateVariables()`——React setState 异步，保存闭包里的 state 还是旧值，后端写回旧变量，卡片清不掉。
- **修复**：`saveTemplateVariables(next?)` 支持显式传入下一份值；清空场景传 `{}`（后端清 variables 段 + 重建），与 setState 解耦。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。
### 模块「新建」增加 Variables 入口（2026-08-23）
- **新建 → Variables**：模板选择弹窗（新建）顶部新增固定「变量 / Variables」入口——点击展开模块列表顶部的模板变量卡片（受控展开）并添加一个待编辑空行，不插入提示词配置。
- 模板变量卡片展开状态提升为受控（`PromptConfigsEditor` 管理），清空/折叠联动。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。
### 模块列表增加拖拽排序（2026-08-23）
- **拖拽**：模块卡片 header 新增拖拽手柄（⠿），HTML5 DnD 拖到目标卡片上/下半区（落点指示线：上缘/下缘高亮）松手即移动；复用显示视图移动（`moveToView`：按显示相邻逐步交换 order 与数组位置，与连续点按钮等价，跨层正确）。
- **交互隔离**：`draggable` 只设在手柄上（整卡不参与拖拽），展开表单的输入/文本选择不受干扰；拖拽源卡片半透明（data-dragging）。
- 样式：configCard 新增 `data-dragging` / `data-drop-before` / `data-drop-after`。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。
### 修复模块列表上移/下移失效（2026-08-23）
- **根因**：`moveWithinLayer` 按**数组相邻**交换，而列表显示顺序是 `(层序, order, 声明序)` 排序——跨层配置混合时（ST 转换产物正是如此）数组顺序 ≠ 显示顺序，上移/下移交换的是"数组邻居"而非"显示邻居"，视觉上不移动甚至错乱（跨层跳位）。
- **修复**：移动基于显示视图（`viewOrderedIds`：层序/order/声明序）找显示相邻项，交换两者的 order 与数组位置——显示顺序与引擎注入顺序（数组序）同步变化；按钮可用状态（canMoveUp/canMoveDown）同步按显示视图计算。
- 验证：跨层场景（`[P1(pre), S1(ss), P2(pre)]` 中 P2 上移 → `[S1, P2, P1]`）正确；typecheck / lint / test 全绿（272 pass/0 fail）。
- **说明**：模块列表为按钮式排序（无拖拽）；技能列表拖拽是独立功能（PromptWorkspace），本次未涉及。
### 模板变量卡片：移除保存按钮，失焦自动保存；「添加变量」改名「添加」（2026-08-23）
- **自动保存**：删除「保存模板变量」按钮——焦点离开卡片容器（编辑完点别处/收起/切换开关/点击删除）即自动持久化（`/preset-variables` + 重建）；保存成功静默、失败提示。
- **文案**：`VariablesEditor`「添加变量」按钮统一改名「添加」（配置卡片与模板变量卡片共用组件，同步生效）。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。
### 停用模板变量时自动剥离配置中的 {{key}} 引用（2026-08-23）
- **行为**：`variablesEnabled=false`（开关停用）时，`writePreset` 除不生成 `variables.yml` 外，还把每条配置文本（`texts`/`text`/`params.text`）中的**预设变量引用** `{{key}}` 剥离为空——不再有字面残留，也不触发官方 `unknown prompt variable` 渲染报错。
- **保留**：内置变量（`{{DSH_HOME}}`/`{{WORKSPACE}}`/`{{CWD}}`）与配置自身 variables 的引用不受影响（剥离只针对预设变量键）。
- **测试**：停用时 `剧情{{wordsCloud}}字 {{DSH_HOME}}` → `剧情字 {{DSH_HOME}}`；启用后引用保留（引擎插值）（272 pass/0 fail）。
### 模板变量卡片增加插值开关（与其他模块卡片一致）（2026-08-23）
- **开关**：卡片 header 新增启用/停用 toggle（configEnable 样式，与其他模块卡片一致），控制"模板变量插值"——存 preset.yml 顶层 `variablesEnabled`（缺省 true），切换即时持久化 + 重建。
- **停用语义**：`writePreset` 不再生成 `variables.yml`——`{{key}}` 不再被替换（引擎无预设变量源）；展开态显示停用提示。注意：system-section 配置若文本残留 `{{key}}`，官方渲染会抛 unknown variable（用户主动停用时的已知行为，卡片 title 有提示）。
- **端点**：`/preset-variables` 读写增加 `enabled` 字段；`savePresetParams` 新增 `variablesEnabled` 参数（true = 删除键即缺省，false = 显式停用）。
- **测试**：停用不生成 variables.yml / 启用恢复（272 pass/0 fail）。
### 模板变量卡片彻底归类到配置列表下（可折叠 / 可删除 / 可新建）（2026-08-23）
- **位置**：模板变量卡片经 `PromptConfigList.beforeCards` 插槽渲染在配置列表区域内（列表头部之后、配置卡片之前），随页面滚动，不再独立于列表上方。
- **交互对齐配置卡片**：可折叠（chevron 展开/收起，默认收起）；可删除（header「删除 → 确认清空」，清空全部变量并持久化）；可新建（展开后 VariablesEditor「添加变量」）。
- 语义不变：非 promptConfig，保存仍走 `/preset-variables` 写 preset.yml 顶层 `variables` 段。
- 验证：typecheck / lint / test 全绿（271 pass/0 fail）。
### 模板变量编辑入口并入模块列表（B 方案）（2026-08-23）
- **调整**：「模板变量」从工作台独立卡片（ModelToolCards 下方）移入提示词配置模块列表（PromptConfigsEditor）顶部——与 world-book、人设、各提示词模块并列管理，样式统一（configCard）。
- 语义保持：预设级数据（非 promptConfig，不进配置列表保存路径），保存仍走 `/preset-variables` 写 preset.yml 顶层 `variables` 段。
- `PromptConfigsEditor` props 扩展（templateVariables / setTemplateVariables / saveTemplateVariables）；`PromptWorkspace` 移除旧独立卡片组件。
- 验证：typecheck / lint / test 全绿（271 pass/0 fail）。
### 预设级模板变量迁移到 preset.yml 顶层 variables 段（2026-08-23）
- **设计**：`params` 混着两类语义（引擎行为参数 + 模板变量）——模板变量迁移到顶层 `variables:` 段（对齐官方"变量表"概念），`params` 只留引擎行为参数（PARAM_KEYS）。
- **转换**：`convertStToPreset` 的 setvar/getvar 收集改写入顶层 `variables`（不再进 params）。
- **写入**：`savePresetParams` 新增 `variables` 参数——写顶层 `variables` 段 + 清理 params 同名旧键（保存即迁移）；params 空 key 跳过。
- **渲染**：`writePreset` 的 variables.yml 来源 = 顶层 `variables`（优先）+ 旧布局 params 内容键（兼容）；runtime 参数（promptText 等）不再进变量文件。
- **端点**：`/preset-variables` 读 = 顶层 variables + 旧 params 内容键合并（顶层优先）；写 = 顶层段。
- **测试**：writePreset variables.yml 断言更新（顶层优先 + 旧键兼容 + runtime 排除）；savePresetParams variables 写入（271 pass/0 fail）。
- **环境**：`beta-2-42` 预设已迁移（19 内容变量 → 顶层 variables，params 剩 14 个 UI 键，备份 `.bak-pt-vars-top-*`）。
### 修复 VariablesEditor「添加变量」失效（2026-08-23）
- **根因**：`VariablesEditor.commit` 过滤空 key 行——「添加变量」新增的 `['', '']` 待编辑行被立即丢弃，按钮点击无效果（配置卡片与模板变量卡片共用，均受影响）。
- **修复**：编辑器保留空 key 行（新增行可继续输入）；空 key 由保存端统一清理——`savePresetParams`（params 空 key 跳过 + promptConfigs 逐条清理 variables 空 key）、模板变量卡片保存前本地过滤。
- **测试**：`savePresetParams` 空 key 清理回归断言（271 pass/0 fail）。
### 模板变量单一编辑入口：variables.yml + 工作台「模板变量」卡片（2026-08-23）
- **问题**：writePreset 把预设级内容变量展开进每条配置的 `variables`，每个模块卡片的「variables（模板变量 {{key}} 插值）」重复显示同一批变量。
- **数据流重构**：预设级内容变量（非 `PARAM_KEYS` 的非空 string 键）→ 生成 `prompt-configs/variables.yml`（单一文件）；引擎 `loadPromptConfigFiles` 读入后合并进每条配置 variables（配置自身优先）；生成目录每条配置 yml 保持干净（卡片 VariablesEditor 只显示配置自身变量）。
- **UI**：工作台主会话页新增「模板变量」卡片（复用 `VariablesEditor` key-value 行编辑，ST 对应物 = 宏系统变量管理 `public/scripts/variables.js`），保存走新端点 `/preset-variables`（写激活预设 preset.yml 内容变量 + 重建）。
- **桥端点**：`BRIDGE_ENDPOINTS` 22→23（`presetVariables`），契约测试同步。
- **host 加载**：`prompt-configs.ts loadPromptConfigFiles` 跳过 `variables.yml`（非配置）。
- **测试**：引擎合并断言（变量文件不入配置列表、配置自身优先）、writePreset 生成 variables.yml、liangshen/custom 目录断言过滤变量文件（270 pass/0 fail）。
### 预设级内容变量展开进 variables（官方插值机制；修复 {{key}} 注入失败）（2026-08-23）
- **根因**：writePreset 把预设级内容变量合并进 `config.params`，但引擎插值（`interpolateVariables`/`interpolateStatic`）只读 `config.variables`——`{{JailbreakPrompt}}`/`{{wordsCloud}}`/`{{getvar::k}}→{{k}}` 不被替换；且 system-section 文本注册进官方 `ctx.systemPrompt` 后，残留 `{{key}}` 触发官方 `unknown prompt variable` 抛错 → **该段注入失败**（warn 静默）。
- **修复**：合并层从 `params` 改为 `variables`——预设级内容变量（非 `PARAM_KEYS` 的 string 键）展开进每条配置的 `variables`（官方插值源，配置自身优先）；`params` 只保留配置自身策略参数（strategies.mjs 消费）。
- **UI**：`StrategyParamsFields` JSON 回退分支在 params 为空时不再渲染「params（高级参数 JSON）」框，提示"本策略无高级参数；模板变量见上方 variables"——内容变量由既有 `VariablesEditor` 结构化编辑。
- **测试**：write-preset 断言内容变量进 variables（params 不含）、UI 管理键双不落（269 pass/0 fail）；实测 `{{JailbreakPrompt}}` 经 variables 插值成功。
### 配置 params 合并排除 UI 已管理键（JSON 高级参数框只留内容变量）（2026-08-23）
- **问题**：writePreset 把整包预设级 params 合并进每条 promptConfig 的 params（供 `{{key}}` 插值），模型设置/工具与深度/开关等 **UI 已有专门编辑入口**的键（`PARAM_KEYS`）也一并出现——「params（高级参数 JSON；本策略无固定字段）」框里冗余回写这些参数。
- **修复**：`PARAM_KEYS` 移至 `src/shared/param-keys.ts`（host 层不 import config 的分层纪律，单一来源）；`writePreset` 合并预设级 params 时排除 `PARAM_KEYS`，配置自身策略参数（第二层 `...config.params`）不受影响。
- **测试**：`write-preset.test.mjs` 新增断言——生成配置 params 不含 `firstTurnAnchor/modelProvider/guideText/usePtcMode/...` 等 UI 管理键、内容变量（如 `promptText`）保留合并（269 pass/0 fail）。
### ST 转换剥离采样参数（模型参数统一归「模型设置」UI）（2026-08-23）
- **根因**：convertStToPreset 把 ST 卡采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`）固化为顶层 `params.model*`，与「模型设置」UI 编辑的是同一份预设级参数——ST 卡固化值会在导入/重建时覆盖用户在模型设置里的设置。
- **剥离**：转换引擎不再写入 `modelTemperature` / `modelMaxTokens` / `modelReasoningEffort`（ST 源码对照：这三者是 ST 请求层采样参数，属会话运行时设置，非预设内容）；模型参数完全由模型设置 UI / 宿主默认管理。
- **测试**：`preset-package-import` 用例改为断言转换产物不含三键（268 pass/0 fail）。
- **环境配套**：已导入预设 `xiajin-tianqin-beta-2-42/preset.yml` 顶层 params 三键剥离（yaml 保留注释写回 + 备份），生成目录旧 `00-model-params.yml` 删除（writePreset 重建时会清空 prompt-configs 目录，无残留路径）。
### 预设 id 官方命名约束（修复官方客户端 resume 报 preset not found）（2026-08-23）
- **根因**：ST 导入预设 id 保留中文字符（`\u4e00-\u9fff`），目录建在官方 `USER_PRESET_DIR` 后被宿主 discovery 的 `PRESET_ID`（`/^[a-z0-9][a-z0-9-]*$/`）静默跳过；插件又把宿主 `agent-presets.default` 同步为该 id → 官方客户端 resume 会话报 `agent-presets: preset "夏瑾-天琴座-beta-2-42" not found`。
- **`stPresetId`**：ST 导入 id 生成抽为独立函数并导出——文件名 slug 化（去中文，满足官方 `^[a-z0-9][a-z0-9-]*$`）；纯中文名退化为 `st-<文件名短哈希>`（唯一且合法）；显示名 `name` 保留中文原名。
- **writePreset 校验收紧**：`presetTemplate` 从「可含中文的目录名」收紧为官方 agent-presets id（`^[a-z0-9][a-z0-9-]*$`），非法 id fail loud，防止再生成官方不可见目录。
- **宿主 default 同步防护**：`syncHostDefault` 同步前校验 id 合法，不合法 warn 跳过（不再写坏宿主 settings）。
- **测试**：新增 `test/host/sillytavern.test.mjs`（中文名 slug / 纯中文 hash / 英文 slug）；write-preset 拒绝中文/大写 templateName；`preset-package-import` 中文文件名用例同步新 id 形态。
- **注意**：已导入的中文 id 预设（如 `夏瑾-天琴座-beta-2-42`）需手动改名为合法 id 并同步 `settings.yaml`（`agent-presets.default` / `prompt-tool.presetTemplate`），否则插件重启后 writePreset fail loud。
## [0.5.0] - 2026-08-22
### 角色卡 / 世界书 / ST 变量（SillyTavern 全链路）
- **角色卡库**：SillyTavern 角色卡（PNG tEXt chunk `ccv3`/`chara` 或 chara_card JSON）导入独立库 `~/.dsh/.agent-presets/.characters/<id>/`（原图 / 原始 JSON / 转换参数 / 角色记忆），按需「导入到当前预设」（`chara-<卡>-` 前缀合并、幂等可移除）；多文件（角色卡 × 响应预设）自动合并；中文 id 支持
- **角色记忆**：`memory.md` 跟随角色卡跨预设，应用时合并为 world-book constant 配置注入；世界书工具 `note` 参数按 id 前缀归属写入卡记忆
- **世界书回归模块体系**：`character_book` 转 world-book 策略配置（`keys` 命中触发 / `constant` 常驻 / `useRegex` 正则 / `caseSensitive` / `wholeWords`），与普通模块同一存储与编辑；模块列表「世界书」过滤 + 批量启用/禁用；旧 `worldBook` 段自动迁移
- **ST 变量 fallback**：`setvar` 收集进 params、`getvar`（含默认值）改写 `{{key}}` 由引擎插值兜底（key 支持中文）；`trim`/注释/ERA 剥离、`{{user}}`/`{{char}}` 替换、TavernHelper 扩展注入物剥离
- **模型工具 8 个**：`character_import/apply/remove/delete/list` + `world_book_list/upsert/delete`（会话中直接管理角色卡与世界书）
- **UI**：角色管理页（方块卡片）、模块列表合并过滤下拉（全部/世界书/层级）+ 批量开关、备用开场白、TavernHelper 剥离
- **依赖**：新增 `@deepseek-ai/dsh-tools`（模型工具注册）；`.gitattributes` 统一 LF
### persona 注册层重构：router-first-turn 接管人设（2026-08-22）

- **token 参数名直观化**：组合模板占位符从 SCREAMING_SNAKE_CASE（`__USE_PTC_MODE__` 等）改为 camelCase（`__usePtcMode__` 等），与 `params` 键逐字对应（`USE_PTC_MODE`↔`usePtcMode` 心智映射消除）；`renderTemplateVariables` / `assertCompositionArray` / 测试检测正则统一支持大小写；`resolvePresetParams` 删除 SCREAMING_SNAKE 别名生成（`upperKey` 移除）；`__SUBAGENT_FLASH__`（rebuild 脚本旧名）同步为 `__subagentConfig__`。
- **人设彻底模块化（方案 B 落地）**：人设从 params 参数迁移为 promptConfigs 的 `persona-main` 模块（`layer: system-section` + `params.sectionName: deployment:persona`）——与普通模块同一存储/编辑/新建通道（模块列表「人设」徽标）；`complete` 保留且 UI 互斥（预设内仅一个，手写冲突官方 fail loud，与官方行为一致）；`suppressRuntimeContext` 经 wireSystemSections 透传（等价官方 includeRuntimeContext:false）；`router-first-turn.mjs` 整体退役（引擎文件、composition 行、`__MAIN_PERSONA__` token、FALLBACK_MODULES 引用全删）；`mainPersona` 参数删除，6 预设人设文本迁入 promptConfigs（anchored/minimal complete 独占系、standard/ptc/creative/liangshen 非独占）；子代理回退链改为「显式 subagentPersona → scope 链继承主会话 persona」；templates/20-system-section.yml 补 persona 用法；测试重写（persona 模块集成测试：shadow 注册/complete 独占/多 complete fail loud/suppressRuntimeContext/子代理不继承）+ 修复 prompt-configs 测试 DSH_HOME 隔离（paths 模块顶层缓存 DEFAULT_PRESET_DIR，必须动态 import）。
- **官方预设人设全量对齐**：standard → 官方 standard 原文（`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`，非独占）；ptc → 官方 code 原文（同 standard，PTC 保留）；minimal → 官方 minimal 原文（`You are a helpful software engineer assistant.`，complete 独占 + 抑制 runtime context 由组合默认提供）；creative → 官方 cordis（上条）。anchored / liangshen / custom 为自研预设无官方对应，保留自有设计。write-preset 测试新增三预设人设对齐断言。
- **creative 对齐官方 cordis（创造模式）**：`preset/creative/preset.yml` 人设替换为官方 cordis 创意文本（`{{model}}`/`{{cwd}}` 变量经 token 渲染保留、assemble 后由官方插值）；`usePtcMode` 改 false（官方 cordis 非 PTC）；配套 skills 补齐——`preset/creative/skills/cordis-plugin-development/` 与 `editing-cordis-compositions/`（官方原文复制，writePreset 随预设复制进生成目录，skill-filesystem `customSkillDirs` 解析）；write-preset 测试加变量保留与 skills 复制断言。
- **人设体系收敛为「主会话 / 子代理」两轴**（用户定稿）：完全放弃 Flash/Pro 模型档位分流——`mainPersona` 重定义为主会话人设（全模型通用，静态注册层 shadow + complete 独占），`proPersona` 参数取消（曾短暂引入后按用户决策回退）；子代理轴由既有 `subagentPersona`（显式 → 回退 mainPersona → 继承主会话）承担，与主会话天然隔离（scope 链不继承）。
- **修复真实宿主缺陷**：官方 `dsh-system-prompt` 的 `complete` 语义在 assembly waterfall 后恢复注册原文——旧实现的 waterfall 段替换（Flash/Pro 人设路由、mnemon 隐藏、plan 保留）在 `complete: true` 预设下被整体覆盖，**mainPersona 自定义从未真正到达模型**（桩 ctx 测试掩盖）。经官方源码核对 + 真实 cordis/dsh-system-prompt 集成验证（6 场景全绿）。
- **注册层实现**：`engine/router-first-turn.mjs` 改为官方 scope shadow 机制——同名注册 `deployment:persona` 遮蔽全局 persona，`section.text` 为函数 provider 按 `context.agent.options.model` 每次组装路由（Flash → `mainPersona`，Pro → 官方 RL 原句），首轮即正确、模型切换自动跟随；`complete: true`（默认）天然独占 system prompt，无需 waterfall 修改。
- **persona 行移除**：6 个预设（anchored/minimal/liangshen/standard/ptc/creative）的 `modules` 删除 `persona` 行与 `moduleConfigs.persona`（同名单注册冲突）；`includeRuntimeContext: false` 语义迁移为 `router-first-turn.suppressRuntimeContext`（anchored/minimal 开启）；standard/ptc/creative/liangshen 保持非独占（`complete: false`）；liangshen 补挂 router-first-turn 与 `params.mainPersona`。
- **配置收敛**：`hideSectionPrefixes` / `includeSubagents` 删除——mnemon 段隐藏由 complete 免费实现（原真实宿主上同样被覆盖，无回归）；子代理 scope 不继承 shadow（官方 scope 链），天然放行全局 persona，自定义走 tool-subagent 行 `subagentPersona`。
- **测试升级**：`anchored-presets.test.mjs` router 用例从桩 ctx 改为真实 cordis + dsh-system-prompt + dsh-scope 集成测试（Flash/Pro 路由、complete 独占、子代理放行、suppressRuntimeContext 等 6 用例）；devDependencies 新增 `@deepseek-ai/dsh-scope`。
- **回归**：typecheck / lint / 257 测试全绿。

### 适配 DSH v0.1.1-rc.1（2026-08-21）

- **依赖升级**：peerDependencies / devDependencies 全部 `^0.1.0-rc.8` → `^0.1.1-rc.1`（dsh-api-remotes、dsh-client-connection、dsh-client-runtime、dsh-client-ui-primitives、dsh-client-ui-settings、dsh-client-ui-slots、dsh-commands、dsh-host-webserver、dsh-settings、dsh-skill、dsh-system-prompt），pnpm-workspace.yaml minimumReleaseAgeExclude 同步更新。
- **兼容性核对**：插件 import 的 11 个符号（ClientContext / SettingsScope / IApiClient / ConnectionHandle / settingsNamespace 等）在 rc.1 全部保留且签名未变；上游类型变化均为增量（RpcFetch / ClientTransportHooks / IndexInjection 新增、sessions 可选字段、MarkdownRenderContext.inBlockquote）；`credentials/updated` 事件更名为 `credentials/reference-updated`（插件未使用，无影响）。
- **回归**：typecheck / lint / 235 测试全绿。

### UI 参数全覆盖：预设级参数可自定义（2026-08-20）

- **overrides 通道 8→15 项**：`fastModelPersona`（主对话快速模型人设，textarea）、`subagentPersona`（子代理独立人设，textarea）、`subagentToolFilterAllow/Deny`（工具集白/黑名单，逗号分隔 input）、`subagentMaxDepth`（递归深度，下拉：不设置/provider-managed/0/1/2/3/5）、`allowKinds`（注入 kind 白名单，逗号分隔 input）、`firstTurnWord`（锚定词，**自由文本输入**任意自定义文本）——全部经 prompt-tool.overrides.yml 随预设隔离，settings.yaml 保持纯净。
- **空值保护**：fastModelPersona 引擎必需非空（空串触发 router-first-turn 抛错）——空值不写 overrides 键，保留模板默认；allowKinds 空数组 = 白名单全拦（危险）——空值跳过；firstTurnWord 空回退模板默认 we；subagentMaxDepth 空 = 不设置（官方默认）。
- **链路**：WritePresetOptions / BuildCordisOptions / RuntimeOptions / Fields / store（load paramPatch + persistParamOverrides）/ applyParamOverrides 同步扩展；UI「消息批层入口」加锚定词、「功能设置」加主对话快速模型人设 + kind 白名单、「子代理设置」加独立人设 + 工具集白/黑名单 + 递归深度。
- **回归**：buildCordis fastModelPersona/allowKinds 覆盖断言 + writePreset firstTurnWord 透传/回退断言（210 pass）。

### 参数归类分层：作用域 × 维度（2026-08-20）

- **子代理参数归类**：参数统一为「作用域（主对话 / 子代理）× 维度（模型/人设/工具集/深度/相位/注入）」矩阵——preset.yml 顶层**独立 `subagent:` 段**（与 `params` 平级，不埋在主对话设置中；`modelProvider/modelName`、`persona`、`toolFilter.allow/deny`、`maxDepth`），引擎合并入口 `resolvePresetParams` 拍平为扁平键（`subagentModelProvider` 等），运行时/UI/overrides 继续消费扁平键，两套表示等价；主对话模型由 dsh 全局配置（插件只读），相位（`moduleConfigs.*.includeSubagents`）与注入（`promptConfigs[].subagents/promotion/modelScope`）保持既定段位。
- **命名脱离上游**：`subagentFlashProvider/Model` → `subagentModelProvider/ModelName`（UI 已为「模型服务商/模型名」）、`flashPersona` → `fastModelPersona`（快速模型路由人设）、`installSubagentFlashRoute` → `installSubagentModelRoute`、渲染 token `__FLASH_PERSONA__/__SUBAGENT_FLASH__` → `__FAST_MODEL_PERSONA__/__SUBAGENT_CONFIG__`；全链路 26 文件同步，无旧格式兼容。
- **相位补齐**：`moduleConfigs.router-first-turn.includeSubagents` 暴露（与 tool-bootstrap/context-gate 同段，router-first-turn 子代理首轮相位可配）。
- **回归**：`resolvePresetParams` 嵌套拍平测试（含空默认值不渲染、运行时扁平键优先）。

### 审查修复：官方对照归一（2026-08-20）

- **子代理完整自定义（官方 tool-subagent Config 参数化）**：`params` 新增 `subagentPersona`（per-child shadow，显式优先/固定路由回退 fastModelPersona/缺省继承主会话）、`subagentToolFilterAllow/Deny`（toolFilter 白/黑名单，数组或逗号/空格字符串）、`subagentMaxDepth`（0 禁止委派/provider-managed/正整数）——渲染进 tool-subagent/subagent_fork 行（`agentOptions` + `persona` + `toolFilter` + `maxDepth`）；任一字段非空即渲染对应行，全部缺省=官方默认；WritePresetOptions/BuildCordisOptions 同步透传；全预设冒烟（minimal 无 delegation 模块按官方不渲染）。

- **allowKinds 兜底对齐官方 pre-step 行为**：官方 deepseek-harness 的 `agent/pre-step` 默认无 kind 过滤（claimed + runtime-context 快照，kind 全集 user/plugin/tool/skill-catalog/skill-invocation/agent-instructions/goal）——`allowKinds` 未声明时不再写行、context-gate 不做 kind 过滤（官方行为）；显式声明（anchored 等）仍为白名单门控。配套修复 `renderTemplateVariables` 空值 token 独立行整行删除（原只删 token 残留 `key:` null）与两步替换的行定位错位。

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
- library 合并与差异参数化：删除 17 个与现有模块重复/可合并的 `official-*`（tool-pwsh/tool-fs/planning/compaction/delegation 等 11 个与现有一致、official-filesystem=bootstrap-filesystem、official-delegation 的 `__SUBAGENT_CONFIG__` token 对官方预设渲染为空可兼容）；**persona 差异参数化**——persona.yml 收敛为 standard 版（仅 text），anchored/minimal/creative 的差异（text/complete/includeRuntimeContext）由 preset.yml `moduleConfigs` 传递（纯数据可参数化）；`applyModuleConfigs` 支持行无 config 时创建节点；**`!!js` 表达式差异不参数化**（YAML tag 经 preset.yml 解析丢失，代码类差异保留独立文件 official-skill-filesystem-cordis）；保留 official-* 6 个（agent-instructions/tool-bash/tool-skill/tool-presentation/tool-cordis/persistent-shell，现有无对应或内容为本地定制）。
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
