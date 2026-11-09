# AGENTS.md

给在本仓库工作的编码代理（以及新加入的开发者）的约定。先读这一页，再动手。

## 项目是什么

数据仓库资源控制台：管理批量调度服务器、批量调度平台 IP、采集交换平台 IP、NAS、GDS 服务器。
业务主线是「需求项目 → 项目环境 → 槽位 → 资源」，并带容量核算、按时段峰值、错峰复用、
占用期限、环境模板、字典、RBAC 与审计。

## 目录与分层

```
packages/shared/   Zod 契约、枚举、DTO，前后端共同引用（Vite 直接引 TS 源码）
apps/api/          Fastify 5 + Zod 4 + Drizzle；routes → service → repository
apps/web/          React 19 + Vite 7 + Tailwind 4 + TanStack Query
scripts/           真实 HTTP / CDP 冒烟测试，以及离线打包脚本
deploy/            compose 使用的 nginx、db-init、生产 .env 模板
docs/              内网离线部署说明
```

API 关键位置：

- `apps/api/src/app.ts`：插件、/health、/ready、/docs 与路由注册。
- `apps/api/src/db/index.ts`：双驱动统一入口。业务代码只 `import { db, withTransaction }`，
  不要直接 new 驱动连接。SQLite 是单进程 + `BEGIN IMMEDIATE`，PostgreSQL 用连接池真事务。
- `apps/api/src/db/schema.sqlite.ts` / `schema.pg.ts` / `schema.ts`：三份 schema 必须同步改。
- `apps/api/src/db/auto-migrate.ts`：启动迁移；SQLite 走 `drizzle/`，PG 走 `postgres-migrate.ts`
  里的内嵌 SQL。**新增表/列时两边都要加迁移**，不能只改 Drizzle schema。
- `apps/api/src/modules/<domain>/{routes,service,repository}.ts`：按域组织。
- `apps/api/src/lib/{capacity,occupancy}.ts`：容量与占用计算，改口径前先看冒烟用例。

前端关键位置：

- `apps/web/src/components/ui.tsx`：自研 Select / Modal / Switch 等基础件，不要引入组件库。
- `apps/web/src/components/layout.tsx`：侧边栏与页面骨架。
- `apps/web/src/index.css`：Tailwind 4 主题变量与全局样式。
- `apps/web/src/lib/`：auth（内存 access token + httpOnly refresh cookie）、dict、import-template。
- 页面按 `pages/*-page.tsx` 组织，数据请求统一走 TanStack Query。

## 常用命令

```bash
npm install                 # Node >= 20.19
npm run dev                 # shared 构建 + API 8787 + Web 5173
npm run typecheck           # 三个 workspace 的 tsc --noEmit
npm run build               # shared → api → web
npm run smoke               # 7 套冒烟串联，需先启动 API（Web 仅 UI 用例需要）
npm run ui:check            # CDP 浏览器用例，需要 Chrome/Chromium
npm run db:seed             # 写入演示项目/环境/资源/账号
npm run db:reset            # 只用于本地演示库，会清空数据
```

测试脚本读取根目录 `.env` 里的 `BOOTSTRAP_ADMIN_*`；也可用 `SMOKE_BASE`、`SMOKE_PASSWORD`、
`CHROME_PATH` 覆盖。CI 里 Web 端口固定 5173（见 `.github/workflows/ci.yml`）。

## 数据库与部署

- 默认 SQLite（`./data/dw-console.db`，相对 API 进程 cwd）；生产用 PostgreSQL/DWS。
- 双驱动差异用 `firstRow()` / `execSql()` / `withTransaction()` 抹平；不要写只在一种驱动可用的查询。
- `better-sqlite3` 是 optionalDependency，且 API 镜像里被删除；不要静态 `import` 它。
- Docker 部署：以 `deploy/.env.example` 复制为根 `.env`，`docker compose up -d --build`，
  Web 默认 8080，API 只在 compose 网络内 expose。
- `db-init` 由 `DB_CREATE_TABLES` / `DB_IMPORT_DATA` 控制；已有库两项都保持 false。
- 离线包：`scripts/package-docker-offline.ps1 -Version x.y.z`。版本号递增，不要覆盖旧包。
- 生产环境 `AUTO_MIGRATE=false`，迁移交给 db-init；`JWT_SECRET`、管理员口令、`CORS_ORIGIN` 必须改。

## 代码约定

- 接口契约先写 `packages/shared` 的 Zod schema，路由用它做校验/序列化/OpenAPI。
- 写操作必须落审计；涉及多表写入时包在 `withTransaction()` 里。
- 权限只有 ADMIN / USER / READONLY；新增写接口默认要求 ADMIN 或 USER，并在路由层显式声明。
- 资源类型/环境来自数据库字典，不要再假设代码常量一定存在；显示名用 `environmentLabelOf()`。
- 前端文案用中文，风格克制；颜色走 CSS 变量/主题 token，不写死十六进制。
- 时间轴粒度是天；容量按时段峰值计算，父子资源容量规则见 `capacity.ts`。
- 提交信息使用中文或 conventional commit 均可，但要能说明「为什么」。

## 测试与验收

- 提交前至少：`npm run typecheck` + `npm run build`。
- 改后端行为：启动 API 后跑对应 `npm run smoke:*`；改 UI 再跑 `npm run ui:check`。
- 冒烟会真实写库。跑 `ui:regression-fixes` 等破坏性用例前，确认 `DATABASE_URL` 指向临时库。
- 不要对已有业务数据的库执行 `db:reset`、`db:seed` 或手工删表。

## 不要提交

`.env`、`apps/api/data/`、`data/`、`artifacts/`、`import/*`（README 除外）、`.workbuddy/`、
`.obsidian/`、`node_modules/`、`dist/`。这些已经在 `.gitignore` 里，别用 `git add -f` 绕过。
