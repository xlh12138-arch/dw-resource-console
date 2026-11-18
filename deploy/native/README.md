# 麒麟 V10 原生离线部署

本包不依赖 Docker，使用普通用户自己的 Node.js、Nginx 和应用目录。

## 首次部署

```sh
unzip dw-resource-console-kylin-v10-dws821-<version>.zip
cd dw-resource-console
cp .env.native.example .env
chmod +x start-api.sh stop-api.sh
```

编辑 `.env`，至少填写：

- DWS 的 `DATABASE_URL` 和 `DB_SCHEMA`
- 实际访问地址 `CORS_ORIGIN`
- 新的 `JWT_SECRET`
- 新的 `BOOTSTRAP_ADMIN_PASSWORD`
- 用户无操作自动退出时间 `IDLE_TIMEOUT`，默认 `30m`

刷新令牌 Cookie 是浏览器会话 Cookie，正常关闭浏览器后重新打开需要登录。

已有表和数据时，不要执行迁移或导入。

新库先建表：

```sh
node apps/api/dist/db/migrate.js
```

需要导入本包数据时：

```sh
DB_IMPORT_FILE=data/dw_console_data.sql \
DB_IMPORT_SOURCE_SCHEMA=public \
DB_IMPORT_FORCE=false \
node apps/api/dist/db/import-data.js
```

启动 API：

```sh
./start-api.sh
```

检查：

```sh
node -e "fetch('http://127.0.0.1:8787/health').then(r=>console.log(r.status))"
node -e "fetch('http://127.0.0.1:8787/ready').then(r=>console.log(r.status))"
```

## Nginx

参考 `deploy/nginx-native.conf`，把内容合并到已有 Nginx 的 `http {}`。

必须修改：

```nginx
root /home/YOUR_USER/dw-resource-console/apps/web/dist;
```

同一个 `8080` 端口只能有一个 `default_server`。已有 `8080` server 时，把代理
location 合并进去即可。

使用自己的 Nginx 路径验证并重载：

```sh
"$NGINX_BIN" -p "$NGINX_HOME" -c "$NGINX_CONF" -t
"$NGINX_BIN" -p "$NGINX_HOME" -c "$NGINX_CONF" -s reload
```

## 停止

```sh
./stop-api.sh
```

日志在 `logs/api.log`，PID 在 `logs/api.pid`。
