# 数据导入目录

将部署时要导入的数据文件放在此目录，并在 `.env` 中配置：

```env
DB_IMPORT_DATA=true
DB_IMPORT_FILE=/import/data.sql
DB_IMPORT_FORMAT=auto
DB_IMPORT_SOURCE_SCHEMA=public
```

推荐使用 `pg_dump --data-only` 生成的普通 SQL 文件，便于把原有 `public` schema
安全映射到 `DB_SCHEMA`。导入成功后建议将 `DB_IMPORT_DATA` 改回 `false`。

真实数据文件不要提交到 Git。
