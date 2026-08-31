# dsh-plugin-prompt-tool L2 参数与预设完整迁移计划

> 计划日期：2026-08-31
> 当前分支：`dev`
> 审查基线：`65d4d5b`
> 执行策略：L2 定向重构；不做无收益的大规模重写。
> 用户要求：参数与预设完整迁移；删除旧参数/旧预设运行时兼容；世界书旧 `preset.yml` 必须迁入 canonical `promptConfigs`；`variables` 空字符串是 worldBook 工具动态调整的合法占位值，不能按参数空值删除。

## 状态

- [x] L0 只读审查完成
- [x] 两个独立审查代理成功返回并完成本地交叉验证
- [x] 第二次 `typecheck` / `lint` / `test` 基线通过（386 pass / 0 fail）
- [x] 本计划写入
- [ ] Wave 1：canonical 路径、Schema、旧兼容入口删除
- [ ] Wave 2：参数/文件/Bridge/保存/顺序契约
- [ ] Wave 3：前端、引擎、脚本、模板、文档
- [ ] 最终验证、提交、推送

## 一、已确认审查结论

### P1 数据完整性与安全

1. `src/host/manifest.ts:175-207`、`src/runtime/settings-bridge.ts` 多处、`src/host/write-preset.ts:220`：自定义 `presetDir` 没有贯穿发现、解析、导入、克隆、导出和写入。
2. `src/index.ts:201-250`：补建非激活预设复用激活 runtime，破坏每预设隔离。
3. `src/host/write-preset.ts:226-273`：旧 `worldBook` 只删旧段、不持久化迁移后的 `promptConfigs`，后续重建丢条目；空条目旧段也不会完成迁移。
4. `src/host/write-preset.ts:520,536-538`：prompt config/custom tool ID 直接拼接文件名，可越出生成目录。
5. `src/host/write-preset.ts:543-546`：`legacyCleanup` 可删除 `outDir` 外部文件。
6. `src/host/manifest.ts:743-852`：组合文件/模块相对路径未统一 containment 校验。
7. `engine/schema.mjs:23-29,258`：`templateFile` 可读取任意本地文件进入模型上下文。
8. `src/runtime/settings-bridge.ts:965-979`：导出 ID 未校验，可越出预设根读取外部 `preset.yml`。
9. `src/runtime/settings-bridge.ts:899-949`：导入允许大写/中文 ID，但 writer 只接受官方小写 slug，可能 200 成功而物化失败。
10. `src/runtime/settings-bridge.ts:54-78`：Origin 只比较 hostname，未比较 scheme/port。
11. `src/host/manifest.ts:532-545`：`.engine`、`.characters` 等隐藏目录仍可被 CRUD 删除。
12. `src/host/manifest.ts:448-526`、`src/runtime/agents-file.ts`、`src/web-surface.ts`：多个增量写路径非原子。
13. `src/runtime/models.ts:103-117`：官方异步 `saveSelection()` 未 await/catch。
14. `src/host/characters.ts:197-231`：PNG `inflateSync` 无解压后大小上限。

### P1 参数与行为

1. `src/client/prompt-tool-store.ts:834-865,1031-1039`：自动保存绕过权威校验；重建失败被吞掉但 Bridge 仍可能返回成功。
2. `src/client/prompt-tool-store.ts:850-853`：空数组直接 return，用户无法清空全部 promptConfigs。
3. `src/runtime/configs-validate.ts`、`engine/schema.mjs`：重复 ID 不拒绝，最终后者覆盖前者。
4. `src/host/write-preset.ts:174-195`：手写数字模型参数不会生成 model patch。
5. `src/host/manifest.ts:704-711`：空 allow/deny 无法清除 moduleConfigs 旧值。
6. `engine/schema.mjs:143`：六层 `/meta` 返回字母序，非规范顺序。
7. prompt config/tool 文件名两位前缀 + 字典序读取，超过 10 条顺序错误。
8. `loadPresetSpec` 使用宽松 YAML parse，不检查解析错误，损坏 preset 可能被部分接受。

### P2 维护与 UI

1. 多个引擎 session Map 无统一清理上限。
2. `skills-watcher` 不监听嵌套技能目录。
3. 世界书筛选视图的移动逻辑使用全量配置视图。
4. Bridge 成功载荷类型是宽泛 union，缺少按端点的共享请求/响应契约。
5. README 测试数、PromptConfigsEditor 文案、engine-reuse 优先级描述已漂移。
6. `scripts/rebuild-composition.mjs` 的 library 替换不是失败安全的原子替换。

