# 对账系统

一期先实现抖店订单、结算、历史成本和直播场次的对账闭环；千川消耗独立展示。

## 环境要求

- Node.js `22 LTS`
- npm `>=10`
- Docker Desktop

## 本地启动

```bash
nvm use
cp .env.example .env
sh scripts/generate-admin-credentials.sh admin
npm install
npm run infra:up
npm run db:generate
npm run db:migrate
npm run dev
```

将密码生成脚本输出的 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH` 和
`SESSION_SECRET` 写入 `.env` 后再启动。启用 HTTPS 时将
`COOKIE_SECURE` 设置为 `true`，本地 HTTP 环境保持 `false`。

- 前端：http://localhost:3100
- 后端：http://localhost:3001
- 后端健康检查：http://localhost:3001/health
- 前端健康检查：http://localhost:3100/api/health

除健康检查和登录接口外，所有页面和业务接口都需要管理员登录。系统当前只支持
一个管理员账号，不提供注册、多账号、角色权限和找回密码。

## 常用命令

```bash
npm run build
npm test
npm run test:e2e
npm run lint
npm run infra:down
```

## 当前已完成

当前已完成抖店订单、结算、商品成本和直播场次的导入及标准化。系统会保留原始文件名、导入批次、原始行号和完整原始数据，并根据文件内容防止重复导入。

- `POST /imports/orders`：上传订单文件，表单字段名为 `file`
- `POST /imports/settlements`：上传结算文件，表单字段名为 `file`
- `POST /imports/costs`：上传商品成本文件，表单字段名为 `file`
- `POST /imports/live-sessions`：上传抖音直播明细文件，表单字段名为 `file`
- `GET /imports?dataType=DOUYIN_ORDER`：查询订单导入批次
- `GET /imports/:batchId`：查询导入批次结果
- `GET /imports/:batchId/records`：查询该批次的原始记录
- `POST /orders/standardize/:batchId`：将订单原始记录标准化
- `POST /settlements/standardize/:batchId?orderBatchId=<订单批次 ID>`：标准化结算并按指定订单批次关联
- `POST /costs/standardize/:batchId?orderBatchId=<订单批次 ID>`：标准化成本并生成订单商品成本快照
- `GET /costs/versions`：查询成本版本
- `GET /costs/versions/:id/items`：分页查询版本中的商品成本
- `POST /costs/versions/:id/changes`：基于现有版本人工新增或更正成本，并生成完整新版本
- `POST /live-sessions/standardize/:batchId?orderBatchId=<订单批次 ID>`：标准化直播场次，并按订单提交时间匹配订单归属
- `GET /orders/:mainOrderNo`：查询订单、商品和结算明细
- `GET /orders?batchId=<订单批次 ID>`：按批次查询订单
- `GET /orders/issues?orderBatchId=<订单批次 ID>`：按订单批次查询本次对账问题
- `POST /reconciliation-tasks`：创建按月份绑定数据批次的对账任务
- `GET /reconciliation-tasks`：查询对账任务
- `POST /reconciliation-tasks/:id/run`：运行对账任务并返回汇总

真实数据验收结果：327 个订单、342 个订单商品明细、184 条结算记录；142 条结算按订单号关联成功。商品成本按“商品 ID + 商家编码”匹配，231 个商品明细唯一匹配，90 个缺成本，21 个成本冲突。

每次导入成本表都会生成独立版本并直接使用。新成本表只处理尚未匹配成本、缺成本或成本冲突的订单商品；已经成功保存成本快照的历史订单不会被覆盖。订单已有结算且全部商品成本匹配成功时计算利润；缺成本和成本冲突不会按 0 元处理。

“成本版本”页面支持基于现有完整版本新增遗漏商品，或更正已有商品成本。人工维护会生成新的完整成本版本和成本批次，不覆盖原版本；更正成本必须指定开始适用日期，系统按订单发生时间选择旧成本或新成本。新版本需要在“对账任务”中选中后运行。

直播归属规则：达人 ID 为空、`0` 或 `108314295234` 归为自营，其他达人 ID 归为达人；自营订单按“直播开始时间 ≤ 订单提交时间 ≤ 直播结束时间”判断上播。多场重叠标记“直播冲突”，缺少订单提交时间标记“缺少下单时间”。直播场次编号按抖音号和开始时间生成，例如 `DY-xiaoxianghanzi-20260722110021`；同一场次在不同批次中可以重复保存，便于追溯来源。

真实直播文件 `直播明细_自营账号_20260701_20260731.xlsx` 已导入 10 场直播并匹配真实订单批次：327 条订单中自营上播 131 条、自营非上播 46 条、达人订单 150 条，直播冲突和订单时间缺失均为 0。

前端工作台已接入真实数据，默认选择订单数最多的订单批次，也可以手动切换批次、搜索订单、按自营/达人和直播状态筛选，并查看订单的直播场次、结算记录和商品成本快照。

“对账任务”页面可以按结算月份绑定订单、结算、成本和直播批次，点击“开始对账”复用现有标准化流程，固定本次对账的数据范围，避免不同月份批次混用。

创建任务时会检查订单号是否已在其他批次处理过。订单全部重复时自动复用原订单批次；只有部分重复时阻止创建并提示重复数量，请选择原批次或重新导出只包含新增订单的文件。

相同月份和相同订单、结算、成本、直播批次不会重复创建任务。待运行和失败任务可删除；重复的已完成任务可删除到只剩一条。任务删除不删除导入批次或业务数据。

浏览器操作顺序：

1. 打开 http://localhost:3100，使用管理员账号登录。
2. 进入“对账任务”，在订单表、结算表、成本表和直播表右侧分别点击“导入”，或选择已有批次。
3. 选择对账归属月，确认各批次文件名后创建任务。
4. 点击“开始对账”，任务完成后点击“查看结果”。
5. 在订单工作台、对账汇总和异常处理页面核对结果，使用完毕后退出登录。

需求与开发顺序见 [Cursor开发清单.md](./Cursor开发清单.md)。

日常操作、字段准备、对账流程和异常处理见 [对账系统使用手册.md](./对账系统使用手册.md)。

测试服务器的容器化部署、访问保护、更新和备份流程见 [测试环境部署手册.md](./测试环境部署手册.md)。
