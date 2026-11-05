import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Download,
  FileSpreadsheet,
  FolderTree,
  Link2,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router';
import {
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABELS,

  type ResourceDto,
  type ResourceStatus,
} from '@dw/shared';
import { useDict } from '../lib/dict';
import {
  buildImportColumns,
  columnLetter,
  downloadImportTemplate,
  importRowsToCsv,
  parseImportFile,
  type ImportIssue,
  type ParsedImport,
} from '../lib/import-template';
import { projectsApi, resourcesApi, type ResourceQuery } from '../lib/endpoints';
import { friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ResourceDetailModal } from '../components/resource-detail';
import { ResourceFormModal } from '../components/resource-form';
import { useToast } from '../components/toast';
import { Button, Card, ClickableBadge, EmptyState, ErrorBanner, Field, Input, Modal, ModalCancelButton, Pagination, Select, Spinner, Td, Th, Table, Textarea } from '../components/ui';
import { EnvBadge } from '../components/env-badge';

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * 台账容量列与资源详情同口径：优先展示「按时间段的峰值占用」（错峰不累加）。
 * capacityPeak 为 null 时（老数据或未设容量）回落到不分时段的合计。
 */
function capacityUsed(r: ResourceDto): number {
  return r.capacityPeak ?? r.capacityAllocated;
}

function capacityLeft(r: ResourceDto): number {
  if (r.capacityTotal === null) return 0;
  return r.capacityPeakAvailable ?? r.capacityAvailable ?? Math.max(0, r.capacityTotal - capacityUsed(r));
}

/** 资源状态 → 徽标配色（台账列表与筛选标签共用） */
function statusTone(status: ResourceStatus): 'gray' | 'green' | 'amber' | 'red' {
  if (status === 'IN_USE') return 'green';
  if (status === 'MAINTAINING') return 'amber';
  if (status === 'RETIRED') return 'red';
  return 'gray';
}

