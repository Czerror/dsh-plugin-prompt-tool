---
name: dsh-module
description: 新建、修改、审查 DSH Prompt Tool 模块，或把规则、人设、工具和 SillyTavern 来源转成原生 module.yml；也用于排查启用后未注入、将旧内部上下文/会话变量格式显式转换为原生规则。模块由插件在各 Agent scope 装配，与官方会话预设分开。
---

# DSH 模块

先确定任务是创建、编辑、审查、导入还是旧格式转换。只读审查不授予修复；用户已经授权的修改直接完成，不额外请求确认。涉及安装、启用新能力、覆盖用户文件或重启服务，遵守会话已有授权和项目边界。

路径基于实际 `$DSH_HOME`。模块定义为 `.prompt-tool/modules/<id>/module.yml`，启用集合在 `.prompt-tool/config.yml`。包内 `engine/`、`templates/`、`modules/` 相对插件包根，不相对本技能目录；可通过已加载插件位置或实际安装信息定位，不猜默认 profile。

## 1. 读取目标与所有者

读取完整 module.yml 与有关资产，确认目录名和 id 一致，保留用户已有修改。不要编辑 `rules/`：它是完整定义的校验投影，手改会被恢复。

| 内容 | 写入位置 |
|---|---|
| 条件、动作、正文、规则启停 | rules |
| 共享模型/能力参数 | layerSettings 的登记层 |
| 持久模块变量 | 顶层 variables |
| 全局变量 | 同一 DSH_HOME 的插件 variables.yml，经变量 owner 读写 |
| 人设正文/选项 | 各模块 persona.main / persona.subagent；rules/_settings.yml 仅作投影 |
| 主/子人设来源 | config.yml.personaSources 只存单选模块 ID，默认官方 |
| 自定义工具/子代理授权 | customTools / subagentToolPolicy |
| 模块私有文件 | memory.md、assets/（只读）、data/（只追加），经 module_file_read/append 显式读写；装配清单走 module_manifest |
| 用户指令文件 | 原文件与独立指令策略，独立授权通道 |

完成判据：每处改动都有单一 owner，工具操作目标与 UI 编辑模块不混淆。

## 2. 创建最小规则

```yaml
id: my-module
name: 我的模块
version: 1.0.0
modules: [rule-engine]
variables: {}
rules:
  - id: project-rules
    enabled: false
    then:
      - id: inject
        kind: inject-text
        config:
          layer: system-section
          strategy: static
          text: |-
            按用户确认的项目约束执行。
```

一条规则有独立总开关；动作 id 在整条规则的 then/else/嵌套树内唯一。if 缺省为无条件，else 必须有对应 if。条件未知时不能以“否定”为由放行。规则级 layer 是动作缺省层与展示归属，不是全局执行阶段。

条件、动作和字段选择查 [reference.md](reference.md)。工具或请求类动作有自身执行点；tool-pipeline 没有 inject-text 通道。普通文本空白保持空，不补未经请求的默认正文。

完成判据：完整候选通过唯一 compileRules 校验，规则启停、受众、层、位置和次数符合请求。静态可解析不等于模型实际收到。

## 3. 变量、人设和上下文激活

普通规则引用的变量需手动在模块变量卡建立；不要扫描正文偷偷登记。空字符串是有效占位，会遮住同名全局值；删除模块键才回落全局。动作 config.variables 已退役。

需要赋值才声明 `params.templateEvaluation: true`，使用 `{{module.set::key::value}}` 或 module/global 的 get/add/inc/dec。一张模板只能写一个域，扫描与预览只读；禁止用 session 表或执行重挂伪装持久事务。

人设正文使用模块内 persona.main/subagent；主会话和子代理各自单选来源，默认官方。来源由独立人设卡下拉选择，config.yml.personaSources 只存模块 ID，不能放正文；选择不自动启用来源模块 rules。仅取所选模块对应受众的字段，不跨模块逐字段合并。省略字段继承、空文本清空、complete:false 解除人设独占；有效官方人设与启用规则的 complete 冲突仍需配装预检。人设不进入规则数组或排序，rules/_settings.yml 的校验投影保持只读。

上下文激活使用 `strategy: context-activation`、`params.activation.scan: batch|history`。关键词、候选组和副键约束的语义查 reference；启停与受众仍归规则。记忆不自动生成常驻规则。

