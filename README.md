# pi-only-tools

`pi-only-tools` 是一个面向 [Pi](https://pi.dev) coding agent 的统一工具与工作流扩展。它集成 Codex 风格的命令、补丁和联网搜索工具，并在同一套配置中管理 Normal、Ask、Plan 三种运行模式。

插件重点解决四类问题：提供稳定的基础工具协议、限制工具输出规模、让只读问答与计划流程拥有明确权限边界，以及在模式切换时尽量保持 provider 可见工具目录稳定，减少 Prompt Cache 前缀变化。

## 核心功能

### 基础工具

- **`shell_command`**：执行同步 shell 命令，支持流式输出、工作目录、超时和中断；返回内容经过字节与近似 Token 双重限制，避免超长命令输出迅速撑大上下文。
- **`apply_patch`**：把标准 `*** Begin Patch` 补丁传给本机 `apply_patch` 命令，并计算真实文件差异、增删行和 hunk 摘要。
- **`web_search`**：提供 Codex 兼容的独立搜索协议，支持批量搜索、打开页面、链接跳转、页内查找、PDF 截图、天气、金融、体育和时间等命令。

### 三种运行模式

- **Normal**：正常实现模式，使用用户配置的模型、思考强度和工具 allowlist。
- **Ask**：只读问答模式，继承 Normal 的模型与思考强度，使用独立的只读工具 allowlist；已知编辑和工作流控制工具会被锁定关闭。
- **Plan**：计划模式，使用独立模型、思考强度和调查工具 allowlist；只允许通过 `plan_write` 写入规范计划，项目文件应保持只读。

### Plan 工作流

- `plan_write` 支持在模型生成参数时流式展示 Markdown。
- 计划标题、小标题和正文跟随用户语言，不再固定为英文。
- 有效计划写入后直接进入用户审核，不再由模型调用 `ExitPlanMode`。
- 用户可选择保留上下文执行、清空上下文后执行、返回编辑、提供反馈或稍后处理。
- 计划正文只在 `plan_write` 阶段完整显示一次，批准动作不会重复打印计划。

### 权限与缓存稳定性

- Normal、Ask、Plan 共享一个会话内稳定的 provider-visible 工具目录，切换模式只改变当前 allowlist。
- 工具权限由 fail-closed `tool_call` gate 强制执行；OpenAI Responses 请求还会使用 `tool_choice.allowed_tools` 或 `none` 限制模型选择范围。
- 新启用工具按 Pi registry 顺序追加，取消权限或切换模式不会删除、重排已有目录项。
- GPT-5.6+ 的 OpenAI Responses 请求会在动态 runtime-state 之前，为最新的真实 user 文本或 text tool result 添加显式 Prompt Cache 断点；工具续轮优先标记 tool result，使滚动历史继续形成可复用前缀，同时保留默认 implicit caching。
- `shell_command` 与 `apply_patch` 不再注册固定的工具渲染器；安装 [`pi-open-tui`](https://github.com/CoderDoubleflower/pi-open-tui) 时由它统一渲染，未安装时回退到 Pi 的标准工具外框。

## 安装

### 环境要求

- Pi `>=0.84.2 <0.85.0`
- Node.js `>=22.19.0`
- 本机 PATH 中存在可执行的 `apply_patch`

检查 `apply_patch`：

```bash
command -v apply_patch
```

不在 PATH 中时可指定绝对路径：

```bash
export PI_ONLY_TOOLS_APPLY_PATCH_COMMAND=/absolute/path/to/apply_patch
```

### 从 GitHub 全局安装

```bash
pi install git:github.com/CoderDoubleflower/pi-only-tools
```

### 仅在当前项目安装

在项目目录中执行：

```bash
pi install -l git:github.com/CoderDoubleflower/pi-only-tools
```

### 更新

```bash
pi update --extensions
```

安装或更新后，重启 Pi，或者执行：

```text
/reload
```

> 已安装独立 `pi-claude-plan-mode` 的用户应先移除旧扩展，避免重复注册 Plan 工作流。

## 快速开始

### 配置工具矩阵

执行：

```text
/only-tools
```

界面以 Normal / Ask / Plan 为列，以 Model / Effort / Tool 为行。配置保存在：

```text
~/.pi/agent/tools.json
```

常用按键：

| 按键 | 行为 |
|---|---|
| `↑` / `↓` | 选择模型、思考强度或工具行 |
| `←` / `→` | 切换 Normal、Ask、Plan 列 |
| `Enter` / `Space` | 编辑当前单元格或切换工具权限 |
| `M` | 配置当前 Normal/Plan 列的模型 |
| `E` / `T` | 配置当前 Normal/Plan 列的思考强度 |
| `A` | 当前 Profile 全选可配置工具 |
| `N` | 清空当前 Profile |
| `R` | 恢复当前 Profile 默认值 |
| `Esc` / `S` | 保存并关闭 |

Ask 的 Model 和 Effort 固定继承 Normal，因此不可单独编辑。查看当前 `allowedTools`、稳定目录和 Pi 实际 active tools：

```text
/only-tools status
```

### 切换模式

```text
/mode
```

可直接选择 Normal、Ask 或 Plan。TUI 中也可以按 `Shift+Tab` 按以下顺序循环：

```text
Normal → Ask → Plan → Normal
```

Agent 正在运行时不会中途切换模式，需等待当前 turn 结束。

## Ask Mode

Ask 使用独立持久 allowlist。以下已知编辑、替代命令执行和工作流控制工具会始终锁定关闭：

```text
shell_command
apply_patch
powershell
edit
write
EnterPlanMode
plan_write
ExitPlanMode
```

原生 `bash` 默认保留，便于 Skill 执行读取、搜索、列出和检查命令；固定 system prompt 会禁止重定向写文件、`tee`、原地修改、patch、formatter、generator、包管理器和 Git 写操作。

Pi 的通用 ToolDefinition 没有统一的只读元数据，因此第三方或 MCP 工具需要用户在 Ask 列中显式授权。只应启用读取、搜索、列出、获取和检查类工具。

> Ask Mode 不是操作系统沙箱。工具名 gate 无法分析已允许 `bash` 命令的具体副作用，Bash 禁写属于模型策略约束。

## Plan Mode

进入 Plan：

```text
/mode
```

也可以使用 `/plan`，或让模型在 Normal 中调用 `EnterPlanMode`。

工作流：

```text
Normal
  └─ 进入 Plan
       └─ 只读调查与方案设计
            └─ plan_write
                 └─ 用户审核
                      ├─ 保留上下文并执行
                      ├─ 新会话执行
                      ├─ 编辑或反馈
                      └─ 稍后审核
```

非交互场景可以使用：

```text
/plan-approve keep
/plan-approve clear
```

`/plan config` 与 `/only-tools` 打开同一套 Profile 矩阵。`ExitPlanMode` 不会注册给模型；只有用户明确批准后才会回到 Normal 开始实现。

## `shell_command`

调用示例：

```json
{
  "command": "git status --short && npm test",
  "workdir": ".",
  "timeout_ms": 10000
}
```

参数：

- `command`：必填。
- `workdir`：可选，相对路径以当前 Pi cwd 为基准。
- `timeout_ms`：可选，默认 `10000` 毫秒。

Unix 默认使用 `$SHELL -lc`，没有 `$SHELL` 时使用 `/bin/bash`；Windows 使用 `cmd.exe /d /s /c`。可通过以下变量覆盖 Unix shell：

```bash
export PI_ONLY_TOOLS_SHELL=/bin/zsh
```

输出限制分为捕获层、聚合层和模型正文层：stdout/stderr 会被有界读取，最终模型正文按约 `10,000` 个近似 Token 截断，并保留开头、结尾、退出码、运行时间和原始行数。

兼容别名：`cmd` → `command`、`cwd` → `workdir`、`timeout`（秒）→ `timeout_ms`。

## `apply_patch`

调用示例：

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-oldValue\n+newValue\n*** End Patch\n",
  "workdir": ".",
  "timeout_ms": 120000
}
```

支持：

```text
*** Add File:
*** Update File:
*** Delete File:
*** Move to:
```

插件会在执行前后读取涉及的文本文件并计算真实 diff，将文件、hunk、`additions` 和 `removals` 写入结果 details。单文件超过 2 MiB、二进制文件或过大 diff 会回退到简化统计。

兼容别名：`input`、`patch_text`、`patchText`、`command` → `patch`，`cwd` → `workdir`，`timeout`（秒）→ `timeout_ms`。

## `web_search`

`web_search` 复用当前 Pi 模型、provider headers/API key 与全局 fetch dispatcher。当前 provider 必须实现：

```text
POST {baseUrl}/alpha/search
```

OpenAI Codex 兼容 provider 可直接使用；只实现普通 Responses API、但没有 `alpha/search` 的网关会返回 HTTP 错误。

支持的命令包括：

```text
search_query · image_query · open · click · find · screenshot
finance · weather · sports · time · response_length
```

用户配置文件：

```text
~/.pi/agent/web-search.json
```

也可以通过环境变量指定其他路径：

```bash
export PI_ONLY_TOOLS_WEB_SEARCH_CONFIG=/absolute/path/to/web-search.json
```

`mode` 可设为 `disabled`、`cached`、`indexed` 或 `live`；`contextSize` 可设为 `low`、`medium` 或 `high`。完整配置说明见 [`WEB_SEARCH.md`](WEB_SEARCH.md)。

## 渲染方式

`pi-only-tools` 只负责工具协议、执行、流式状态和有界结果，不固定 `shell_command` 与 `apply_patch` 的终端外观：

- 安装 `pi-open-tui`：使用统一的 Claude/OpenAI 风格标题、分组、输出预览和 rich diff。
- 未安装 `pi-open-tui`：使用 Pi 标准工具外框。
- 其他 TUI 扩展也可以根据工具名接管渲染。

`EnterPlanMode` 和 `plan_write` 仍保留 Plan 专用渲染，因为它们负责计划流式输出和 Markdown 审核。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_ONLY_TOOLS_APPLY_PATCH_COMMAND` | 指定本机 `apply_patch` 可执行文件 |
| `PI_ONLY_TOOLS_SHELL` | 覆盖 Unix shell |
| `PI_ONLY_TOOLS_WEB_SEARCH_CONFIG` | 指定 Web Search 配置文件 |
| `PI_ONLY_TOOLS_ALLOWED_TOOLS=off` | 关闭 Responses payload 的 `allowed_tools`，保留运行时 gate |
| `PI_ONLY_TOOLS_PROMPT_CACHE_BREAKPOINTS=off` | 关闭 GPT-5.6+ Responses payload 的显式 Prompt Cache 断点改写 |

只有确实不支持 `tool_choice.allowed_tools` 的兼容网关才应关闭 `PI_ONLY_TOOLS_ALLOWED_TOOLS`。如果兼容网关拒绝 `prompt_cache_breakpoint` 字段，可以单独关闭 `PI_ONLY_TOOLS_PROMPT_CACHE_BREAKPOINTS`，不影响稳定工具目录和运行时权限 gate。

## 安全说明

- 扩展和 shell 命令拥有当前用户权限。
- `shell_command` 与原生 `bash` 可以执行任意命令，插件不会提供操作系统级沙箱。
- `apply_patch` 是本机外部命令，插件只负责调用和结果整理。
- Ask/Plan 的只读约束由工具名 allowlist、运行时 gate 和模型 prompt 共同实现，不能替代容器、虚拟机或系统权限隔离。
- 安装前可重点审查 `src/entry.js`、`src/index.js`、`src/codex-shell-command.js`、`src/codex-web-search.js` 和 `dist/index.js`。

## 开发

```bash
npm install
npm run build
npm run check
npm test
```

## 许可证

[MIT](LICENSE)
