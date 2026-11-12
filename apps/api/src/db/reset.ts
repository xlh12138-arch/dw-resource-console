import { runMigrations } from './auto-migrate.js';
import { db, withTransaction } from './index.js';
import {
  auditLogs,
  environmentDict,
  envSlots,
  resources,
  refreshTokens,
  projectEnvironments,
  projectSnapshots,
  projects,
  envTemplates,
  resourceTypeFields,
  resourceTypes,
  users,
} from './schema.js';

await runMigrations();
await withTransaction(async () => {
  // 先解除资源对项目 / 项目环境的引用（ADD COLUMN 的外键不带级联置空）
  await db.update(resources).set({ projectId: null, projectEnvId: null });
  await db.delete(envSlots);
  await db.delete(projectEnvironments);
  await db.delete(projectSnapshots);
  await db.delete(envTemplates);
  await db.delete(projects);
  await db.delete(auditLogs);
  await db.delete(refreshTokens);
  await db.delete(resources);
  await db.delete(users);
  await db.delete(resourceTypeFields);
  await db.delete(resourceTypes);
  await db.delete(environmentDict);
});
console.log('[db] 已清空业务数据与字典配置（含项目、项目环境、环境模板、资源类型与环境字典）');
process.exit(0);
