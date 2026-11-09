import { hexToRgb } from '@dw/shared';
import { useDict } from '../lib/dict';
import { cn } from './ui';

/** 预设色调 → 兜底十六进制（环境字典未配置自定义标识色时使用） */
const TONE_HEX: Record<string, string> = {
  gray: '#475569',
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  purple: '#7c3aed',
  violet: '#a63a1a',
};

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(71, 85, 105, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** 相对亮度：用于判断亮色底上是否需要压暗文字，保证可读性 */
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#334155';
  const mix = (v: number) => Math.round(v * (1 - amount));
  return `#${[mix(rgb.r), mix(rgb.g), mix(rgb.b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 环境徽标：优先使用字典里的自定义标识色（任意 RGB），
 * 未设置时回退到预设色调。颜色只作用于背景/文字/描边，不影响其他徽标语义。
 */
export function EnvBadge({
  code,
  label,
  className,
  size = 'sm',
}: {
  code: string;
  label?: string;
  className?: string;
  size?: 'xs' | 'sm';
}) {
  const dict = useDict();
  const raw = dict.envColor(code);
  const tone = dict.envTone(code);
  const hex = raw ?? TONE_HEX[tone] ?? TONE_HEX.gray;
  const text = luminance(hex) > 0.62 ? darken(hex, 0.45) : hex;
  const resolvedLabel = label ?? dict.envLabel(code);
  const duplicateLabel =
    dict.environments.filter((item) => item.label === resolvedLabel).length > 1;
  const displayLabel = duplicateLabel ? `${resolvedLabel}（${code}）` : resolvedLabel;

  return (
    <span
      title={`环境标识色 ${hex}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium ring-1 ring-inset',
        size === 'xs' ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs',
        className,
      )}
      style={{
        backgroundColor: rgba(hex, 0.1),
        color: text,
        boxShadow: `inset 0 0 0 1px ${rgba(hex, 0.28)}`,
      }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} />
      {displayLabel}
    </span>
  );
}
