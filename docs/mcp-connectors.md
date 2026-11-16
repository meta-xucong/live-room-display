# MCP 自然语言连接器

直播间信息牌已提供远程 MCP 端点：

```text
https://douyin.sohodigital.top/mcp
```

Codex 和 WorkBuddy 使用各自独立的 API 密钥连接。连接后可用自然语言查看直播间与排班，或整理排班更新。内部字段格式由 Harness 处理，用户不需要编辑 API 路径、代码或固定文本模板。

普通员工日常录入时可直接使用[排班文案模板](./普通员工-MCP排班写入示例.md)。

## 能力和安全规则

MCP 提供四个工具：

- `list_rooms`：列出直播间编号与名称。
- `get_room_schedule`：读取指定直播间某日排班。
- `preview_schedule_update`：校验并预览该直播间该日的完整排班，不写入数据。
- `commit_schedule_update`：提交指定的预览。

排班更新会替换一个直播间某一天的全部时段。需要包含完整时段；缺少直播间编号、日期或时段边界时，Harness 必须先询问。预览会显示直播间、日期、将替换的时段数、排班明细和校验提示。只有用户明确确认已展示的预览，Harness 才可提交。

“今天/明天”等明确相对日期可按上海时区解析，并在预览中展示成具体日期。未知的直播间、时段或人员必须询问，不可自行补值。

预览编号只对创建它的 API 密钥有效，10 分钟后失效，只能使用一次。预览之后只要排班数据有任何更新，预览编号就会失效，必须重新预览并再次确认。文本接口不接收照片；系统按主播姓名匹配头像库，管理员通过网页的“主播头像库”上传或更换照片，之后所有关联排班会自动更新。Harness 对话里的图片附件目前不会自动传入 MCP。

头像按规范化后的完整姓名匹配；同名主播可在姓名后加稳定括号备注，例如“张敏（A组）”和“张敏（B组）”。头像库和排班必须使用一致的写法，括号备注也会显示在直播间页面上。

API 密钥以 SHA-256 摘要存储在服务端 SQLite 中；响应只在创建时显示一次。接口每个密钥共用 10 分钟最多 30 次的限流。

## 前端生成密钥并配置 Harness

日常操作不需要 SSH 登录服务器，也不需要运行代码或命令。管理员在网页生成密钥，使用者将密钥填进 Harness 的连接凭证框；连接成功后，员工直接用自然语言录入排班。

### 管理员：在网页生成密钥

