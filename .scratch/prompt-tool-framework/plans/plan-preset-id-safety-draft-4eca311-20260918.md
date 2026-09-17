# 草稿：预设 id 安全化（插件侧根治「Ponytail 卡不注入」）

> 状态：**未开工**。前一个任务（技能停用改为文件层调用策略，占用 `PLAN.md` 与 8 个源文件）正在运行，
> 本任务需等它提交推送、工作树干净后，按仓库流程正式化为 `PLAN.md` 再执行。
> 基线：dev@`4eca311`（叠加技能任务未提交改动）。
> 用户授权：2026-09-18「插件侧根治」。

## 用户已拍板的取舍

1. 安全 id 用 **`pt-` 前缀**（`pt-standard` / `pt-ptc` / `pt-minimal`）。
2. **不做工作台遮蔽标记**——用户原话：不需要标记，因为已经自动改名，或者在「拉取官方内置预设、装配成本项目预设时」就使用新名。即：在生成/新建/种子化落点解决，不新增 UI 提示。
3. 等技能任务收尾后再开工（避免同文件互相覆盖）。

## 根因（已核实，含证据）

1. 宿主发现预设的根顺序：shipped（内置，随发行包分发）根在最前，用户根在最后，**同名 id 由靠前的根赢**——
   `deepseek-harness/packages/preset/agent-presets/src/preset.ts:55-64`（`includeShippedRoot` / `includeUserRoot` 注释）、
   安装包 `lib/types/index.js:187-189`（roots 组装），注释原话「a user directory named like a shipped preset is shadowed by it」。
2. 内置预设目录：`profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/{cordis,minimal,ptc,standard}`。
3. 插件无法从自身解析该包（`createRequire(...).resolve('@deepseek-ai/dsh-agent-presets/package.json')` → `MODULE_NOT_FOUND`），
   因为插件是被 link 进 profile 的、Node 按真实路径向上解析，解析链不进 `profiles/node_modules`。
4. 权威判定通道是宿主服务 `agentPresets`：`list()`（含 `trust: 'system' | 'user'`）、`resolve(id)`（含 `path`）、
   `settings()`（`{ presets: [{ id, trust, isDefault }], authorable, modeSelectionEnabled }`）——
   `deepseek-harness/packages/preset/agent-presets/src/index.ts:290-303`（settings）、`:322-360`（compositionInventory）、`:372-385`（resolve）。
   插件当前 `inject` 不含它（`src/index.ts`：`export const inject = ['skills', 'commands', 'llm', 'subagents']`）。
5. 模板名与输出目录名当前是同一个值：`writePreset` 的 `templateName`（`src/host/write-preset.ts:258-274`，`outputId` 已支持覆盖但
   调用方从未传），模板查找 `resolveRenderablePresetDir` 是「用户目录优先 → 包内同名兜底」（`src/host/manifest.ts:267-274`）。
6. 包内模板目录只有 `preset.yml`（参数源 + 模块清单），组合本体由模块库渲染，所以**改用户目录名不必动包内模板目录**。
7. 宿主 standing mount 的重挂载判据是组合文件 `agent.cordis.yml` 的 mtime+size
   （`deepseek-harness/packages/preset/agent-presets/src/index.ts:776-806`）；只改 `prompt-configs/*.yml` 不会重挂载。
8. 现有 `'standard'` 字面量落点：`src/index.ts:121/281/504/713/730`、`src/host/write-preset.ts:260`、
   `src/host/manifest.ts:177`（`loadPresetContent` 默认值）、`src/config.ts:28,79`、`src/client/data/prompt-tool-fields.ts:80`、
   `src/client/data/prompt-tool-view.ts:102`、`src/runtime/settings-bridge.ts:640,1833`。
9. 测试里 72 处 `standard` 分布在 16 个文件（`test/host/write-preset.test.mjs` 18 处最多）——**保持「模板名仍是 standard」即可不动这些用例**。
10. 本机遗留：`.agent-presets/{standard,ptc,minimal}` 三个被遮蔽目录（已用复制换名 `*-copy` 绕开，待新会话验证后清理）。

## 方案（待正式化）

- **W1 安全 id 判据（纯函数 + 探测）**
  - `safePresetId(id, occupied)`：`occupied.has(id)` → `pt-${id}`，否则原样。
  - `templateNameFor(id, templateIds)`：包内精确命中优先；否则 `id` 以 `pt-` 开头且去掉前缀后命中包内 → 用去掉前缀的名字（实现「安全 id → 包内模板」反查，零硬编码映射表）。
  - `detectOccupiedPresetIds()`：宿主服务优先（`agentPresets.settings()` 取 `trust === 'system'`），启动瞬间用文件系统探测兜底
    （`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/*` 与 `$DSH_HOME/profiles/*/node_modules/...`）；
    两者都不可用 → 空集合 = 退回今天的行为（不归一化）。
- **W2 生成路径落到安全名**：`ensurePresetSeed`（首次种子化复制包内模板时用安全名）、`cloneBuiltinPreset`（「新建」目标名用安全名，
  返回实际 id 供 UI 显示）、`listBuiltinTemplates`（展示安全名）、`writePreset`（`outputId` 归一化）。
- **W3 激活预设归一化**：runtime 确定 `presetTemplate` 时（首次加载、settings 变化、工作台切换）若被占用 → 改用 `pt-<id>`，
  写回 settings 并 `syncHostDefault()`；服务晚到时二次归一化。
- **W4 回归测试**：纯函数（安全 id、模板反查、占用探测降级）、行为（种子化/新建/写入落到安全名、既有目录不被误改）、
  归一化写回 settings；契约不变式：模板名仍为 `standard`，现有技能/预设用例不动。
- **W5 文档与交付**：README 预设一节说明「与内置预设重名时自动使用 `pt-` 前缀」、`CHANGELOG.md` 记行为变化、
  门禁（typecheck / lint / test / build / `git diff --check`）、中文 Conventional Commit 推送 origin/dev。

## 验证与回滚

- 验证：单测 + 一个「临时 `DSH_HOME` 里放一个与内置同名的预设目录」的行为回归（断言生成物落在 `pt-<id>`、原目录不被改）；
  真实环境复核用「新会话 + 会话文件探针」确认注入段出现。
- 回滚：本轮只改插件代码，`git revert` 提交即可；用户数据侧已完成的复制换名（`standard-copy` 等）不回滚。

## 接手步骤（前一任务提交后）

1. `git -C D:\AI\GitHub\dsh-plugin-prompt-tool status --short` 确认为空（工作树干净）。
2. 归档技能任务的 `PLAN.md` 到 `.scratch/prompt-tool-framework/archive/plan-skills-file-policy-<其提交SHA>-20260918.md`（先核 SHA-256）。
3. 用本草稿正式化新 `PLAN.md`（dev-expert「任务拆解与执行」格式，Wave 末尾 `[✔]`/`[ ]` 标记）。
4. 按 W1→W5 执行，门禁全绿后提交推送，并追加 `.ai-memory/{YYYYMMDD}/daily.md`。
