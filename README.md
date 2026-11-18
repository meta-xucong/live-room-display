# 直播间信息牌

面向直播间门口电子屏的登录式网页程序。管理员上传包含多个工作表的 `.xlsx` 排班工作簿；每个工作表对应一个直播间。普通用户登录后选择直播间，页面按排班时间自动更新岗位、主播照片、主推商品和目标销售额。

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

单个直播间导入时，先在网页选定 01–27 号直播间，再上传含 1 个工作表的 Excel。表内直播间名称和编号可以留空。27 个直播间总表需保留 27 个工作表，每表在 B1 填直播间名称，在 E1 填编号。

第 3 行保留字段标题。第 4 行起，A–D 列填写导演班次，F–N 列填写主播场次。助播跟随主播，主播照片放在对应行的 K 列。核对预览中的直播间和日期后确认更新，系统会整体替换列出日期的排班。

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
