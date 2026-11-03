# 数据仓库资源管理平台（DW Resource Console）

面向数据仓库基础设施的**资源台账与治理服务**：统一管理**批量调度服务器、批量调度平台 IP、采集交换平台 IP、NAS 存储、GDS 服务器**，提供台账录入、检索、IP 冲突检测、批量导入导出、变更审计、RBAC 权限与概览视图。

> 本仓库既是「完整方案说明」，也是可直接运行的 Demo（前后端均已跑通，353 项接口冒烟 + 46 项 UI 实测全部通过）。

---

## 一、技术选型（2026 年主流版本）

| 层次 | 选型 | 版本 | 选型理由 |
| --- | --- | --- | --- |
| 运行时 | Node.js | 22 LTS | 原生 ESM、内置 `fetch`/`test runner`，前端同源同语言降低心智负担 |
| 后端框架 | Fastify | 5.x | 吞吐高、插件与封装模型清晰、原生 JSON Schema 校验链路 |
| 校验/契约 | Zod + `fastify-type-provider-zod` | 4.x / 7.x | **一份 schema 同时产出**：运行时校验、TS 类型、OpenAPI 文档、响应裁剪 |
| ORM / 迁移 | Drizzle ORM + drizzle-kit | 0.45 / 0.31 | 类型安全 SQL、版本化可回滚迁移、SQLite 与 PostgreSQL 同构代码 |
| 数据库 | SQLite（better-sqlite3） | 13.x | Demo 零运维；`DB_DRIVER` 切到 `postgres` 仅换驱动即可上生产 |
| 认证 | JWT 访问令牌 + 服务端刷新令牌（httpOnly Cookie） | @fastify/jwt 10.x + @fastify/cookie | 访问令牌 15 分钟短时效且只存内存；刷新令牌存库可吊销并轮换，经 httpOnly Cookie 下发，刷新页面可静默续期 |
| 口令哈希 | Node `crypto.scrypt` | 内置 | 免第三方原生依赖，自带 salt 与定长摘要 |
| 日志 | Pino（Fastify 内置） | — | 结构化 JSON、请求 ID 贯穿、敏感头自动 redact |
| 前端框架 | React | 19.x | 主流生态与并发特性 |
| 构建 | Vite | 7.x | 秒级冷启动、同源代理免 CORS |
| 数据请求 | TanStack Query | 5.x | 缓存/失效/重试策略（4xx 不重试、5xx 有限重试） |
| 样式 | Tailwind CSS | 4.x | `@theme` 设计令牌、零配置 Vite 插件 |
| 路由 | React Router | 8.x | 与 React 19 对齐，`NavLink`/守卫开箱可用 |
| 工程组织 | npm workspaces Monorepo | — | `packages/shared` 让前后端共用同一套枚举与 DTO |

**为什么不是别的**：NestJS 更重（装饰器 + DI 容器），本场景服务端逻辑以 CRUD + 校验 + 审计为主，Fastify + 显式分层更轻且更快；Prisma 需要生成客户端与引擎二进制，Drizzle 更贴近 SQL 且迁移产物可读可回滚；`localStorage` 存令牌已被明确禁止，改为「访问令牌存内存 + 刷新令牌由 httpOnly Cookie 承载 + 轮换」。

---

## 二、架构设计

### 2.1 分层与目录

```
dw-resource-console/
├─ packages/shared/           # 契约层：枚举、Zod schema、DTO 类型、动态表单定义（前后端同源）
│  └─ src/{enums.ts,schemas.ts,index.ts}
├─ apps/api/                  # 后端：按功能组织 + 三层架构
│  ├─ src/config/env.ts       # 集中配置 + 启动即校验（快速失败）
│  ├─ src/db/                 # schema / 连接 / 迁移 / 种子 / 重置
│  ├─ src/lib/                # errors(类型化错误) password(scrypt) actor(审计操作人)
│  ├─ src/plugins/            # error-handler / security(cors·helmet·限流) / auth(jwt·RBAC)
│  └─ src/modules/            # 按功能：auth / resources / dict / projects / audit / stats / users / meta
│     └─ <module>/{routes.ts, service.ts, repository.ts}
│        routes   → 只做参数绑定与响应码，不含业务逻辑
│        service  → 业务规则、事务边界、审计留痕，不依赖 HTTP 对象
│        repository → 数据访问，避免 N+1
│     lib/occupancy.ts 统一推导占用状态与超期天数；dict 模块额外含 validator.ts（按字段定义动态编译 Zod + 缓存）与 bootstrap.ts（内置字典播种）
├─ apps/web/                  # 前端控制台
│  ├─ src/lib/{api.ts, endpoints.ts, auth.tsx, dict.tsx, query.ts}
│  ├─ src/components/{ui.tsx, layout.tsx, resource-form.tsx, resource-detail.tsx, timeline.tsx, toast.tsx}
│  └─ src/pages/{login,dashboard,resources,dict,projects,project-detail,templates,audit,users}-page.tsx
└─ scripts/
   ├─ smoke-test.mjs          # 资源端到端 + 三角色 RBAC 冒烟（52 项断言）
   ├─ smoke-project.mjs       # 项目 / 环境 / 模板 + 权限边界冒烟（45 项断言）
   ├─ smoke-dict.mjs          # 字典可维护 + 引用检查 + 一键同步 + 普通用户可写可删 / 只读只读冒烟（52 项断言）
   ├─ smoke-slot-capacity.mjs # 槽位维护 + 引用/跨环境提示 + 容量管理冒烟（51 项断言）
   ├─ smoke-capacity-period.mjs # 容量按时间段核算 + 台账与详情同口径 + 字典引用带项目名冒烟（44 项断言）
   ├─ smoke-hierarchy-period.mjs # 父子层级容量同步 + 占用期限/续期/释放 + 标签层级筛选 + 超期汇总/环境可改冒烟（101 项断言）
   ├─ smoke-user.mjs          # 三角色（管理员 / 普通用户 / 只读）+ 管理员重置密码（旧密码失效、刷新令牌吊销、审计不留明文）冒烟（39 项断言）
   └─ ui-check.mjs            # 无头 Chrome + CDP 的 UI 实测（71 项断言：环境卡片布局、ESC 模态栈、容量峰值展示、Cookie 续期、保存后不提示未保存、台账与详情口径、时间轴 tooltip、字典引用项目名、三角色与重置密码、只读用户无写入口、普通用户除审计与用户管理外全可用）
```

### 2.2 数据模型（SQLite / PostgreSQL 同构）

- **users**：账号、角色（`ADMIN`/`USER`/`READONLY`）、状态、最近登录
- **refresh_tokens**：刷新令牌摘要（不存明文）、过期与吊销时间，支持轮换
- **resource_types / resource_type_fields**：**资源类型字典**，类型编码 + 显示名 + 编码前缀 + 该类型的字段定义（键 / 标签 / 字段类型 / 是否必填 / 枚举选项 / 默认值 / 单位 / 是否 IP 字段 / 是否列表关键列 / 排序），可增删改停
- **environment_dict**：**环境字典**（编码 + 显示名 + 预设色调 + **自定义标识色 `color`（#rrggbb）** + 说明），内置 4 种、可自由增删改停；标识色支持调色板与 RGB 输入
- **resources**：**所有资源类型共用一张表**，公共字段（编码/名称/类型/环境/状态/机房/负责人/标签/备注）+ `attrs` JSON 存放类型专属字段
  - 好处：统一检索、分页、排序、审计、导入导出；`type` / `environment` 存字典编码，类型强约束由**运行时按字典动态编译的 Zod schema**保证
  - 编码前缀取自字典（如 `BS-SRV-0001`、`BS-IP-0001`、`CE-IP-0001`、`NAS-0001`、`GDS-0001`；自定义类型自带前缀）
  - 层级与容量：`parent_id`（自引用，子资源）+ `demand_amount`（向父资源申请的容量）+ `capacity_total`（顶层资源的总量），三者共同支撑「父子容量同步校验」
- **audit_logs**：动作、对象（`RESOURCE`/`USER`/`PROJECT`/`ENVIRONMENT`/`TEMPLATE`/`DICT`）、操作人、`changes`（字段级 from → to）、请求 ID
- **projects**：需求项目（编码、名称、负责人、说明、状态：进行中/已归档）
- **project_environments**：项目 × 环境（环境取自环境字典）的一套环境，含运行状态（规划中/搭建中/运行中/已下线）与所用模板
- **env_templates / env_template_items**：项目环境模板，条目为「资源类型（取自资源类型字典）+ 槽位名称 + 数量 + 是否必需」，可自由组合
- **env_slots**：模板展开后的资源槽位，绑定具体资源（0 或 1 个）；同一资源可被多个环境的槽位引用（共享资源场景）
  - 占用期限：`start_at` / `end_at`（`end_at` 为空即不定期限的长期）/ `renew_count` / `updated_at`；占用状态与超期天数由服务端按当前时间派生，不落库
- **resources.project_id / project_env_id**：资源的**主归属项目 / 项目环境**，用于按项目检索与批量标注；与槽位引用是「或」关系

内置（可改，非硬编码）的 5 种资源类型与默认字段：

