# dsh-plugin-prompt-tool L2 参数、Bridge 与 Engine 重构计划

> 日期：2026-09-01
> 分支：`dev`
> 基线：`5cc1b0f`
> 范围：参数链路、Settings Bridge、Client 存储、Engine 装配、脚本安全与文档一致性。
> 明确排除：预设管理本身。当前 `agent-presets` / preset root / seed / copy / remove / open 已经可用，本计划不再修改这些链路。

## 一、范围与结论

本次重构只处理以下三类问题：

1. **参数与行为契约**
   - 参数校验、空值语义、模型参数、`promptConfigs` 合并顺序、重复 ID、旧字段兼容。
2. **Bridge 与存储安全**
   - 请求解析、Origin 校验、路径越界、原子写、异步失败、PNG 解压上限。
3. **Engine 与前端一致性**
   - 实际插入点按需装配、同插入点内排序、session 清理、UI 保存队列、文档漂移。

不再包含以下内容：

- `agent-presets` 所有权、roots、system/user 信任、默认预设。
- preset root、preset ID、preset seed、copy、remove、open。
- `preset.yml` 的目录布局或预设管理迁移。
- `cordis.patch.yml` 对 `agent-presets` 的 patch。
- `.engine` 作为预设根级共享目录的布局调整。

## 二、目标不变量

1. **预设管理保持现状**
   - 不改 `ctx.agentPresets` 的 roster / discovery / copy / remove / open。
   - 不改 `$DSH_HOME/.agent-presets` 的目录结构和 seed 逻辑。
   - 不引入新的 preset root，不调整 system/user 信任。
2. **参数与变量分离**
   - `params` 中 `''` / `[]` 表示删键并回落默认。
   - `variables: { key: '' }` 是合法占位值，必须原样保留。
   - `variablesEnabled: false` 只停用插值，不删除源数据。
3. **行为源保持单一**
   - `preset.yml` 继续作为参数与提示词配置的行为源。
   - 不把行为源迁移到 `agent.cordis.yml` 或新增 preset 管理文件。
4. **Bridge 契约严格**
   - 成功载荷 `{ ok: true, value }`。
   - 失败载荷 `{ ok: false, code?, message? }`。
   - 每个端点有明确请求/响应类型，不复用宽泛 union。
5. **Engine 按声明装配**
   - 只装配配置实际声明的插入点。
   - `order` 只在同一插入点内生效。
   - 不同插入点之间没有插件自定义的全局顺序。
6. **安全边界前移**
   - 所有文件路径写入前做 canonical containment。
   - 所有信任边界输入先校验类型、范围、枚举，再落盘。
7. **旧数据只走显式迁移**
   - 迁移脚本只处理旧参数、旧 worldBook、旧覆盖文件。
   - 不做运行时自动兼容，不改 preset 目录管理。

## 三、已确认问题清单

### P1 数据完整性与安全

1. `src/host/manifest.ts`：
   - `loadPresetSpec` 使用宽松 YAML parse，不检查解析错误。
   - 导出 ID 未做统一校验。
   - 组合文件与模块相对路径缺少统一 containment 校验。
2. `src/host/write-preset.ts`：
   - prompt config / custom tool ID 直接拼接文件名，可能越出生成目录。
   - `legacyCleanup` 可删除 `outDir` 外部文件。
   - 多处增量写路径非原子。
3. `engine/schema.mjs`：
   - `templateFile` 可读取任意本地文件进入模型上下文。
   - `/meta` 层级顺序与执行契约不一致。
4. `src/runtime/settings-bridge.ts`：
   - Origin 只比较 hostname，未比较 scheme 和 port。
   - 导入 ID 与 writer 的合法 slug 规则不一致。
   - 部分端点缺少严格请求解析。
5. `src/host/characters.ts`：
   - PNG `inflateSync` 无解压后大小上限。
6. `src/runtime/models.ts`：
   - 官方异步 `saveSelection()` 未 await / catch。

### P1 参数与行为

1. `src/client/prompt-tool-store.ts`：
   - 自动保存绕过权威校验。
   - 空数组直接 return，用户无法清空全部 `promptConfigs`。
   - 保存失败可能被吞掉但 Bridge 仍返回成功。
2. `src/runtime/configs-validate.ts`、`engine/schema.mjs`：
   - 重复 ID 不拒绝，最终后者覆盖前者。
