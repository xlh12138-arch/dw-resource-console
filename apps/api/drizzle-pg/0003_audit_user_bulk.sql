-- 审计动作枚举新增 ENABLE / DISABLE（批量启用、停用用户）。
-- 数据库列本身是 text / varchar，没有约束，这里只需刷新列注释，便于 DBA 查看。
COMMENT ON COLUMN "audit_logs"."action" IS 'CREATE / UPDATE / DELETE / IMPORT / LOGIN / LOGOUT / ENABLE / DISABLE';