| 资源类型 | 编码 | 前缀 | 专属属性（attrs） |
| --- | --- | --- | --- |
| 批量调度服务器 | `BATCH_SCHED_SERVER` | `BS-SRV` | 主机名、管理 IP、操作系统、CPU/内存/磁盘、Agent 端口、节点角色（主/备/代理）、调度域 |
| 批量调度平台 IP | `BATCH_SCHED_PLATFORM_IP` | `BS-IP` | 平台名称、IP、端口、协议、访问地址、是否 VIP、网关 |
| 采集交换平台 IP | `COLLECT_EXCHANGE_PLATFORM_IP` | `CE-IP` | 平台名称、IP、端口、协议、访问地址、是否 VIP、网关 |
| NAS 存储 | `NAS` | `NAS` | 存储集群、共享路径、挂载点、协议（NFS/CIFS/FTP/S3）、总容量、已用容量、读写模式 |
| GDS 服务器 | `GDS_SERVER` | `GDS` | 主机名、IP、端口、服务类型、版本号、节点角色、上游节点 |

内置环境：`DEV` 开发（#2563eb）、`PT` 产品测试（#d97706）、`UAT` 用户测试（#7c3aed）、`PROD` 生产（#dc2626）。以上编码、显示名、标识色、字段定义均可在「字典配置」页修改；历史库里被标记为非内置的 `PROD` 会在启动自检时自动恢复为内置。

### 2.3 关键设计决策

1. **契约同源**：`packages/shared` 用 Zod 定义枚举与 DTO，后端用它校验并生成 OpenAPI，前端直接复用类型；新增资源类型无需改代码，在「字典配置」页面配置即可。
2. **字典驱动的动态表单与校验**：后端按 `resource_types` + `resource_type_fields` 在运行时编译 Zod schema（TEXT/TEXTAREA/NUMBER/INTEGER/IP/PORT/SELECT/BOOLEAN），前端按 `/meta` 返回的字段定义渲染同名控件，双端一致、进程内缓存、字典变更即失效。
3. **IP 冲突治理**：主机类按 IP 判重、平台地址类按 IP+端口判重，仅与「在用/预留」资源比较；表单输入即实时预检，提交时服务端兜底并返回冲突对象编码。
4. **审计留痕**：所有写操作（含登录/登出）记录字段级 diff，资源详情页与审计页可按对象回溯。
5. **错误处理**：`AppError` 类型化错误 + 全局处理器，统一输出 `{ error: { code, message, details?, requestId } }`，客户端永不看到堆栈；前端按 `code` 映射中文文案。
6. **安全基线**：helmet 安全头、显式 CORS 来源（生产禁 `*`）、全局与登录接口分级限流、scrypt 哈希、访问令牌只存内存、日志 redact 授权头。
7. **配置治理**：`config/env.ts` 用 Zod 校验全部环境变量，缺失即退出（fast-fail）；`.env` 不入库，仅提交 `.env.example`。
8. **项目 / 环境 / 模板三层建模**：资源主归属到项目，环境是「项目 × 环境类型」的部署单元，模板只描述「需要哪些资源类型、各几个」，建环境时把模板条目**展开成槽位**，再逐个绑定实际资源。这样同一套模板可被多个项目复用，资源与环境的绑定关系可追溯、可解绑。
9. **归属与引用分离**：`resources.project_id` 是主归属（用户显式标注或批量标注），`env_slots` 是环境对资源的引用（可被多环境共享）。按项目查看取二者并集，既支持独占资源也支持共享资源。
10. **字典化 + 引用保护 + 一键同步**：资源类型与环境全部由数据库字典驱动；改编码 / 删除前先统计引用（资源、模板条目、环境槽位、项目环境），有引用即返回 409 并携带引用明细，前端弹「已被引用」清单，点「一键同步修改」后带 `sync: true` / `migrateTo` 原子地把存量数据一并改掉，不留悬空引用。

---

## 二之二、项目环境与模板（本次新增）

**业务问题**：不同需求项目往往各自有多套环境（DEV / PT / UAT），每套环境需要的资源组合不同；每次从零挑资源既耗时又容易漏配。

**解法**：

```
环境模板（自由组合资源类型）
  标准数仓项目-生产 = 调度节点×2 + 调度平台入口×1 + 采集交换入口×1 + 共享存储×1 + GDS×2
        │  新建环境时套用
        ▼
项目「信贷风控数据集市」→ 生产环境（7 个槽位）
        │  逐个槽位分配实际资源（校验类型 + 环境一致）
        ▼
BS-SRV-0001 / NAS-0001 / GDS-0001 …
```

- **模板**：`资源类型 + 槽位名称 + 数量 + 是否必需` 的清单，数量 > 1 时展开为 `槽位名-1/2/3`；支持克隆、另存、被引用次数统计，被引用时禁止删除。
- **环境**：可套模板一键生成槽位，也可手动加槽位或后续追加套用模板；槽位填充率直接反映环境就绪度。
- **资源标注**：新建/编辑资源时可选所属项目；存量资源在资源台账里勾选后「批量标注项目」；槽位绑定资源时若资源尚无归属会**自动补标**，解绑且无其它引用时自动撤销。
- **按项目查看**：资源台账支持「所属项目 / 未标注项目」筛选；项目详情页直接列出该项目的全部资源（主归属 ∪ 槽位引用）。
- **权限**：沿用 `resource:read / write / delete`；普通用户与管理员一样可增删改（仅无用户管理与审计），只读用户仅可查看。
- **审计**：新增 `PROJECT`、`ENVIRONMENT`、`TEMPLATE` 三类审计对象，模板套用、槽位绑定/解绑均留痕。

---

## 二之三、字典配置：资源类型与环境可维护（本次新增）

**业务问题**：资源类型原本写死在枚举里（批量调度服务器 / 调度平台 IP / 采集交换 IP / NAS / GDS），环境也只有生产 / 准生产 / 开发测试三类。实际工作中会不断冒出新的资源类型（如 Kafka、FTP 网关、算力节点）和新的环境（如 SIT、压测、灾备），不可能每次都改代码发版；而且改类型编码、删类型时，已经引用它的资源、模板、槽位、项目环境必须给出提示，并能一键跟着改。

**解法**：

```
字典配置页（资源类型 / 环境 两个 Tab）
  ├─ 资源类型：编码、显示名、编码前缀、说明、是否按 IP+端口判重
  │    └─ 字段定义：键、标签、字段类型（文本/长文本/数字/整数/IP/端口/下拉/开关）
  │                 必填、枚举选项、默认值、占位符、单位、是否 IP 字段、是否列表关键列、排序
  └─ 环境：编码、显示名、色调、说明、启用状态
        │  新增的类型 / 环境立即可被引用
        ▼
资源表单 / 环境模板条目 / 环境槽位 / 项目环境（下拉项与校验规则全部来自字典）
        │  修改编码或删除时
        ▼  409 CONFLICT + 引用明细 → 前端弹「已被引用」→ 一键同步 / 迁移式删除
```

**能力清单**：

- **增删改停**：资源类型与环境均支持新建、编辑、停用 / 启用、删除；内置项（`builtin`）允许改显示名与字段，但不建议改编码以免破坏存量数据。
- **字段级建模**：每个资源类型自带字段定义，支持 8 种字段类型；`SELECT` 可维护「值:显示名」枚举，`IP` / `PORT` / `INTEGER` / `NUMBER` 带格式与范围校验，`BOOLEAN` 渲染开关；可标记「列表关键列」，资源台账按类型动态展示关键属性列。
- **运行时动态校验**：后端按字段定义即时编译 Zod schema（进程内缓存，字典变更自动失效），未登记的类型直接 422 拒绝；编码前缀、IP 冲突判重规则（按 IP 还是 IP+端口）同样取自字典。
- **引用检查**：`GET /resource-types/:code/references` 与 `GET /environments/:code/references` 返回分组引用统计与样例 —— 资源类型 → 资源 / 环境模板条目 / 环境槽位；环境 → 资源 / 项目环境。
- **修改即提示 + 一键同步**：改编码且存在引用时返回 409 + `details.references`，前端展示引用清单；点「一键同步修改」后带 `sync: true` 重提，后端在同一事务里同步所有存量记录的编码并写审计。
- **字段重命名 / 删除的存量同步**：字段键改了或字段删了，保存后提示「还有 N 条资源使用旧字段」，点「一键同步字段」调用 `sync-attrs`，按 `keyRenames` 改名、`dropUnknown` 清理已删除字段的残留 attrs。
- **迁移式删除**：删除有引用的字典项返回 409 并要求选择 `migrateTo` 目标编码，后端把引用对象迁移到目标后再删除原字典项（资源类型迁移资源 / 模板条目 / 槽位；环境迁移资源 / 项目环境）。
- **停用即冻结**：停用后的类型 / 环境不允许再被新资源、新模板条目、新环境引用（422），但不影响存量数据。
- **项目环境标签实时同步**：项目环境只存环境编码，显示名由服务端按最新字典实时计算并随 DTO 返回（`environmentLabel`），改字典后项目里的标签立即生效；若项目里已有的环境名称与字典不一致，字典页会提示数量并提供**一键同步名称**（`syncNames`），保留原有「环境」后缀习惯。

