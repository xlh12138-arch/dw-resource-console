# 数据仓库资源控制台离线 Docker 部署

## 1. 先理解几个名词

- **镜像**：已经打包好的应用和全部依赖，内网机器不需要再执行 `npm install`。
- **容器**：镜像运行起来的实例。本项目有 `web`、`api` 和一次性的 `db-init`。
- **PostgreSQL / 华为 DWS**：数据库继续使用内网数据库，不放进应用容器。

推荐流程是：在能联网的电脑上构建镜像，把镜像导出成 `.tar` 文件，再复制到内网服务器导入并运行。

## 2. 两台机器分别需要什么

### 构建机

- Windows 或 Linux。
- 已安装 Docker Desktop 或 Docker Engine。
- 能执行 `docker build`、`docker save`。

### 内网运行机

- Linux x86_64（最常见的服务器架构）。
- 已离线安装 Docker Engine 和 Docker Compose 插件。
- 能访问内网 PostgreSQL 兼容数据库，例如华为 DWS。

如果内网机器还没有 Docker，需要先从 Docker 官方离线包或公司软件源安装 Docker Engine。这个问题与 Node/npm 依赖无关，Docker 本身必须先存在。

## 3. 配置数据库、schema、建表与导入

### 3.1 配置数据库连接和 schema

`.env` 中至少配置：

```env
DB_DRIVER=postgres
DATABASE_URL=postgres://用户名:密码@dws地址:8000/数据库名
DB_SCHEMA=dw_console
DB_CREATE_SCHEMA=true
```

- `DB_SCHEMA` 是应用表所在 schema，只能使用小写字母、数字和下划线。
- 如果 DBA 已经创建 schema，并且应用账号没有建 schema 权限，请设置
  `DB_CREATE_SCHEMA=false`。
- 所有业务表、外键、索引以及应用查询都会使用这个 schema。

华为 DWS 是 PostgreSQL 兼容数据库，但不同版本对 DDL 或类型支持的细节可能不同。
建议先在 DWS 测试库和独立测试 schema 中开启 `DB_CREATE_TABLES=true` 验证一次建表，
再迁移正式环境。

### 3.2 三个部署开关

`db-init` 容器在 API 启动前执行一次，由以下配置决定行为：

| 场景 | DB_CREATE_TABLES | DB_IMPORT_DATA |
| --- | :---: | :---: |
| 表和数据都已经准备好 | `false` | `false` |
| 新 schema，只需要建表 | `true` | `false` |
| 表已存在，只导入数据 | `false` | `true` |
| 新 schema，建表后导入数据 | `true` | `true` |

`AUTO_MIGRATE` 在 Docker 部署中保持 `false`。建表由显式的 `db-init` 流程执行，
避免 API 启动时隐式修改数据库。

只建表、不导入业务数据时，API 首次启动仍会自动补齐系统内置资源类型、环境字典和
初始管理员账号；这些是应用运行所需的基础数据，不会覆盖已经存在的数据。

### 3.3 建表

新环境设置：

```env
DB_CREATE_TABLES=true
```

`db-init` 会：

1. 按 `DB_CREATE_SCHEMA` 决定是否创建 schema。
2. 只执行尚未执行过的版本化 SQL。
3. 在目标 schema 内创建/升级表、索引和外键。
4. 记录迁移历史，后续重启不会重复建表。

### 3.4 导入数据

推荐把数据导出为普通 SQL：

```bash
pg_dump --data-only --no-owner --no-privileges \
  -h 原数据库地址 -U 用户名 -d 原数据库名 \
  -f dw_console_data.sql
```

把文件放入部署目录的 `import/`，然后配置：

```env
DB_IMPORT_DATA=true
DB_IMPORT_FILE=/import/dw_console_data.sql
DB_IMPORT_FORMAT=sql
DB_IMPORT_SOURCE_SCHEMA=public
```

导入时会把 SQL 中的原 schema 前缀替换为 `DB_SCHEMA`。例如原文件中的
`public.resources` 会导入到 `dw_console.resources`。

数据导入使用文件 SHA-256 记录：

- 同一个文件重复执行会自动跳过。
- 文件内容变化后会视为新文件。
- 如需强制重新导入，设置 `DB_IMPORT_FORCE=true`，并自行确保不会产生主键冲突。
- 首次成功后建议将 `DB_IMPORT_DATA=false`。

也支持 `pg_dump` 自定义格式（`.dump`、`.backup`）：

```env
DB_IMPORT_DATA=true
DB_IMPORT_FILE=/import/dw_console_data.dump
DB_IMPORT_FORMAT=custom
```

自定义格式无法自动重写 schema 名，导出时的 schema 必须与 `DB_SCHEMA` 一致。

### 场景 A：把现有数据库迁移到内网 DWS

先在当前数据库执行备份：

```bash
pg_dump -Fc -h 127.0.0.1 -U postgres -d dw_console -f dw_console.dump
```

在内网新建一个空数据库后恢复。建议先只恢复表结构，再由 `db-init` 导入数据；
也可以直接恢复完整 dump，此时两个部署开关都设为 `false`。

```bash
createdb -h <内网数据库IP> -U postgres dw_console
pg_restore -h <内网数据库IP> -U postgres -d dw_console dw_console.dump
```

恢复完整数据库后设置：

```env
DB_CREATE_TABLES=false
DB_IMPORT_DATA=false
AUTO_MIGRATE=false
```

不要对已经有业务数据的数据库执行 `db:reset` 或删除 schema 的操作。

### 场景 B：内网使用全新的空数据库/DWS schema

设置：

```env
DB_CREATE_TABLES=true
DB_IMPORT_DATA=false
DB_CREATE_SCHEMA=true
```

