# Caveman 提示词来源与修改说明

- 上游：[JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)。
- 固定提交：`a192894723a8f47e7f504c7b5041967ff1f18e55`。
- 原始文件：`skills/caveman/SKILL.md`、`skills/ultracave/SKILL.md`、`skills/megacave/SKILL.md`。
- 许可：Apache-2.0，完整文本见 [LICENSE](LICENSE)，相关署名见 [NOTICE](NOTICE)。当前版本的提示词不采用上游保留的历史 MIT 许可。

本模块已修改上游提示词：精简重复的说明及示例，保留三档风格、技术载荷保护、用户语言和清晰表达例外；文言档适配简体中文并尊重明确语言要求。模式选择改由 DSH 模块和互斥规则卡负责，移除上游命令、hook 及状态查询约定。正文直接内嵌于 module.yml，各档主会话系统段与子代理 pre-step 各有一份相同正文；后者按当前模型可见上下文去重，压缩或替换后可能重新投递。

不包含上游 CLI、hooks、运行时、云服务、输入压缩或其它技能，不承诺 token 节省或模型遵从率。本模块为独立适配，不代表上游官方背书。