**行为边界**：

| 场景 | 行为 |
| --- | --- |
| 改显示名 / 说明 / 字段定义 | 直接生效，无需同步 |
| 改显示名后项目环境名称不一致 | 返回 `pendingNameSync` → 一键同步名称（`syncNames: true`） |
| 改编码（无引用） | 直接生效 |
| 改编码（有引用） | 409 + 引用明细 → 需 `sync: true` 一键同步 |
| 删除（无引用） | 直接删除 |
| 删除（有引用） | 409 → 需指定 `migrateTo` 迁移式删除 |
| 停用 | 存量保留，新增引用被拒（422） |
| 未登记的类型 / 已停用环境 | 创建资源时 422 并提示「请先到字典配置中维护」 |
| 内置项 | 可改可停；`db:reset` 后由 `ensureBuiltinDict()` 自动重建 |

**冒烟验证**：`npm run smoke:dict`（52 项）覆盖内置字典初始化、自定义类型 + 自定义字段建资源并校验、编码改动的 409 → 一键同步、字段重命名与残留字段清理、环境自定义与同步、删除保护与迁移式删除、停用拦截、普通用户可写可删 / 只读用户写被拒 403，以及环境改名后项目环境标签实时同步 / 一键同步名称、校验失败原因、项目资源移出（主归属 ∪ 槽位引用）。

---

演示数据内置 3 个模板、3 个项目、6 套环境，部分槽位已自动填充。

---

## 二之四、槽位维护、引用提示与容量管理（本次新增）

### 1. 槽位可删除

项目环境 → 槽位表格每行提供**分配 / 解绑 / 删除**三个操作。删除前弹窗确认：若槽位已绑定资源，会提示将同时释放该槽位占用的容量；删除后槽位与绑定关系一并移除，资源本身不受影响。删除槽位属于环境日常维护，只需 `resource:write` 权限。

### 2. 引用资源时的三类提示

`POST /project-environments/:id/slots/:slotId/assign` 会先做一次「软校验」，把风险点作为 `warnings` 返回；存在提示且未确认时返回 **409 + `details.warnings`**，前端弹出清单，用户点「我已确认，继续绑定」后带 `acknowledge: true` 重提即可。

| 提示码 | 触发条件 | 说明 |
| --- | --- | --- |
| `CROSS_ENVIRONMENT` | 资源环境 ≠ 项目环境 | **允许**跨环境引用（如项目 A 的准生产环境引用开发环境资源），但必须显式确认 |
| `USED_BY_OTHER_PROJECT` | 资源已被其他项目的槽位引用 | **允许**跨项目共享，返回占用明细（项目 / 环境 / 槽位 / 占用量） |
| `CAPACITY_REQUIRED` | 资源设了容量但未填申请量 | 必须填写本槽位申请的容量 |
| `CAPACITY_EXCEEDED` | 申请量 > 剩余可用 | 硬校验，即使确认也会被拒 |

配套 `GET /project-environments/:id/slots/:slotId/candidates` 返回候选资源及上述标注（跨环境 / 已被占用 / 容量余量），候选列表**放开环境限制**并把同环境未占用的排在前面，跨环境、已被占用的靠后但仍可选。

### 3. 容量管理

- 资源上可设置 `capacityTotal` / `capacityUnit` / `capacityRemark`（资源表单「容量设置」开关），未设置则不参与容量核算。
- 槽位引用带容量的资源时**必须**填写申请量，`env_slots.demand_amount` 记录。
- 校验规则：`除本槽位外的占用 + 本次申请 ≤ 总容量`，否则 409 并给出「总容量 / 已占用 / 剩余」明细。其中「除本槽位外的占用」**按占用时间段核算**（见下文）：不重叠的错峰占用不累加，重叠的才求和。
- **调小容量**时校验现有占用：`新容量 < 已占用` → 409，返回缺口值与「哪个项目的哪套环境、哪个槽位占了多少」的明细；仍有占用时不允许取消容量设置。
- 解绑槽位即释放其占用的容量。
- **台账展示**：资源列表新增「容量」列（`已占用/总容量 单位` + 剩余 + 进度条，超 90% 转红）；资源详情展示容量明细与按项目聚合的占用去向。

#### 容量按时间段核算（错峰复用）

同一份容量可以被多个项目在**不同时间段**复用，因此「已占用」不能简单求和，而要取时间轴上的**峰值**：

| 场景 | 算法 | 例子 |
| --- | --- | --- |
| 时间段不重叠 | 取各段最大值，**不累加** | A 占 1–5 月 1000GB、B 占 6–10 月 1000GB → 峰值 1000GB，两者都能拿到满容量 |
| 时间段重叠 | 同一时刻**求和** | 上例中 C 再占 3–4 月 200GB → 该时段 1200GB > 1000GB，409 拒绝 |
| 未填时间段 | 视为**长期占用**（默认从今天起） | 与当前仍生效的占用全部重叠 |

实现落在 `apps/api/src/lib/capacity.ts`：把每条占用的起止时刻作为断点切分时间轴，逐段求和后取最大值，同时产出 `curve`（相邻等值区间已合并的占用曲线，可直接画走势）。子资源申请量属于「任何时刻都占用」的恒定基线，计入每一段。

资源详情的 `capacity` 因此有两个口径：

- `allocated` / `available`：不分时段的**合计**占用（台账列表仍用此口径，便于对账）；
- `peak` / `peakAvailable`：**按时间段的峰值**占用与剩余（判断「容量够不够」的正确口径），含 `startAt` / `endAt`（峰值时段）、`slotCount` / `items`（峰值时刻的占用明细）、`curve`（时间轴曲线）。

前端容量块在峰值口径之外额外提示：当合计占用 > 峰值占用时，说明这些占用分布在不同时间段、容量被**错峰复用**，按峰值核算并不冲突，避免被「合计 200%」误导。

### 4. 资源台账查看被引用情况

`GET /resources/:id` 在资源 DTO 之上返回：

- `capacity`：总容量 / 单位 / 已占用 / 剩余 / 占用率 / 说明
- `references`：被哪些项目、哪套项目环境（含环境类型）、哪个槽位引用，以及各自占用的容量
- `capacityByProject`：按项目聚合的「环境数 / 槽位数 / 占用量」

列表行的资源名称旁显示引用槽位数（🔗 N），点开详情即可看到完整引用清单。

**冒烟验证**：`npm run smoke:slot`（51 项）覆盖内置环境 DEV/PT/UAT/PROD 与标识色、槽位新增/删除、容量必填与超额、调小与取消容量的校验、跨项目占用提示与确认、跨环境引用提示与确认、台账引用明细、解绑释放容量。

---

## 二之五、资源层级、占用期限与标签跳转（本次新增）

### 1. 资源父子层级与容量同步

**业务问题**：NAS / GDS 这类资源往往是一台物理设备被多个业务分走一块配额，原先只能建多条互不相关的资源，配额与物理上限脱节。

**解法**：资源新增自引用 `resources.parent_id` 与 `resources.demand_amount`（向父资源申请的容量），一条链路贯穿到底：

| 规则 | 实现 |
| --- | --- |
| 同类型才能挂父子 | 创建 / 修改时校验 `子资源类型 === 父资源类型`，否则 400 并返回父资源类型 |
| 子资源必须有申请额度 | `demandAmount` 必填，且父资源必须设置了容量 |
| 申请不能超额 | `父资源槽位占用 + 其它子资源申请 + 本次申请 ≤ 父资源总容量`，否则 409 并返回 `slotAllocated / siblingDemand / available` |
| 子资源总容量 = 申请额度 | 子资源的 `capacity_total` 由申请额度派生，表单里不再单独填写，避免两套口径 |
| 属性继承 | 子资源未填的专属属性继承父资源（`{...parent.attrs, ...input.attrs}`），只需补充差异项 |
| 归属继承 | 未显式指定时继承父资源的项目 / 项目环境 / 机房 / 负责人 |
| 父容量下调 | 需 ≥ `槽位占用 + 子资源申请`，否则 409 并列出子资源明细 |
| 子申请量下调 | 需 ≥ 该子资源自身已被下级（其槽位 + 其子资源）占用的量 |
| 有子资源不可删 | 删除父资源返回 409 `reason: HAS_CHILDREN`，需先调整或删除子资源 |
| 防环 | 修改 `parentId` 时用 `descendantIds` 检测，禁止挂到自己的后代下 |

**容量口径统一**：`capacityAllocated = 槽位占用（slotAllocated） + 子资源申请（childAllocated）`，资源列表、详情、概览、槽位绑定的超额校验全部按这一口径计算，不再出现「列表已满但槽位还能绑」的错位。

### 2. 标签、项目、父子资源的点击跳转与预筛选

