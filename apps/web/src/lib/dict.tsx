import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ATTR_FIELDS,
  ENVIRONMENT_LABELS,
  RESOURCE_TYPE_LABELS,
  TYPE_COLUMNS,
  type AttrFieldDef,
  type EnvironmentDto,
  type ResourceTypeDto,
} from '@dw/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { dictApi, metaApi } from './endpoints';
import { useAuth } from './auth';
import type { SelectOption } from '../components/ui';

export type BadgeTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

export interface DictValue {
  /** 全部类型（含停用），用于管理与筛选展示 */
  resourceTypes: ResourceTypeDto[];
  /** 仅启用的类型，用于下拉框 */
  activeTypes: ResourceTypeDto[];
  environments: EnvironmentDto[];
  activeEnvironments: EnvironmentDto[];
  typeLabel: (code: string) => string;
  envLabel: (code: string) => string;
  envTone: (code: string) => BadgeTone;
  /** 环境的自定义标识色（#rrggbb）；未设置返回 null，由调用方回退到 tone */
  envColor: (code: string) => string | null;
  /** 某类型的动态属性字段（供资源表单渲染） */
  attrFields: (code: string) => AttrFieldDef[];
  /** 某类型在列表页展示的关键列 */
  typeColumns: (code: string) => string[];
  /**
   * 资源类型下拉项。默认含停用项（标记 disabled 并加「已停用」后缀）：
   * 编辑停用类型的存量数据时下拉才不会空白，同时也能阻止用户主动选择停用类型。
   */
  typeOptions: (opts?: { includeDisabled?: boolean }) => SelectOption[];
  /** 环境下拉项，规则同 typeOptions */
  envOptions: (opts?: { includeDisabled?: boolean }) => SelectOption[];
  loading: boolean;
  refresh: () => void;
}

/** 字典尚未到达时的兜底：用内置常量渲染，保证下拉框永远有选项（不会只剩「全部」） */
interface DictItemLite {
  code: string;
  label: string;
  enabled: boolean;
}
const BUILTIN_TYPES: DictItemLite[] = Object.entries(RESOURCE_TYPE_LABELS as Record<string, string>).map(
  ([code, label]) => ({ code, label, enabled: true }),
);
const BUILTIN_ENVS: DictItemLite[] = Object.entries(ENVIRONMENT_LABELS as Record<string, string>).map(
  ([code, label]) => ({ code, label, enabled: true }),
);

/** 字典尚未加载时的兜底：使用内置常量，保证首屏不闪空白 */
const fallback: DictValue = {
  resourceTypes: [],
  activeTypes: [],
  environments: [],
  activeEnvironments: [],
  typeLabel: (code) => (RESOURCE_TYPE_LABELS as Record<string, string>)[code] ?? code,
  envLabel: (code) => (ENVIRONMENT_LABELS as Record<string, string>)[code] ?? code,
  envTone: () => 'gray',
  envColor: () => null,
  attrFields: (code) => (ATTR_FIELDS as unknown as Record<string, AttrFieldDef[]>)[code] ?? [],
  typeColumns: (code) => (TYPE_COLUMNS as unknown as Record<string, string[]>)[code] ?? [],
  // 字典未加载时先用内置常量兜底，避免首屏下拉空白
  typeOptions: () =>
    Object.entries(RESOURCE_TYPE_LABELS as Record<string, string>).map(([value, label]) => ({ value, label })),
  envOptions: () =>
    Object.entries(ENVIRONMENT_LABELS as Record<string, string>).map(([value, label]) => ({ value, label })),
  loading: true,
  refresh: () => {},
};

const DictContext = createContext<DictValue>(fallback);

const TONE_MAP: Record<string, BadgeTone> = {
  gray: 'gray',
  blue: 'blue',
  green: 'green',
  amber: 'amber',
  red: 'red',
  purple: 'violet',
  violet: 'violet',
};

/**
 * 字典上下文：资源类型与环境均由服务端字典驱动，新增/改名后刷新即可全站生效。
 * 内置常量仅作为首屏兜底，不会出现空白下拉。
 */