### 已复核否定项

- `compaction/end` epoch 重置逻辑当前正确。
- 六层运行时接线没有遗漏；问题是 `/meta` 元数据顺序。
- 普通非 loopback socket/Host 请求不能绕过 loopback 检查。
- 预设/角色卡普通导入路径中的直接 `..` 穿越已被过滤。
- 普通 preset CRUD、角色卡 CRUD、worldBook CRUD 的 ID 本身没有直接文件系统穿越。

## 二、Canonical 预设与参数规则

### 2.1 唯一目录布局

```text
<presetRoot>/
  <preset-id>/
    preset.yml
    agent.cordis.yml
    prompt-configs/
    custom-tools/
    preset.md                 # 可选
    agents.md                 # 可选
    agents-instruction.md     # 可选
  .engine/                    # 共享引擎，永不作为 preset id
```

- `presetRoot` 是唯一预设根，默认 `$DSH_HOME/.agent-presets`，所有读写/发现/导入/导出/复制/删除必须显式使用同一根。
- `preset-id` 唯一采用 `/^[a-z0-9][a-z0-9-]*$/`，必须等于目录名。
- 隐藏目录（所有 `.` 开头目录）不是用户预设，不得被普通 CRUD 操作。
- 不再运行时识别或生成 `prompt-tool` 容器根、旧 `presets/`、别名快照、`prompt-tool.overrides.yml`。

### 2.2 `preset.yml` canonical 结构

允许并按以下职责组织：

```yaml
id: <目录名>
name: <显示名>
description: <可选说明>
version: <版本>
engineCompat: <兼容范围>
meta: <显示/来源元数据>
content: <模板初始内容，可选>
model: <主模型段>
subagentModel: <子代理模型段>
params: <canonical EngineParams>
variables: <模板变量；空字符串合法>
variablesEnabled: <可选>
modules: <组合模块清单>
moduleConfigs: <行级配置补充>
promptConfigs: <注入配置数组>
customTools: <声明式工具数组>
```

明确禁止运行时兼容的旧字段/文件：

- `params.modelProvider/modelName/...` 等旧扁平模型键；
- `guideComplexPattern`、旧内容参数别名；
- 顶层 `worldBook`；
- `prompt-tool.overrides.yml`；
- `legacyCleanup`；
- 旧容器根、旧 `~/.dsh/presets`、`outputId`/`aliasOf`；
- 缺失/不合法 ID 的隐式回退。

### 2.3 `variables` 空值规则

`variables` 与引擎行为参数完全分离：

- `variables: { key: '' }` 是合法且有意义的 worldBook 动态占位值；
- worldBook 工具写入/更新条目引用的变量时，空字符串必须继续保留；
- 只有 `params` 中的 `''` / `[]` 才使用引擎参数删键语义；
- 禁止把 `variables` 复用为 `PARAM_KEYS` 或数值参数校验通道；
- `variablesEnabled: false` 只控制插值，不删除 `variables` 源数据。

### 2.4 迁移策略

- 旧数据只通过显式一次性迁移脚本处理，不再由启动、写入或读取热路径兼容。
- 迁移脚本将：
  1. 旧目录合并到 canonical `<presetRoot>/<id>`；
  2. 扁平模型键转换到 `model/subagentModel`；
  3. 旧 `worldBook` 转为 `promptConfigs`，并写回同一 `preset.yml`；
  4. 旧 params 内容变量转到顶层 `variables`，保留空字符串；
  5. 删除旧覆盖文件和旧字段；
  6. 生成 canonical `agent.cordis.yml` / `prompt-configs`；
  7. 迁移失败时保留备份并返回非零状态。
- 运行时不再自动迁移；未通过 canonical 校验的预设直接 fail loud。
- 本次不触碰真实用户 `$DSH_HOME`，只提交迁移工具和仓库模板/测试。

## 三、第二轮逐文件 L2 修改清单

### Wave 1：canonical 路径、Schema 与旧兼容删除

