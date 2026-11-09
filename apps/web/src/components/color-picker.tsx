import {
  ENVIRONMENT_PALETTE,
  hexToRgb,
  normalizeHexColor,
  parseColorInput,
  rgbToHex,
} from '@dw/shared';
import { useEffect, useState } from 'react';
import { Input, cn } from './ui';

/**
 * 环境标识色调色板：
 * - 点预设色块直接套用
 * - 原生取色器任选颜色
 * - 支持十六进制 / RGB 两种输入，内部统一存 #rrggbb
 */
export function ColorPicker({
  value,
  onChange,
  label = '标识色',
  hint,
}: {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
  hint?: string;
}) {
  const normalized = normalizeHexColor(value) ?? '#64748b';
  const rgb = hexToRgb(normalized) ?? { r: 100, g: 116, b: 139 };

  const [hexText, setHexText] = useState(normalized);
  const [rgbText, setRgbText] = useState({ r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) });

  // 外部值变化（切换编辑对象、点色板）时同步输入框
  useEffect(() => {
    const next = normalizeHexColor(value) ?? '#64748b';
    const c = hexToRgb(next) ?? { r: 100, g: 116, b: 139 };
    setHexText(next);
    setRgbText({ r: String(c.r), g: String(c.g), b: String(c.b) });
  }, [value]);

  const applyHex = (raw: string) => {
    setHexText(raw);
    const parsed = parseColorInput(raw);
    if (parsed) onChange(parsed);
  };

  const applyRgb = (channel: 'r' | 'g' | 'b', raw: string) => {
    const next = { ...rgbText, [channel]: raw };
    setRgbText(next);
    const nums = [next.r, next.g, next.b].map((v) => Number(v));
    if (next.r === '' || next.g === '' || next.b === '') return;
    const hex = rgbToHex(nums[0], nums[1], nums[2]);
    if (hex) {
      setHexText(hex);
      onChange(hex);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-700">
        {label}
        {hint ? <span className="ml-1 font-normal text-slate-400">{hint}</span> : null}
      </p>

      {/* 预设色板 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ENVIRONMENT_PALETTE.map((preset) => {
          const active = preset === normalized;
          return (
            <button
              key={preset}
              type="button"
              title={preset}
              aria-label={`使用颜色 ${preset}`}
              onClick={() => onChange(preset)}
              className={cn(
                'h-6 w-6 rounded-md ring-offset-1 transition-transform hover:scale-110',
                active ? 'ring-2 ring-slate-500' : 'ring-1 ring-slate-200',
              )}
              style={{ backgroundColor: preset }}
            />
          );
        })}

        {/* 原生取色器：任意色彩 */}
        <label
          className="relative flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-md ring-1 ring-slate-300"
          title="自定义取色"
          style={{
            background:
              'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)',
          }}
        >
          <input
            type="color"
            value={normalized}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="自定义颜色"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-slate-500">十六进制</p>
          <div className="flex items-center gap-1.5">
            <span
              className="h-8 w-8 shrink-0 rounded-md ring-1 ring-inset ring-slate-200"
              style={{ backgroundColor: normalized }}
            />
            <Input
              value={hexText}
              onChange={(e) => applyHex(e.target.value)}
              placeholder="#2563eb"
              className="font-mono text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-[11px] font-medium text-slate-500">
            RGB 值
            <span className="ml-1 font-normal text-slate-400">
              支持 37,99,235 或 rgb(37,99,235)
            </span>
          </p>
          <div className="flex items-center gap-1.5">
            {(['r', 'g', 'b'] as const).map((channel) => (
              <Input
                key={channel}
                type="number"
                min={0}
                max={255}
                value={rgbText[channel]}
                onChange={(e) => applyRgb(channel, e.target.value)}
                aria-label={`${channel.toUpperCase()} 通道`}
                className="text-center text-xs"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
