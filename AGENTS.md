# AGENTS.md

给在本仓库工作的编码代理（以及新加入的开发者）的约定。先读这一页，再动手。
这份文件同时承担项目交接说明，部署、认证和打包相关改动必须先核对本页。

## 项目是什么

数据仓库资源管理平台：管理 ETL 服务器、功能服务器、采集交换平台、DWS/ORACLE/ARGO 数据库、MRS、
调度平台（理想/源启）、NAS 与 GDS 服务器。资源类型字典以生产库（PG）为准。
生产环境的字典编码是 `PRD`（不要再用 `PROD`）。
业务主线是「需求项目 → 项目环境 → 槽位 → 资源」，并带容量核算、按时段峰值、错峰复用、
占用期限、环境模板、字典、RBAC 与审计。

## 目录与分层

```
packages/shared/   Zod 契约、枚举、DTO，前后端共同引用（Vite 直接引 TS 源码）
apps/api/          Fastify 5 + Zod 4 + Drizzle；routes → service → repository
apps/web/          React 19 + Vite 7 + Tailwind 4 + TanStack Query
scripts/           冒烟测试、Docker 离线包、原生全量/增量包脚本
deploy/            Compose 配置和 deploy/native 原生离线部署模板
docs/              Docker、麒麟 V10 原生离线包和增量部署说明
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
- `apps/api/src/config/env.ts`：环境变量校验和 TTL 解析；新增环境变量时同步所有 `.env` 模板。

前端关键位置：

- `apps/web/src/components/ui.tsx`：自研 Select / Modal / Switch 等基础件，不要引入组件库。
- `apps/web/src/components/layout.tsx`：侧边栏与页面骨架。
- `apps/web/src/index.css`：Tailwind 4 主题变量与全局样式。
- `apps/web/src/lib/`：auth（内存 access token + httpOnly refresh cookie）、dict、import-template。
- 页面按 `pages/*-page.tsx` 组织，数据请求统一走 TanStack Query。

## 内网目标环境

当前明确的内网部署目标：

- 操作系统：Kylin Linux Advanced Server V10 (Tercel)。
- 普通用户部署，没有 root；Node.js 和 Nginx 都安装在用户自己拥有的目录。
- 不使用 Docker；应用和 Nginx 由普通用户自己的脚本、PID 和日志管理。
- Nginx 监听 `8080`，前端静态文件来自 `apps/web/dist`。
- API 监听 `127.0.0.1:8787`，只允许本机 Nginx 转发。
- 数据库为华为 DWS 8.2.1，PostgreSQL 兼容模式，使用独立 schema。

Nginx 要求：

- `http {}` 中可以 `include` 多个 `.conf` 文件，每个文件通常直接写 `server {}`。
- 同一地址和端口只能有一个 `default_server`。
- 必须代理 `/api/`、`/health`、`/ready`、`/docs` 到 `127.0.0.1:8787`。
- 前端路由使用 `try_files $uri $uri/ /index.html`。
- 必须设置 `proxy_set_header X-Forwarded-Proto $scheme`，供 Cookie 的 `Secure` 判断。
- 用户自己的 Nginx 使用 `-p <prefix> -c <conf>`；验证用 `-t`，reload 用 `-s reload`。
- 不要要求用户执行 `systemctl reload nginx`，因为目标环境没有 root。

原生环境模板位于 `deploy/native/`，完整说明见 `docs/NATIVE_OFFLINE_DEPLOY.md`。

## 常用命令

```bash
npm install                 # Node >= 20.19
npm run dev                 # shared 构建 + API 8787 + Web 5173
npm run lint                # ESLint（TS/TSX + React Hooks）
npm run format              # Prettier 统一格式
npm run format:check        # 只检查不写入，CI 用
npm run typecheck           # 三个 workspace 的 tsc --noEmit
npm run build               # shared → api → web
npm run smoke               # 7 套冒烟串联，需先启动 API（Web 仅 UI 用例需要）
npm run ui:check            # CDP 浏览器用例，需要 Chrome/Chromium
npm run db:seed             # 写入演示项目/环境/资源/账号
npm run db:reset            # 只用于本地演示库，会清空数据
```

测试脚本统一从 `scripts/lib/smoke-env.mjs` 读环境：显式环境变量 > 根目录 `.env`。
管理员口令取 `SMOKE_PASSWORD` 或 `BOOTSTRAP_ADMIN_PASSWORD`，缺失时脚本直接非 0 退出，
不要改成「跳过并 exit 0」。其余可用 `SMOKE_BASE`、`SMOKE_WEB_BASE`、`CHROME_PATH` 覆盖。
CI 里 Web 端口固定 5173（见 `.github/workflows/ci.yml`）。

## 数据库与部署

- 默认 SQLite（`./data/dw-console.db`，相对 API 进程 cwd）；生产用 PostgreSQL/DWS。
- 双驱动差异用 `firstRow()` / `execSql()` / `withTransaction()` 抹平；不要写只在一种驱动可用的查询。
- `better-sqlite3` 是 optionalDependency，且 API 镜像里被删除；不要静态 `import` 它。
- 华为 DWS 必须设置 `DB_COMPAT_MODE=dws`；标准 PostgreSQL 使用默认 `postgres`。
- DWS 模式下迁移会跳过外键、移除 `USING btree`，并避免 8.2.1 不支持的
  `CREATE INDEX IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`。改动见
  `apps/api/src/db/dws-compat.ts` 和 `postgres-migrate.ts`。
- DWS 的 `users`、`resource_types`、`resource_type_fields`、`environments`、
  `env_templates`、`env_template_items`、`projects`、`project_environments`、
  `project_snapshots`、`resources`、`refresh_tokens` 使用
  `DISTRIBUTE BY REPLICATION`。这些是配置/小表，建议控制在 100 万行以内。
- `audit_logs`、`env_slots` 保持普通分布。新增带主键/唯一约束的复制表前，
  先评估 DWS 的分布列限制。
- 因为 DWS 模式没有数据库外键，删除和解除引用必须由应用层补偿。当前已显式清理：
  刷新令牌、资源类型字段、模板条目、项目环境槽位，以及资源删除后的槽位引用。
  新增关联表或删除路径时必须同步补应用层清理。
- 数据导入必须走 `import-data.ts` 的 DWS SQL 清洗逻辑，不要在导入时使用
  `ON CONFLICT` 或 DWS 不支持的会话参数，例如 `lock_timeout`。
- Docker 部署：以 `deploy/.env.example` 复制为根 `.env`，`docker compose up -d --build`，
  Web 默认 8080，API 只在 compose 网络内 expose。
- `db-init` 由 `DB_CREATE_TABLES` / `DB_IMPORT_DATA` 控制；已有库两项都保持 false。
- 离线包：`scripts/package-docker-offline.ps1 -Version x.y.z`。版本号递增，不要覆盖旧包。
- 原生离线包：`scripts/package-native-offline.ps1 -Version x.y.z`。
- 生产环境 `AUTO_MIGRATE=false`；已有库建表和导入都关闭。迁移/导入只允许显式执行。
- `JWT_SECRET`、管理员口令、`CORS_ORIGIN`、数据库密码必须替换为真实安全值。
- 数据库密码含 URL 保留字符时必须 URL 编码。

## 认证与会话

- 访问令牌只保存在前端内存，不写 `localStorage`；API 用 `Authorization: Bearer` 校验。
- 刷新令牌只通过 `httpOnly + SameSite=Lax` 的 `dw_refresh` Cookie 传输，数据库仅存 SHA-256 摘要。
- `dw_refresh` 是浏览器会话 Cookie，不设置 `Max-Age` / `Expires`。正常关闭浏览器后需要重新登录。
- Cookie 的 `Secure` 按 `request.protocol === 'https'` 动态设置。内网 HTTP 必须可登录，
  同时 HTTPS 环境要保持安全属性；Nginx 必须传 `X-Forwarded-Proto`。
- `POST /auth/logout` 不依赖访问令牌，而是按刷新 Cookie 查找并吊销令牌，确保空闲超时或
  访问令牌过期后仍能可靠登出。
- `packages/shared` 的 `authResultSchema` 包含 `idleTimeoutSeconds`。登录、刷新接口必须返回；
  前端 `AuthProvider` 根据用户活动重置计时器，超时调用登出并清理内存令牌。
- 三个时间参数含义：
  - `ACCESS_TOKEN_TTL`：JWT 访问令牌有效期，默认 `15m`。
  - `REFRESH_TOKEN_TTL`：单枚数据库刷新令牌有效期，默认 `7d`；轮换后新令牌重新计时。
  - `IDLE_TIMEOUT`：用户无操作自动退出时间，默认 `30m`，通过 API 返回给前端。
- 认证链路改动通常同时涉及：
  `packages/shared/src/schemas.ts`、
  `apps/api/src/config/env.ts`、
  `apps/api/src/modules/auth/*`、
  `apps/web/src/lib/api.ts`、
  `apps/web/src/lib/auth.tsx`。
- 修改 `packages/shared` 后必须重新构建 shared、API 和 Web；原生增量包使用 `-Areas shared`。

## 原生离线包与增量部署

完整操作说明在 `docs/NATIVE_OFFLINE_DEPLOY.md`，环境模板在 `deploy/native/`。

全量包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-offline.ps1 `
  -Version <version>
```

增量包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version <version> -Areas <area>
```

`-Areas` 可用值：

- `api`：只改 API 时使用。
- `web`：只改前端时使用。
- `shared`：共享契约变化时使用；脚本会构建 shared + API + Web。
- `migrations`：只携带 `drizzle/` 和 `drizzle-pg/`。
- `data`：只携带 `data/dw_console_data.sql`。
- 多个值用逗号分隔，例如 `-Areas api,web,migrations`。

规则：

- 增量包不包含 `node_modules`；依赖变化必须重新生成全量包。
- 内网增量部署使用包内 `apply-update.sh <生产目录>`。脚本会停止 API、备份旧目录，
  只替换包中存在的目录；不会自动执行迁移或导入数据。
- 全量包生产依赖安装使用 `npm ci --omit=dev --omit=optional --ignore-scripts`，
  避免带入 SQLite 原生可选依赖。
- 不要手工用 Windows `Compress-Archive` 作为最终交付包。它会把 Unix 权限写成 `000`，
  并使用反斜杠路径。必须调用 `scripts/lib/zip-linux-permissions.ps1`：
  目录 `040755`、`.sh` `100755`、普通文件 `100644`，路径统一为 `/`。
- 打包脚本会把 `TEMP` / `TMP` 指向工作区临时目录，规避 Windows esbuild 临时文件权限问题。
- 交付包必须记录 SHA256；版本号递增，不覆盖历史包。
- 不要从旧 ZIP 反向解析后改包，直接从仓库当前构建产物重新生成。

Linux 权限验收：

```sh
zipinfo -l <package>.zip | grep -E 'dw-resource-console/($|start-api.sh|stop-api.sh|package.json)'
find <extracted-dir> -type d ! -perm -u+x
find <extracted-dir> -type f -name '*.sh' ! -perm -u+x
```

前两条检查命令应分别看到目录/脚本可执行，`find` 命令应无输出。

## 代码约定

- 接口契约先写 `packages/shared` 的 Zod schema，路由用它做校验/序列化/OpenAPI。
- 写操作必须落审计；涉及多表写入时包在 `withTransaction()` 里。
- 权限只有 ADMIN / USER / READONLY；新增写接口默认要求 ADMIN 或 USER，并在路由层显式声明。
- 资源类型/环境来自数据库字典，不要再假设代码常量一定存在；显示名用 `environmentLabelOf()`。
- 前端文案用中文，风格克制；颜色走 CSS 变量/主题 token，不写死十六进制。
- 时间轴粒度是天；容量按时段峰值计算，父子资源容量规则见 `capacity.ts`。
- 认证/会话改动必须同时检查 API 响应契约、Cookie 属性、前端续期与空闲计时链路。
- 数据删除、解除槽位引用等跨表行为不能只依赖 PostgreSQL 外键；DWS 也要成立。
- 格式交给 Prettier（`.prettierrc.json`：100 列、单引号、结尾逗号），规则交给 ESLint
  （`eslint.config.js`）；不要手写与配置冲突的排版，也不要新增 `eslint-disable` 而不写原因。
- 提交信息使用中文或 conventional commit 均可，但要能说明「为什么」。
- 提交时显式列出本次路径，不要用 `git add -A` 把用户已有改动一起带走。
- 不执行 `git reset --hard`、`git checkout --` 或回滚不属于本次任务的改动。
- push 后用 `git status -sb` 确认没有 `ahead`；网络失败时保留本地提交并明确报告，不能谎报已推送。

## 测试与验收

- 提交前至少：`npm run lint` + `npm run format:check` + `npm run typecheck` + `npm run build`。
- 改后端行为：启动 API 后跑对应 `npm run smoke:*`；改 UI 再跑 `npm run ui:check`。
- 冒烟会真实写库。跑 `ui:regression-fixes` 等破坏性用例前，确认 `DATABASE_URL` 指向临时库。
- 不要对已有业务数据的库执行 `db:reset`、`db:seed` 或手工删表。
- 认证改动至少验证：登录返回 `idleTimeoutSeconds`；`Set-Cookie` 无 `Max-Age`/`Expires`；
  刷新 Cookie 可以续期；不带访问令牌也能登出；登出后 `/auth/refresh` 返回 401。
- 原生打包改动至少验证：生产依赖解析、`@dw/shared` 可加载、ZIP `testzip` 通过、
  路径为正斜杠、目录和脚本权限正确。
- 全量包和增量包脚本都应使用 `-SkipBuild` 做一次结构/权限快速验收；正式交付前再跑完整构建。

## 不要提交

`.env`、`apps/api/data/`、`data/`、`artifacts/`、`import/*`（README 除外）、`.workbuddy/`、
`.obsidian/`、`node_modules/`、`dist/`。这些已经在 `.gitignore` 里，别用 `git add -f` 绕过。
