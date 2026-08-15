# 提示词工具（dsh-plugin-prompt-tool）

DSH 插件：把简体中文行为规范注入三层（常驻层 + 按需技能层 + agent preset 锚定注入层），并提供 Web UI 在线编辑 `prompt.md`。完整集成 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的首轮锚定机制。

## 三层注入

- **常驻层（user 层）**：`AGENTS.md` 规则写入 `~/.dsh/AGENTS.md`，由 dsh-agent-instructions 每轮注入（`prompt.md` 不混入，改由 preset 层在锚定确认后注入，避免重复）。
- **按需层（技能）**：注册 `prompt` 技能，content = `prompt.md` 中文规范 + `prompt/SKILL.md` 正文，`resourceBase` 指向 `prompt` 目录，`references` 按需读取（flash-7013 / pro-8013 双档位规则）。
- **独立 agent preset 层**：插件复制 anchored-standard 原版 preset 到 `~/.dsh/.agent-presets/prompt-tool/`（首轮 = 官方 Minimal 真实 schema：持久 `bash` + `str_replace_editor` + 剥离自动注入上下文，无输出 cap）；首轮 reasoning 稳定 "we" 轨迹，we 锚定确认后注入 `prompt.md`，随后放开完整 Standard 目录。

> 提示词采用「we 锚定确认后注入」：首轮剥离自动注入（`agent-instructions` / `skill-catalog`），Minimal 真实工具 schema 下 reasoning 稳定走 "We need…" 轨迹；确认 we 锚定后（或不确认则最多等一轮兜底）把中文规范作为 user 消息补进来（每会话一次）。工具目录晋升不依赖 we 确认（首个工具调用或助手回复即放开），锚定失败也不会卡死。

## 项目引用

本项目集成与参考的生态项目：

