# Codex 插件包

这是直播间排班 MCP 的 Codex 插件配置。插件连接 `https://douyin.sohodigital.top/mcp`，只把 API 密钥放在 Codex 的连接凭证设置中；仓库不包含密钥。

## 导入

1. 下载 `live-room-schedule-codex.zip` 并解压，在 Codex 的插件页面选择安装本地插件，选取解压出的插件文件夹。
2. 在连接提示中粘贴单独为 Codex 创建的 API 密钥。
3. 启用“直播间排班助手”，用“查看直播间”或“查看今天的排班”确认连接。

修改排班时，助手会先展示完整预览，并等待你明确确认后才提交。

员工排班文案模板见[普通员工 MCP 排班文案模板](https://github.com/meta-xucong/live-room-display/blob/main/docs/%E6%99%AE%E9%80%9A%E5%91%98%E5%B7%A5-MCP%E6%8E%92%E7%8F%AD%E5%86%99%E5%85%A5%E7%A4%BA%E4%BE%8B.md)。主播头像按姓名关联；同名人员需由管理员和员工共同约定一致的括号备注，该备注也会显示在直播间页面。

密钥创建与撤销说明见项目的 `docs/mcp-connectors.md`。
