# 直播间信息牌

面向直播间门口电子屏的登录式网页程序。管理员上传包含多个工作表的 `.xlsx` 排班工作簿；每个工作表对应一个直播间。普通用户登录后选择直播间，页面按排班时间自动更新岗位、主播照片、主推商品和目标销售额。

第一版包含前端展示、登录与角色权限、管理员工作台、Excel 工作簿校验与原子更新、受登录保护的主播照片读取，以及按上海时区自动切换。项目尚未绑定真实服务器或公开部署。

## 本地运行

需要 Node.js 24 或更新版本。第一次在项目目录运行：

```powershell
npm install
npm run create-user -- --username admin --role admin
npm run create-user -- --username display --role viewer
npm run dev
```

创建账号时，密码会在终端中隐藏输入，不放在命令行或配置文件里。开发环境会同时启动网页和 API 服务，打开 Vite 显示的本地地址。

管理员登录后上传工作簿。导入器使用本项目的排班模板约定：B1 为直播间名称、E1 为直播间编号、第 3 行为字段标题、第 4 行起一行一场；主播照片嵌入对应排班行的 G 列。校验全部通过后才替换当前数据；如果有阻断错误，旧数据保持不变。

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
- `docs/功能蓝图.md`：产品角色、Excel 约定和业务规则。
- `docs/后端开发文档.md`：已落地实现、接口与部署说明。

`src/rooms.json` 和单文件 HTML 导出演示只含合成样例；正式网页读取已登录用户可访问的服务器数据。
