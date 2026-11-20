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

主播和导演各填自己的时间。核对预览后确认，系统按房间和日期整体替换两类排班。只写入预览列出的房间和日期。详情见 [员工排班表导入 · 前端开发文档](./docs/员工排班表导入-前端开发文档.md)。

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
