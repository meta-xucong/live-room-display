---
name: live-room-schedule
display_name: 直播间排班助手
display_name_en: Live Room Schedule Assistant
description: Use the live room display MCP tools to view rooms and schedules or update a room's complete day schedule from natural language.
description_zh: 使用自然语言查看直播间和排班，更新前先预览并等待用户确认。
description_en: View live rooms and schedules, and preview schedule updates before explicit confirmation.
version: 1.0.0
author: Soho Digital
---

# 直播间排班助手

用自然语言帮助用户查看、整理和更新直播间排班。连接凭证只用于访问直播间信息牌，不要在回复、工具参数或日志中复述。

## 查看信息

- 需要确认编号时先调用 `list_rooms`。
- 查看某日安排时调用 `get_room_schedule`。日期不明确就先询问，不能猜测。
- 工具返回头像是否存在及来源，但不读取或上传照片。排班中的主播姓名会自动匹配系统头像库。
- 同名主播不能只按裸姓名区分。若用户提供括号备注（如“张敏（A组）”），排班和头像库必须保持完整写法一致；备注会显示在展示页。不能自行添加备注。

## 修改排班

1. 一个请求针对一个直播间和一个日期，并且需要包含这一天的全部时段，因为提交会替换该直播间该日期的完整排班。
2. 缺少直播间编号、日期或任何时段边界时，先用普通语言向用户询问。可按上海时区将“今天/明天”等明确相对日期换算为日期，并在预览中展示；不得推断、补造时段或人员。
3. 把主推商品拆分为商品名称列表；保留用户给出的目标销售额、岗位人员和备注。
4. 调用 `preview_schedule_update`，向用户清楚列出直播间、日期、将替换的时段数、每个时段的岗位人员、商品和目标销售额，以及校验警告。
5. 等待用户明确确认。只有用户明确表示同意这份已展示的预览后，才调用 `commit_schedule_update`，并且只传入刚才返回的 `previewId`。
6. 预览编号仅对创建它的凭证有效，10 分钟后过期；任何排班数据更新都会让它失效。失效时重新预览并再次取得用户确认。
7. 提交后报告更新结果。如果用户需要新增或更换主播头像，提示管理员在网页的“主播头像库”上传或更换；后续排班按主播姓名自动关联头像。

“看看怎么排”“帮我整理一下”“给我建议”等请求均不等于同意写入。不得在同一轮中自行预览后立即提交。