启动完成后可以改回 `DB_CREATE_TABLES=false`。即使保持为 `true`，迁移记录也会保证
不会重复建表。

### 数据库就在 Docker 宿主机上

`.env` 中数据库主机使用：

```env
DATABASE_URL=postgres://dw_console:密码@host.docker.internal:5432/dw_console
```

如果 `.env` 同时要给宿主机本地开发使用，可以保留本机地址，并单独增加 Docker 地址：

```env
DATABASE_URL=postgres://dw_console:密码@127.0.0.1:5432/dw_console
DOCKER_DATABASE_URL=postgres://dw_console:密码@host.docker.internal:5432/dw_console
```

Compose 会优先使用 `DOCKER_DATABASE_URL`。

同时需要 PostgreSQL：

1. `postgresql.conf` 中 `listen_addresses` 允许对应网卡。
2. `pg_hba.conf` 增加仅允许 Compose 子网的规则，例如：

```text
host all all 172.28.0.0/24 scram-sha-256
```

不要为了省事写成 `0.0.0.0/0`。

3. 重新加载 PostgreSQL 配置。

如果 `172.28.0.0/24` 与内网现有网段冲突，请同时修改 `.env` 中的
`DOCKER_SUBNET` 和 `pg_hba.conf` 中的对应网段。

如果 PostgreSQL 在另一台内网服务器上，直接把 `host.docker.internal` 换成那台服务器的 IP 或域名即可。

## 4. 在联网构建机上生成镜像

### Windows 一键打包（推荐）

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-docker-offline.ps1 -Version 1.0.0
```

脚本会自动：

1. 构建 API 和 Web 镜像。
2. 导出两个镜像为一个 `.tar` 文件。
3. 复制 `compose.yaml`、环境变量模板和部署说明。
4. 生成 `artifacts/dw-resource-console-offline-1.0.0.zip`。

把生成的 ZIP 复制到内网服务器即可。

如果服务器是 ARM 架构，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-docker-offline.ps1 -Version 1.0.0 -Platform linux/arm64
```

### 手动构建

在项目根目录执行。内网服务器通常是 x86_64，因此显式指定 `linux/amd64`：

```bash
docker build --platform linux/amd64 --target api -t dw-resource-console-api:1.0.0 .
docker build --platform linux/amd64 --target web -t dw-resource-console-web:1.0.0 .
```

导出两个镜像：

```bash
docker save -o dw-resource-console-1.0.0-images.tar \
  dw-resource-console-api:1.0.0 \
  dw-resource-console-web:1.0.0
```

最终需要带到内网的文件：

- `dw-resource-console-1.0.0-images.tar`
- `compose.yaml`
- 根据 `deploy/.env.example` 改好的 `.env`
- 需要导入时，将数据文件放到 `import/` 目录

## 5. 复制到内网并启动

把上述文件放在同一个部署目录，例如 `/opt/dw-resource-console`：

```bash
mkdir -p /opt/dw-resource-console
cd /opt/dw-resource-console
unzip /path/to/dw-resource-console-offline-1.0.0.zip
cp .env.example .env
# 编辑 .env，填写数据库地址、密码、JWT_SECRET 和 CORS_ORIGIN
```

请确认宿主机防火墙只开放实际需要的 Web 端口（默认 `8080`），不要直接暴露 API 的
`8787` 端口或 PostgreSQL 的 `5432` 端口到不可信网络。

导入镜像：

```bash
docker load -i dw-resource-console-1.0.0-images.tar
```

检查镜像：

```bash
docker images | grep dw-resource-console
```

启动，不重新构建、不访问外网：

```bash
docker compose up -d --no-build
```

查看状态：

```bash
docker compose ps
docker compose logs db-init
docker compose logs -f api
```

`db-init` 正常完成后状态应为 `Exited (0)`，随后 `api` 和 `web` 才会启动。

浏览器访问：

```text
http://<内网服务器IP>:8080
```

API 文档：

```text
http://<内网服务器IP>:8080/docs
```

## 6. 日常操作

```bash
# 停止并删除应用容器，数据库不受影响
docker compose down

# 重新启动
docker compose up -d --no-build

# 查看 API 日志
docker compose logs -f api

# 查看 Web 日志
docker compose logs -f web

# 更新版本：先在内网导入新镜像，然后改 IMAGE_TAG
IMAGE_TAG=1.0.1 docker compose up -d --no-build
```

永远不要执行 `docker compose down -v` 来清理本项目。本项目没有把 PostgreSQL 放进 Compose，但仍建议避免使用带数据卷删除含义的命令。

## 7. 内网更新方式

1. 在联网构建机重新构建两个镜像，版本号递增。
2. `docker save` 新版本。
3. 复制到内网并 `docker load`。
4. 修改 `.env` 或命令中的 `IMAGE_TAG`。
5. 执行 `docker compose up -d --no-build`。

整个更新过程不需要内网访问 npm、Docker Hub 或任何代码仓库。

## 8. 常见问题

### 容器一直重启

```bash
docker compose logs --tail=200 api
```

重点检查 `DATABASE_URL`、数据库账号密码、PostgreSQL 监听地址和防火墙。

### 页面能打开，但接口报 502

```bash
docker compose ps
docker compose logs --tail=200 web
docker compose logs --tail=200 api
```

确认 `api` 健康状态为 `healthy`。

### 登录后立刻掉线

- 浏览器必须访问同一个地址，例如始终使用服务器 IP，不要混合 IP 和主机名。
- 确认 `CORS_ORIGIN` 与实际访问地址一致。
- 确认 Nginx 转发时保留 Cookie。

### 服务器是 ARM 架构

在服务器执行：

```bash
uname -m
```

如果输出 `aarch64`，构建时把 `linux/amd64` 改为 `linux/arm64`。