- 资源台账与概览里的**资源标签、项目名、父/子资源编码**都是可点击徽章：点标签 → `/resources?tag=xxx`，点项目 → `/projects/:id`，点父资源 / 子资源 → 详情内直接上下钻。
- 台账筛选条件**与 URL 双向同步**（`useSearchParams`），浏览器前进 / 后退、刷新、分享链接都能还原筛选结果。
- 支持的筛选参数：`tag`（逗号分隔多标签，按「**同时包含**」匹配）、`projectId`、`type`、`environment`、`status`、`rootOnly`（只看顶层资源）、`parentId`（只看某父资源的子资源）。
- 概览页的「资源标签」云、「按类型 / 环境 / 状态 / 项目」分布条、「只看顶层资源」均可点击直达台账并预先带上筛选条件。

### 3. 引用有效期：超期不释放、一键续期 / 释放、按时间看占用

**业务问题**：项目引用资源往往有期限（临时测试、季度评审），到期后既担心真实资源被误回收，又担心配额被长期占用却无人认领。

**解法**：`env_slots` 增加 `start_at` / `end_at` / `renew_count` / `updated_at`，服务端派生占用状态（见 `apps/api/src/lib/occupancy.ts`）：

| 状态 | 条件 | 页面表现 |
| --- | --- | --- |
| `ACTIVE` 占用中 | 已申请资源（**含开始时间在未来**），或未设结束时间，或结束时间未到 | 绿色 |
| `EXPIRED` 已超期 | 结束时间已过、**占用未释放** | 红色，并显示 `overdueDays` 超期天数 |

关键点：

- **提交即占用**：只要槽位申请了资源，无论开始时间是否已到，容量都立即扣除（不再有「未生效、不占容量」的状态）；开始时间在未来的占用会用 `notStarted` 字段单独标注「未开始 / 已预约」，提醒这属于提前预约。
- **过期不自动释放**：`end_at` 只是提醒用的软期限，容量仍然被占用，避免业务还在用却被系统静默回收；释放必须显式操作。
- **一键续期**：`POST …/slots/:slotId/renew` 支持三种方式——顺延 N 天（已超期时从今天重新起算）、指定新的结束日期、转为长期（`endAt: null`）；`renewCount` 自增，全程写审计（`targetType: SLOT_PERIOD`）。
- **一键释放**：`POST …/slots/:slotId/release` 立即清空绑定与期限、回收容量，槽位保留可再次分配。
- **期限可后调**：`PATCH …/slots/:slotId/period` 不改变绑定关系，只改起止时间。
- **可更换资源**：槽位已绑定资源时，`POST …/slots/:slotId/assign` 直接传入新资源即完成更换——旧资源的占用立即释放、新资源按同一时间段计入，未传起止时间则沿用原区间；审计里记录「资源由 A 更换为 B」。
- **页面提示**：项目页顶部与环境下都展示「N 个槽位已超期未释放」提醒条，槽位行标红并显示超期天数，续期入口就在行上。
- **按时间看占用与共用**：资源详情、环境下都有「占用时间轴」视图（纯 CSS 绝对定位的极简甘特图，无图表库依赖），绿色=占用中（含尚未开始的预约占用）、红色=已超期、紫框=区间重叠（并发共用），并带「今天」参考线；后端同时返回 `overlaps`（哪些区间互相重叠）与 `expiredCount`。

绑定槽位时可指定占用起止（结束时间留空即「不定期限的长期」），候选资源会按**时间区间是否重叠**追加 `PERIOD_OVERLAP` 提示——同一时间段重复占用需要显式确认。

**冒烟验证**：`npm run smoke:hierarchy`（101 项，需 `SMOKE_PASSWORD` 环境变量）覆盖父子资源创建与属性继承、超额申请、类型不一致、父容量下调、有子资源不可删、槽位 + 子资源两段容量汇总、超期状态与天数、时间重叠提示、续期 / 转长期 / 释放、资源与环境的占用时间轴、标签多值筛选与 `rootOnly` / `parentId` 层级筛选、概览层级与期限统计。

## 二之六、环境生产类型 / 标识色调色板 / 占用口径补充（本次新增）

### 1. 环境生产类型与标识色调色板

- **内置环境补齐「生产」**：`ENVIRONMENTS` 由 `DEV / PT / UAT` 扩展为 `DEV / PT / UAT / PROD`，`PROD` 为内置（`builtin = true`），默认标识色 `#dc2626`（红），默认排序在最后。历史上被标记为非内置的 `PROD` 会在启动自检时自动恢复为内置，不会重复插入。
- **标识色不再是固定枚举**：`environments` 表新增 `color`（`#rrggbb`），字典页的「标识色」改为**调色板控件**——14 个预设色块 + 原生取色器 + 十六进制输入 + RGB 三通道输入（自动互转，提交前统一规范化为 `#rrggbb`）。`tone` 字段保留，仅在这一列没有颜色时作为徽标兜底。
- **全站徽标跟随自定义色**：新增 `components/env-badge.tsx`，按颜色生成「圆点 + 浅色底 + 同色描边」的环境徽标（对高亮色自动压暗文字保证对比度），资源台账、资源详情、概览、项目详情、字典页统一使用。
- 迁移：`apps/api/drizzle/0005_env_color_prod.sql`（加列 + 回填内置色 + `INSERT OR IGNORE` 生产环境）。

### 2. 子资源只能补充非必填属性

- 建子资源时，**必填属性一律继承父资源且不可修改**：表单把它们渲染为只读并标注「继承」，提交载荷只包含非必填字段。
- 服务端同样强制：`create` 时按字典的 `required` 过滤掉子资源提交的必填键、用父资源值覆盖；`update` 时也把必填键回写成父资源值，直接调 API 也绕不过去。
- 子资源的 IP 等属性既然继承自父资源，就**不构成独立占用**：IP 冲突检测与概览的「IP 冲突」统计都会跳过子资源（否则父子同 IP 会互相误报）。
- 子资源不能直接改「总容量」（容量 = 向父资源申请的额度），传 `capacityTotal` 返回 400，应改 `demandAmount`。

### 3. 申请即占用；已绑定槽位可直接换资源

- 取消「未生效（PENDING）」状态：槽位一旦申请资源，**即使开始时间在未来也算占用**，容量立即扣除；未来开始的占用通过 `notStarted` 字段标注「未开始 / 已预约」，概览的已占用数也包含这部分。
- 只给日期（`YYYY-MM-DD`）时，开始时间按当天 `00:00` 解析、结束时间按当天 `23:59:59` 解析，避免「今天开始」被判成未来。
- 已绑定资源的槽位可**直接换资源**：ASSIGN 接口覆盖绑定，旧资源占用自动释放、新资源按同一时间段计入；未传起止时间时沿用原区间，审计记录「资源由 A 更换为 B」。前端按钮文案与弹窗按「分配 / 更换」自适应。

### 4. 父资源容量下限

- 父资源调小总容量时，服务端按「槽位占用 + 子资源申请」核算，**新容量小于已占用即 409**（`details.shortage` 给出缺口），调到恰好等于已占用（剩余 0）允许；取消容量设置仍要求无任何引用。
- 表单侧：总容量输入框的 `min` 直接设为当前已占用值，并在提示里实时显示「当前剩余」，提交前再做一次本地校验，避免让用户填完才看到 409。

**冒烟验证**：`npm run smoke:hierarchy` 已覆盖以上新增点（未来开始仍占用、更换资源后旧资源释放、容量下调到已占用以下被拒、子资源必填属性不可改、PROD 内置与标识色读写）。

---

## 二之七、下拉框显示健壮性与环境列表改版（本次新增）

### 1. 下拉框不再「显示不出值」

全站下拉框统一收敛到 `components/ui.tsx` 的 `Select`，改为**传 `options` 数组**（不再在各页面手拼 `<option>`），由组件统一兜住三类「空白下拉」：

| 成因 | 表现 | 组件内处理 |
| --- | --- | --- |
| 类型不一致 | state 是 number、`option value` 是字符串（或反之），匹配不上 | `value` 与 `option.value` 统一 `String()` 归一 |
| 值不在候选项里 | 环境/类型被停用、项目不在选项接口里、父资源不在候选分页内、动态属性选项被改过 | 自动补一个兜底项（默认文案「<值>（当前值）」，可由 `fallbackLabel` 自定义），保证 DOM 里一定存在对应 option |
| 选项异步到达 | React 只在受控 select 自身 props 变化时同步 `value`，选项后补齐时不会重新应用，`selectedIndex` 停在 -1 | 每次渲染后回写一次 `node.value` |

配套的数据侧修复：

