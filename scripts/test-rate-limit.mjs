/**
 * 验证客户端无法通过轮换 X-Forwarded-For 绕过登录限流。
 * 该脚本应放在测试流程最后执行，因为它会占满当前测试 IP 的登录限流额度。
 */
import { existsSync, readFileSync } from 'node:fs';

const envUrl = new URL('../.env', import.meta.url);
const envText = existsSync(envUrl) ? readFileSync(envUrl, 'utf8') : '';
const envLimit = Number(
  process.env.RATE_LIMIT_LOGIN_MAX ?? envText.match(/^RATE_LIMIT_LOGIN_MAX=(.*)$/m)?.[1] ?? 10,
);
const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787/api/v1';
const statuses = [];

for (let i = 1; i <= envLimit + 3; i += 1) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 每次都伪造不同来源；TRUST_PROXY=false 时服务端必须忽略它。
      'x-forwarded-for': `198.51.100.${i}`,
    },
    body: JSON.stringify({ username: 'rate-limit-probe', password: 'wrong-password' }),
  });
  statuses.push(response.status);
}

const limited = statuses.includes(429);
const firstLimitedAt = statuses.indexOf(429) + 1;
if (limited) {
  console.log(`  ✓ 轮换 X-Forwarded-For 仍触发限流（第 ${firstLimitedAt} 次请求开始返回 429）`);
} else {
  console.log(`  ✗ 未触发登录限流，状态序列：${statuses.join(',')}`);
}
process.exit(limited ? 0 : 1);