完成判据：变量来源和空值语义明确，人设继承可表达，激活字段无需依赖“来自 ST”才生效。

## 4. 能力与模型工具

只声明任务需要的能力。模型工具目录与能力映射如下：

| 能力 | 工具 |
|---|---|
| module-rule-tools | module_rules_read / module_rules_edit |
| module-variable-tools | module_variables |
| module-file-tools | module_file_read / module_file_append |
| module-manifest-tools | module_manifest |
| module-import-tools | module_import |
| tool-config-engine | customTools 声明的工具 |

规则先读完整树与 revisions，再携带 expectedModuleId/expectedRevisions 编辑完整合法规则；关闭标记 settingsChanged，显式启用用 activateRuleId，删除整规则用 rule:null。正文保存不覆盖并发状态，版本冲突先重读。

变量先 list/get 取版本，再 set/delete；set 必须显式字符串，空串不是删除。global 写影响同一安装的所有模块。文件 append 带当前目标身份与显式 path，与规则事务分开；module_manifest 按清单只写 data/、不覆盖。module_import 先预览并完成选择，提交原始 files 与两份预览凭据，默认另存且不自动启用。

共享模型/能力参数以 `ENGINE_PARAM_DEFINITIONS` 为唯一目录，使用登记的 layerSettings 路径：主/子模型路由与采样、PTC 呈现、run_code 环境、Git Bash、指令提示和工具批准都在其中；数量与 options 以源码为准，不抄旧文档的固定键数。也可通过 request-params 动作按受众改请求。官方工具、规划、压缩和普通委派来自官方预设，模块不重声明它们。

完成判据：声明与实际工具注册一致，目标、版本、批准和取消保护没有绕过。

## 5. 导入和显式转换

ST 预设、角色卡、世界书优先经工作台或 module_import 转换。**ST 导入自动登记缺失裸变量为空占位；普通规则不自动登记。** 导入只转换文本和声明，不执行 STscript 或任意来源代码；报告与生成后的 enabled 状态必须一起检查。

用户要求转换旧内部模块时：

1. 读取完整定义并保存用户同意范围内的备份；保留未知资产、记忆与来源证明。
2. 将旧上下文策略转换为 context-activation，明确 scan；ST 数字副键映射为具名真值逻辑，不能照抄旧 any/not 注释。
3. 将 stWorldBook 执行字段拆为 activation，把角色/位置/不支持控制项移至 source.original；模块递归声明 contextActivationRecursive。
4. 将 set/get/add/inc/decvar 经 parser 转为 module/global 操作，启用 templateEvaluation。局部变量无冲突提升到顶层 variables，同名不同值先报告并解决；不建立第三层变量。
5. 将旧工具与能力改为上表名称；完整规则替换保留分支与未改字段，记忆从 note 副作用分离。
6. 将扁平 persona 明确分配到 main/subagent，保留省略/空串/false；由用户为两类受众各选择官方或一个模块来源，不因转换自动启用规则或切换来源。
7. 旧私有记忆标记先核实并把私有内容归回 memory.md；不能单删标记后导出。
8. 在隔离候选校验与读回，再按授权提交；失败保留原定义。

插件不提供自动迁移器。未知宏、不等价控制或无法证明的行为要明确报告，不能把成功解析当成转换完成。

## 6. 生效与交付

工作台保存和开关走官方插件运行更新；变量内容更新不重挂 Agent。直接手改 module.yml 的实际加载结果需通过重新读取/重建链确认。代码、bundle、patch 更新需要用户重启 DSH；不自行停止正在运行的服务。

验证以实际公共出口为准：层、位置、次数、受众、规则条件、epoch、变量写入与 disposer。读取失败、过期版本、解析拒绝不应改盘；发布失败区分已保存与尚未生效，refreshOnly 不重放写入。

在本仓库开发时遵守 AGENTS.md 的隔离 cwd 和完整 package gates。一次性探针放临时目录，永久测试须满足项目的 seam/独立真值/公共接口准入，不为退役符号写墓碑测试。

完成判据：用户要求的改动、生效验证和失败路径已覆盖，交付明确实际运行过的检查与未验证限制。

## 审查已有模块

按身份、完整规则树、执行点、受众、变量 owner、共享参数归属、能力授权、人设单选来源与 complete 冲突、排序、保存版本逐项核对。纯审查只给事实与改法，不自动把发现转成修复授权。
