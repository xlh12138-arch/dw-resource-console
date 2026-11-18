# 麒麟 V10 原生离线包与增量部署

本文适用于不使用 Docker、由普通用户运行 Node.js 和 Nginx、连接华为 DWS 的部署方式。
可复用的环境模板放在 `deploy/native/`。

## 包结构

全量包包含：

- API：`apps/api/dist`、生产依赖、DWS/PG 迁移
- Web：`apps/web/dist`
- 共享包：`packages/shared/dist`
- 数据：`data/dw_console_data.sql`
- 运维：启动/停止脚本、Nginx 模板、环境变量模板、部署说明

API 的网络监听地址是 `127.0.0.1:8787`，浏览器统一访问 Nginx 的 `8080`。

浏览器关闭后必须重新登录；用户无操作自动退出时间由 `.env` 控制：

```env
IDLE_TIMEOUT=30m
```

支持 `30m`、`1h`、`3600` 等写法，修改后重启 API。
刷新令牌 Cookie 不设置 `Max-Age` 或 `Expires`，属于浏览器会话 Cookie。

空闲退出由前后端各自校验，不依赖浏览器计时器是否准确：

- 前端计时器在无操作时到点退出，只负责即时提示；
- 服务端在每次 `/auth/refresh` 校验 `refresh_tokens.last_used_at`，空闲超过 `IDLE_TIMEOUT`
  直接返回 401「登录状态已超时」，并吊销该刷新令牌。因此休眠、改系统时间或绕过前端直接
  调接口，都无法让会话无限续期。
- 升级到带 `last_used_at` 的版本时，必须先执行迁移（`node apps/api/dist/db/migrate.js`），
  否则 `/auth/refresh` 会因缺列报错；旧令牌在迁移时统一按迁移时刻作为最后一次使用时间。

### 协议判定与代理信任

刷新 Cookie 的 `Secure` 由 `request.protocol === 'https'` 决定，因此 API 必须能拿到真实协议：

- Nginx 的 `/api/`、`/health`、`/ready`、`/docs` 每段都要转发
  `proxy_set_header X-Forwarded-Proto $scheme;`，`deploy/native/nginx.conf` 已包含。
- `.env` 的 `TRUST_PROXY` 必须包含 Nginx 的来源地址。同一台机器部署时填 `127.0.0.1`
  （Nginx 与 API 都在本机）；多台机器部署时填 Nginx 所在主机 IP 或所在网段 CIDR，
  多个值用英文逗号分隔。
- `TRUST_PROXY` 不匹配时 API 会忽略 `X-Forwarded-Proto`，`request.protocol` 恒为 `http`，
  HTTPS 下 Cookie 也不会带 `Secure`；反过来，把 `TRUST_PROXY` 设成 `true` 会让任何
  能直连 8787 的来源伪造协议头。生产环境优先写具体地址或网段。
- API 只监听 `127.0.0.1:8787`，所以浏览器无论如何都访问不到 API，只能经由 Nginx。

验证方式：登录后查看响应头。

```sh
curl -i -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<管理员口令>"}' | grep -i '^set-cookie'
```

HTTP 部署应看到 `dw_refresh=...; HttpOnly; SameSite=Lax`；HTTPS 部署应额外包含 `Secure`。

## 全量生产包

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-offline.ps1 `
  -Version cookiefix-20261118
```

输出：

```text
artifacts/dw-resource-console-kylin-v10-dws821-cookiefix-20261118.zip
```

脚本会：

1. 构建 `@dw/shared`、API 和 Web。
2. 复制运行时文件、DWS 迁移和当前数据 SQL。
3. 在临时目录安装仅生产依赖，并排除原生 SQLite 可选依赖。
4. 修复 npm workspace 产生的本机符号链接，保证 ZIP 解压后可运行。
5. 验证 `@dw/shared`、Fastify 和 pg 驱动能够加载。
6. 写入 Linux ZIP 权限：目录 `0755`、Shell 脚本 `0755`、普通文件 `0644`。
7. 生成 ZIP、SHA256 和 `BUILD_INFO.txt`。

已有构建产物时可跳过构建：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-offline.ps1 `
  -Version cookiefix-20261118 -SkipBuild
```

