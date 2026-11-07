# 数据仓库资源控制台

统一管理批量调度服务器、平台 IP、采集交换节点、NAS 存储和 GDS 服务器，并将资源台账、项目环境、环境模板、槽位分配、容量核算、占用期限、权限与审计整合到一个控制台中。

[![CI](https://github.com/xlh12138-arch/dw-resource-console/actions/workflows/ci.yml/badge.svg)](https://github.com/xlh12138-arch/dw-resource-console/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=nodejs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B-4169E1?logo=postgresql&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-supported-003B57?logo=sqlite&logoColor=white)

## 项目定位

这是一个可直接运行的内部工具型 MVP，重点解决以下问题：

- 资源分散在表格和文档中，缺少统一台账。
- 服务器、IP、存储等资源没有一致的检索和冲突检测入口。
- 项目需要多套环境，资源组合依赖人工挑选，容易漏配或重复占用。
- 同一资源在不同时间段被多个环境复用，简单容量相加无法反映真实占用。
- 资源变更、项目环境和模板操作缺少可追溯的审计记录。

当前版本采用角色级 RBAC，不包含团队或项目级数据隔离。

## 功能概览

| 模块 | 主要能力 |
| --- | --- |
| 资源概览 | 资源总量、类型/环境/项目分布、NAS 使用率、IP 冲突、容量和超期汇总 |
| 资源台账 | 分页、搜索、多条件筛选、动态字段列、IP 冲突检测、CSV 导入导出 |
| 资源详情 | 类型属性、项目归属、容量明细、父子资源、占用时间轴、被引用位置、变更历史 |
| 资源类型字典 | 自定义资源类型、编码前缀、字段类型、必填项、IP 字段和列表关键列 |
| 环境字典 | 自定义环境编码、名称、标识色、启停管理和引用检查 |
| 项目管理 | 项目、多套环境、环境模板、槽位编辑与候选资源分配 |
| 容量治理 | 父子容量联动、槽位容量申请、分段峰值占用和错峰复用 |
| 占用期限 | 开始/结束时间、长期占用、续期、释放、超期提醒和时间轴 |
| 权限与审计 | 管理员、普通用户、只读用户；字段级变更审计和请求 ID |
| 系统能力 | OpenAPI 文档、健康探针、限流、Cookie 会话、双数据库和 CI |

## 技术栈

| 层次 | 技术 |
| --- | --- |
| Monorepo | npm workspaces |
| 前端 | React 19、Vite 7、TanStack Query 5、Tailwind CSS 4 |
| 后端 | Fastify 5、Zod 4、`fastify-type-provider-zod` |
| 数据库 | SQLite（better-sqlite3）或 PostgreSQL（node-postgres） |
| ORM / 迁移 | Drizzle ORM、drizzle-kit |
| 认证 | JWT 访问令牌 + 服务端轮换刷新令牌 + httpOnly Cookie |
| 测试 | Node 冒烟测试、事务测试、限流测试、无头 Chrome UI 测试 |
| CI | GitHub Actions，覆盖 SQLite、PostgreSQL 和浏览器测试 |

## 快速开始

如果目标环境是内网且不能下载 npm 依赖，请直接参考
[离线 Docker 部署手册](docs/DOCKER_OFFLINE_DEPLOY.md)。该方案在联网机器生成镜像，
内网服务器只需导入镜像并执行 `docker compose up -d --no-build`。

### 环境要求

- Node.js `>= 20.19`，推荐 Node.js 22 LTS。
- npm 10+。
- 使用 PostgreSQL 时，需要 PostgreSQL 16 或更高版本。

### 1. 安装依赖

```bash
npm ci
```

### 2. 准备环境变量

```bash
cp .env.example .env
```

至少修改以下配置：

```env
JWT_SECRET=<随机长字符串>
BOOTSTRAP_ADMIN_PASSWORD=<管理员初始密码>
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

### 3. 选择数据库

#### SQLite

适合本地开发和单机部署：

```env
DB_DRIVER=sqlite
DATABASE_URL=./data/dw-console.db
```

#### PostgreSQL / 华为 DWS

适合生产、多实例部署和 PostgreSQL 兼容的华为 DWS：

```env
DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@127.0.0.1:5432/dw
DB_SCHEMA=public
DB_CREATE_SCHEMA=true
DB_SSL=false
DB_POOL_MAX=10
```

`DB_SCHEMA` 控制业务表、外键、索引和原生查询使用的 PostgreSQL schema。
仅允许小写字母、数字和下划线；如果 schema 由 DBA 预建，可设置
`DB_CREATE_SCHEMA=false`。

如果密码包含 `@`、`#`、`/`、`:` 等 URL 保留字符，必须先进行 URL 编码。例如 `@` 应写成 `%40`。

### 4. 初始化数据库

```bash
npm run db:migrate
```

如需演示资源和示例项目：

```bash
npm run db:seed
```

> `db:seed` 会写入演示资源、项目、环境和模板，只建议用于开发或演示环境。

### 5. 启动开发环境

```bash
npm run dev
```

默认地址：

- Web：<http://localhost:5173>
- API：<http://localhost:8787/api/v1>
- OpenAPI：<http://localhost:8787/docs>
- 就绪探针：<http://localhost:8787/ready>

### 6. 生产构建

```bash
npm run build
npm start
```

生产环境建议显式执行迁移并关闭启动时自动迁移：

```env
AUTO_MIGRATE=false
```

```bash
npm run db:migrate
npm start
```

## 演示账号

首次启动且用户表为空时，当前 Demo 会创建：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | `admin` | `.env` 中的 `BOOTSTRAP_ADMIN_PASSWORD` |
| 普通用户 | `user` | `User@12345` |
| 只读用户 | `readonly` | `Readonly@12345` |

> 这些固定演示账号只适合本地环境。正式部署时应修改初始密码，并停用或删除不需要的演示账号。

## 权限模型

| 权限 | 管理员 | 普通用户 | 只读用户 |
| --- | :---: | :---: | :---: |
| 查看资源、项目、字典和概览 | ✅ | ✅ | ✅ |
| 新建、编辑、导入、分配和续期 | ✅ | ✅ | — |
| 删除资源、项目和字典项 | ✅ | ✅ | — |
| 用户管理 | ✅ | — | — |
| 查看审计日志 | ✅ | — | — |

前端会根据权限隐藏入口，后端仍会再次执行权限校验。

## 架构

```text
浏览器
  │
  ▼
React Web / Vite
  │  /api/v1
  ▼
Fastify API
  ├─ 认证与 RBAC
  ├─ 资源 / 项目 / 模板 / 字典
  ├─ 容量与占用期限
  ├─ 审计
  └─ Drizzle 数据访问
       ├─ SQLite
       └─ PostgreSQL
```

### 目录结构

```text
dw-resource-console/
├─ apps/
│  ├─ api/
│  │  ├─ src/config/          # 环境变量与启动校验
│  │  ├─ src/db/              # 双驱动 schema、连接、事务和迁移
│  │  ├─ src/modules/         # auth/resources/projects/dict/users/audit/stats
│  │  ├─ src/plugins/         # auth/security/error handler
│  │  ├─ drizzle/             # SQLite 迁移
│  │  └─ drizzle-pg/          # PostgreSQL 迁移
│  └─ web/                    # React 控制台
├─ packages/shared/           # 共享 Zod schema、枚举和 DTO
├─ scripts/                   # API、事务、限流与 UI 测试
└─ .github/workflows/ci.yml   # GitHub Actions
```

### 核心数据关系

```mermaid
flowchart LR
  RT[资源类型字典] --> R[资源]
  ED[环境字典] --> P[项目环境]
  P --> PE[项目环境]
  T[环境模板] --> PE
  PE --> S[环境槽位]
  S --> R
  P --> R
  R --> C[子资源]
```

资源公共字段存储在统一资源表中，类型专属字段存储在 `attrs`。两者在 SQLite 中使用 JSON 文本，在 PostgreSQL 中使用 `jsonb`。

## 双数据库与事务

### SQLite

- 零运维，适合开发、演示和单机部署。
- 使用 WAL、外键检查和 `BEGIN IMMEDIATE` 事务。
- 事务由进程内互斥锁串行化，不支持多实例写入。

### PostgreSQL / DWS

- 使用 `node-postgres` 连接池。
- 使用可配置 PostgreSQL schema 和迁移目录；迁移 SQL 会按 `DB_SCHEMA` 自动切换。
- 事务直接使用连接池中的原生事务连接。
- 支持多实例部署和更高的并发能力。

API 中“多表写入 + 审计”操作统一通过 `withTransaction()` 执行。任一步骤失败时，业务数据和审计记录会一起回滚。

### 常用数据库命令

```bash
# 根据 DB_DRIVER 生成对应迁移
npm run db:generate

# 执行迁移
npm run db:migrate

# 写入演示数据
npm run db:seed

# 清空业务数据和字典配置（仅用于开发）
npm run db:reset
```

> `db:reset` 会删除业务数据，请勿在生产环境执行。

## 安全设计

- 访问令牌只保存在内存中。
- 刷新令牌只通过 `httpOnly + SameSite=Lax` Cookie 传输，不进入 JSON 响应体。
- 刷新令牌在数据库中以 SHA-256 摘要保存，并支持轮换与吊销。
- 密码使用 Node `crypto.scrypt` 加盐哈希。
- Helmet 安全头、显式 CORS 来源和接口限流默认启用。
- 限流使用 Fastify 解析后的来源地址，不信任客户端自行设置 `X-Forwarded-For`。
- 直接暴露服务时保持 `TRUST_PROXY=false`；在可信反向代理后，只填写代理 IP/CIDR。
- 所有写操作记录字段级审计；密码明文不会写入日志或审计记录。

## 测试

### 本地验证

先启动并初始化 API，然后运行：

```bash
npm run typecheck
npm run build
npm run smoke
npm run test:transaction
npm run test:rate-limit
```

UI 测试需要同时运行 Web 和 API：

```bash
npm run ui:check
```

当前测试规模：

- 387 项 API 与权限冒烟断言。
- 71 项无头浏览器 UI 断言。
- 13 项默认值、容量编辑、槽位维护与动态属性排序回归断言。
- 10 项台账、模板、槽位、字典和表单浏览器回归断言。
- 事务提交、回滚及审计一致性测试。
- 伪造 `X-Forwarded-For` 的限流绕过测试。

### GitHub Actions

[CI 工作流](.github/workflows/ci.yml) 在每次 push 和 pull request 时执行：

1. 类型检查和完整构建。
2. SQLite 迁移、种子、事务、API 和 UI 测试。
3. PostgreSQL 16 迁移、种子、事务和完整 API 测试。

## API 约定

- 基础路径：`/api/v1`
- 交互文档：`/docs`
- 健康检查：`/health`
- 数据库就绪检查：`/ready`

统一错误结构：

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "资源冲突",
    "details": {},
    "requestId": "request-id"
  }
}
```

## 主要配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | `./data/dw-console.db` | SQLite 文件路径或 PostgreSQL 连接串 |
| `DB_SCHEMA` | `public` | PostgreSQL/DWS 业务表所在 schema，仅允许小写标识符 |
| `DB_CREATE_SCHEMA` | `true` | schema 不存在时是否允许应用创建 |
| `DB_SSL` | `false` | PostgreSQL 是否启用 TLS |
| `DB_POOL_MAX` | `10` | PostgreSQL 连接池上限 |
| `AUTO_MIGRATE` | `true` | 启动时自动执行迁移 |
| `JWT_SECRET` | — | JWT 签名密钥，生产必须替换 |
| `ACCESS_TOKEN_TTL` | `15m` | 访问令牌有效期 |
| `REFRESH_TOKEN_TTL` | `7d` | 刷新令牌有效期 |
| `CORS_ORIGIN` | 本地前端地址 | 允许的前端来源，多个用逗号分隔 |
| `TRUST_PROXY` | `false` | 可信反向代理地址或 CIDR |
| `RATE_LIMIT_MAX` | `300` | 单 IP 每分钟接口请求上限 |
| `RATE_LIMIT_LOGIN_MAX` | `10` | 单 IP 每分钟登录请求上限 |

## 已知限制

- 权限只区分管理员、普通用户和只读用户，没有团队或项目级数据隔离。
- 到期占用不会自动释放，也不会主动发送邮件或企业微信通知。
- 尚未接入 CMDB、监控、调度平台或自动化资源发放。
- 时间轴粒度为天，更适合占用规划而非精确到分钟的任务调度。
- 前端未做国际化与移动端专项适配，构建产物仍以单包输出。
- SQLite 仅适合单进程部署；多实例请使用 PostgreSQL。

## 后续方向

- 接入统一身份认证、审批流和工单系统。
- 对接 CMDB、监控与调度平台，降低台账漂移。
- 增加企业微信/邮件到期提醒和后台对账任务。
- 按真实场景引入资源发放编排与自动回收。
- 补充单元测试、OpenAPI 客户端和可观测性指标。

## 贡献

提交改动前请至少执行：

```bash
npm run typecheck
npm run build
```

涉及数据库、权限或交互的改动，还应运行对应冒烟测试和 UI 测试。
