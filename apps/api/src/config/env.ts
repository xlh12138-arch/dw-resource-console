import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/** 从当前目录向上查找 .env（兼容在仓库根目录或子包目录启动） */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = resolve(here, '../../../.env');
  return existsSync(fallback) ? fallback : undefined;
}

const envFile = findEnvFile();
if (envFile) process.loadEnvFile?.(envFile);

const bool = (v: unknown, d: boolean) => (v === undefined ? d : ['1', 'true', 'yes'].includes(String(v)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_BASE_PATH: z.string().startsWith('/').default('/api/v1'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().min(1).default('./data/dw-console.db'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET 长度至少 16 位，请使用 openssl rand -hex 48 生成'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),

  BOOTSTRAP_ADMIN_USERNAME: z.string().default('admin'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  AUTO_MIGRATE: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  /** 登录接口单独限流，抵御口令爆破 */
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).default(10),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // 快速失败：配置缺失或非法时立刻退出，而不是带着错误配置启动
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`[config] 环境变量校验失败：\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

/** 支持 15m / 2h / 7d / 3600 这类写法 */
function parseTtl(input: string): number {
  const matched = /^(\d+)(s|m|h|d)?$/.exec(input.trim());
  if (!matched) throw new Error(`非法的时间表达式: ${input}`);
  const value = Number(matched[1]);
  const unit = matched[2] ?? 's';
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit as 's' | 'm' | 'h' | 'd'];
  return value * factor;
}

export const config = {
  env: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  log: { level: raw.LOG_LEVEL },
  server: { host: raw.API_HOST, port: raw.API_PORT, basePath: raw.API_BASE_PATH },
  cors: {
    // 生产环境禁止通配符，必须显式列出来源
    origins: raw.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  },
  db: { driver: raw.DB_DRIVER, url: raw.DATABASE_URL },
  auth: {
    jwtSecret: raw.JWT_SECRET,
    accessTokenTtlSeconds: parseTtl(raw.ACCESS_TOKEN_TTL),
    refreshTokenTtlSeconds: parseTtl(raw.REFRESH_TOKEN_TTL),
    bootstrapAdmin: {
      username: raw.BOOTSTRAP_ADMIN_USERNAME,
      password: raw.BOOTSTRAP_ADMIN_PASSWORD,
    },
  },
  rateLimit: { max: raw.RATE_LIMIT_MAX, timeWindow: '1 minute' },
  rateLimitLogin: { max: raw.RATE_LIMIT_LOGIN_MAX, timeWindow: '1 minute' },
  autoMigrate: bool(raw.AUTO_MIGRATE, true),
} as const;

export type AppConfig = typeof config;