export function DictProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  /**
   * 字典接口全部需要鉴权，而 DictProvider 挂在登录态之外（首屏就会挂载）。
   * 若此时直接发请求必然 401，且 4xx 不重试，登录成功后再也不会重拉 —— 表现就是
   * 资源台账的「资源类型 / 环境」下拉永远只剩「全部」。所以未登录时不发请求，
   * 登录后再由 enabled 翻转触发首次加载。
   */
  const authed = Boolean(user);

  const types = useQuery({
    queryKey: ['dict', 'resource-types'],
    queryFn: () => dictApi.types(true),
    staleTime: 30_000,
    enabled: authed,
  });

  const environments = useQuery({
    queryKey: ['dict', 'environments'],
    queryFn: () => dictApi.environments(true),
    staleTime: 30_000,
    enabled: authed,
  });

  const meta = useQuery({
    queryKey: ['dict', 'meta'],
    queryFn: () => metaApi.get(),
    staleTime: 30_000,
    enabled: authed,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dict'] });
    queryClient.invalidateQueries({ queryKey: ['meta'] });
  }, [queryClient]);

  // 登录成功 / 换账号后主动拉一次，避免沿用上一个账号的字典缓存
  useEffect(() => {
    if (!authed) return;
    queryClient.invalidateQueries({ queryKey: ['dict'] });
    queryClient.invalidateQueries({ queryKey: ['meta'] });
  }, [authed, user?.id, queryClient]);

  const value = useMemo<DictValue>(() => {
    const typeList = types.data ?? [];
    const envList = environments.data ?? [];
    const attrMap = (meta.data?.attrFields ?? {}) as Record<string, AttrFieldDef[]>;
    const columnMap = (meta.data?.typeColumns ?? {}) as Record<string, string[]>;
    const envToneMap = new Map(envList.map((e) => [e.code, e.tone]));
    const envColorMap = new Map(envList.map((e) => [e.code, e.color]));

    return {
      resourceTypes: typeList,
      activeTypes: typeList.filter((t) => t.enabled),
      environments: envList,
      activeEnvironments: envList.filter((e) => e.enabled),
      typeLabel: (code) =>
        typeList.find((t) => t.code === code)?.label ??
        (RESOURCE_TYPE_LABELS as Record<string, string>)[code] ??
        code,
      envLabel: (code) =>
        envList.find((e) => e.code === code)?.label ?? (ENVIRONMENT_LABELS as Record<string, string>)[code] ?? code,
      envTone: (code) => TONE_MAP[envToneMap.get(code) ?? 'gray'] ?? 'gray',
      envColor: (code) => envColorMap.get(code) ?? null,
      attrFields: (code) =>
        attrMap[code] ?? (ATTR_FIELDS as unknown as Record<string, AttrFieldDef[]>)[code] ?? [],
      typeColumns: (code) =>
        columnMap[code] ?? (TYPE_COLUMNS as unknown as Record<string, string[]>)[code] ?? [],
      // 字典还没到位（首屏 / 请求失败）时用内置常量兜底，下拉不会只剩「全部」
      typeOptions: ({ includeDisabled = true } = {}) =>
        (typeList.length > 0 ? typeList : BUILTIN_TYPES)
          .filter((t) => includeDisabled || t.enabled)
          .map((t) => ({
            value: t.code,
            label: t.enabled ? t.label : `${t.label}（已停用）`,
            disabled: !t.enabled,
          })),
      envOptions: ({ includeDisabled = true } = {}) =>
        (envList.length > 0 ? envList : BUILTIN_ENVS)
          .filter((e) => includeDisabled || e.enabled)
          .map((e) => ({
            value: e.code,
            label: e.enabled ? e.label : `${e.label}（已停用）`,
            disabled: !e.enabled,
          })),
      loading: types.isLoading || environments.isLoading || meta.isLoading,
      refresh,
    };
  }, [types.data, types.isLoading, environments.data, environments.isLoading, meta.data, meta.isLoading, refresh]);

  return <DictContext.Provider value={value}>{children}</DictContext.Provider>;
}

export function useDict(): DictValue {
  return useContext(DictContext);
}

/** 字典变更后刷新全站缓存 */
export function useDictRefresh(): () => void {
  return useDict().refresh;
}