1. 打开[直播间信息牌](https://douyin.sohodigital.top)，使用管理员账号登录。
2. 进入顶部的“**MCP 密钥**”选项卡。
3. 输入用途名称，例如“Codex - 小王”或“WorkBuddy - 小王”，点击“生成密钥”。建议每个 Harness 安装分别生成一把，方便单独撤销。
4. 点击“复制密钥”。完整密钥以 `lrd_live_` 开头，只在创建成功后显示这一次；立即转交给对应使用者，或直接粘贴到该 Harness 的连接凭证框。

密钥列表只显示名称、创建时间、最近使用时间和状态，不会再次显示完整密钥。若复制前关闭或刷新页面，或之后找不到已保存的密钥，请撤销旧密钥并重新生成。发现泄露时也应立即撤销。

### Codex：安装并连接

1. 下载[Codex 插件包](../integrations/dist/live-room-schedule-codex.zip)，解压后在 Codex 的插件页面选择安装本地插件，并选取解压出的插件文件夹。
2. 在插件连接提示中的 **API Key/Bearer 密钥**框粘贴管理员刚生成的 Codex 密钥，并保存连接。
3. 启用“直播间排班助手”，发送“查看直播间”确认连接成功。

### WorkBuddy：安装并连接

1. 下载[WorkBuddy Connector 包](../integrations/dist/live-room-schedule-workbuddy.zip)，在 WorkBuddy Connector 管理页面导入或发布该连接器。
2. 添加连接时，在“**直播间信息牌 API 密钥**”密码框粘贴管理员刚生成的 WorkBuddy 密钥，并保存连接。
3. 发送“查看直播间”确认连接成功。如果组织没有本地导入权限，请让 Connector 管理员代为导入或发布。

### 员工：用自然语言写入排班

连接只需配置一次。此后员工在已连接的 Harness 对话中，提供直播间、日期和当天完整时段安排；助手会先展示将要替换的排班预览，员工核对并明确回复确认后才写入系统。可直接使用[普通员工排班文案模板](./普通员工-MCP排班写入示例.md)。

API 密钥只填入 Harness 的连接凭证框，**不要发在普通聊天对话、排班文案、群聊或公开文档中**。密钥持有人可以通过 MCP 访问排班并提交更新；如果员工不再需要访问，请管理员在“MCP 密钥”选项卡撤销对应密钥。撤销即时生效且无法恢复，之后需要重新生成并配置。

## 通过命令行创建和撤销密钥

服务器命令行方式仍可用于维护或自动化场景：

在服务器上分别创建 Codex 与 WorkBuddy 密钥。务必各生成一把，方便独立撤销：

```bash
cd /opt/live-room-display/current
runuser -u live-room-display -- env DATA_DIR=/var/lib/live-room-display \
  /opt/nodejs/current/bin/node scripts/create-api-token.mjs --name "Codex MCP"
runuser -u live-room-display -- env DATA_DIR=/var/lib/live-room-display \
  /opt/nodejs/current/bin/node scripts/create-api-token.mjs --name "WorkBuddy MCP"
```

命令会输出一次性密钥。只将对应密钥粘贴到 Codex/WorkBuddy 的连接密码框，不要提交到 Git、写入普通配置文件或粘贴到排班对话中。

撤销密钥：

```bash
runuser -u live-room-display -- env DATA_DIR=/var/lib/live-room-display \
  /opt/nodejs/current/bin/node scripts/revoke-api-token.mjs --id <密钥ID>
```

## Codex 安装

1. 从仓库的 `integrations/dist/live-room-schedule-codex.zip` 下载并解压，在 Codex 的本地插件安装页选择解压出的插件文件夹。
2. 在连接器的 API Key/Bearer 密钥输入框中粘贴刚创建的 `Codex MCP` 密钥。
3. 启用“直播间排班助手”，发出“查看直播间”确认连接。

插件只声明 MCP 地址和 Bearer 认证方式，不包含实际密钥。根目录配置见 `integrations/codex-plugin/`。

## WorkBuddy 安装

1. 下载仓库的 `integrations/dist/live-room-schedule-workbuddy.zip`，交给 WorkBuddy Connector 管理员导入或发布。
2. 点击连接，在“直播间信息牌 API 密钥”字段粘贴 `WorkBuddy MCP` 密钥。
3. 连接成功后，可直接自然语言查看或整理排班。

如果组织尚未启用本地 Connector 导入，可先将 `integrations/workbuddy-connector/` 提交给 WorkBuddy Connector 管理员发布到组织内。配置字段遵照 WorkBuddy 连接器规范；本项目尚未代为提交到 WorkBuddy Marketplace。

## MCP 请求兼容

这是无会话的 Streamable HTTP MCP 服务，使用 JSON 请求/响应，不需要额外安装本地运行时。所有请求都需要 `Authorization: Bearer <API密钥>`。服务兼容 2026-07-28 新协议，并兼容 MCP 2025-11-25、2025-06-18、2025-03-26 和 2024-11-05 握手协议。

通用客户端配置示例：

```json
{
  "mcpServers": {
    "live-room-display": {
      "type": "streamableHttp",
      "url": "https://douyin.sohodigital.top/mcp",
      "headers": {
        "Authorization": "Bearer <API密钥>"
      }
    }
  }
}
```

若把 MCP 端点改接至其他域名，仍应使用 HTTPS，并在服务的 `MCP_ALLOWED_ORIGINS` 中按需列出浏览器来源。
