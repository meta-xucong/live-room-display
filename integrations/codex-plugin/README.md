# Codex 插件包

这是直播间排班 MCP 的 Codex 插件包。插件安装页不提供 API Key 输入框；使用随包的 `Install-Codex.ps1` 直接配置 Codex MCP 和排班技能。仓库不包含密钥。

## 一步安装

把本文档（或仓库链接）和管理员生成的 Codex API 密钥发给 Codex 的私密配置会话，请助手直接运行 `Install-Codex.ps1`。如果会话里只有链接，助手应自行获取并解压 Codex 安装包。密钥通过进程环境传给脚本，保存在当前 Windows 用户环境变量 `SOHO_LIVE_ROOM_API_KEY`；Codex 配置文件只引用变量名。不要把密钥写进仓库、脚本、命令参数或回复。

安装器会注册 `soho_live_room` MCP 服务、安装排班技能，并要求每次提交排班前确认。安装完成后完全退出并重启 Codex 一次，然后新建聊天发送“查看直播间”。如果由用户手动运行脚本且没有提供进程环境变量，安装器会提示安全输入密钥。

修改排班时，助手会先展示完整预览，并等待你明确确认后才提交。

员工排班文案模板见[普通员工 MCP 排班文案模板](https://github.com/meta-xucong/live-room-display/blob/main/docs/%E6%99%AE%E9%80%9A%E5%91%98%E5%B7%A5-MCP%E6%8E%92%E7%8F%AD%E5%86%99%E5%85%A5%E7%A4%BA%E4%BE%8B.md)。主播头像按姓名关联；同名人员需由管理员和员工共同约定一致的括号备注，该备注也会显示在直播间页面。

密钥创建与撤销说明见项目的 `docs/mcp-connectors.md`。
