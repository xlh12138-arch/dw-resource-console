/**
 * 冒烟 / UI 脚本共用的环境读取。
 *
 * 取值顺序：显式环境变量 > 仓库根目录 .env > 默认值（仅限非敏感项）。
 * 管理员口令属于敏感项：缺失、为空或仍是占位值时直接以非 0 退出，
 * 避免出现「套件被跳过但命令仍然成功」的假绿。
 */
import { existsSync, readFileSync } from 'node:fs';

const ENV_URL = new URL('../../.env', import.meta.url);

function parseEnv(text) {
  const map = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

export const dotenv = existsSync(ENV_URL) ? parseEnv(readFileSync(ENV_URL, 'utf8')) : {};

/** 按顺序返回第一个非空值（环境变量优先于 .env）。 */
export function envValue(...names) {
  for (const name of names) {
    const value = process.env[name] ?? dotenv[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export const BASE = envValue('SMOKE_BASE') ?? 'http://127.0.0.1:8787/api/v1';
export const WEB_BASE = envValue('SMOKE_WEB_BASE') ?? 'http://localhost:5173/';
export const ADMIN_USERNAME = envValue('SMOKE_ADMIN_USER', 'BOOTSTRAP_ADMIN_USERNAME') ?? 'admin';

const PLACEHOLDER_PASSWORDS = new Set(['change-me', 'changeme', 'password', 'admin']);

/**
 * 读取管理员口令；缺失时打印可执行的修复提示并退出（退出码 1）。
 * @param {string} script 脚本名，用于错误信息
 */
export function adminPassword(script) {
  const value = envValue('SMOKE_PASSWORD', 'BOOTSTRAP_ADMIN_PASSWORD');
  if (!value || PLACEHOLDER_PASSWORDS.has(value)) {
    console.error(
      [
        '',
        `[${script}] 缺少管理员口令，测试无法执行。`,
        '',
        '请在仓库根目录 .env 里设置 BOOTSTRAP_ADMIN_PASSWORD（首次播种时使用的值），',
        '或显式传入 SMOKE_PASSWORD：',
        '',
        `  SMOKE_PASSWORD='你的管理员口令' node scripts/${script}.mjs`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return value;
}
