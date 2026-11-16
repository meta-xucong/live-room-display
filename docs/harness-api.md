# Codex、WorkBuddy 等 Harness 接入指南

直播间信息牌提供 HTTPS REST API。Harness 把用户的自然语言整理成下方固定字段格式，调用预览接口取得校验结果；用户确认摘要后，再调用提交接口。API 不会猜测缺失的直播间编号、日期或时间。

## 1. 创建和撤销 API 密钥

在 VPS 上以应用服务账号运行。每个 Harness 建议单独创建一把密钥，便于单独撤销：

```bash
cd /opt/live-room-display/current
runuser -u live-room-display -- env DATA_DIR=/var/lib/live-room-display \
  /opt/nodejs/current/bin/node scripts/create-api-token.mjs --name "Codex"
```

密钥只显示一次。将它保存在 Harness 的密钥/环境变量设置中，不要写入提示词、Excel、Git 仓库或普通日志。撤销密钥：

```bash
runuser -u live-room-display -- env DATA_DIR=/var/lib/live-room-display \
  /opt/nodejs/current/bin/node scripts/revoke-api-token.mjs --id <密钥ID>
```

## 2. 自然语言转固定格式

Harness 按用户描述填写文本。一个请求只包含一个直播间、一个排班日期以及该日全部时段：

```text
直播间编号：01
直播间名称：MLB服饰旗舰店
排班日期：2026-11-16
---
时段：07:00-13:00
导演：吴丹
主播：张思琪
助播：彭欣琦
主推商品：经典学长；经典老爹；鹅绒羽绒服 工装款
目标销售额：20万
备注：
---
时段：13:00-17:00
导演：吴丹
主播：王晓
助播：
主推商品：羽绒服新款
目标销售额：200000
备注：
```

固定字段为：直播间编号、直播间名称、排班日期，以及每个时段的时段、导演、主播、助播、主推商品、目标销售额、备注。使用独立一行 `---` 分隔信息块。可选人员、商品、金额和备注可以留空，但对应字段行仍需保留。日期格式为 `YYYY-MM-DD`；时段使用 24 小时制，例如 `07:00-11:00`。商品用中文分号、英文分号或顿号分隔；目标金额可写 `200000`、`20万` 或 `20万元`。校验也会检查跨午夜时段与前后日期已有排班的冲突。

自然语言描述缺少编号、名称、日期或时段边界时，Harness 应先向用户询问，不得自行编造。接口最多接收 100 个时段、60,000 个字符；服务端继续执行已有的日期、金额和排班重叠校验。

## 3. 预览并提交

API 根地址：`https://douyin.sohodigital.top`

先调用预览：

```http
POST /api/v1/integrations/schedule-text/preview
Authorization: Bearer <API密钥>
Content-Type: application/json

{"text":"直播间编号：01\n直播间名称：MLB服饰旗舰店\n排班日期：2026-11-16\n---\n时段：07:00-13:00\n导演：吴丹\n主播：张思琪\n助播：彭欣琦\n主推商品：经典学长；经典老爹\n目标销售额：20万\n备注："}
```

预览返回目标直播间、日期、将替换的已有时段数量、解析出的排班和警告。展示预览结果并等待用户确认后，提交相同文本：

```http
POST /api/v1/integrations/schedule-text/commit
Authorization: Bearer <API密钥>
Content-Type: application/json

{"text":"<与预览相同的完整排班文本>","confirmReplace":true}
```

`confirmReplace` 必须为 `true`。提交只替换该直播间该日期的全部排班；其他直播间及其他日期的数据不变。再次提交同一份排班不会增加重复时段。

## 4. 主播照片

文本接口不接收照片。系统按规范化后的完整主播姓名自动匹配头像库中的图片；没有匹配到时，原时段和主播仍会沿用该场已有照片，新的主播或时段会在预览中提示缺少头像。管理员可在网页“主播头像库”集中上传、更换照片，所有关联排班会自动使用最新头像。Harness 对话中的图片附件目前不会自动传入 MCP。遇到同名主播时，可在姓名后添加稳定括号备注（例如“张敏（A组）”），并在头像库和排班中保持一致；括号内容会显示在页面上。

## 5. Harness 的执行规则

建议在 Codex、WorkBuddy 或其他 Harness 中配置 HTTPS 请求工具，并把 API 密钥作为机密变量提供。给 Harness 的工作指令可写为：

> 把用户提供的排班整理成固定字段格式。必填信息不足时先询问。先调用预览接口，把直播间、日期、替换时段数量和排班摘要展示给用户。只有用户明确确认后，才用相同文本调用提交接口并设置 `confirmReplace=true`。不得把密钥写入请求正文或回复内容。

完整 OpenAPI 描述见 [harness-openapi.yaml](./harness-openapi.yaml)。

## 6. 常见响应

| HTTP 状态 | 含义 |
|---|---|
| `200` | 预览成功或提交成功 |
| `401` | 缺失、无效或已撤销的密钥 |
| `409` | 提交时没有显式确认替换 |
| `422` | 固定格式或排班数据校验失败，响应包含字段错误 |
| `429` | 单把密钥 10 分钟内调用超过 30 次 |