| 文件 | 修改 | 原因 | 风险/验证 |
|---|---|---|---|
| `src/host/paths.ts` | 删除旧布局常量；保留 canonical `DEFAULT_PRESET_DIR`、`.engine`；增加统一 ID/路径工具 | 消除旧目录分裂 | 迁移/CRUD/隔离测试 |
| `src/host/manifest.ts` | 所有预设 API 增加显式 `presetRoot`；目录名与 `spec.id` 强一致；严格 YAML 错误；删除旧 flat model/worldBook/旧 ID 回退；统一 containment 与隐藏目录保护；原子 YAML 写 | 建立单一来源 | preset root、坏 YAML、路径反例 |
| `src/host/migration.ts` | 改为显式 `migratePresetRoot()` 一次性迁移器；不再被 runtime 自动调用 | 旧兼容移出热路径 | 旧布局/旧参数/worldBook 双次重建 |
| `src/index.ts` | 删除启动自动 legacy migration、alias snapshot、overrides migration、旧 skillsDir/presetDir 归一；按目标预设独立生成 options；所有重建错误向上抛 | 消除隐式兼容和跨预设污染 | apply/切换/重建回归 |
| `src/config.ts` | 删除 `skillsDir` 等旧字段；Config 只保留部署轴；校验 presetRoot/id | 配置契约收敛 | schema/typecheck |
| `src/shared/param-keys.ts` | 删除 `guideComplexPattern` 等旧键，只保留 canonical 参数/变量分界 | 不再接受旧参数 | 参数契约测试 |
| `src/shared/engine-params.ts` | 补齐全量参数校验规则；模型字段 canonical 化；不兼容旧键 | 保存期 fail loud | 参数类型/空值/枚举测试 |
| `src/host/write-preset.ts` | 删除 `outputId`/`aliasOf`/旧覆盖复制/worldBook 热迁移/legacyCleanup；使用显式 templateDir；统一安全文件名与固定宽度序号；支持数字模型参数；原子物化 | 物化只接受 canonical 数据 | 13+ 配置、恶意 ID、迁移产物 |
| `src/host/prompt-configs.ts` | 共用固定宽度排序和安全文件名函数；重复 ID 在合并前拒绝 | Host/Engine 顺序一致 | 13 条、重复 ID |

### Wave 2：Bridge、存储、异步和安全边界

| 文件 | 修改 | 原因 | 风险/验证 |
|---|---|---|---|
| `src/runtime/settings-bridge.ts` | 按端点使用显式 presetRoot；严格请求解析；完整 Origin 校验；导入/物化事务化；参数与 promptConfigs 同源校验；删除旧 payload 分支 | 防止 200 假成功和越界 | 26 端点契约/异常请求 |
| `src/shared/bridge-contract.ts` | 增加端点请求/响应类型或最小 endpoint map；保留统一 `{ok,value}` | 消除宽泛 union | 编译期/契约测试 |
| `src/runtime/models.ts` | `saveSelection` 支持 Promise 并捕获拒绝；超时使用 AbortSignal（若 provider 支持） | 避免 unhandled rejection/悬挂请求 | async reject/timeout 测试 |
| `src/runtime/agents-file.ts` | 受管标记内容安全处理；原子写；失败保留旧文件 | 防止边界破坏/截断 | marker/故障路径测试 |
| `src/host/characters.ts` | 角色卡三文件临时目录 + 原子 rename；PNG 解压大小上限；变量空值保持 | 防止部分写和膨胀输入 | PNG/失败回滚测试 |
| `src/web-surface.ts` | profile manifest 使用原子写和备份恢复 | 自愈不能损坏 profile | 写失败测试 |
| `src/profile-skills.ts` | 同步副本使用临时目录/失败清理；不覆盖用户自定义技能 | 保持技能资产完整 | manifest/部分复制测试 |
| `src/runtime/skills-watcher.ts` | 监听嵌套技能目录或按扫描结果重建 watcher；保留 disposer | watcher 与扫描语义一致 | nested skill 变更测试 |

### Wave 3：前端、引擎、模板、脚本与文档