| 项目 | 关系 | 复用内容 |
|---|---|---|
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | **集成（上游）** | `preset/agent.cordis.yml` 与 `preset/tool-bootstrap.mjs` 完全复制（字节一致），Minimal 真实 schema 首轮锚定机制 |
| [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | 参考 | 复杂度启发式正则、近距离注入原则、持久事件推导状态（resume 安全） |
| [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) | 参考 | 缓存铁律（静态进 system 头、动态走消息尾）、首轮锚定铁律、开发工具链（dev_* 注入/热重载） |
| [dsh 破限者（1449690477/dsh）](https://github.com/1449690477/dsh) | 姊妹项目 | `prompt/` 技能目录（SKILL.md + references）与之同源，常驻层 AGENTS.md 机制一致 |

### 上游同步

`preset/` 的上游文件不手工修改，通过同步脚本更新（本地差异只有 prompt-injector 块，自动重新注入，永不冲突）：

```sh
git submodule update --remote                      # 先更新 vendor/dsh-anchored-standard 子模块
node scripts/sync-anchored.mjs                     # 默认源 = vendor 子模块
node scripts/sync-anchored.mjs <anchored仓库路径>  # 自定义上游路径
```

- 上游仓库以子模块形式固定在 `vendor/dsh-anchored-standard`，版本可复现；`preset/` 内为同步快照（clone 无需子模块即可直接运行）
- 同步 `tool-bootstrap.mjs`（字节级）+ `agent.cordis.yml`（上游内容 + 本地 prompt-injector 块）
- `preset.yml`、`prompt-injector.mjs` 为本项目自有文件，不覆盖

## 修改记录

- **v2.1（2026-08-15）**：技能目录重命名 `dreammod` → `skill` → `prompt`；新增 `scripts/sync-anchored.mjs` 上游同步脚本。
- **v2.0（2026-08-15）**：跟随 anchored-standard PR #14，首轮工具 schema 从 `pwsh/read + 1024 cap` 改为官方 Minimal 真实 schema（持久 `bash` + `str_replace_editor`，无 cap）；删除 zero 变体与锚定消息机制，回归原版 tool-bootstrap（字节一致）+ `prompt-injector.mjs` 附加件（we 确认后注入一次 prompt.md，未确认最多等一轮兜底）。实测：复杂英文任务 ×5 并行，we 锚定 5/5、首请求纯净、注入恰好一次。
- **v1（2026-08）**：初版——zero 工具锚定变体 + 固定锚定消息 + 三层注入（AGENTS.md 常驻层、skill 按需层、preset 层）。

## Web UI

在 Settings 注册「提示词工具」项，展开后提供：

- **保存**：把编辑框内容写入 `prompt-tool` settings 命名空间，Host 监听后写回 `prompt.md` 与 `~/.dsh/AGENTS.md`
- **打开编辑**：用系统编辑器打开 `prompt.md`
- **在线编辑框**：直接编辑 `prompt.md` 文本

## 工作原理

1. Host 启动读取 `prompt.md` 作为中文规范源。
2. 常驻层：`AGENTS.md` 规则写入 `~/.dsh/AGENTS.md`（首轮被剥离，晋升后由 dsh-agent-instructions 每轮注入）。
3. 按需层：注册 `prompt` 技能，name/description/whenToUse/metadata 全部来自 `SKILL.md` frontmatter。
4. preset 层：复制完整 `preset/` 目录到 `~/.dsh/.agent-presets/prompt-tool/`，并把 `prompt.md` 注入 `prompt-injector` 的 `promptText`（we 锚定确认后注入）。
5. UI 保存通过 settings API 写入 `promptText`；Host 的 watch 回调写回 `prompt.md` 与 `AGENTS.md`，下一次请求即生效。

## 文件结构

```text
dsh-plugin-prompt-tool/
├── package.json
├── prompt.md                  # 中文规范源文件（Web UI 可编辑）
├── AGENTS.md                  # 常驻层附加规则
├── plan.md                    # 设计与测试计划（含上游更新对照、实测数据）
├── tsdown.config.ts           # client bundle 构建配置
├── cordis.patch.yml           # 挂载配置
├── preset/                    # anchored-standard 原版 preset 模板（sync-anchored.mjs 同步）
│   ├── agent.cordis.yml       # 完整 Standard 目录 + Minimal 组（持久 bash + str_replace_editor）+ tool-bootstrap + prompt-injector
│   ├── preset.yml             # preset 元数据
│   ├── tool-bootstrap.mjs     # 原版字节一致：首轮 Minimal schema + 剥离注入 + 晋升
│   └── prompt-injector.mjs    # 附加件：we 锚定确认后注入一次 prompt.md
├── prompt/
│   ├── SKILL.md               # 按需层技能定义（name: prompt）
│   └── references/
│       ├── flash-7013.md
│       └── pro-8013.md
├── scripts/
│   └── sync-anchored.mjs      # 上游 preset 同步脚本
├── src/
│   ├── index.ts               # Host 入口
│   ├── css-modules.d.ts
│   └── client/
│       ├── index.ts           # Client 入口（注册 settings item）
│       ├── PromptEditor.tsx   # 编辑框组件
│       └── PromptEditor.module.css
└── lib/                       # 构建产物（pnpm build 生成，不提交）
    ├── index.js               # Host 运行时
    └── client.js              # Client 运行时
```

## 构建

```sh
pnpm install
pnpm build
```

构建预设引用 `../dsh-web-ui/shared/tsdown.client.ts`；若插件不在 dsh-web-ui 同级目录，改 `tsdown.config.ts` 里的引用路径。

## 挂载

```yaml
- insert:
    - id: prompt-tool
      name: dsh-plugin-prompt-tool
      config:
        text: ''            # 可选：覆盖 prompt.md 文本（默认读文件）
        writeAgents: true   # 是否写 ~/.dsh/AGENTS.md（默认 true）
```

config 字段：`text`（覆盖 `prompt.md` 文本，默认读文件）、`writeAgents`（是否写 `~/.dsh/AGENTS.md`，默认 true）。`strict` 字段仍在 Config 中但当前未使用。

## 锚定机制实测

工具引导由 preset 层的 `tool-bootstrap.mjs`（anchored-standard 原版，字节一致）承担（挂在 agent-plane 首行，`inject:[]` + `prepend: true`，保证 strip 是 waterfall 的最终 transform）：首轮 = Minimal 真实 schema（持久 `bash` + `str_replace_editor`）+ 剥离自动注入 → reasoning 稳定 "we" 轨迹 → 首个工具调用/助手回复落库放开完整目录 → we 确认后（`prompt-injector.mjs`，注册在 tool-bootstrap 之后）注入 `prompt.md` 一次。prompt-tool 插件（host 层）只负责生成 preset，不直接注册工具引导事件，避免与 preset 层重复。

实测（deepseek-v4-pro + reasoningEffort=max，复杂英文任务 ×5 并行，dsh web HTTP API）：

| 断言 | 结果 |
|---|---|
| turn1 reasoning 首词 we | **5/5** |
| 首请求工具 | [bash, str_replace_editor]（5/5） |
| 首请求 maxTokens | 256000（无 cap，5/5） |
| 首请求前注入消息 | 纯净（仅 user，5/5） |
| prompt.md 注入 | 恰好一次，we 确认后同 turn 注入（5/5） |
| 晋升后目录 | 33 工具（5/5） |

详细设计、上游更新对照与踩坑记录见 [plan.md](plan.md)。