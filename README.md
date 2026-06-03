# TimeManageSystem

时间管理系统。前端使用 Vue 3 + Vite + Element Plus + ECharts，后端使用 Node.js + Express + TypeScript，钉钉表格作为主数据源，SQLite 保存账号、权限和审计日志。

## 启动

```bash
npm install
copy .env.example .env
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:4000

默认账号：

| 用户名 | 密码 | 角色 |
| --- | --- | --- |
| admin | admin123 | 管理员 |
| editor | editor123 | 编辑者 |
| viewer | viewer123 | 只读用户 |

## 钉钉配置

在 `.env` 中配置：

```bash
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=
DINGTALK_WORKBOOK_ID=
DINGTALK_OPERATOR_ID=
```

如果配置缺失，服务端自动使用 mock 数据，方便先验收页面和交互。配置齐全后，后端会通过钉钉开放接口读取和写入表格数据；前端不会接触钉钉密钥。