| 文件 | 修改 | 原因 | 风险/验证 |
|---|---|---|---|
| `src/client/prompt-tool-store.ts` | 自动保存走校验/统一队列；允许用户明确保存空数组；Promise 类型正确；删除旧兼容字段 | 修复 UI 数据丢失 | 清空/非法草稿/竞态测试 |
| `src/client/prompt-tool-bridge.ts` | 严格 fields 与 endpoint payload 解析；空数组不与缺失混淆 | 保持设置语义 | bridge view 单测 |
| `src/client/PromptConfigList.tsx` | 拒绝/提示重复 ID；世界书筛选移动使用实际可见集合；保存失败保留 dirty | 修复列表行为 | UI contract 测试 |
| `src/client/PromptConfigsEditor.tsx` | 更新“写入 preset.yml”文案；变量空值说明 | 消除误导 | 文案检查 |
| `src/client/slot-workbench.tsx` | 补 focus return；减少宿主父节点层级假设 | 可访问性/宿主升级稳定性 | client contract + 浏览器 smoke |
| `engine/schema.mjs` | 固定层级顺序；templateFile 只允许 canonical 预设目录；统一排序；严格 schema | 执行契约唯一 | engine tests |
| `engine/tool-config-engine.mjs` | 使用统一固定宽度文件排序；验证工具文件来源 | 顺序一致 | 13+ tools test |
| `engine/*.mjs` | 对 session Map 增加清理/上限；保持 epoch/waterfall 既有正确语义 | 长运行资源稳定 | session lifecycle tests |
| `scripts/migrate-presets.mjs` | 新增离线一次性 canonical 迁移工具，支持 dry-run、备份、失败非零 | 替代 runtime 兼容 | 临时 DSH_HOME fixtures |
| `scripts/rebuild-composition.mjs` | 临时目录完成后用备份 + rename 的失败安全替换 | 防 library 丢失 | 故障路径测试 |
| `preset/*/preset.yml` | 全部转换为 canonical schema；删除 legacyCleanup/旧字段；worldBook 均使用 promptConfigs；变量空占位保留 | 模板与运行时一致 | 全预设渲染测试 |
| `preset.yml` | 更新完整 canonical 模板和变量规则 | 用户 authoring 单一入口 | YAML round-trip |
| `test/**` | 删除旧兼容断言；新增迁移、安全、顺序、空值、重复 ID、隔离回归 | 验收真实行为 | 完整 `pnpm test` |
| `README.md` | 更新 canonical 目录、迁移命令、测试数、变量规则 | 用户文档一致 | diff check |
| `docs/architecture-params.md` | 重写为 canonical 参数/变量链路，删除旧兼容描述 | 架构单一事实源 | 文档核对 |
| `docs/engine-reuse.md` | 修正参数优先级和固定层序 | 消除旧契约 | grep/人工核对 |
| `SillyTavern.md` | 改为导入生成 canonical `promptConfigs`/`variables`，删除 runtime worldBook 兼容说法 | 转换契约一致 | ST fixture |
| `CHANGELOG.md` | 增加本次 breaking migration 条目，注明不再自动兼容旧格式 | 发布可追溯 | 文案核对 |

## 四、验收标准

### 功能

- [ ] canonical 预设根可发现、切换、导入、导出、复制、删除。
- [ ] 每个预设只读取自身 `preset.yml` 与自身生成目录。
- [ ] 激活预设参数不会污染其他预设。
- [ ] 旧 worldBook 一次迁移后，连续两次重建仍保留 `promptConfigs`。
- [ ] 旧 flat model 参数迁移为顶层 `model/subagentModel`。
- [ ] `variables: { key: '' }` 在保存、生成、worldBook 工具更新和读回中保持。
- [ ] 用户主动删除全部 promptConfigs 后可保存空数组。
- [ ] 重复 ID、非法参数类型和越界路径在保存前失败。

### 安全与可靠性

- [ ] 所有生成文件路径 canonical containment 通过。
- [ ] `legacyCleanup` 不再接受任意外部路径或被移除。
- [ ] `templateFile`/composition 不能读取预设根外文件。
- [ ] loopback Origin 校验 scheme/host/port。
- [ ] 所有 preset.yml、AGENTS、profile manifest 增量写路径原子化。
- [ ] 异步模型保存拒绝不产生 `unhandledRejection`。
- [ ] PNG 解压存在输出大小上限。

### 验证命令

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
pnpm --dir $Repo pack --dry-run --json
```

测试必须在 `D:\AI\workspase\_temp` 执行，所有 DSH_HOME 使用临时目录；不停止当前 DSH 服务，不修改真实用户预设。

## 五、回滚与中断点

- 批量修改前将目标文件备份到 `D:\AI\workspase\_temp\prompt-tool-l2-backup-20260831\`，不把备份纳入 Git。
- 每个 Wave 完成后运行完整验证并记录结果。
- 任一 Wave 验证失败，保留备份和临时迁移现场，停止扩大范围。
- 不对 `main` 做任何提交或推送；最终只提交并推送 `dev`。
- 若迁移工具执行失败，返回非零并保留原 preset 与 `.bak`，不自动删除用户资产。

## 六、执行后复盘

- 更新本文件状态和实际文件列表；
- README / CHANGELOG / 参数架构文档同步；
- 记录 canonical Schema、变量空占位和迁移边界；
- 记录验证命令、测试数量、提交 SHA 和 `origin/dev` 推送结果。