- **字典请求不再在登录前发出（本次真正的根因）**：`DictProvider` 挂在登录态之外，首屏就会发 `/resource-types`、`/environments`、`/meta`，此时还没有令牌 → 401；而全局 `retry` 策略是「4xx 不重试」，登录成功后这些查询也不会重拉，于是**台账的「资源类型 / 环境」下拉永远只剩「全部」**（其余筛选用的是常量或页面级查询，所以正常）。现在三个字典查询都加 `enabled: Boolean(user)`，登录后由 `enabled` 翻转触发首次加载，并在登录/换账号时主动 `invalidateQueries(['dict'], ['meta'])`。
- **字典项下拉包含停用项**：`dict.typeOptions()` / `dict.envOptions()` 默认返回全部（含停用，标记 `disabled` 并加「已停用」后缀），编辑存量数据时不会空白，同时用户也无法主动选到停用项；筛选类下拉同样包含，避免 URL 带入停用编码时空白。字典未加载完时用内置常量兜底。
- **环境不再被强行纠正**：资源表单原来只要环境不在「启用列表」就改成第一个启用项，会把停用环境的存量资源悄悄改错；现在只有**字典里彻底不存在**该编码时才纠正。
- **父资源候选一定含当前父资源**：候选按类型分页查询，若当前父资源不在其中（跨类型 / 超出分页 / 仍在加载），单独拉一次详情补进选项；`isChild` 直接由 `parentId` 判定，不再因为候选未到位把子资源误判成顶层资源。
- 其他：动态属性下拉值失效时显示「不在候选项」；删除弹窗切换删除对象时清空「迁移到」，避免残留值；`Select` 默认把当前项完整文案挂到 `title`，窄列截断时可悬停看全。

### 2. 字典配置：环境列表去掉标识色列

- 环境表格**删除「标识色」列**（色块 + 十六进制文本都不再展示），颜色改为直接作为**编码列的底色**：`<EnvBadge code={e.code} label={e.code} />`，等宽字体 + 环境色背景，一眼就能对上资源台账里的徽标。
- 颜色依然在「新增 / 编辑环境」弹窗里用调色板维护（预设色块 / 取色器 / HEX / RGB 均可），只是列表不再单独占一列。

**验证**：`npm run typecheck`、`npm run build` 通过；后端未改动，五套冒烟（39 + 48 + 51 + 86）全绿（资源套件的 3 条「总数 = 16」断言依赖全新播种的库，库里若有手工新增数据会失败，属预期）。

---

## 二之八、台账筛选、超期汇总、环境可改与弹窗未保存提示（本次新增）

### 1. 资源台账：筛选以 URL 为唯一来源

原来「页面内 state」与「URL 参数」是两套状态：点标签加筛选走 URL、改下拉改 state，二者互相覆盖，于是出现「点 × 把全部筛选都清掉」。现在 **`query` 完全由 `useSearchParams` 反推**，任何筛选变化都只改 URL 上对应的那一个参数：

- **标签点击筛选**：类型 / 环境 / 状态列的徽标都可点击（再点一次取消该筛选），项目、标签、父子层级同理。
- **× 只移除自己**：「当前筛选」区为每个生效条件（关键字 / 类型 / 环境 / 状态 / 机房 / 项目 / 资源 / 父资源 / 层级 / 标签）生成独立标签，点 × 只删该参数，其余条件原样保留。
- **从子资源跳父资源**：点「父：XXX」走 `?id=<父资源 id>`（后端 `resourceQuerySchema` 新增 `id` 精确筛选），列表只显示父资源本身；「子资源 ×N」仍走 `?parentId=` 看该资源下的子资源。

### 2. 超期占用：概览页统一视图 + 项目内明细

- 概览页新增「**超期占用资源**」卡片：按项目归集（`overdueByProject`，超期最久的排前面，标注「N 个槽位超期 · 最长 X 天」），每条明细给出资源编码 / 名称 / 类型 / 环境 / 槽位 / 到期日 / 超期天数，可一键跳到项目或资源。「占用超期」统计卡也改为直达超期最久的那个项目。
- 项目详情页新增「**超期占用资源**」区块（`data.overdueCount > 0` 时展示）：列出该项目的超期资源、所属环境、槽位、超期天数与「去处理」入口；项目槽位引用 `projectSlotRefSchema` 现在冗余了 `resourceCode / resourceName / resourceType / environmentLabel / amount / renewCount`，前端无需二次请求。
- 超期依旧**不会自动释放**，两处都明确提示「超期不会自动释放，请续期或释放」。

### 3. 项目环境创建后可修改属性

- 环境卡片右上角新增「编辑」按钮，环境详情弹窗底部新增「编辑环境」按钮，打开后可改**名称 / 环境类型 / 运行状态 / 负责人 / 环境说明**（`PATCH /project-environments/:id`，此前只有创建接口在前端暴露）。
- 改属性不影响已有槽位与已分配资源；环境类型变更只影响标识展示。

### 4. 弹窗：ESC 关闭 + 未保存改动提示

`components/ui.tsx` 的 `Modal` 统一提供两种能力，所有表单弹窗（资源 / 项目 / 环境 / 模板 / 字典 / 导入）自动生效：

- **ESC = 点击关闭**：按 ESC 等同点右上角 ✕；若已弹出二次确认，再按一次 ESC 只关确认框。
- **有改动才提示**：弹窗容器通过捕获 `input / change / switch` 事件感知「是否动过」；关闭时若有改动，弹「**有未保存的修改**」→ 继续编辑 / 放弃修改 / 保存修改（传了 `onSave` 时才有「保存修改」，点击后直接落库）。没动过则直接关闭，不会打扰。
- **取消按钮同样受保护**：新增 `ModalCancelButton`，通过 `ModalGuardContext` 走弹窗自己的关闭流程，点「取消」与按 ESC 行为一致。

**验证**：`npm run typecheck`、`npm run build` 通过；后端冒烟 `smoke:hierarchy` 扩到 **101 项全绿**（新增 id 精确定位、概览超期明细、项目超期引用带资源编码、项目环境可改属性等断言）；另用无头浏览器做了 19 项 UI 实测（下拉选项、类型/环境/状态点击筛选、叠加与单独移除、父资源按 id 只显示 1 条、ESC 未保存确认、环境编辑弹窗、空改动直接关闭）全部通过。

---

## 二之九、环境卡片布局、模态栈、容量按时段与 Cookie 登录（本次新增）

### 1. 项目环境：编辑按钮不再压住运行状态

环境卡片原先把编辑按钮绝对定位在右上角，与「运行状态」徽标重叠。现改为：标题行整体在可点击区域之外，徽标与编辑按钮**同排流式排列**（徽标在左、按钮在右，`gap` 分隔），下方区域才是「进入槽位」的点击区，三者互不遮挡。

### 2. ESC 只关最上层弹窗（模态栈）

`components/ui.tsx` 的 `Modal` 维护一个模块级**模态栈**：弹窗打开时入栈、关闭时出栈，并按栈内位置设置 `z-index`（50 + 序号 × 10）。ESC 处理里只认栈顶：

```ts
if (modalStack[modalStack.length - 1] !== modalId) return; // 还有更晚打开的弹窗，放行
```

因此「环境槽位 → 分配资源」两层弹窗同时打开时，第一次 ESC 关掉后弹出的「分配资源」，第二次才关「环境槽位」——符合直觉，也避免一次 ESC 连带关掉底层页面。二次确认框（未保存改动）仍优先消费 ESC。

### 3. 容量按时间段核算

见上文「容量按时间段核算（错峰复用）」。

### 4. Cookie 登录：刷新页面不再掉登录态

- 后端：`@fastify/cookie` 注册后，登录 / 续期时把刷新令牌写入 `dw_refresh`（`httpOnly` + `sameSite=lax` + 生产 `secure` + `path=/`），登出时清除；`POST /auth/refresh` 优先读请求体里的令牌、**缺失时回落 Cookie**，无请求体时不再依赖 body 也能续期（`body` schema 用 `nullish`，因为 Fastify 在无请求体时传入的是 `null` 而非 `undefined`）。
- 前端：所有请求带 `credentials: 'include'`；访问令牌仍**只存内存**，`AuthProvider` 挂载时先 `restoreSession()`（凭 Cookie 静默换访问令牌）再把 `ready` 置为 true，因此刷新页面、新开标签页都能直接恢复登录，且脚本读不到刷新令牌。

### 5. 验证

- `npm run typecheck`、`npm run build` 通过。
- 后端冒烟新增 `npm run smoke:capacity`（30 项）覆盖错峰复用、重叠求和被拒、空档期可占用、长期占用重叠、峰值时段与明细、占用曲线；六套合计 **306 项全绿**。
- `node scripts/ui-check.mjs`（无头 Chrome + CDP）17 项全绿：环境卡片按钮与徽标无重叠、两层弹窗的 ESC 关闭顺序、资源详情展示「按时间段峰值」、刷新页面保持登录且 Cookie 对 JS 不可见。

---

## 二之十、引用明细带项目名、保存后不提示未保存、时间轴与台账口径对齐（本次新增）

### 1. 字典引用明细带项目名

环境 / 资源类型的「引用明细」原本只写环境名（如「开发环境」），重名环境分不清属于哪个项目。现在引用样例统一写成 **`项目名 · 环境名 · 槽位名`**：

- `GET /environments/:code/references` 的「项目环境」分组：`信贷风控数据集市 · 开发环境`
- `GET /resource-types/:code/references` 的「项目环境槽位」分组：`客户画像平台 · 生产环境 · ETL 共享存储`
- 无归属项目的显示为「未归属项目 · …」。

### 2. 保存成功后不再提示「有未保存的修改」

`Modal` 新增 `dirtyResetKey`：该值变化时即视为「内容已落库」，清除未保存标记与二次确认框。槽位**分配 / 更换资源**、**续期**这类「先填后保存」的弹窗在 `onSuccess` 里自增该值，因此保存完成后点 ✕ / ESC 直接关闭，不会再弹多余的未保存提示；未保存就关闭时仍照常提示。

