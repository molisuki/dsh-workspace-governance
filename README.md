# Workspace Governance

DSH Desktop 多工作区 Markdown 容量治理插件。采用**文件变更 → 增量复核 → 持久化待办 → 运行中 Agent 建议**。

## 能力

- **容量规则**：文件显式上限 > 最近祖先目录上限 > 工作区默认上限；目录累计预算独立。默认严格计入 Markdown 源文件的全部 Unicode 字符（含空白、换行、代码块）；可显式选择仅统计正文的 `text` 模式，支持规则继承与版本验证。
- **提示模式**：预警、超限、关闭。目标使用率 `max(0,选定触发阈值－精简百分点)`；目标字符数按有效上限向下取整。数值目标不授予删除权限或语义损失许可。
- **监测与任务**：Windows `fs.watch` 配合 450ms 防抖；增量重算变化 Markdown 与祖先容量，结构不确定时完整扫描。无周期全仓扫描；监听失败时一次性延时重挂载并复核。未核验结果不清空已验证待办。
- **Agent 投递**：仅对同工作区处于 `running` 的真实顶层对话使用 `Agent.steer`；不唤醒 `idle` 会话。多运行会话独立去重；投递回执持久化，同一会话重启、等长修改、无关策略调整不重复推送；消息被丢弃或有效容量状态改变时允许重试。已明确标记的人工任务消息通过原生收件箱识别并消除二次投递。成功提交不保证模型已读取或采纳。
- **人工操作**：预览、确认压缩、哈希/版本校验恢复、活动日志管理；受保护文档不允许通过压缩或恢复接口绕过授权。
- **客户端**：目录、预警、超限、专项、日志五视图；稀疏目录图支持折叠、缩放、拖拽、全屏及复位，根节点保持可视。容量提示、文件变更检测和 Agent Skill 卡片默认收起；检测卡片只读展示待办与投递状态。Skill 支持自定义、内置与关闭，独立于容量提示模式。
- **Skill 运行时**：任务提示与 Skill 分离；两份完整 Skill 通过 DSH `ctx.skills` 原生注册表按需读取，在 `agent/pre-step` 以 Skill 类型消息加载；检测当前有效会话已装载的 Skill 并复用，压缩后缺失的上下文可重新加载。

## 部署与数据

Desktop Profile 通过 `link:local/dsh-workspace-governance` 注册插件；客户端组件标识为 `workspace-governance`，HTTP 前缀为 `/api/dsh-workspace-governance`。修改源码后重启 DSH 生效。

策略位于 `~/.dsh/state/workspace-governance/`；待办、日志、经人工确认的恢复快照分别存放于 DSH 私有状态目录，不写入业务仓库。暂停跟踪保留已有策略。

## 接口与验证

`GET /workspaces`、`/tree`、`/maintenance`、`/remediation`；`PUT /mode`、`/defaults`、`/rules`、`/skill-settings`；`POST /scan`、`/preview`、`/apply`、`/restore`。写接口要求同源、操作请求头与有效性校验。

`node bin/cli.js list|add|check|rules`

`npm test`

## 公开仓库准备

使用 Node.js 24 运行 `npm test`；GitHub Actions 在 Windows 上执行同一测试并检查文件打包清单。构建不需要联网安装额外依赖。

仓库仅包含插件源码、内置 Skill、测试和必要文档。DSH 用户策略、会话、恢复快照和凭据位于仓库之外，禁止上传。HTTP 接口仅允许本机访问，详见 [安全说明](SECURITY.md)。

目前未授予开源许可（`UNLICENSED`），并保留 `private: true` 防止意外发布 npm 包。公开前须由权利人确定许可证，并确认内置 Skill 的再发布权；公开 GitHub 仓库并不自动等同于开源授权。
