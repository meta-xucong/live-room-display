# 直播间信息牌

面向直播间门口电子屏的登录式网页程序。管理员上传员工使用的 `.xlsx` 排班表，系统按直播间名称和日期批量导入。普通用户登录后选择直播间，页面按排班时间自动更新岗位、主播照片、主推商品和目标销售额。

当前版本包含前端展示、登录与角色权限、Excel 工作簿校验与原子更新、受登录保护的主播照片读取、按上海时区自动切换，以及供 Codex、WorkBuddy 等 Harness 调用的自然语言 MCP 服务和固定格式文本 API。生产入口为 `https://douyin.sohodigital.top`。

## 本地运行

需要 Node.js 24 或更新版本。第一次在项目目录运行：

```powershell
npm install
npm run create-user -- --username admin --role admin
npm run create-user -- --username display --role viewer
npm run dev
```

创建账号时，密码会在终端中隐藏输入，不放在命令行或配置文件里。开发环境会同时启动网页和 API 服务，打开 Vite 显示的本地地址。

打开「排班 Excel」，上传含「日期、直播间、主播时间、主播、导演时间、导演」列的员工排班表。一个文件可包含 1–27 个直播间及多个日期。首次出现的名称在网页上匹配编号，确认导入后系统会记住。

主播、导演和助播各填自己的时间。可用「助播时间」「助播」两列独立录入助播，管理端和展示端按助播自己的时段显示。核对预览后确认，系统按房间和日期替换排班。缺少助播列的旧表会沿用已有助播班次。详情见 [员工排班表导入 · 前端开发文档](./docs/员工排班表导入-前端开发文档.md)。

打开「直播间管理」可为已建直播间改名、设置头像或删除。房号从 01 连续排列，删除后后面的房号依次前移，其他房间的排班、别名和头像随房间转入新房号。删除前会提示受影响的排班数量。展示端的直播间选择器会在名称前显示头像，未配置时显示默认头像。

Excel 优先按已登记的直播间名称或别名匹配。新直播间在现有列表末尾分配房号。若历史上已存在两间同名直播间，可在「直播间管理」中选择「合并重名直播间」，选择转入哪一间。

在员工表右侧填写「主推商品」和「目标销售额」。多件商品用英文逗号 `,` 或中文逗号 `，` 分隔。目标销售额按原文显示，例如「20万」或「按现场决定」。这两列跟随同一行的主播场次。

运行 `npm test` 检查导入接口。另可用环境变量 `STAFF_IMPORT_XLSX` 指定验收样表，在临时数据库复现其预览和写入。

## 生产运行

先构建网页，再启动 API 和静态网页服务：

```powershell
npm run build
$env:NODE_ENV = "production"
$env:DATA_DIR = "D:\live-room-data"
$env:PORT = "4174"
npm run start
```

通过 HTTPS 反向代理转发到服务端口。生产环境会为登录 Cookie 设置 `Secure`。数据库和照片保存在 `DATA_DIR` 下的 SQLite 数据文件中；请将该目录放在公开仓库之外，并限制服务器文件权限。

## 文件说明

- `src/`：已确认的白色磨砂玻璃展示页与登录、管理工作区。
- `server.mjs`：登录会话、角色鉴权、展示接口、图片访问、上传处理和 SQLite 持久化。
- `server/xlsx.mjs`：`.xlsx` 工作簿、工作表和锚定照片读取及限制。
- `scripts/create-user.mjs`：在部署环境中创建管理员或普通用户账号。
- `scripts/create-api-token.mjs` / `scripts/revoke-api-token.mjs`：创建或撤销 Harness API 密钥。
- `docs/功能蓝图.md`：产品角色、Excel 约定和业务规则。
- `docs/后端开发文档.md`：已落地实现、接口与部署说明。
- `docs/harness-api.md`：自然语言转固定格式文本及 API 调用流程。
- `docs/harness-openapi.yaml`：Harness 可导入的 OpenAPI 描述。
- `docs/mcp-connectors.md`：MCP 服务、密钥和 Codex/WorkBuddy 连接器的配置说明。
- `docs/普通员工-MCP排班写入示例.md`：员工可直接复制的排班文案模板和头像匹配说明。
- `integrations/`：Codex 插件与 WorkBuddy Connector 导入包源文件。

`src/rooms.json` 和单文件 HTML 导出演示只含合成样例；正式网页读取已登录用户可访问的服务器数据。
