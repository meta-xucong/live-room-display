# WorkBuddy MCP Connector

WorkBuddy 排班 MCP 有两种配置方式：个人本机一键安装，或作为 Connector 提交市场供组织成员安装。

## 个人本机一键安装

把本文档（或仓库链接）和管理员生成的 WorkBuddy API 密钥发给 WorkBuddy 的私密配置会话，请助手直接运行 `Install-WorkBuddy.ps1`。如果会话里只有链接，助手应自行获取并解压 WorkBuddy 安装包。

安装器会将 MCP 服务写入当前 Windows 用户的 `%USERPROFILE%\.workbuddy\mcp.json`，保留文件中的其他服务，并安装排班技能。API 密钥写入本机配置文件的 `Authorization` 请求头，不会写入仓库或安装包。不要将密钥复制到普通排班对话、命令参数、GitHub 或回复中。

安装后新建聊天并发送“查看直播间”。如果 MCP 工具未出现，再完全退出并重启 WorkBuddy。

## 市场版 Connector

此目录同时包含标准 WorkBuddy Connector 包。它使用 WorkBuddy 的 API Key 密码表单（`token-schema.json`）；连接地址和认证占位符见 `mcp.json`。组织管理员可将安装包提交 WorkBuddy 审核，通过后发布到 Connector 市场。

使用“查看直播间”确认连接。修改排班时先看完整预览，只有明确确认后才提交。

员工排班文案模板见[普通员工 MCP 排班文案模板](https://github.com/meta-xucong/live-room-display/blob/main/docs/%E6%99%AE%E9%80%9A%E5%91%98%E5%B7%A5-MCP%E6%8E%92%E7%8F%AD%E5%86%99%E5%85%A5%E7%A4%BA%E4%BE%8B.md)。主播头像按姓名关联；同名人员需使用头像库和排班中一致的括号备注，该备注也会显示在直播间页面。

密钥创建与撤销说明见项目的 `docs/mcp-connectors.md`。

WorkBuddy 官方流程要求 Connector 包经审核后才能在市场发布。个人本机一键安装不需要市场审核。
