# pi-only-tools

`pi-only-tools` 是一个面向 [Pi](https://pi.dev) coding agent 的统一工具与工作流扩展。它集成 Codex 风格的命令、补丁和联网搜索工具，并在同一套配置中管理 Normal、Ask、Plan 三种运行模式。

插件重点解决四类问题：提供稳定的基础工具协议、限制工具输出规模、让只读问答与计划流程拥有明确权限边界，以及配合 Pi 的动态工具加载和增量上下文机制，减少不必要的 Prompt Cache 前缀变化。

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

### 权限与动态工具

- Normal、Ask、Plan 各自的 allowlist 决定当前可调用工具，权限检查始终读取 Pi 的实时 registry；已授权的 MCP 工具在异步注册后即可使用。
- 模型可见工具随当前权限更新。`deferred` / `codemode` 工具保留 Pi 的按需发现行为，`hidden` 工具始终不可调用；未授权的 `codemode`、`tool_search` 不会被自动启用。
- 工具权限由 fail-closed `tool_call` gate 强制执行；OpenAI Responses 请求还会使用 `tool_choice.allowed_tools` 或 `none` 限制模型选择范围，并与调用方已有的限制取交集。
- 保留 Pi 的结构化 system prompt 和工具增量机制，兼容顶层 `tools` 与 `input.additional_tools` 请求格式。缓存收益取决于模型和 provider 对增量上下文的支持。
- `shell_command` 与 `apply_patch` 不再注册固定的工具渲染器；安装 [`pi-open-tui`](https://github.com/CoderDoubleflower/pi-open-tui) 时由它统一渲染，未安装时回退到 Pi 的标准工具外框。

## 安装

### 环境要求

- Pi `1.5.2` 或更新版本；当前固定验证基线为 `1.5.2`，CI 另行检查 `latest`
- Node.js `>=22.19.0`
- 本机 PATH 中存在可执行的 `apply_patch`

Pi 相关 peer dependencies 使用宿主提供的版本；开发依赖固定到上述验证基线。通配 peer 范围不代表已验证所有历史版本。

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

Ask 的 Model 和 Effort 固定继承 Normal，因此不可单独编辑。查看当前 `allowedTools`、模型可见工具和 Pi 实际 active tools：

```text
/only-tools status
```

如果配置文件损坏或使用了更新的 schema，插件会保留原文件与本会话最后一份有效权限；首次启动没有有效配置时，所有工具保持禁用。可以修复文件后执行 `/reload`，或在 `/only-tools` 中明确选择先备份原文件、再恢复默认配置。不会因读取失败自动覆盖文件或扩大权限。

### 切换模式

```text
/mode
```

可直接选择 Normal、Ask 或 Plan。TUI 中也可以按 `Shift+Tab` 按以下顺序循环：

```text
Normal → Ask → Plan → Normal
```

Agent 正在运行时，模式命令会等待当前运行结束后再切换；`Shift+Tab` 会提示稍后重试。

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

Pi / MCP 工具的 `readOnlyHint` 只提供行为提示，不能替代权限判断。第三方或 MCP 工具需要用户在 Ask 列中显式授权，只应启用读取、搜索、列出、获取和检查类工具。

> Ask Mode 不是操作系统沙箱。工具名 gate 无法分析已允许 `bash` 命令的具体副作用，Bash 禁写属于模型策略约束。

## Plan Mode

进入 Plan：

```text
/mode
```

也可以使用 `/plan`，或让模型在 Normal 中调用 `EnterPlanMode`。

工作流：

1. 从 Normal 进入 Plan，进行只读调查与方案设计。
2. 模型通过 `plan_write` 保存并发布一个完整、可验证的计划 revision，结束规划回合。
3. 用户审核该 revision，选择保留上下文执行、新会话执行、编辑、反馈或稍后处理。

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

stdout 和 stderr 分别使用最多 `1 MiB` 的首尾缓冲区，持续统计实际字节数和行数；即使输出超过缓冲区，最终错误或完成信息仍可保留。两条流合并后的模型正文限制在约 `10,000` 个近似 Token 内，并保留退出码、运行时间和原始行数。截断不会拆开 UTF-8 字符。

超时或中断会终止进程树；Unix 上先发送 TERM，再对仍存活的进程组发送 KILL，避免 shell 已退出而后代进程继续占用输出管道。命令非零退出、超时、中断以及未知退出状态都会返回 `isError: true`。

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

补丁命令失败、超时或中断时返回 `isError: true`，模型和宿主可以正确识别失败结果。

兼容别名：`input`、`patch_text`、`patchText`、`command` → `patch`，`cwd` → `workdir`，`timeout`（秒）→ `timeout_ms`。

## `web_search`

`web_search` 默认复用当前 Pi 模型，也可以指定独立的搜索 provider 和 model。选定的 provider 必须实现：

```text
POST {baseUrl}/alpha/search
```

工具通过 Pi 解析选定模型的 headers/API key，并复用全局 fetch dispatcher。支持该端点的 Codex 兼容 provider 可以使用；普通 Responses API 支持并不保证存在搜索端点。HTTP 404、405、501 会给出端点不可用和配置搜索模型的提示。

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

若聊天模型所在的 provider 不提供搜索，可以在该配置中同时填写 `provider` 与 `model`，使用 Pi 中已注册且支持搜索的模型。这样切换聊天模型不会改变搜索路由和凭据；省略这两个字段则继续跟随当前模型。

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

只有确实不支持 `tool_choice.allowed_tools` 的兼容网关才应关闭该字段。

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

`npm test` 自动发现全部测试文件，包括实际 Pi 宿主加载、模式切换、原生 MCP 异步注册、真实 Responses 请求序列化，以及进程清理和配置保护回归。`npm run test:host` 可单独执行宿主集成测试。

CI 在 Node.js `22.19.0`、`24` 上检查固定 Pi 基线，并在 Node.js `24` 上检查最新 Pi；每周自动执行一次兼容性检查。测试使用临时目录、内存 MCP 服务和本地 HTTP 服务，无需模型 API key，也不调用外部搜索服务。Unix 进程组回归在 Linux 执行，Windows 分支尚未纳入 CI。

## 许可证

[MIT](LICENSE)