function SortableTh({
  label,
  sortKey,
  currentSort,
  currentOrder,
  onSort,
}: {
  label: string;
  sortKey: string;
  currentSort: string;
  currentOrder: 'asc' | 'desc';
  onSort: (key: string) => void;
}) {
  const active = currentSort === sortKey;
  const Icon = !active ? ChevronsUpDown : currentOrder === 'asc' ? ChevronUp : ChevronDown;
  return (
    <Th>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-brand-700"
        aria-sort={active ? (currentOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <Icon size={12} className={active ? 'text-brand-600' : 'text-slate-400'} />
      </button>
    </Th>
  );
}

/** 单个筛选条件标签：点 × 只移除这一项，不影响其他筛选 */
function FilterChip({
  label,
  tone = 'violet',
  onRemove,
}: {
  label: string;
  tone?: 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet';
  onRemove: () => void;
}) {
  return (
    <ClickableBadge tone={tone} onClick={onRemove} title="移除该筛选条件">
      {label}
      <X size={11} className="ml-1" />
    </ClickableBadge>
  );
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ResourcesPage() {
  const dict = useDict();
  const { push } = useToast();
  const { can: canDo } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(searchParams.get('q') ?? '');
  const [selected, setSelected] = useState<number[]>([]);

  /**
   * URL 即筛选条件的唯一来源：任何筛选变化都写回 URL，页面再从 URL 反推查询条件。
   * 这样「点标签加筛选」「点 × 去掉某一个筛选」都只改一个参数，不会互相覆盖。
   */
  const query = useMemo<ResourceQuery>(() => {
    const p = searchParams;
    const num = (key: string) => {
      const v = p.get(key);
      return v && !Number.isNaN(Number(v)) ? Number(v) : undefined;
    };
    const requestedPageSize = num('pageSize');
    return {
      page: num('page') ?? 1,
      pageSize: PAGE_SIZE_OPTIONS.includes(requestedPageSize ?? DEFAULT_PAGE_SIZE)
        ? (requestedPageSize ?? DEFAULT_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
      sortBy: (p.get('sortBy') ?? 'updatedAt') as ResourceQuery['sortBy'],
      sortOrder: (p.get('sortOrder') as 'asc' | 'desc' | null) ?? 'desc',
      q: p.get('q') || undefined,
      type: p.get('type') ?? undefined,
      environment: p.get('environment') ?? undefined,
      status: (p.get('status') as ResourceStatus | null) ?? undefined,
      datacenter: p.get('datacenter') || undefined,
      id: num('id'),
      projectId: num('projectId'),
      projectEnvId: num('projectEnvId'),
      parentId: num('parentId'),
      tag: p.get('tag') ?? undefined,
      rootOnly: p.get('rootOnly') === 'true' ? true : undefined,
      unassigned: p.get('unassigned') === 'true' ? true : undefined,
    };
  }, [searchParams]);

  /** 写一个或多个筛选参数（空值即删除该条件）；resetPage=false 用于翻页 */
  const setFilter = (
    patch: Record<string, string | number | boolean | null | undefined>,
    resetPage = true,
  ) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === null || value === '' || value === false) next.delete(key);
          else next.set(key, String(value));
        }
        if (resetPage) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  /** 同一维度重复点击时取消该筛选 */
  const toggleFilter = (key: string, value: string) => {
    const current = searchParams.get(key);
    setFilter({ [key]: current === String(value) ? undefined : value });
  };
  const [bulkOpen, setBulkOpen] = useState(false);
  const [formState, setFormState] = useState<{ open: boolean; initial: ResourceDto | null; type: string }>({
    open: false,
    initial: null,
    type: '',
  });
  const [detail, setDetail] = useState<ResourceDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ResourceDto | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // 外部跳转（概览 / 详情 / 项目页）带来的关键字变化要同步回输入框
  const urlKeyword = searchParams.get('q') ?? '';
  useEffect(() => {
    setKeyword((prev) => (prev === urlKeyword ? prev : urlKeyword));
  }, [urlKeyword]);

  // 关键字输入防抖，避免每敲一个字符就请求一次
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter({ q: keyword || undefined });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const list = useQuery({
    queryKey: ['resources', query],
    queryFn: () => resourcesApi.list(query),
    placeholderData: keepPreviousData,
  });

  const projects = useQuery({ queryKey: ['projects-options'], queryFn: () => projectsApi.options() });
  const tags = useQuery({ queryKey: ['resource-tags'], queryFn: () => resourcesApi.tags() });

  /** 选中的标签集合（多标签取「同时包含」） */
  const activeTags = useMemo(
    () => (query.tag ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    [query.tag],
  );

  const applyTag = (next: string[]) => {
    setFilter({ tag: next.length > 0 ? next.join(',') : undefined });
  };

  const toggleTag = (tag: string) => {
    applyTag(activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag]);
  };

  const bulkAssign = useMutation({
    mutationFn: (projectId: number) => resourcesApi.bulkAssign({ ids: selected, projectId }),
    onSuccess: (result) => {
      push('success', `已将 ${result.updated} 个资源标注到项目`);
      setSelected([]);
      setBulkOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => resourcesApi.remove(id),
    onSuccess: (_, id) => {
      push('success', '资源已删除');
      setPendingDelete(null);
      setSelected((prev) => prev.filter((selectedId) => selectedId !== id));
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const bulkRemove = useMutation({
    mutationFn: () => resourcesApi.bulkRemove(selected),
    onSuccess: (result) => {
      push('success', `已删除 ${result.deleted} 个资源`);
      setSelected([]);
      setBulkDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const rows = list.data?.items ?? [];
  const primaryAttrKey = query.type ? dict.typeColumns(query.type)[0] : undefined;
  const sortBy: NonNullable<ResourceQuery['sortBy']> = query.sortBy ?? 'updatedAt';
  const sortOrder: 'asc' | 'desc' = query.sortOrder ?? 'desc';
  const sortColumn = (key: string) => {
    const defaultOrder: 'asc' | 'desc' = key.startsWith('attr:') || key === 'name' || key === 'code' || key === 'type' || key === 'environment' || key === 'status' || key === 'owner'
      ? 'asc'
      : 'desc';
    setFilter({
      sortBy: key,
      sortOrder: sortBy === key && sortOrder === defaultOrder
        ? (defaultOrder === 'asc' ? 'desc' : 'asc')
        : defaultOrder,
    });
  };
  /** 按 id 精确定位时，列表里就是这一条，用它的编码回显筛选标签 */
  const focused = query.id ? rows.find((r) => r.id === query.id) : undefined;
  /** 按父资源筛选时，用首行的父信息回显「父资源」标签 */
  const parentHint = rows.find((r) => r.parentId === query.parentId) ?? rows[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">资源台账</h1>
          <p className="text-xs text-slate-500">
            批量调度服务器 / 调度平台IP / 采集交换平台IP / NAS / GDS 服务器
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            title={selected.length > 0 ? `仅导出已勾选的 ${selected.length} 个资源` : '导出当前筛选结果'}
            onClick={async () => {
              try {
                // 有勾选时只按勾选的 id 导出，忽略当前筛选；未勾选时保持导出筛选结果
                const exportQuery: ResourceQuery = selected.length > 0
                  ? { ids: selected.join(',') }
                  : query;
                const csv = await resourcesApi.exportCsv(exportQuery);
                if (!csv) {
                  push('error', '所选资源已不存在，请刷新后重试');
                  return;
                }
                download(`resources-${new Date().toISOString().slice(0, 10)}.csv`, csv);
                push(
                  'success',
                  selected.length > 0
                    ? `已导出勾选的 ${selected.length} 个资源`
                    : '已导出当前筛选结果',
                );
              } catch (err) {
                push('error', friendlyMessage(err));
              }
            }}
          >
            <Download size={14} />
            导出 CSV{selected.length > 0 ? `（已选 ${selected.length}）` : ''}
          </Button>
          {canWrite && selected.length > 0 && (
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <Tag size={14} />
              标注项目（{selected.length}）
            </Button>
          )}
          {canDelete && selected.length > 0 && (
            <Button variant="danger" onClick={() => setBulkDeleteOpen(true)}>
              <Trash2 size={14} />
              删除（{selected.length}）
            </Button>
          )}
          {canWrite && (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload size={14} />
                批量导入
              </Button>
              <Button onClick={() => setFormState({ open: true, initial: null, type: query.type ?? '' })}>
                <Plus size={14} />
                新增资源
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="min-w-56 flex-1">
            <Field label="关键字">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索编码 / 名称 / IP / 负责人 / 备注"
                />
              </div>
            </Field>
          </div>
          <div className="w-44">
            <Field label="资源类型">
              <Select
                value={query.type ?? ''}
                placeholder="全部类型"
                options={dict.typeOptions()}
                onChange={(e) => setFilter({ type: e.target.value || undefined })}
              />
            </Field>
          </div>
          <div className="w-32">
            <Field label="环境">
              <Select
                value={query.environment ?? ''}
                placeholder="全部"
                options={dict.envOptions()}
                onChange={(e) => setFilter({ environment: e.target.value || undefined })}
              />
            </Field>
          </div>
          <div className="w-32">
            <Field label="状态">
              <Select
                value={query.status ?? ''}
                placeholder="全部"
                options={RESOURCE_STATUSES.map((s) => ({ value: s, label: RESOURCE_STATUS_LABELS[s] }))}
                onChange={(e) => setFilter({ status: e.target.value || undefined })}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="所属项目">
              <Select
                value={query.unassigned ? '__none__' : (query.projectId ? String(query.projectId) : '')}
                placeholder="全部项目"
                fallbackLabel="当前筛选项目"
                options={[
                  { value: '__none__', label: '未标注项目' },
                  ...(projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name })),
                ]}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilter({
                    projectId: v && v !== '__none__' ? Number(v) : undefined,
                    unassigned: v === '__none__' ? true : undefined,
                  });
                }}
              />
            </Field>
          </div>
          <div className="w-36">
            <Field label="机房">
              <Input
                value={query.datacenter ?? ''}
                onChange={(e) => setFilter({ datacenter: e.target.value || undefined })}
                placeholder="如 深圳A机房"
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="标签">
              <Select
                value={activeTags.length === 1 ? activeTags[0] : ''}
                placeholder="全部标签"
                fallbackLabel="当前筛选标签"
                options={(tags.data ?? []).map((t) => ({ value: t.tag, label: `#${t.tag}（${t.count}）` }))}
                onChange={(e) => applyTag(e.target.value ? [e.target.value] : [])}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="层级">
              <Select
                value={query.parentId ? `p${query.parentId}` : query.rootOnly ? 'root' : ''}
                placeholder="全部层级"
                options={[
                  { value: 'root', label: '仅顶层资源' },
                  ...(query.parentId
                    ? [{ value: `p${query.parentId}`, label: '已按父资源筛选' }]
                    : []),
                ]}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilter({
                    parentId: v.startsWith('p') ? Number(v.slice(1)) : undefined,
                    rootOnly: v === 'root' ? true : undefined,
                    id: undefined,
                  });
                }}
              />
            </Field>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setKeyword('');
              setSelected([]);
              setSearchParams({}, { replace: true });
            }}
          >
            重置
          </Button>
        </div>

        {/* 当前生效的筛选：每一项都可以单独移除，互不影响 */}
        {(activeTags.length > 0 ||
          query.q ||
          query.type ||
          query.environment ||
          query.status ||
          query.datacenter ||
          query.projectId ||
          query.unassigned ||
          query.parentId ||
          query.id ||
          query.rootOnly) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">
            <span>当前筛选：</span>
            {query.q ? (
              <FilterChip label={`关键字：${query.q}`} onRemove={() => setFilter({ q: undefined })} />
            ) : null}
            {query.type ? (
              <FilterChip label={`类型：${dict.typeLabel(query.type)}`} onRemove={() => setFilter({ type: undefined })} />
            ) : null}
            {query.environment ? (
              <FilterChip
                label={`环境：${dict.envLabel(query.environment)}`}
                tone="blue"
                onRemove={() => setFilter({ environment: undefined })}
              />
            ) : null}
            {query.status ? (
              <FilterChip
                label={`状态：${RESOURCE_STATUS_LABELS[query.status as ResourceStatus]}`}
                tone={statusTone(query.status as ResourceStatus)}
                onRemove={() => setFilter({ status: undefined })}
              />
            ) : null}
            {query.datacenter ? (
              <FilterChip label={`机房：${query.datacenter}`} onRemove={() => setFilter({ datacenter: undefined })} />
            ) : null}
            {query.projectId ? (
              <FilterChip
                label={`项目：${projects.data?.find((p) => p.id === query.projectId)?.name ?? query.projectId}`}
                onRemove={() => setFilter({ projectId: undefined })}
              />
            ) : null}
            {query.unassigned ? (
              <FilterChip label="未标注项目" onRemove={() => setFilter({ unassigned: undefined })} />
            ) : null}
            {query.id ? (
              <FilterChip
                label={`资源：${focused?.code ?? `#${query.id}`}${focused ? ` ${focused.name}` : ''}`}
                tone="amber"
                onRemove={() => setFilter({ id: undefined })}
              />
            ) : null}
            {query.parentId ? (
              <FilterChip
                label={`父资源：${parentHint?.parentCode ?? parentHint?.parentName ?? `#${query.parentId}`} 的子资源`}
                tone="blue"
                onRemove={() => setFilter({ parentId: undefined })}
              />
            ) : null}
            {query.rootOnly ? (
              <FilterChip label="仅顶层资源" onRemove={() => setFilter({ rootOnly: undefined })} />
            ) : null}
            {activeTags.map((t) => (
              <FilterChip key={t} label={`#${t}`} onRemove={() => toggleTag(t)} />
            ))}
          </div>
        )}

        {list.isError && (
          <div className="px-5 pb-4">
            <ErrorBanner message={friendlyMessage(list.error)} />
          </div>
        )}

        {list.isLoading ? (
          <div className="flex h-56 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="没有匹配的资源"
            desc="调整筛选条件，或新增一条资源记录"
            action={
              canWrite && (
                <Button size="sm" onClick={() => setFormState({ open: true, initial: null, type: query.type ?? '' })}>
                  新增资源
                </Button>
              )
            }
          />
        ) : (
          <Table
            head={
              <tr>
                <Th className="w-10">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-600"
                    aria-label="全选"
                    checked={selected.length > 0 && selected.length === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                  />
                </Th>
                <SortableTh label="编码" sortKey="code" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <SortableTh label="名称" sortKey="name" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <SortableTh label="类型" sortKey="type" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                {primaryAttrKey ? (
                  <SortableTh
                    label="关键属性"
                    sortKey={`attr:${primaryAttrKey}`}
                    currentSort={sortBy}
                    currentOrder={sortOrder}
                    onSort={sortColumn}
                  />
                ) : (
                  <Th>关键属性</Th>
                )}
                <Th>所属项目</Th>
                <Th>标签</Th>
                <SortableTh label="环境" sortKey="environment" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <Th>容量</Th>
                <SortableTh label="状态" sortKey="status" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <SortableTh label="负责人" sortKey="owner" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <SortableTh label="更新时间" sortKey="updatedAt" currentSort={sortBy} currentOrder={sortOrder} onSort={sortColumn} />
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td>
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-600"
                    aria-label={`选择 ${r.code}`}
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id),
                      )
                    }
                  />
                </Td>
                <Td className="font-mono text-xs text-slate-500">{r.code}</Td>
                <Td>
                  <div className={r.parentId ? 'pl-4' : ''}>
                    {r.parentId ? (
                      <span className="mr-1 font-mono text-[11px] text-slate-400">└</span>
                    ) : null}
                    <button
                      type="button"
                      className="text-left font-medium text-slate-900 hover:text-brand-700"
                      onClick={() => setDetail(r)}
                      title="查看资源详情、容量明细与被引用情况"
                    >
                      {r.name}
                      {r.slotRefCount > 0 && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] font-normal text-violet-600">
                          <Link2 size={11} />
                          {r.slotRefCount}
                        </span>
                      )}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      {r.parentId ? (
                        <ClickableBadge
                          tone="blue"
                          title={`查看父资源 ${r.parentName ?? r.parentCode}`}
                          onClick={() => setFilter({ id: r.parentId, parentId: undefined, rootOnly: undefined })}
                        >
                          <FolderTree size={10} className="mr-1" />
                          父：{r.parentName ?? r.parentCode}
                        </ClickableBadge>
                      ) : null}
                      {r.childCount > 0 ? (
                        <ClickableBadge
                          tone="amber"
                          title="查看该资源下的子资源"
                          onClick={() => setFilter({ parentId: r.id, id: undefined, rootOnly: undefined })}
                        >
                          子资源 ×{r.childCount}
                        </ClickableBadge>
                      ) : null}
                    </div>
                  </div>
                </Td>
                <Td>
                  <ClickableBadge
                    tone="blue"
                    title={query.type === r.type ? '取消类型筛选' : `按类型「${dict.typeLabel(r.type)}」筛选`}
                    onClick={() => toggleFilter('type', r.type)}
                  >
                    {dict.typeLabel(r.type)}
                  </ClickableBadge>
                </Td>
                <Td className="max-w-64">
                  {(() => {
                    const keys = dict.typeColumns(r.type) ?? [];
                    if (keys.length === 0) {
                      return <span className="text-xs text-slate-400">未设置关键属性</span>;
                    }
                    const labels = new Map(dict.attrFields(r.type).map((field) => [field.key, field.label]));
                    return (
                      <span className="text-xs text-slate-600">
                        {keys
                          .map((key) => `${labels.get(key) ?? key}=${String(r.attrs[key] ?? '—')}`)
                          .join(' · ')}
                      </span>
                    );
                  })()}
                </Td>
                <Td>
                  {r.projectName && r.projectId ? (
                    <ClickableBadge
                      tone="violet"
                      title={query.projectId === r.projectId ? '取消项目筛选' : `按项目「${r.projectName}」筛选`}
                      onClick={() => toggleFilter('projectId', String(r.projectId))}
                    >
                      {r.projectName}
                    </ClickableBadge>
                  ) : (
                    <span className="text-xs text-slate-400">未标注</span>
                  )}
                </Td>
                <Td>
                  <div className="flex max-w-40 flex-wrap gap-1">
                    {r.tags.length === 0 ? (
                      <span className="text-xs text-slate-400">—</span>
                    ) : (
                      r.tags.map((t) => (
                        <ClickableBadge key={t} tone="gray" title={`按标签 #${t} 筛选`} onClick={() => toggleTag(t)}>
                          #{t}
                        </ClickableBadge>
                      ))
                    )}
                  </div>
                </Td>
                <Td>
                  <button
                    type="button"
                    title={query.environment === r.environment ? '取消环境筛选' : `按环境「${dict.envLabel(r.environment)}」筛选`}
                    onClick={() => toggleFilter('environment', r.environment)}
                  >
                    <EnvBadge code={r.environment} label={dict.envLabel(r.environment)} />
                  </button>
                </Td>
                <Td>
                  {r.capacityTotal !== null ? (
                    <div
                      className="min-w-28"
                      title={
                        r.capacityPeak !== null && r.capacityAllocated > r.capacityPeak + 0.01
                          ? `合计占用 ${r.capacityAllocated}${r.capacityUnit ? ` ${r.capacityUnit}` : ''}（未按时间段拆分）；按时间段峰值 ${r.capacityPeak}，差额来自错峰复用`
                          : undefined
                      }
                    >
                      <div className="flex items-baseline justify-between text-[11px] text-slate-600">
                        <span>
                          {/* 与资源详情同口径：按时间段的峰值占用（错峰不累加） */}
                          {capacityUsed(r)}/{r.capacityTotal}
                          {r.capacityUnit ? ` ${r.capacityUnit}` : ''}
                        </span>
                        <span>余 {capacityLeft(r)}</span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${
                            r.capacityTotal > 0 && capacityUsed(r) / r.capacityTotal > 0.9
                              ? 'bg-rose-500'
                              : 'bg-brand-500'
                          }`}
                          style={{
                            width: `${Math.min(100, r.capacityTotal > 0 ? (capacityUsed(r) / r.capacityTotal) * 100 : 0)}%`,
                          }}
                        />
                      </div>
                      {r.childAllocated > 0 ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">
                          其中子资源 {r.childAllocated}
                          {r.capacityUnit ? ` ${r.capacityUnit}` : ''}
                        </p>
                      ) : null}
                      {r.capacityPeak !== null && r.capacityAllocated > r.capacityPeak + 0.01 ? (
                        <p className="mt-0.5 text-[10px] text-violet-600">错峰复用 · 峰值 {r.capacityPeak}</p>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">未设置</span>
                  )}
                </Td>
                <Td>
                  <ClickableBadge
                    tone={statusTone(r.status)}
                    title={query.status === r.status ? '取消状态筛选' : `按状态「${RESOURCE_STATUS_LABELS[r.status]}」筛选`}
                    onClick={() => toggleFilter('status', r.status)}
                  >
                    {RESOURCE_STATUS_LABELS[r.status]}
                  </ClickableBadge>
                </Td>
                <Td>{r.owner ?? '—'}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {new Date(r.updatedAt).toLocaleString('zh-CN')}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && (
                      <Button variant="ghost" size="sm" onClick={() => setFormState({ open: true, initial: r, type: r.type })}>
                        <Pencil size={13} />
                      </Button>
                    )}
                    {canDelete && (
                      <Button variant="ghost" size="sm" onClick={() => setPendingDelete(r)}>
                        <Trash2 size={13} className="text-rose-600" />
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {list.data && (
          <Pagination
            page={list.data.meta.page}
            totalPages={list.data.meta.totalPages}
            total={list.data.meta.total}
            pageSize={list.data.meta.pageSize}
            onChange={(page) => setFilter({ page }, false)}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={(pageSize) => {
              setSelected([]);
              setFilter({ pageSize }, true);
            }}
          />
        )}
      </Card>

      <ResourceFormModal
        key={formState.open ? `${formState.initial?.id ?? 'new'}:${formState.type}` : 'closed'}
        open={formState.open}
        initial={formState.initial}
        defaultType={formState.type}
        onClose={() => setFormState({ open: false, initial: null, type: '' })}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['resources'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
        }}
      />

      <ResourceDetailModal
        resource={detail}
        onClose={() => setDetail(null)}
        onEdit={(r) => {
          setDetail(null);
          setFormState({ open: true, initial: r, type: r.type });
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="删除资源"
        desc="删除后将写入审计日志，且不可恢复"
        width="max-w-md"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={removeMutation.isPending}
              onClick={() => pendingDelete && removeMutation.mutate(pendingDelete.id)}
            >
              {removeMutation.isPending ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          确认删除 <span className="font-medium">{pendingDelete?.code}</span>
          {pendingDelete ? `（${pendingDelete.name}）` : ''} 吗？
        </p>
      </Modal>

      <Modal
        open={bulkDeleteOpen}
        title="批量删除资源"
        desc="仅允许删除完整父子子树；已绑定的环境槽位会同时释放"
        width="max-w-md"
        onClose={() => setBulkDeleteOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={bulkRemove.isPending || selected.length === 0}
              onClick={() => bulkRemove.mutate()}
            >
              {bulkRemove.isPending ? '删除中…' : `确认删除 ${selected.length} 个`}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            确认删除已勾选的 <span className="font-medium">{selected.length}</span> 个资源吗？
          </p>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            若所选资源下还有未勾选的子资源，本次删除会被拒绝。删除后不可恢复，操作会写入审计日志。
          </p>
        </div>
      </Modal>

      <Modal
        open={bulkOpen}
        title="批量标注项目"
        desc="把选中的资源标注到指定项目，便于按项目维度查看与统计"
        width="max-w-md"
        onClose={() => setBulkOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              取消
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            已选中 <span className="font-medium">{selected.length}</span> 个资源
          </p>
          <div className="space-y-2">
            {(projects.data ?? []).map((p) => (
              <Button
                key={p.id}
                variant="outline"
                className="w-full justify-start"
                disabled={bulkAssign.isPending}
                onClick={() => bulkAssign.mutate(p.id)}
              >
                {p.name}
                <span className="ml-auto font-mono text-xs text-slate-400">{p.code}</span>
              </Button>
            ))}
          </div>
          {(projects.data ?? []).length === 0 && (
            <EmptyState title="还没有项目" desc="请先在「需求项目」中创建一个项目" />
          )}
        </div>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        defaultType={query.type ?? ''}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ['resources'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
        }}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['resources'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
          setImportOpen(false);
        }}
      />
    </div>
  );
}

/** 字段级问题清单：定位到 Excel 行号 / 列标 / 字段名 */
function ImportIssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-rose-700">
        <AlertCircle size={14} />
        发现 {issues.length} 处字段问题，请修正 Excel 后重新上传
      </p>
      <div className="max-h-52 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="sticky top-0 bg-rose-100 text-rose-800">
            <tr>
              <th className="w-12 px-3 py-1.5 font-medium">行</th>
              <th className="w-12 font-medium">列</th>
              <th className="w-40 font-medium">字段</th>
              <th className="font-medium">问题</th>
            </tr>
          </thead>
          <tbody>
            {issues.slice(0, 200).map((issue, i) => (
              <tr key={`${issue.row}-${issue.field}-${i}`} className="border-t border-rose-100 text-rose-700">
                <td className="px-3 py-1.5 font-mono">{issue.row}</td>
                <td className="font-mono">{issue.column || '—'}</td>
                <td className="truncate" title={`${issue.label}（${issue.field}）`}>
                  {issue.label ? `${issue.label}（${issue.field}）` : issue.field || '整行'}
                </td>
                <td className="py-1.5 pr-3">{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {issues.length > 200 && (
          <p className="border-t border-rose-100 px-3 py-1.5 text-xs text-rose-600">
            …另有 {issues.length - 200} 处问题未展示
          </p>
        )}
      </div>
    </div>
  );
}

function ImportModal({
  open,
  onClose,
  defaultType,
  onChanged,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  defaultType: string;
  /** 部分行导入成功时刷新列表，但不关闭弹窗 */
  onChanged: () => void;
  onDone: () => void;
}) {
  const dict = useDict();
  const { push } = useToast();
  const [mode, setMode] = useState<'excel' | 'csv'>('excel');
  const [type, setType] = useState<string>(defaultType);
  const [csv, setCsv] = useState('');
  const [onConflict, setOnConflict] = useState<'skip' | 'overwrite'>('skip');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [serverIssues, setServerIssues] = useState<ImportIssue[]>([]);
  const [serverSummary, setServerSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState<'template' | 'parse' | null>(null);
  const [localError, setLocalError] = useState('');

  const columns = useMemo(() => buildImportColumns(type, dict), [type, dict]);
  const requiredColumns = columns.filter((c) => c.required);
  const optionalColumns = columns.filter((c) => !c.required);

  const resetParsed = () => {
    setParsed(null);
    setServerIssues([]);
    setServerSummary(null);
    setLocalError('');
  };

  useEffect(() => {
    if (open) {
      setType(defaultType);
      setCsv('');
      setMode('excel');
      setOnConflict('skip');
      resetParsed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultType]);

  // 资源类型变了，模板列与必填规则也变了，旧的解析结果必须作废
  useEffect(() => {
    resetParsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const mutation = useMutation({
    mutationFn: (payload: { type: string; csv: string; onConflict: 'skip' | 'overwrite' }) =>
      resourcesApi.importCsv(payload),
    onSuccess: (result) => {
      const issues: ImportIssue[] = result.errors.flatMap((error) => {
        const row =
          mode === 'excel' && parsed ? (parsed.rowNumbers[error.row - 2] ?? error.row) : error.row;
        if (error.fields.length === 0) {
          return [{ row, column: '', field: '', label: '', message: error.message }];
        }
        return error.fields.map((field) => {
          const index = mode === 'excel' ? (parsed?.headers.indexOf(field.field) ?? -1) : -1;
          return {
            row,
            column: index >= 0 ? columnLetter(index) : '',
            field: field.field,
            label: field.label,
            message: field.message,
          };
        });
      });

      if (result.errors.length > 0) {
        setServerIssues(issues);
        setServerSummary(
          `本轮：新增 ${result.created} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条，失败 ${result.errors.length} 行。请按下方提示修正后重新上传。`,
        );
        push('info', `有 ${result.errors.length} 行未通过校验，请查看字段级提示`);
        onChanged();
      } else {
        push(
          'success',
          `导入完成：新增 ${result.created} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条`,
        );
        onDone();
      }
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const downloadTemplate = async () => {
    if (!type) {
      push('error', '请先选择资源类型');
      return;
    }
    setBusy('template');
    try {
      await downloadImportTemplate(type, dict.typeLabel(type), columns);
      push(
        'success',
        `已下载「${dict.typeLabel(type)}」导入模板：${requiredColumns.length} 个必填列、${optionalColumns.length} 个选填列`,
      );
    } catch (err) {
      push('error', `模板下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 允许连续上传同一个文件
    event.target.value = '';
    if (!file) return;
    resetParsed();
    if (!/\.xlsx$/i.test(file.name)) {
      setLocalError('请上传 .xlsx 文件；如果是 .xls，请先在 Excel 中另存为 .xlsx');
      return;
    }
    if (!type) {
      setLocalError('请先选择资源类型再上传文件');
      return;
    }
    setBusy('parse');
    try {
      const result = await parseImportFile(file, columns);
      setParsed(result);
      if (result.rows.length === 0) setLocalError('没有读到数据行，请从表头下方一行开始填写');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const csvPayload =
    mode === 'excel'
      ? parsed && parsed.issues.length === 0
        ? importRowsToCsv(parsed.rows, columns)
        : ''
      : csv;
  const blockedByIssues = mode === 'excel' && (parsed?.issues.length ?? 0) > 0;
  const canImport =
    Boolean(type) &&
    Boolean(csvPayload.trim()) &&
    !blockedByIssues &&
    !mutation.isPending &&
    busy === null;

  const doImport = () => {
    if (!canImport) return;
    setServerIssues([]);
    setServerSummary(null);
    mutation.mutate({ type, csv: csvPayload, onConflict });
  };

  const sample = [
    'name,environment,status,owner,' + columns.filter((c) => c.group === 'attr').map((c) => c.key).join(','),
    '示例资源,PROD,IN_USE,张三,',
  ].join('\n');

  return (
    <Modal
      open={open}
      title="批量导入资源"
      desc="选择资源类型 → 下载标注了必填/选填的 Excel 模板 → 填写后上传校验导入"
      width="max-w-3xl"
      onClose={onClose}
      onSave={doImport}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={!canImport} onClick={doImport}>
            <Upload size={14} />
            {mutation.isPending ? '导入中…' : mode === 'excel' ? '校验并导入' : '开始导入'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'excel' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setMode('excel')}
          >
            Excel 模板导入
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'csv' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setMode('csv')}
          >
            粘贴 CSV（原有方式）
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="资源类型" required>
            <Select
              value={type}
              placeholder="请选择资源类型"
              options={dict.typeOptions({ includeDisabled: false })}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
          <Field label="重复数据处理">
            <Select
              value={onConflict}
              options={[
                { value: 'skip', label: '跳过（保持原记录）' },
                { value: 'overwrite', label: '覆盖（更新原记录）' },
              ]}
              onChange={(e) => setOnConflict(e.target.value as 'skip' | 'overwrite')}
            />
          </Field>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700">
              {type ? `「${dict.typeLabel(type)}」模板列` : '请先选择资源类型'}
            </span>
            <span className="text-slate-500">
              共 {columns.length} 列 · 必填 {requiredColumns.length} · 选填 {optionalColumns.length}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {columns.map((c) => (
              <span
                key={c.key}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  c.required
                    ? 'bg-rose-100 font-medium text-rose-700'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200'
                }`}
                title={`${c.key}${c.options?.length ? `｜允许值：${c.options.map((o) => o.value).join(' / ')}` : ''}`}
              >
                {c.required ? '*' : ''}
                {c.label}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            红色带 * 为必填，其余为选填；列与必填规则取自该资源类型的字典属性定义，字典改了模板会同步变化。
          </p>
        </div>

        {mode === 'excel' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                  <FileSpreadsheet size={14} className="text-brand-600" />
                  第 1 步 · 下载 Excel 模板
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  含「资源数据」与「填写说明」两个工作表，必填标红、下拉列已内置可选值
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!type || busy === 'template'}
                onClick={() => void downloadTemplate()}
              >
                <Download size={14} />
                {busy === 'template' ? '生成中…' : '下载模板'}
              </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-slate-700">第 2 步 · 填写后上传 .xlsx 文件</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  上传后会先逐行逐列校验；有问题会列出行号、列标和字段，全部通过后才写入数据库
                </p>
              </div>
              <input
                type="file"
                accept=".xlsx"
                onChange={(e) => void onFile(e)}
                className="block w-full cursor-pointer text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-brand-700 hover:file:bg-brand-100"
              />
              {busy === 'parse' && <p className="text-xs text-slate-500">正在解析并校验 Excel…</p>}
              {parsed && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                  <CheckCircle2 size={14} />
                  已解析「{parsed.fileName}」：{parsed.rows.length} 行数据、{parsed.headers.length} 列
                  {parsed.issues.length === 0 && parsed.rows.length > 0 ? '，校验通过，可以导入' : ''}
                </p>
              )}
              {parsed && parsed.unknownColumns.length > 0 && (
                <p className="text-[11px] text-amber-700">
                  以下列未识别，导入时会被忽略：{parsed.unknownColumns.join('、')}
                </p>
              )}
            </div>
          </div>
        ) : (
          <Field
            label="CSV 内容"
            required
            hint={`公共列：name,environment,status,datacenter,owner,tags,remark；类型专属列：${columns
              .filter((c) => c.group === 'attr')
              .map((c) => c.key)
              .join(', ')}`}
          >
            <Textarea
              className="min-h-40 font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={sample}
            />
          </Field>
        )}

        {localError && <ErrorBanner message={localError} />}
        {serverSummary && <ErrorBanner message={serverSummary} />}
        <ImportIssueList issues={mode === 'excel' ? [...(parsed?.issues ?? []), ...serverIssues] : serverIssues} />
        {blockedByIssues && (
          <p className="text-[11px] text-slate-500">
            修正 Excel 后重新上传即可再次校验；为避免产生半批数据，存在字段问题时不会提交导入。
          </p>
        )}
      </div>
    </Modal>
  );
}