3. `src/host/write-preset.ts`：
   - 手写数字模型参数不会生成 model patch。
   - 空数组无法清除 `moduleConfigs` 旧值。
4. 生成文件排序：
   - 两位数字前缀 + 字典序读取，超过 10 条后顺序错误。
5. Engine 层级：
   - 需要按实际声明插入点分组注册。
   - 未声明的插入点不应挂监听器。
   - `order` 只在同一插入点内解释。

### P2 维护与 UI

1. 多个 engine session Map 缺少统一清理或上限。
2. `skills-watcher` 不监听嵌套技能目录。
3. 世界书筛选视图的移动逻辑使用全量配置视图。
4. Bridge 成功载荷类型宽泛，缺少按端点契约。
5. README、`docs/architecture-params.md`、`docs/engine-reuse.md` 已漂移。
6. `scripts/rebuild-composition.mjs` 的 library 替换不是失败安全替换。

## 四、修改清单

### Wave 1：参数契约与路径安全

| 文件 | 修改 | 原因 | 验证 |
|---|---|---|---|
| `src/shared/engine-params.ts` | 补齐全量参数校验；模型字段 canonical 化；不兼容旧键 | 保存期 fail loud | 参数类型 / 空值 / 枚举测试 |
| `src/shared/param-keys.ts` | 删除旧内容参数别名，只保留 canonical 键 | 键集唯一来源 | 契约测试 |
| `src/host/manifest.ts` | 严格 YAML 解析；统一路径 containment；导出 ID 校验 | 防路径穿越和半接受 | 坏 YAML / 路径反例 |
| `src/host/write-preset.ts` | 安全文件名；固定宽度序号；数字模型参数；原子物化；删除 `legacyCleanup` | 防越界与数据丢失 | 13+ 配置 / 恶意 ID / 迁移产物 |
| `src/host/prompt-configs.ts` | 统一固定宽度排序；重复 ID 在合并前拒绝 | Host / Engine 顺序一致 | 13 条 / 重复 ID |

### Wave 2：Bridge、存储与异步安全

| 文件 | 修改 | 原因 | 验证 |
|---|---|---|---|
| `src/runtime/settings-bridge.ts` | 严格请求解析；完整 Origin 校验；导入/物化事务化；参数与 promptConfigs 同源校验 | 防假成功和越界 | 26 端点契约 / 异常请求 |
| `src/shared/bridge-contract.ts` | 增加端点级请求/响应类型，保留统一 `{ok,value}` | 消除宽泛 union | 编译期 / 契约测试 |
| `src/runtime/models.ts` | `saveSelection` 支持 Promise 并捕获拒绝；超时使用 AbortSignal | 避免 unhandled rejection | async reject / timeout 测试 |
| `src/runtime/agents-file.ts` | 受管块安全处理；原子写；失败保留旧文件 | 防截断 | marker / 故障路径测试 |
| `src/host/characters.ts` | PNG 解压大小上限；三文件临时目录 + 原子 rename；变量空值保持 | 防膨胀与部分写 | PNG / 失败回滚测试 |
| `src/web-surface.ts` | profile manifest 原子写和备份恢复 | 自愈不损坏 profile | 写失败测试 |
| `src/profile-skills.ts` | 同步副本临时目录 / 失败清理；不覆盖用户自定义技能 | 保资产完整 | manifest / 部分复制测试 |
| `src/runtime/skills-watcher.ts` | 监听嵌套技能目录或按扫描结果重建 watcher | watcher 与扫描一致 | nested skill 变更测试 |

### Wave 3：前端、Engine、脚本与文档