### 3. 占用时间轴悬浮信息补全

资源详情时间轴上每段占用的 `title` 由「环境｜槽位｜时段」扩展为 **`项目名 · 环境名 · 槽位「X」 · 占用 N GB · 起 → 止 ·（尚未开始 / 已超期 N 天）`**，鼠标悬浮即可确认这段占用属于哪个项目、占了多少容量。

### 4. 台账容量列与详情峰值同口径

资源列表 DTO 新增 `capacityPeak` / `capacityPeakAvailable`，由 `peakAmountByResources()` 批量按时间段计算（只查设置了容量的资源）。台账容量列改为展示峰值口径，并在「合计占用 > 峰值」时追加 `错峰复用 · 峰值 N` 的紫色提示与悬浮说明，避免被「合计 200%」误导；进度条与超 90% 转红也改为按峰值计算。资源详情保持 `capacity.peak` 不变，两者同一算法（`lib/capacity.ts` 的 `peakOf`）。

### 5. 验证

- `npm run typecheck`、`npm run build` 通过。
- `smoke:capacity` 扩到 **44 项**（新增台账与详情口径一致、字典环境引用带项目名、资源类型槽位引用带项目名、清理后无残留），六套合计 **320 项全绿**（37/39/48/51/44/101）。
- `npm run ui:check` 扩到 **32 项全绿**：分配资源保存后关闭不再提示未保存、台账容量列数值 = 详情峰值、时间轴 tooltip 首段为项目名、字典引用明细带项目名。

---

## 二之十一、三角色模型：管理员 / 普通用户 / 只读用户（本次新增）

### 1. 角色与权限矩阵

| 角色 | 权限 |
| --- | --- |
| `ADMIN` 管理员 | `resource:read` `resource:write` `resource:delete` `user:manage` `audit:read` |
| `USER` 普通用户 | `resource:read` `resource:write` `resource:delete` —— 除「用户管理」「变更审计」外与管理员**完全一致** |
| `READONLY` 只读用户 | `resource:read` —— 可见范围与普通用户相同（概览 / 台账 / 项目 / 模板 / 字典都能看、可导出），但没有任何写入口 |

- 契约在 `packages/shared/src/enums.ts` 的 `ROLES` / `ROLE_PERMISSIONS`，前后端共用；`userSchema` / `createUserSchema` / `updateUserSchema` 的 `role` 枚举同步为三项。
- 前端 `canDo('resource:write' | 'resource:delete' | 'user:manage' | 'audit:read')` 决定入口显隐：只读用户看不到「新增资源 / 批量导入 / 编辑 / 删除 / 新建项目 / 分配资源」，也看不到「用户管理 / 变更审计」菜单。后端 `authorize()` 独立拦截，越权请求一律 403（双重校验）。
- 路由级兜底：`RequireAdmin` 守卫同时护住 `/users` 与 `/audit`，非管理员直接访问 URL 也只会看到「无权访问」。

### 2. 权限修正

- **审计接口此前只校验登录**（`preHandler: app.authenticate`），普通用户绕过菜单直接请求 `GET /audit-logs` 也能拿到全量变更记录。现补上 `authorize('audit:read')`，普通用户与只读用户均返回 403。
- 普通用户原先缺少 `resource:delete`，与「除审计与用户管理外同管理员」不符；现已补上，删除资源 / 项目 / 字典项均与管理员一致。

### 3. 老库兼容与种子账号

- 启动时 `normalizeLegacyRoles()` 幂等归一：`VIEWER → READONLY`、其余未知值 → `USER`，改动条数打印在启动日志。
- 种子数据现在创建三个演示账号：`admin`（口令取自 `.env`）、`user` / `User@12345`、`readonly` / `Readonly@12345`；登录页的三张演示账号卡片与之对应。

### 4. 验证

- `npm run typecheck`、`npm run build` 通过。
- 七套接口冒烟 **384 项全绿**：资源 52 / 项目 45 / 字典 52 / 槽位 51 / 容量时段 44 / 层级期限 101 / 用户与角色 39。其中 `smoke:user` 新增角色矩阵：只读用户读资源 / 项目 / 字典均 200，写 / 删 / 建项目 / 用户管理 / 审计均 403；普通用户删除资源与项目均 200，审计与用户管理 403；种子数据里存在 `readonly` 账号；未定义角色（如 `VIEWER`）仍 422。
- `npm run ui:check` 扩到 **71 项全绿**：角色下拉三项、只读账号登录后顶栏显示「只读用户」、菜单无「用户管理 / 变更审计」、台账 16 行可见但无「新增资源 / 批量导入」、行内无编辑删除、项目页无「新建项目」；普通用户登录后可见其余全部菜单、能看到「新增资源 / 批量导入 / 删除」。

---

## 三、快速开始

```bash
# 1) 安装依赖（已配置 npmmirror 镜像）
npm install

# 2) 复制并按需修改环境变量
cp .env.example .env          # Windows: copy .env.example .env

# 3) 建库 + 迁移 + 写入演示数据（16 条资源（含 2 条子资源）+ 5 种资源类型 + 4 种环境 + 3 个模板 + 3 个项目 7 套环境 + 3 个账号）
npm run db:seed

# 4) 启动前后端（一条命令）
npm run dev
#   API   http://localhost:8787    OpenAPI 文档 http://localhost:8787/docs
#   Web   http://localhost:5173

# 5) 接口冒烟测试（需先启动 API）：资源 52 + 项目环境 45 + 字典配置 52 + 槽位与容量 51 + 容量按时段 44 + 层级与期限 101 + 用户与改密 39 = 384 项
npm run smoke

# 也可单跑某一套
npm run smoke:resource
npm run smoke:project
npm run smoke:dict
npm run smoke:slot
npm run smoke:capacity                                  # 容量按时间段核算
SMOKE_PASSWORD=<管理员口令> npm run smoke:hierarchy   # 未提供口令时会打印「跳过」并退出 0
npm run smoke:user                                      # 三角色权限矩阵 + 重置密码

# 6) UI 实测（需先启动 Web，用无头 Chrome 走 CDP）：环境卡片布局 / ESC 模态栈 / 容量峰值展示 / Cookie 续期 / 三角色与重置密码 / 只读用户无写入口
npm run ui:check
```

其他常用命令：

```bash
npm run typecheck       # 全量类型检查（shared / api / web）
npm run build           # 依次构建 shared → api → web
npm run start           # 运行编译后的 API（node dist/server.js）
npm run db:generate     # 修改 db/schema.ts 后生成迁移
npm run db:migrate      # 执行迁移（生产推荐显式执行）
npm run db:reset        # 清空业务数据（保留表结构）
```

### 演示账号

角色分三级：

| 账号 | 角色 | 权限 |
| --- | --- | --- |
| `admin` | 管理员（`ADMIN`） | 全部权限：读写 + 删除 + 用户管理 + 变更审计 |
| `user` | 普通用户（`USER`） | 除「用户管理」「变更审计」外与管理员一致（可增删改） |
| `readonly` | 只读用户（`READONLY`） | 可见范围与普通用户相同，但只能查看（不能增删改） |

权限矩阵（`packages/shared/src/enums.ts` 的 `ROLE_PERMISSIONS`，前后端共用）：

| 权限 | 管理员 | 普通用户 | 只读用户 |
| --- | --- | --- | --- |
| `resource:read`（台账 / 项目 / 字典 / 概览 / 导出） | ✅ | ✅ | ✅ |
| `resource:write`（新建 / 编辑 / 分配 / 续期 / 导入） | ✅ | ✅ | — |
| `resource:delete`（删除资源 / 项目 / 字典项） | ✅ | ✅ | — |
| `user:manage`（用户管理、重置密码） | ✅ | — | — |
| `audit:read`（变更审计） | ✅ | — | — |

口令：`admin` 的初始口令取自 `.env` 的 `BOOTSTRAP_ADMIN_PASSWORD`（首次启动播种时打印在控制台）；`user` 为 `User@12345`，`readonly` 为 `Readonly@12345`（见 `apps/api/src/modules/auth/service.ts` 的播种逻辑）。登录后可在「用户管理」中改角色、停用账号，或由管理员**重置密码**。

> 早期的 `OPERATOR` / `VIEWER` 已废弃：服务启动时会把老库里的 `VIEWER` 归为 `READONLY`、其余旧值归为 `USER`（幂等，改动条数会打印在启动日志里），新建用户也不再接受旧角色值。
> 权限是**前后端双重校验**：前端按 `canDo()` 隐藏入口（只读用户看不到「新增资源 / 批量导入 / 编辑 / 删除」，也看不到「用户管理 / 变更审计」菜单），后端按 `authorize()` 拦截（越权请求返回 403）。

### 密码重置

管理员在「用户管理」每行点「重置密码」→ 二次确认（提示会强制该账号下线）→ 服务端生成 **12 位随机口令**（排除 `0/O/1/l/I` 等易混淆字符），弹窗展示并支持一键复制。

