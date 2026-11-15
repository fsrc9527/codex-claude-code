# Claude Code for Codex

把本机 Claude Code 作为 Codex 里的可见子智能体。可以派任务、查工具记录、在同一会话里追问，也可以在子智能体面板停止。

需要本机 Codex、Git、Node.js 22.13+（含 npm）和已配置的 [Claude Code](https://code.claude.com/docs/en/setup)。运行一条命令即可安装。

```sh
npx --yes --package=git+https://github.com/fsrc9527/codex-claude-code.git codex-claude-code
```

已下载源码时也可在目录里运行 `node install.mjs`。安装器会注册本地 MCP、Skill 和 `Claude Code` 子智能体。重启 Codex 后，在项目对话中试一下。

> `$claude-code-delegate` 让 Claude Code 只读定位登录入口，返回文件路径和行号。

派任务和续问都可用 `model` 指定当前供应商支持的模型。`claude_code.models` 可查询候选模型。Anthropic 官方 Claude 模型理论上可用，尚未实测。

新任务省略模型时使用已配置的默认值。续问省略模型时优先沿用同一会话最近一次成功运行的模型，否则沿用所续接的那一轮。运行记录会显示模型选择。

派任务和续问都可传 `effort`。在 `claude_code.models` 中传入 `model` 可查询该模型的 `efforts`。续问省略档位时沿用会话选择，换到不支持原档位的模型时使用目标模型默认值。明确指定不支持的档位会报出可用选项。`trace` 会显示记录的档位。

任务默认只读。授权后可用 Edit 和 Write 修改文件。子任务在 Claude Code 安全模式运行，保留供应商配置并关闭项目 hooks、插件和 MCP。安装器将本地 `claude_code` MCP 设为自动批准。

派任务和追问使用当前模型供应商的额度。执行记录保存在 Codex 用户目录的 `claude-code/runs.sqlite`。重复执行安装命令可以更新。

## 按需委派

安装后，把下面这段追加到目标项目根目录的 `AGENTS.md`，或追加到 `~/.codex/AGENTS.md` 作为个人默认。安装了多个桥接时，可在同一节列出各自的角色名。 [Codex 的 AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

```md
## 外部子智能体

- `claude_code`（Claude Code）子智能体及其 MCP 可用时，将它纳入分工考虑。
- 对可独立完成的排查、复核或实现，结合耗时、额度消耗和结果质量判断是否值得委派。适合委派时，主动选用合适的子智能体角色。简单任务由主智能体直接处理。
- 派发时说明目标、工作范围和预期产出。需要追问时继续原会话，主智能体核实结果并负责交付。
```
