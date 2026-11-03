import { config } from './config/env.js';
import { runMigrations } from './db/auto-migrate.js';
import { authService } from './modules/auth/service.js';
import { buildApp } from './app.js';
import { closeDatabase } from './db/index.js';

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await runMigrations();
    await authService.ensureBootstrapAdmin();

    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info(`API 已启动: http://${config.server.host}:${config.server.port}${config.server.basePath}`);
    app.log.info(`OpenAPI 文档: http://localhost:${config.server.port}/docs`);

    const shutdown = async (signal: string) => {
      app.log.info({ signal }, '收到退出信号，开始优雅停机');
      try {
        await app.close();
        await closeDatabase();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, '优雅停机失败');
        process.exit(1);
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (err) => app.log.error({ err }, '未处理的 Promise 拒绝'));
  } catch (err) {
    app.log.error({ err }, '服务启动失败');
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  }
}

void main();
