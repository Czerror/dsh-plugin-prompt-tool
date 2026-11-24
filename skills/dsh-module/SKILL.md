---
name: dsh-module
description: 用于编写、导入或审查 DSH Prompt Tool 的模块定义，编辑已安装模块的规则，排查模块未生效，或转换 SillyTavern 与旧模块格式。
---

# DSH 模块

模块在真实 Agent scope 中贡献规则与能力，官方会话预设仍由宿主拥有。先确定任务是创建、编辑、审查、导入还是旧格式转换；只读审查只交付发现，修改按已有授权执行。

## 1. 定位目标与契约

确认实际 `DSH_HOME` 和插件安装根。已安装模块在 `$DSH_HOME/.prompt-tool/modules/<id>/`，启用集合在 `.prompt-tool/config.yml`。当前规则和版本用模块工具读取，完整定义从工作台导出。拟安装的 `module.yml` 的 id 应与目标目录名一致。

本技能可能被复制到 `$DSH_HOME/skills/dsh-module/`；下文 `engine/`、`templates/`、`modules/` 都相对**插件包根**。从已加载插件位置或安装信息定位，不能按技能目录或默认 profile 推算。随包技能只补缺失，已有用户副本要在授权范围内比对更新。

按任务读取 [reference.md](reference.md) 对应章节：

| 任务 | 章节 |
|---|---|
| 选择条件、动作、注入位置，诊断未命中 | 条件与事实、动作与执行点、注入层 |
| 模型/PTC/批准参数、委派深度、宿主能力 | 参数与宿主控制 |
| 编辑规则、变量、文件、Soul 或检索 | 工具与数据所有权 |
| 人设、模板赋值、关键词激活 | 人设与变量、上下文激活 |
| ST 导入或旧定义转换 | 导入与旧格式 |

完成判据：目标实例、模块身份、原始定义和所需契约均已定位；资料缺失时明确未确认项。

## 2. 构造最小候选

新模块从一条关闭的规则起步，确认启用授权后再激活：

```yaml
id: my-module
name: 我的模块
modules: [rule-engine]
rules:
  - id: project-rules
    enabled: false
    then:
      - id: inject
        kind: inject-text
        config:
          layer: pre-step
          strategy: static
          position: after-user
          dedupe: session
          text: 按用户确认的项目约束执行。
```

编辑已有模块时保留未知字段、注释、资产与完整分支树，只改变任务要求的内容：

- 通过工作台或规则工具编辑已安装模块的条件、动作、正文、人设与启停。`rules/` 内的提交记录和对象由插件维护。需要用外部完整定义覆盖时，先预览再确认导入。
- 共享参数使用工作台的 `layerSettings`，行级配置在交换定义中归 `moduleConfigs`，变量通过专用工具编辑。
- `customTools` 只声明需要的自定义工具；官方工具与普通委派沿用会话预设。
- `memory.md`、`data/` 由各自文件/账本工具拥有；用户 AGENTS.md、CLAUDE.md 及独立指令策略走授权通道，正文留在原文件。

`if` 是单键节点；用 `all/any/not/notAny` 组合。动作 id 在整条规则的 then/else/嵌套树内唯一；else 必须对应 if。缺事实为 `UNAVAILABLE`，不是 false，取反也不放行。规则的 layer 是注入动作缺省层与展示归属，不建立跨层执行顺序。

完成判据：每处修改有明确所有者，条件能取得所选执行点的事实，能力与受众均限于请求范围。

## 3. 校验并提交

已有规则优先用 `module_rules_read({ moduleId })` 取得完整树、版本和当前目录；向 `module_rules_edit` 提交完整规则候选及 `expectedRevisions`，先用 `validateOnly: true` 校验。工具参数以实际 schema 为准。

离线核对规则可用包内 `engine/rule-spec.mjs` 的 `compileRules(module.rules, { moduleId: module.id })`；它只校验规则数组，不验证完整模块、资产可读性或运行依赖。有模板文件时还需按该函数的 `promptConfigOptions` 提供实际模块根。完整模块走工作台或导入候选校验。

保存时保留正文与启停的独立版本：关闭规则标记 `settingsChanged`，显式启用用 `activateRuleId`，整规则删除用 `rule: null`。版本冲突先重读，不重放旧写入。

| 结果 | 后续 |
|---|---|
| 校验拒绝或版本冲突 | 修正候选或重读版本，已提交内容保持 |
| `activationPending` | 用返回版本与 `activateRuleId` 重试选择，不重放 edits |
| 已保存、仅运行发布失败 | 用 `refreshOnly` 重试发布，不混用 edits/activateRuleId/validateOnly |

完成判据：读回已提交规则及版本，分别确认保存、激活与运行发布状态。

## 4. 验证生效并交付

工作台保存与开关走现有运行更新；直接手改定义后，通过重新读取与重建链确认实际加载结果。变量内容更新不重挂 Agent。插件代码、bundle 或 patch 更新需要用户重启 DSH；保留当前运行服务。

按需求观察实际主/子 Agent 的条件命中、投递位置与次数、工具可见/执行面或变量写入。重点复核所改边界：没有事实、未授权目标、过期版本或依赖缺失；静态编译成功只证明声明合法。

仓库开发遵守 AGENTS.md 的检查要求；安装包使用者不依赖未分发的开发脚本。交付列出修改目标、实际运行的检查、未验证项和是否需要更新技能副本/重启。只读审查按上述所有权、执行点、版本与生效边界给出发现和改法。