| 文件 | 修改 | 原因 | 验证 |
|---|---|---|---|
| `src/client/prompt-tool-store.ts` | 自动保存走校验 / 统一队列；允许明确保存空数组；Promise 类型正确 | 修复 UI 数据丢失 | 清空 / 非法草稿 / 竞态测试 |
| `src/client/prompt-tool-bridge.ts` | 严格 fields 与 endpoint payload 解析；空数组不与缺失混淆 | 保持设置语义 | bridge view 单测 |
| `src/client/PromptConfigList.tsx` | 拒绝/提示重复 ID；世界书筛选移动使用实际可见集合；保存失败保留 dirty | 修复列表行为 | UI contract 测试 |
| `src/client/PromptConfigsEditor.tsx` | 更新“写入 preset.yml”文案；变量空值说明 | 消除误导 | 文案检查 |
| `src/client/slot-workbench.tsx` | 补 focus return；减少宿主父节点层级假设 | 可访问性 / 宿主升级稳定 | client contract + 浏览器 smoke |
| `engine/schema.mjs` | 按实际声明插入点返回能力；`templateFile` 只允许 canonical 预设目录；统一排序；严格 schema | 执行契约唯一 | engine tests |
| `engine/layers.mjs` | 按配置首次出现的插入点分组注册，只装配实际声明的 seam | 按需插入 | 未声明 seam 无监听器测试 |
| `engine/executor.mjs` | 同插入点内按 order / 文件顺序执行；不同插入点不做全局排序 | 语义一致 | order / seam 回归 |
| `engine/tool-config-engine.mjs` | 统一固定宽度文件排序；验证工具文件来源 | 顺序一致 | 13+ tools 测试 |
| `engine/*.mjs` | session Map 增加清理 / 上限；保持 epoch / waterfall 既有语义 | 长运行稳定 | session lifecycle tests |
| `scripts/migrate-presets.mjs` | 离线一次性参数迁移：旧参数、旧 worldBook、旧覆盖文件；dry-run、备份、失败非零 | 替代运行时兼容 | 临时 DSH_HOME fixtures |
| `scripts/rebuild-composition.mjs` | 临时目录完成后用备份 + rename 的失败安全替换 | 防 library 丢失 | 故障路径测试 |
| `README.md` | 更新参数、变量、测试数、迁移命令 | 用户文档一致 | diff check |
| `docs/architecture-params.md` | 重写参数/变量链路，删除旧兼容描述 | 架构单一事实源 | 文档核对 |
| `docs/engine-reuse.md` | 修正参数优先级与插入点装配语义 | 消除旧契约 | grep / 人工核对 |
| `SillyTavern.md` | 导入生成 canonical `promptConfigs` / `variables` | 转换契约一致 | ST fixture |
| `CHANGELOG.md` | 增加参数迁移条目，注明不再自动兼容旧参数 | 发布可追溯 | 文案检查 |

## 五、验收标准

### 功能

- [ ] 每个预设只读取自身 `preset.yml` 与自身生成目录。
- [ ] 激活预设参数不会污染其他预设。
- [ ] 旧 `worldBook` 一次迁移后，连续两次重建仍保留 `promptConfigs`。
- [ ] 旧 flat model 参数迁移为顶层 `model/subagentModel`。
- [ ] `variables: { key: '' }` 在保存、生成、worldBook 工具更新和读回中保持。
- [ ] 用户主动删除全部 `promptConfigs` 后可保存空数组。
- [ ] 重复 ID、非法参数类型和越界路径在保存前失败。
- [ ] `order` 只影响同一插入点内的顺序。

### 安全与可靠性

- [ ] 所有生成文件路径 canonical containment 通过。
- [ ] `legacyCleanup` 移除或只接受安全路径。
- [ ] `templateFile` / composition 不能读取预设根外文件。
- [ ] loopback Origin 校验 scheme/host/port。
- [ ] 所有 `preset.yml`、`AGENTS`、profile manifest 增量写路径原子化。
- [ ] 异步模型保存拒绝不产生 `unhandledRejection`。
- [ ] PNG 解压存在输出大小上限。
- [ ] Engine session Map 有清理或上限。

### Engine 语义

- [ ] 未声明的插入点没有监听器。
- [ ] 不同插入点之间没有全局排序。
- [ ] 同一插入点内 `order` 与文件顺序稳定。
- [ ] 超过 10 条配置 / 工具时排序仍正确。

## 六、验证命令

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
pnpm --dir $Repo pack --dry-run --json
```

所有测试使用临时 `DSH_HOME`；不停止当前 DSH 服务，不修改真实用户预设。

## 七、回滚与中断点

- 每个 Wave 完成后运行完整验证并记录结果。
- 任一 Wave 验证失败，保留工作树和错误证据，停止扩大范围。
- 不对 `main` 做任何提交或推送；最终只提交并推送 `dev`。
- 若迁移工具执行失败，返回非零并保留原参数与 `.bak`，不自动删除用户资产。

## 八、执行记录

- [x] 合并两份方案。
- [x] 移除预设管理重构内容。
- [ ] Wave 1：参数契约与路径安全。
- [ ] Wave 2：Bridge、存储与异步安全。
- [ ] Wave 3：前端、Engine、脚本与文档。
- [ ] 最终验证、提交、推送 `origin/dev`。