保留临时目录便于排查：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-offline.ps1 `
  -Version debug -KeepStaging
```

全量包包含约 300 个生产依赖包，压缩时间明显长于增量包。依赖没有变化时，不需要每次
重新生成全量包。

Windows 的 `Compress-Archive` 会把 ZIP 条目的 Unix 权限写成 `000`，Linux 解压后可能
出现目录没有执行权限。打包脚本会在压缩完成后直接修正 ZIP 中央目录中的
`create_system` 和 `external_attr`，并把条目路径统一改为 Linux ZIP 标准的 `/`，
因此不依赖解压后的 `chmod -R` 补救。

打包后可以在 Linux 上检查权限：

```sh
zipinfo -l dw-resource-console-kylin-v10-dws821-<version>.zip \
  | grep -E 'dw-resource-console/($|start-api.sh|stop-api.sh|package.json)'
```

预期模式：

```text
drwxr-xr-x  dw-resource-console/
-rwxr-xr-x  dw-resource-console/start-api.sh
-rwxr-xr-x  dw-resource-console/stop-api.sh
-rw-r--r--  dw-resource-console/package.json
```

解压后也可以检查是否还有目录或 Shell 脚本缺少执行权限：

```sh
find dw-resource-console -type d ! -perm -u+x
find dw-resource-console -type f -name '*.sh' ! -perm -u+x
```

两条命令都没有输出表示权限正常。

## 增量包

增量包只包含构建产物，不包含 `node_modules`，通常只有几 MB，构建和传输都更快。

### Web 修改

只构建并打包前端：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version webfix-20261118 -Areas web
```

### API 修改

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version apifix-20261118 -Areas api
```

### 共享契约修改

`packages/shared` 会同时影响 API 和 Web，脚本会自动构建三部分：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version sharedfix-20261118 -Areas shared
```

### 数据库迁移或数据 SQL

迁移文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version migration-20261118 -Areas migrations
```

数据 SQL：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version data-20261118 -Areas data
```

多个区域可以同时选择：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-native-incremental.ps1 `
  -Version fix-20261118 -Areas api,web,migrations
```

### 必须生成全量包的情况

以下变化不能使用普通增量包：

- `package.json` 或 `package-lock.json` 发生依赖变化
- 新增或升级 Node.js 原生模块
- Nginx、启动脚本或部署目录结构变化
- 目标服务器从未部署过完整生产包

配置值变化不需要打包，直接修改服务器上的 `.env` 后重启 API。

## 增量部署

把增量 ZIP 上传到内网并解压：

```sh
unzip dw-resource-console-kylin-v10-dws821-incremental-<version>.zip
cd dw-resource-console-kylin-v10-dws821-incremental-<version>
chmod +x apply-update.sh
```

执行替换：

```sh
./apply-update.sh /home/dwuser/dw-resource-console
```

脚本会：

1. 停止已有 API。
2. 把旧构建目录移动到 `backups/incremental-<时间>/`。
3. 只替换增量包中存在的目录。
4. 保留数据库和数据文件。
5. 不自动执行迁移或数据导入。

然后按包内容操作：

```sh
cd /home/dwuser/dw-resource-console

# 仅包中包含迁移时执行
node apps/api/dist/db/migrate.js

# 仅包中包含新数据且确认需要导入时执行
DB_IMPORT_FILE=data/dw_console_data.sql \
DB_IMPORT_SOURCE_SCHEMA=public \
DB_IMPORT_FORCE=false \
node apps/api/dist/db/import-data.js

./start-api.sh
```

回滚时，从对应备份目录恢复被替换的 `dist`、迁移目录或共享包，然后重新启动 API。

## 验证

```sh
node -e "fetch('http://127.0.0.1:8787/health').then(r=>console.log(r.status))"
node -e "fetch('http://127.0.0.1:8787/ready').then(r=>console.log(r.status))"
curl -I http://127.0.0.1:8080/
curl http://127.0.0.1:8080/health
```

浏览器登录后点击刷新，应凭 `dw_refresh` Cookie 自动续期。修改 Nginx 配置后必须用
用户自己的 Nginx 路径执行 `-t` 和 `-s reload`。