- 新口令只在本次响应里返回一次，数据库仅存 scrypt 哈希，审计日志只记「已重置（不记录明文）」。
- 重置同时吊销该账号全部刷新令牌，已登录的会话需要重新登录。
- 普通用户与只读用户没有 `user:manage` 权限，调用 `POST /users/:id/reset-password` 返回 403。

---

## 四、API 清单（`/api/v1`，详见 `/docs`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 登录，返回访问令牌 + 刷新令牌 | 公开（限流 10 次/分） |
| POST | `/auth/refresh` | 刷新令牌轮换 | 公开 |
| POST | `/auth/logout` | 吊销刷新令牌 | 登录 |
| GET | `/auth/me` | 当前用户信息 | 登录 |
| GET | `/resources` | 分页列表（关键字/类型/环境/状态/机房/标签（逗号多值，同时包含）/所属项目/未标注/`rootOnly`/`parentId` + 排序） | 登录 |
| GET | `/resources/:id` | 资源详情（含容量明细：槽位占用 + 子资源申请、引用明细（含占用起止与超期天数）、子资源列表、祖先链） | 登录 |
| GET | `/resources/tags` | 标签及资源数量（概览标签云 / 台账标签筛选） | 登录 |
| GET | `/resources/:id/children` | 直接子资源列表 | 登录 |
| GET | `/resources/:id/timeline` | 资源占用时间轴（区间、共用重叠、超期数量、时间范围） | 登录 |
| POST | `/resources` | 新增（校验专属属性 + IP 冲突，可直接指定项目；传 `parentId` + `demandAmount` 即为子资源） | `resource:write` |
| PATCH | `/resources/:id` | 更新（字段级审计，可改项目归属） | `resource:write` |
| POST | `/resources/bulk-assign` | 资源批量标注项目（一次最多 200 条） | `resource:write` |
| DELETE | `/resources/:id` | 删除 | `resource:delete`（仅管理员） |
| GET | `/resources/check-ip` | IP 占用检测 | 登录 |
| POST | `/resources/import` | CSV 批量导入（skip / overwrite） | `resource:write` |
| GET | `/resources/export` | CSV 导出（带 BOM，Excel 不乱码） | 登录 |
| GET | `/resources/:id/audit` | 单资源变更记录 | 登录 |
| GET | `/stats/overview` | 概览统计（类型/环境/状态/机房/NAS 容量/IP 冲突/项目维度） | 登录 |
| GET | `/audit-logs` | 全局审计日志（按动作/对象/操作人筛选） | 登录 |
| GET | `/meta` | 枚举与动态表单元数据（类型 / 环境 / 字段定义全部来自字典） | 登录 |
| GET | `/resource-types` · POST `/resource-types` | 资源类型字典列表（含引用数）/ 新建（含字段定义） | 登录 / `resource:write` |
| GET | `/resource-types/options` | 资源类型下拉选项（仅启用项） | 登录 |
| GET | `/resource-types/:code` | 类型详情 + 字段定义 | 登录 |
| GET | `/resource-types/:code/references` | 引用统计（资源 / 模板条目 / 槽位 + 样例） | 登录 |
| PATCH | `/resource-types/:code` | 更新；改编码有引用时 409，带 `sync: true` 一键同步 | `resource:write` |
| POST | `/resource-types/:code/sync-attrs` | 字段重命名 / 清理残留 attrs 的存量同步 | `resource:write` |
| DELETE | `/resource-types/:code` | 删除；有引用时 409，带 `migrateTo` 迁移式删除 | `resource:delete` |
| GET | `/environments` · POST `/environments` | 环境字典列表（含引用数）/ 新建 | 登录 / `resource:write` |
| GET | `/environments/options` | 环境下拉选项（仅启用项） | 登录 |
| GET | `/environments/:code/references` | 引用统计（资源 / 项目环境 + 样例） | 登录 |
| PATCH | `/environments/:code` | 更新（含 `color: "#rrggbb"` 标识色）；改编码有引用时 409，带 `sync: true` 一键同步 | `resource:write` |
| DELETE | `/environments/:code` | 删除；有引用时 409，带 `migrateTo` 迁移式删除 | `resource:delete` |
| GET | `/projects` · POST `/projects` | 项目列表（含环境数与资源数）/ 新建 | 登录 / `resource:write` |
| GET | `/projects/options` | 项目下拉选项 | 登录 |
| GET | `/projects/:id` | 项目详情（环境列表 + 资源类型分布） | 登录 |
| PATCH `/projects/:id` · DELETE `/projects/:id` | 更新 / 删除（有环境时禁止删除） | `resource:write` / `resource:delete` |
| GET | `/projects/:id/environments` | 项目的环境列表 | 登录 |
| POST | `/projects/:id/environments` | 新建环境，可带 `templateId` 套用模板自动生成槽位 | `resource:write` |
| GET | `/project-environments/:id` | 环境详情（含槽位与已分配资源） | 登录 |
| PATCH `/project-environments/:id` · DELETE | 更新 / 删除环境 | `resource:write` / `resource:delete` |
| POST | `/project-environments/:id/slots` | 手动追加槽位 | `resource:write` |
| GET | `/project-environments/:id/slots/:slotId/candidates` | 槽位候选资源（含跨环境/已被占用/容量余量/**时间区间重叠**标注，可传 `startAt`/`endAt`） | 登录 |
| POST | `/project-environments/:id/slots/:slotId/assign` | 槽位绑定资源：类型必须一致；跨环境/跨项目/时间重叠返回 409 + 提示，`acknowledge: true` 确认后放行；带容量资源须传 `amount`；`startAt`/`endAt` 为占用期限（`endAt: null` 即长期） | `resource:write` |
| POST | `/project-environments/:id/slots/:slotId/renew` | 续期：`days` 顺延 / `endAt` 指定结束日 / `endAt: null` 转长期 | `resource:write` |
| POST | `/project-environments/:id/slots/:slotId/release` | 一键释放占用（回收容量，槽位保留） | `resource:write` |
| PATCH | `/project-environments/:id/slots/:slotId/period` | 调整占用起止（不改绑定关系） | `resource:write` |
| GET | `/project-environments/:id/timeline` | 环境占用时间轴（Gantt 视图数据） | 登录 |
| DELETE | `/project-environments/:id/slots/:slotId/assign` | 槽位解绑资源（释放占用容量） | `resource:write` |
| DELETE | `/project-environments/:id/slots/:slotId` | 删除槽位 | `resource:write` |
| POST | `/project-environments/:id/apply-template` | 对已有环境追加套用模板 | `resource:write` |
| GET | `/env-templates` · POST `/env-templates` | 模板列表 / 新建（自由组合资源类型） | 登录 / `resource:write` |
| GET | `/env-templates/options` | 模板下拉选项 | 登录 |
| GET `/env-templates/:id` · PATCH · DELETE | 模板详情 / 更新 / 删除（被引用时禁止删除） | 登录 / `resource:write` / `resource:delete` |
| POST | `/env-templates/:id/clone` | 克隆模板 | `resource:write` |
| POST | `/env-templates/:id/instantiate` | 一步到位：基于模板在项目下创建环境 | `resource:write` |
| POST | `/projects/:id/resources/:resourceId/detach` | 资源移出项目；`includeSlots=true` 时一并解除该项目下的槽位引用 | `resource:write` |
| GET | `/users` · POST `/users` · PATCH `/users/:id` · POST `/users/:id/reset-password` | 用户管理（角色 `ADMIN` / `USER` / `READONLY`） | `user:manage`（管理员） |
| POST | `/users/:id/reset-password` | 重置密码，返回一次性明文口令并吊销该用户全部刷新令牌 | `user:manage`（管理员） |
| GET | `/health` · `/ready` | 存活 / 就绪探针（含数据库连通性） | 公开 |

统一错误结构：

```json
{ "error": { "code": "CONFLICT", "message": "IP 10.10.1.11 已被资源 BS-SRV-0001（调度主节点-01）占用", "requestId": "…" } }
```

校验失败会给出**具体字段原因**（不再只说"校验未通过"），前端同时把它渲染成错误列表并回填到对应控件：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "资源属性校验失败：hostname：必填；mgmtIp：IP 地址格式不正确 等 5 项",
    "details": [
      { "field": "attrs.hostname", "message": "必填" },
      { "field": "attrs.mgmtIp", "message": "IP 地址格式不正确" }
    ],
    "requestId": "…"
  }
}
```

字典冲突（已被引用）会额外携带 `details.references`，前端据此弹「一键同步修改」：

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "资源类型「Kafka 集群」已被 3 个对象引用，修改编码需同步更新这些引用",
    "details": {
      "needSync": true,
      "references": {
        "code": "KAFKA", "label": "Kafka 集群", "kind": "RESOURCE_TYPE", "total": 3,
        "groups": [
          { "entity": "RESOURCE", "label": "资源", "count": 2, "samples": [{ "id": "12", "name": "KFK-0001 生产 Kafka" }] },
          { "entity": "TEMPLATE_ITEM", "label": "环境模板条目", "count": 1, "samples": [{ "id": "5", "name": "标准数仓项目-生产 · Kafka×1" }] }
        ]
      }
    },
    "requestId": "…"
  }
}
```

---

## 五、前端功能

- **登录页**：演示账号一键填充、错误提示映射中文文案
- **资源概览**：资源总数、各环境资源数、NAS 使用率、IP 冲突告警；类型/环境/状态/**项目**分布；**占用超期卡片（已占用 / 7 天内到期 / 长期）**、**资源标签云**、**层级统计（顶层 / 子资源）**、最近更新；所有分布条、卡片、标签均可点击**带着筛选条件跳到台账**
- **资源台账**：关键字防抖搜索、多维筛选（所属项目 / 未标注 / 标签多选 / 仅看顶层（不含子资源）/ 父资源）、分页、按类型展示关键属性列、**容量列（已占用/总容量 + 其中子资源占用量 + 进度条，超 90% 转红）**、**引用数标记**、详情抽屉（属性 + 变更记录 + 容量明细（槽位 / 子资源两段）+ 子资源列表可下钻 + 祖先面包屑 + **占用时间轴** + 被引用清单（含占用起止与超期天数））、新建/编辑/删除（按角色显隐）；勾选后可**批量标注项目**；筛选条件与 URL 同步，标签 / 项目 / 父子资源均为可点击徽章
- **需求项目**：项目列表（环境数、资源数、状态）、新建/编辑/删除；项目详情页含**超期提醒条**、环境卡片（填充率进度、环境标签取自字典）、槽位表格（**占用起止（未来开始标注「未开始 / 已预约」）/ 占用状态 / 超期天数**，行上**续期**、**释放**与**更换资源**）、**环境占用时间轴** Tab、追加套用模板、项目资源清单（带「主归属 / 槽位引用」来源标记，移出时可**仅取消标注**或**解除槽位并移出**）
- **环境模板**：模板列表（资源组合 chips、槽位数、被引用次数）；模板编辑器可**自由增删资源类型条目**（类型 + 槽位名 + 数量 + 是否必需），支持克隆与「套用模板直接建环境」
- **动态表单**：切换资源类型即切换专属字段（字段定义来自字典）；IP 字段实时占用预检；**容量设置开关（总容量 / 单位 / 说明）**；**父资源选择 + 申请容量**（选定父资源后隐藏容量区；必填属性渲染为只读并标注「继承」，只能填非必填项）；编辑顶层资源时总容量的最小值锁定为「已占用」，实时显示剩余容量，避免调出负剩余；后端字段级错误回填到对应控件，弹窗顶部同时列出「字段：原因」明细
- **字典配置**：资源类型与环境两个 Tab，支持新建 / 编辑 / 停用 / 删除；资源类型可增删排序字段、配置枚举选项与「列表关键列」；改编码或删除被引用时弹出引用清单，支持**一键同步修改**与**迁移式删除**；字段改名后提示存量待同步并提供**一键同步字段**；环境改名后提示项目环境名称不一致并提供**一键同步名称**；环境的**标识色使用调色板控件**（预设色块 / 取色器 / 十六进制 / RGB 三通道），保存后全站环境徽标即时变色；环境列表不再单列「标识色」，颜色直接作为编码单元格的底色；所有开关均带可见的功能名称（必填 / IP 字段 / 列表关键列 / 按 IP+端口判重 / 启用 / 是否必需）
- **字典即时生效**：字典变更写入后前端 `DictProvider` 自动刷新，资源台账、资源表单、模板编辑器、项目环境的下拉与校验立刻使用新类型 / 新环境
- **批量导入**：粘贴 CSV，选择 skip/overwrite 策略，逐行返回结果（成功/更新/跳过/失败行号与原因）
- **变更审计**：按动作、对象类型、操作人筛选，展示字段级 from → to
- **用户管理**：新建账号、改角色（管理员 / 普通用户 / 只读用户）、启停、重置密码（管理员可见）
- **下拉框健壮性**：全站下拉统一用 `ui.tsx` 的 `Select`（传 `options` 而非手写 `option`），自动处理 number/string 类型归一、值不在候选项时补「当前值」兜底项、选项异步到达后回写 DOM，停用字典项也照常回显（disabled），窄列截断可悬停看全；字典未到位时下拉先用内置常量渲染，不会出现只剩「全部」的空下拉
- **字典加载时机**：字典查询只在登录后发起（`enabled: Boolean(user)`），登录后与换账号时主动失效重拉
- **请求层**：401 自动静默刷新并重放请求，刷新失败统一跳登录；4xx 不重试、5xx 最多重试 2 次；网络失败提示离线

---

## 六、生产化落地建议（Demo 之外的下一步）

1. **数据库**：`DB_DRIVER=postgres` + `DATABASE_URL` 指向 PostgreSQL，安装 `pg` 后把 `db/index.ts` 的驱动换成 `drizzle-orm/node-postgres` 即可，业务代码零改动；同步配置连接池与只读副本。
2. **令牌与身份**：刷新令牌已改为服务端下发 `httpOnly; SameSite=Lax`（生产 `Secure`）Cookie，前端不接触；后续可接入 OIDC / LDAP / 企业微信统一身份，并把密码重置改为「邮件/短信一次性链接」。
3. **可观测性**：Pino 结构化日志接入 ELK / Loki；`/health`、`/ready` 接入 K8s 探针；补充 Prometheus 指标（请求耗时 P95、限流命中、冲突校验失败率）。
4. **接入治理**：与 CMDB / 监控 / 调度平台做双向同步（Webhook 或定时对账），避免台账漂移；NAS 容量与 GDS 存活可通过后台任务定时采集（任务需幂等 + 重试 + 死信）。
5. **数据保护**：敏感字段加密存储，数据库定时备份与恢复演练；导出文件加水印与审批流。
6. **测试补齐**：单测 mock 仓储层保持快速，集成测试用真实数据库 + 事务回滚；把 `scripts/smoke-test.mjs`、`scripts/smoke-project.mjs`、`scripts/smoke-dict.mjs`、`scripts/smoke-slot-capacity.mjs`、`scripts/smoke-capacity-period.mjs`、`scripts/smoke-hierarchy-period.mjs`、`scripts/smoke-user.mjs` 接入 CI（后两者需注入管理员口令环境变量）。
7. **项目环境编排**：模板只是「资源需求清单」，下一步可接 terraform / Ansible / K8s Operator 做真实发放；环境状态（规划中→搭建中→运行中）可接入审批流与工单系统。
8. **字典治理**：字典变更可加审批流与变更窗口；引用同步在大表上建议改为异步任务 + 进度查询（当前为同步事务，千级以内数据毫秒级完成）；字典可增加「生效范围 / 租户」维度以支持多团队各自维护。

## 七、已知限制

- Demo 为单进程部署，未做集群与分布式锁；IP 唯一性依赖数据库事务与查询，极高并发下建议加唯一索引或分布式锁。
- 访问令牌只存内存；刷新令牌经 httpOnly Cookie 下发，刷新页面可静默续期，但**关闭浏览器不会保留会话之外的额外设备绑定**，多设备登录互不感知（可按需在 `refresh_tokens` 上按 UA/IP 做设备管理与强制下线）。
- SQLite 适合单机与演示；多实例部署必须切换 PostgreSQL。
- SQLite 的 `ALTER TABLE ADD COLUMN` 不携带 `ON DELETE SET NULL`，删除项目/环境时由服务层显式解除资源引用（切 PG 后由外键级联即可）。
- 模板「是否必需」目前仅作展示，未做环境就绪度强校验（可按需把「必需槽位全部分配」作为环境置为运行中的前置条件）。
- 前端未做国际化与移动端适配；构建产物单包 540 KB，可按需 `manualChunks` 拆包。
- 字典的引用同步与迁移式删除在**单个事务**内完成，适合千级以内数据量；更大规模需改为分批异步任务并提供进度查询。
- 资源类型字段的 `SELECT` 选项变更不会自动改写存量资源里已存的旧选项值（仅改名 / 删字段会走 `sync-attrs`），如需强一致可在保存时一并提交 `keyRenames`。
- 内置资源类型（`builtin`）的编码允许修改并同步，但不建议：外部系统若按编码集成会受影响。
- 资源层级目前只支持一层「父 → 子」的直观用法（模型上允许多层，`ancestors` / `descendantIds` 已做环检测），但统计口径（如 NAS 物理容量）只按顶层资源汇总，多层嵌套时需自定义汇总规则。
- 占用期限只做「提示不释放」：到期不会触发通知或自动回收，接入企业微信 / 邮件提醒需另配定时任务（可基于 `slotPeriod.expiringSoonCount` 的同一套判定逻辑）。
- 时间轴为极简甘特图（绝对定位 + 百分比，无图表库），区间超过约 200 条时建议分页或按资源筛选后再看；时间段粒度到天，不含时分。
- 子资源只继承父资源的必填属性（含 IP、端口），因此**不能拥有独立 IP**；如果业务上需要「同类型但独立地址」的实例，应建成顶层资源而不是子资源。子资源也因此不参与 IP 冲突检测与 IP 冲突统计。
- 开始时间在未来的占用虽然计入容量，但不会自动「到期生效」或触发提醒；如需按生效日通知，可在 `notStarted` 上叠加定时任务。
