/**
 * 数据库事务实测：
 * 1. 业务表写入 + 审计写入后主动抛错，二者必须同时回滚；
 * 2. 正常提交后二者必须同时可见；
 * 3. 测试完成后清理数据。
 */
import { and, eq } from 'drizzle-orm';
import { closeDatabase, db, firstRow, withTransaction } from '../apps/api/dist/db/index.js';
import { runMigrations } from '../apps/api/dist/db/auto-migrate.js';
import { auditLogs, resourceTypes } from '../apps/api/dist/db/schema.js';

const code = `TX_TEST_${Date.now().toString(36).toUpperCase()}`;
let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

try {
  await runMigrations();

  let rollbackError = null;
  try {
    await withTransaction(async () => {
      await db.insert(resourceTypes).values({
        code,
        label: '事务回滚测试',
        prefix: 'TX',
      });
      await db.insert(auditLogs).values({
        actorId: null,
        actorName: '事务测试',
        action: 'CREATE',
        targetType: 'DICT',
        targetId: code,
        targetName: code,
        changes: [{ field: '*', from: null, to: code }],
        createdAt: new Date(),
      });
      throw new Error('intentional rollback');
    });
  } catch (error) {
    rollbackError = error;
  }

  check('事务内异常会向调用方传播', rollbackError?.message === 'intentional rollback');
  check(
    '业务表写入已回滚',
    !(await firstRow(db.select().from(resourceTypes).where(eq(resourceTypes.code, code)))),
  );
  check(
    '审计表写入同步回滚',
    !(await firstRow(
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetType, 'DICT'), eq(auditLogs.targetId, code))),
    )),
  );

  await withTransaction(async () => {
    await db.insert(resourceTypes).values({
      code,
      label: '事务提交测试',
      prefix: 'TX',
    });
    await db.insert(auditLogs).values({
      actorId: null,
      actorName: '事务测试',
      action: 'CREATE',
      targetType: 'DICT',
      targetId: code,
      targetName: code,
      changes: [{ field: '*', from: null, to: code }],
      createdAt: new Date(),
    });
  });

  check(
    '业务表写入正常提交',
    !!(await firstRow(db.select().from(resourceTypes).where(eq(resourceTypes.code, code)))),
  );
  check(
    '审计表写入正常提交',
    !!(await firstRow(
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetType, 'DICT'), eq(auditLogs.targetId, code))),
    )),
  );

  await withTransaction(async () => {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.targetType, 'DICT'), eq(auditLogs.targetId, code)));
    await db.delete(resourceTypes).where(eq(resourceTypes.code, code));
  });
  check('测试数据已清理', true);
} catch (error) {
  failed += 1;
  console.error(error);
} finally {
  await closeDatabase();
  console.log(`\n—— 事务实测：${passed} 通过 / ${failed} 失败 ——`);
  process.exitCode = failed > 0 ? 1 : 0;
}
