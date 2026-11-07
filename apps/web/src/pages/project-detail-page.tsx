import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CalendarClock,
  GanttChartSquare,
  Link2,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Unlink,
} from 'lucide-react';
import { useDict } from '../lib/dict';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ENV_RUN_STATUSES,
  ENV_RUN_STATUS_LABELS,
  RESOURCE_STATUS_LABELS,
  SLOT_OCCUPANCY_STATE_LABELS,
  SLOT_OCCUPANCY_STATE_TONES,
  type EnvRunStatus,
  type EnvSlotDto,
  type ProjectEnvDetail,
  type ProjectEnvDto,
  type ResourceDto,
  type SlotAssignWarning,
} from '@dw/shared';
import { envApi, projectsApi, resourcesApi, templatesApi } from '../lib/endpoints';
import { ApiError, friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  ModalCancelButton,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '../components/ui';
import { EnvBadge } from '../components/env-badge';
import { TimelineChart, toneOfState } from '../components/timeline';

const RUN_TONES: Record<EnvRunStatus, 'gray' | 'blue' | 'green' | 'amber'> = {
  PLANNING: 'gray',
  BUILDING: 'amber',
  RUNNING: 'green',
  OFFLINE: 'gray',
};

/** 占用期限展示：null 统一显示为「长期」 */
function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('zh-CN');
}

/** 以 startAt 为基准顺延若干天，返回 YYYY-MM-DD */
function plusDays(base: string | null | undefined, days: number): string {
  const d = base ? new Date(base) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ProjectDetailPage() {
  const dict = useDict();
  const { id } = useParams();
  const projectId = Number(id);
  const navigate = useNavigate();
  const { push } = useToast();
  const { can: canDo } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const [createOpen, setCreateOpen] = useState(false);
  const [activeEnv, setActiveEnv] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectEnvDto | null>(null);
  const [assignSlot, setAssignSlot] = useState<{ env: ProjectEnvDetail; slot: EnvSlotDto } | null>(null);
  const [pendingDeleteSlot, setPendingDeleteSlot] = useState<EnvSlotDto | null>(null);
  const [pendingDetach, setPendingDetach] = useState<ResourceDto | null>(null);
  const [renewTarget, setRenewTarget] = useState<{ env: ProjectEnvDetail; slot: EnvSlotDto } | null>(null);
  const [editSlot, setEditSlot] = useState<{ env: ProjectEnvDetail; slot: EnvSlotDto } | null>(null);
  const [pendingRelease, setPendingRelease] = useState<{ env: ProjectEnvDetail; slot: EnvSlotDto } | null>(null);
  const [editEnv, setEditEnv] = useState<ProjectEnvDto | null>(null);
  const [envView, setEnvView] = useState<'slots' | 'timeline'>('slots');

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['env'] });
    void queryClient.invalidateQueries({ queryKey: ['resources'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
    enabled: Number.isFinite(projectId),
  });

  const envDetail = useQuery({
    queryKey: ['env', activeEnv],
    queryFn: () => envApi.get(activeEnv!),
    enabled: activeEnv !== null,
  });

  const resources = useQuery({
    queryKey: ['resources', { projectId }],
    queryFn: () => resourcesApi.list({ projectId, pageSize: 50 }),
    enabled: Number.isFinite(projectId),
  });

  const deleteEnv = useMutation({
    mutationFn: (envId: number) => envApi.remove(envId),
    onSuccess: () => {
      push('success', '环境已删除');
      setPendingDelete(null);
      setActiveEnv(null);
      invalidateAll();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const removeSlot = useMutation({
    mutationFn: ({ envId, slotId }: { envId: number; slotId: number }) => envApi.removeSlot(envId, slotId),
    onSuccess: () => {
      push('success', '槽位已删除');
      setPendingDeleteSlot(null);
      invalidateAll();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  /** 一键释放：立即释放占用（含容量），槽位本身保留，等待重新分配 */
  const release = useMutation({
    mutationFn: ({ envId, slotId }: { envId: number; slotId: number }) => envApi.release(envId, slotId),
    onSuccess: () => {
      push('success', '已释放占用，容量已回收');
      setPendingRelease(null);
      invalidateAll();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  // 环境占用时间轴：只在切换到时间轴视图时加载
  const envTimeline = useQuery({
    queryKey: ['env-timeline', activeEnv],
    queryFn: () => envApi.timeline(activeEnv!),
    enabled: activeEnv !== null && envView === 'timeline',
  });

  /**
   * 移出项目：默认只解除主归属；若该资源仍被本项目的环境槽位引用，
   * 列表仍会展示它（并集语义），因此提供「一并解除槽位引用」的选项。
   */
  const detach = useMutation({
    mutationFn: (vars: { resourceId: number; includeSlots: boolean }) =>
      projectsApi.detach(projectId, vars.resourceId, vars.includeSlots),
    onSuccess: (res) => {
      push(
        'success',
        res.unboundSlots > 0
          ? `已移出项目，并解除 ${res.unboundSlots} 个槽位引用`
          : '已取消项目标注',
      );
      setPendingDetach(null);
      invalidateAll();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  if (project.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (project.isError || !project.data) {
    return <ErrorBanner message={friendlyMessage(project.error) || '项目不存在'} />;
  }

  const data = project.data;
  const env = envDetail.data;

  /** 资源 id → 本项目下引用它的槽位数量 */
  const slotRefs = new Map<number, number>();
  for (const ref of data.slotRefs ?? []) {
    slotRefs.set(ref.resourceId, (slotRefs.get(ref.resourceId) ?? 0) + 1);
  }
  /** 本项目超期未释放的占用，按超期天数倒序 */
  const overdueRefs = (data.slotRefs ?? []).filter((r) => r.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays);

  return (
    <div className="space-y-4">
      <Link
        to="/projects"
        className="mb-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-brand-700"
      >
        <ArrowLeft size={13} />
        返回项目列表
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {data.name}
            <Badge tone={data.status === 'ACTIVE' ? 'green' : 'gray'}>
              {data.status === 'ACTIVE' ? '进行中' : '已归档'}
            </Badge>
          </span>
        }
        meta={
          <>
            <p>
              <span className="font-mono">{data.code}</span>
              {data.owner ? ` · 负责人 ${data.owner}` : ''} · {data.envCount} 套环境 · {data.resourceCount} 个资源
            </p>
            {data.description && <p className="mt-1 max-w-2xl">{data.description}</p>}
          </>
        }
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={14} />
              新建环境
            </Button>
          ) : undefined
        }
      />

      {/* 超期资源：过期不自动释放，此处列出本项目超期的资源明细并引导逐个续期或释放 */}
      {(data.overdueCount ?? 0) > 0 && (
        <Card>
          <CardHeader
            title="超期占用资源"
            desc={`本项目有 ${data.overdueCount} 个槽位已超过占用结束时间仍未释放，容量仍在被占用`}
            action={
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
                <AlertTriangle size={11} />
                超期不会自动释放，请续期或释放
              </span>
            }
          />
          <Table
            head={
              <tr>
                <Th>资源</Th>
                <Th>所属环境</Th>
                <Th>槽位</Th>
                <Th>占用结束</Th>
                <Th>超期</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {overdueRefs.map((r) => (
              <tr key={`${r.slotId}-${r.resourceId}`} className="bg-rose-50/30">
                <Td>
                  <button
                    type="button"
                    className="text-left"
                    title="在资源台账中查看该资源"
                    onClick={() => navigate(`/resources?id=${r.resourceId}`)}
                  >
                    <span className="font-mono text-xs text-slate-500">{r.resourceCode ?? `#${r.resourceId}`}</span>{' '}
                    <span className="text-slate-800">{r.resourceName ?? '—'}</span>
                  </button>
                </Td>
                <Td>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-brand-700"
                    title="打开该环境的槽位列表"
                    onClick={() => {
                      setEnvView('slots');
                      setActiveEnv(r.envId);
                    }}
                  >
                    {r.envName}
                    <EnvBadge code={r.environment ?? 'DEV'} label={r.environmentLabel ?? r.environment ?? '—'} />
                  </button>
                </Td>
                <Td className="text-xs text-slate-600">{r.slotRole}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-600">{fmtDate(r.endAt)}</Td>
                <Td>
                  <span className="text-xs font-medium text-rose-600">超期 {r.overdueDays} 天</span>
                </Td>
                <Td className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    title="打开环境并续期 / 释放"
                    onClick={() => {
                      setEnvView('slots');
                      setActiveEnv(r.envId);
                    }}
                  >
                    去处理
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader title="项目环境" desc="一套环境由若干资源槽位组成，可套用模板一键展开" />
        {data.environments.length === 0 ? (
          <EmptyState
            title="还没有环境"
            desc="新建一套环境（可选套用模板自动展开资源槽位）"
            action={
              canWrite && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  新建环境
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
            {data.environments.map((e) => (
              <div
                key={e.id}
                className="rounded-lg border border-slate-200 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
              >
                {/* 标题行放在可点击区域之外：编辑按钮与运行状态徽标同排，互不遮挡 */}
                <div className="flex items-start justify-between gap-2 px-4 pt-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{e.name}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {e.owner ? `负责人 ${e.owner}` : '未指定负责人'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={RUN_TONES[e.status]}>{ENV_RUN_STATUS_LABELS[e.status]}</Badge>
                    {canWrite && (
                      <button
                        type="button"
                        title="编辑环境属性"
                        aria-label={`编辑环境 ${e.name}`}
                        onClick={() => setEditEnv(e)}
                        className="rounded-md border border-slate-200 bg-white p-1 text-slate-400 transition-colors hover:border-brand-300 hover:text-brand-700"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEnvView('slots');
                    setActiveEnv(e.id);
                  }}
                  className="w-full rounded-b-lg px-4 pb-4 pt-2 text-left"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <EnvBadge code={e.environment} label={e.environmentLabel} />
                    {e.templateName ? (
                      <Badge tone="violet">
                        <Boxes size={11} className="mr-1" />
                        {e.templateName}
                      </Badge>
                    ) : (
                      <Badge>自定义</Badge>
                    )}
                  </div>
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>
                        槽位填充 {e.slotFilled}/{e.slotTotal}
                      </span>
                      <span>{e.slotTotal ? Math.round((e.slotFilled / e.slotTotal) * 100) : 0}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{
                          width: `${e.slotTotal ? (e.slotFilled / e.slotTotal) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="项目资源"
          desc="主归属该项目的资源，以及被该项目环境槽位引用的共享资源"
          action={
            canWrite && (
              <Button variant="outline" size="sm" onClick={() => navigate(`/resources?projectId=${projectId}`)}>
                <Tag size={13} />
                在资源台账中筛选
              </Button>
            )
          }
        />
        {(resources.data?.items ?? []).length === 0 ? (
          <EmptyState title="该项目暂无资源" desc="可在环境槽位中分配资源，或在资源台账里批量标注" />
        ) : (
          <Table
            head={
              <tr>
                <Th>编码</Th>
                <Th>名称</Th>
                <Th>类型</Th>
                <Th>关键属性</Th>
                <Th>环境</Th>
                <Th>状态</Th>
                <Th>来源</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {(resources.data?.items ?? []).map((r) => {
              const slotCount = slotRefs.get(r.id) ?? 0;
              const owned = r.projectId === projectId;
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td className="font-mono text-xs text-slate-500">{r.code}</Td>
                  <Td className="font-medium text-slate-900">{r.name}</Td>
                  <Td>
                    <Badge tone="blue">{dict.typeLabel(r.type)}</Badge>
                  </Td>
                  <Td className="max-w-56 text-xs text-slate-600">
                    {(dict.typeColumns(r.type) ?? [])
                      .slice(0, 3)
                      .map((k) => `${k}=${String(r.attrs[k] ?? '—')}`)
                      .join(' · ')}
                  </Td>
                  <Td>
                    <EnvBadge code={r.environment} label={dict.envLabel(r.environment)} />
                  </Td>
                  <Td>{RESOURCE_STATUS_LABELS[r.status]}</Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {owned ? <Badge tone="green">主归属</Badge> : null}
                      {slotCount > 0 ? (
                        <Badge tone="violet">槽位引用 ×{slotCount}</Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="text-right">
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title={slotCount > 0 ? '移出项目（需同时解除槽位引用才会从列表消失）' : '取消项目标注'}
                        aria-label={slotCount > 0 ? `将 ${r.name} 移出项目` : `取消 ${r.name} 的项目标注`}
                        onClick={() => setPendingDetach(r)}
                      >
                        <Unlink size={13} className="text-slate-500" />
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* 环境槽位详情 */}
      <Modal
        open={activeEnv !== null}
        width="max-w-6xl"
        title={env ? `${env.name} · 资源槽位` : '环境详情'}
        desc={env ? `${env.environmentLabel} · 模板 ${env.templateName ?? '自定义'}` : undefined}
        onClose={() => setActiveEnv(null)}
        footer={
          <>
            {canDelete && env && (
              <Button variant="danger" onClick={() => setPendingDelete(env)}>
                <Trash2 size={13} />
                删除环境
              </Button>
            )}
            <div className="flex-1" />
            {canWrite && env && (
              <Button variant="outline" onClick={() => setEditEnv(env)}>
                <Pencil size={13} />
                编辑环境
              </Button>
            )}
            <Button variant="outline" onClick={() => setActiveEnv(null)}>
              关闭
            </Button>
          </>
        }
      >
        {envDetail.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-5 w-5" />
          </div>
        ) : env ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={RUN_TONES[env.status]}>{ENV_RUN_STATUS_LABELS[env.status]}</Badge>
              <EnvBadge code={env.environment} label={env.environmentLabel} />
              <span className="text-xs text-slate-500">
                已填充 {env.slotFilled}/{env.slotTotal} 个槽位
              </span>
              <div className="ml-auto flex rounded-lg border border-slate-200 p-0.5">
                <button
                  type="button"
                  onClick={() => setEnvView('slots')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${
                    envView === 'slots' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <ListTree size={12} />
                  槽位列表
                </button>
                <button
                  type="button"
                  onClick={() => setEnvView('timeline')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${
                    envView === 'timeline' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <GanttChartSquare size={12} />
                  占用时间轴
                </button>
              </div>
            </div>

            {env.overdueCount > 0 && (
              <div className="flex flex-wrap items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-600" />
                <p className="min-w-0 flex-1 text-xs text-rose-800">
                  本环境有 <span className="font-semibold">{env.overdueCount}</span> 个槽位已超期但未释放，
                  容量仍被占用。可对超期槽位「一键续期」或直接「释放」。
                </p>
              </div>
            )}

            {envView === 'slots' ? (
              <>
                <Table
                  head={
                    <tr>
                      <Th>槽位</Th>
                      <Th>需求类型</Th>
                      <Th>已分配资源</Th>
                      <Th>申请容量</Th>
                      <Th>占用起止</Th>
                      <Th>占用状态</Th>
                      <Th className="text-right">操作</Th>
                    </tr>
                  }
                >
                  {env.slots.map((slot) => (
                    <tr key={slot.id} className={slot.overdueDays > 0 ? 'bg-rose-50/40' : undefined}>
                      <Td className="font-medium text-slate-800">
                        <div>{slot.slotRole}</div>
                        {slot.remark ? (
                          <div className="mt-0.5 text-[11px] font-normal text-slate-400">{slot.remark}</div>
                        ) : null}
                      </Td>
                      <Td>
                        <Badge tone="blue">{dict.typeLabel(slot.resourceType)}</Badge>
                      </Td>
                      <Td>
                        {slot.resourceId ? (
                          <span className="text-xs">
                            <span className="font-mono text-slate-500">{slot.resourceCode}</span>{' '}
                            {slot.resourceName}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">待分配</span>
                        )}
                      </Td>
                      <Td>
                        {slot.resourceId && slot.demandAmount !== null ? (
                          <span className="text-xs font-medium text-slate-700">{slot.demandAmount}</span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-slate-600">
                        {slot.resourceId ? (
                          <>
                            {fmtDate(slot.startAt)} → {slot.endAt ? fmtDate(slot.endAt) : '长期'}
                            {slot.notStarted && (
                              <span className="ml-1 rounded bg-brand-50 px-1 py-0.5 text-[10px] font-medium text-brand-700">
                                未开始
                              </span>
                            )}
                            {slot.renewCount > 0 && (
                              <span className="ml-1 text-[11px] text-slate-400">已续 {slot.renewCount} 次</span>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td>
                        {slot.resourceId ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone={SLOT_OCCUPANCY_STATE_TONES[slot.occupancyState ?? 'ACTIVE']}>
                              {SLOT_OCCUPANCY_STATE_LABELS[slot.occupancyState ?? 'ACTIVE']}
                            </Badge>
                            {slot.notStarted && <Badge tone="blue">已预约</Badge>}
                            {slot.overdueDays > 0 && (
                              <span className="text-[11px] font-medium text-rose-600">
                                超期 {slot.overdueDays} 天
                              </span>
                            )}
                          </div>
                        ) : (
                          <Badge tone="amber">待分配</Badge>
                        )}
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1">
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="编辑槽位"
                              aria-label={`编辑槽位 ${slot.slotRole}`}
                              onClick={() => setEditSlot({ env, slot })}
                            >
                              <Pencil size={13} />
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title={slot.resourceId ? '更换资源（原资源的占用容量自动释放）' : '分配资源'}
                              aria-label={slot.resourceId ? `更换槽位 ${slot.slotRole} 的资源` : `为槽位 ${slot.slotRole} 分配资源`}
                              onClick={() => setAssignSlot({ env, slot })}
                            >
                              <Link2 size={13} />
                            </Button>
                          )}
                          {canWrite && slot.resourceId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="续期（顺延或指定新的结束时间）"
                              aria-label={`为槽位 ${slot.slotRole} 续期`}
                              onClick={() => setRenewTarget({ env, slot })}
                            >
                              <CalendarClock size={13} className={slot.overdueDays > 0 ? 'text-rose-600' : 'text-slate-600'} />
                            </Button>
                          )}
                          {canWrite && slot.resourceId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="释放占用（回收容量，槽位保留）"
                              aria-label={`释放槽位 ${slot.slotRole} 的占用`}
                              onClick={() => setPendingRelease({ env, slot })}
                            >
                              <Unlink size={13} className="text-slate-500" />
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="删除槽位"
                              aria-label={`删除槽位 ${slot.slotRole}`}
                              onClick={() => setPendingDeleteSlot(slot)}
                            >
                              <Trash2 size={13} className="text-rose-600" />
                            </Button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </Table>
                {canWrite && (
                  <ApplyTemplateBar
                    envId={env.id}
                    onDone={() => {
                      invalidateAll();
                    }}
                  />
                )}
              </>
            ) : (
              /* 时间轴视图：按时间段展示本环境各槽位的占用与共用情况 */
              <div className="space-y-2">
                {envTimeline.isLoading ? (
                  <div className="flex h-32 items-center justify-center">
                    <Spinner className="h-5 w-5" />
                  </div>
                ) : !envTimeline.data || envTimeline.data.entries.length === 0 ? (
                  <EmptyState title="暂无占用记录" desc="为槽位分配资源后，会在此按时间段展示占用情况" />
                ) : (
                  <>
                    <TimelineChart
                      range={envTimeline.data.range}
                      bars={envTimeline.data.entries.map((e) => ({
                        id: e.slotId,
                        label: `${e.slotRole} · ${e.resourceCode ?? '未绑定'}`,
                        startAt: e.startAt,
                        endAt: e.endAt,
                        tone: e.shared ? 'violet' : toneOfState(e.occupancyState),
                        shared: e.shared,
                        tip: `${e.slotRole}｜${e.resourceCode ?? ''} ${e.resourceName ?? ''}｜${fmtDate(e.startAt)} → ${e.endAt ? fmtDate(e.endAt) : '长期'}${
                          e.notStarted ? '｜尚未开始（容量已占用）' : ''
                        }${e.overdueDays > 0 ? `｜已超期 ${e.overdueDays} 天` : ''}`,
                      }))}
                    />
                    <p className="text-[11px] text-slate-500">
                      紫框表示同一资源在同一时间段被多处占用（并发共用）；红条为首尾已超期、仍占用容量的槽位。
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="环境不存在" />
        )}
      </Modal>

      <EditEnvModal
        env={editEnv}
        onClose={() => setEditEnv(null)}
        onSaved={() => {
          setEditEnv(null);
          invalidateAll();
        }}
      />

      <CreateEnvModal
        open={createOpen}
        projectId={projectId}
        defaultOwner={data.owner ?? ''}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          invalidateAll();
        }}
      />

      <AssignSlotModal
        state={assignSlot}
        onClose={() => setAssignSlot(null)}
        onSaved={() => {
          setAssignSlot(null);
          invalidateAll();
        }}
      />

      <RenewSlotModal
        state={renewTarget}
        onClose={() => setRenewTarget(null)}
        onSaved={() => {
          setRenewTarget(null);
          invalidateAll();
        }}
      />

      <EditSlotModal
        key={editSlot ? `${editSlot.env.id}:${editSlot.slot.id}` : 'closed'}
        state={editSlot}
        onClose={() => setEditSlot(null)}
        onSaved={() => {
          setEditSlot(null);
          invalidateAll();
        }}
      />

      {/* 一键释放：立即回收容量，槽位保留 */}
      <Modal
        open={Boolean(pendingRelease)}
        title="释放资源占用"
        width="max-w-md"
        onClose={() => setPendingRelease(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingRelease(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={release.isPending}
              onClick={() =>
                pendingRelease && release.mutate({ envId: pendingRelease.env.id, slotId: pendingRelease.slot.id })
              }
            >
              {release.isPending ? '释放中…' : '确认释放'}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            确认释放槽位 <span className="font-medium">{pendingRelease?.slot.slotRole}</span> 占用的资源吗？
          </p>
          <p className="text-xs text-slate-500">
            当前占用：{pendingRelease?.slot.resourceCode} {pendingRelease?.slot.resourceName}
            {pendingRelease?.slot.demandAmount !== null ? `（申请 ${pendingRelease?.slot.demandAmount}）` : ''}
            ，占用至 {pendingRelease?.slot.endAt ? fmtDate(pendingRelease.slot.endAt) : '长期'}。
          </p>
          {pendingRelease && pendingRelease.slot.overdueDays > 0 && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              该占用已超期 <span className="font-semibold">{pendingRelease.slot.overdueDays}</span> 天。
              释放后立即回收容量，槽位保留可重新分配。
            </p>
          )}
          <p className="text-xs text-slate-500">释放后槽位变为「待分配」，资源本身不会被删除。</p>
        </div>
      </Modal>

      <Modal
        open={Boolean(pendingDelete)}
        title="删除项目环境"
        desc="槽位与资源绑定关系将一并移除，资源本身不会被删除"
        width="max-w-md"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleteEnv.isPending}
              onClick={() => pendingDelete && deleteEnv.mutate(pendingDelete.id)}
            >
              {deleteEnv.isPending ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          确认删除环境 <span className="font-medium">{pendingDelete?.name}</span> 吗？
        </p>
      </Modal>

      <Modal
        open={Boolean(pendingDeleteSlot)}
        title="删除槽位"
        width="max-w-md"
        onClose={() => setPendingDeleteSlot(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDeleteSlot(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={removeSlot.isPending}
              onClick={() => env && pendingDeleteSlot && removeSlot.mutate({ envId: env.id, slotId: pendingDeleteSlot.id })}
            >
              {removeSlot.isPending ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            确认删除槽位 <span className="font-medium">{pendingDeleteSlot?.slotRole}</span> 吗？
          </p>
          {pendingDeleteSlot?.resourceId ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              该槽位已绑定资源 {pendingDeleteSlot.resourceCode} {pendingDeleteSlot.resourceName}
              {pendingDeleteSlot.demandAmount !== null ? `（占用 ${pendingDeleteSlot.demandAmount}）` : ''}
              ，删除后绑定关系与占用容量一并释放，资源本身不会被删除。
            </p>
          ) : (
            <p className="text-xs text-slate-500">删除后不可恢复，如需重新使用请手动新增槽位。</p>
          )}
        </div>
      </Modal>

      {/* 移出项目：区分「仅取消主归属」与「一并解除槽位引用」 */}
      <Modal
        open={Boolean(pendingDetach)}
        title="移出项目"
        width="max-w-md"
        onClose={() => setPendingDetach(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDetach(null)}>
              取消
            </Button>
            {pendingDetach && (slotRefs.get(pendingDetach.id) ?? 0) > 0 ? (
              <Button
                variant="danger"
                disabled={detach.isPending}
                onClick={() => detach.mutate({ resourceId: pendingDetach.id, includeSlots: true })}
              >
                {detach.isPending ? '处理中…' : '解除槽位并移出'}
              </Button>
            ) : null}
            <Button
              variant={pendingDetach && (slotRefs.get(pendingDetach.id) ?? 0) > 0 ? 'outline' : 'danger'}
              disabled={detach.isPending}
              onClick={() => pendingDetach && detach.mutate({ resourceId: pendingDetach.id, includeSlots: false })}
            >
              {detach.isPending ? '处理中…' : '仅取消项目标注'}
            </Button>
          </>
        }
      >
        {(() => {
          const count = pendingDetach ? (slotRefs.get(pendingDetach.id) ?? 0) : 0;
          return (
            <div className="space-y-2 text-sm text-slate-700">
              <p>
                资源 <span className="font-mono">{pendingDetach?.code}</span>{' '}
                <span className="font-medium">{pendingDetach?.name}</span>
              </p>
              {count > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  该资源还被本项目的 <span className="font-medium">{count}</span> 个环境槽位引用。仅取消项目标注后，它仍会出现在项目资源列表中（主归属 ∪ 槽位引用）；
                  如需彻底移出，请选择「解除槽位并移出」。
                </div>
              ) : (
                <p className="text-xs text-slate-500">取消后该资源将不再属于本项目，资源本身不会被删除。</p>
              )}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

/** 对已有环境追加套用模板 / 手动加槽位 */
function ApplyTemplateBar({ envId, onDone }: { envId: number; onDone: () => void }) {
  const dict = useDict();
  const { push } = useToast();
  const [templateId, setTemplateId] = useState('');
  const [slotRole, setSlotRole] = useState('');
  const [resourceType, setResourceType] = useState<string>(dict.activeTypes[0]?.code ?? 'BATCH_SCHED_SERVER');

  // 字典到位后校正一次：默认值可能不在启用类型里（内置兜底或类型被停用），否则下拉会显示空白
  useEffect(() => {
    if (dict.loading) return;
    const options = dict.typeOptions({ includeDisabled: false });
    if (options.length > 0 && !options.some((o) => o.value === resourceType)) {
      setResourceType(String(options[0]!.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict.loading]);

  const templates = useQuery({ queryKey: ['templates-options'], queryFn: () => templatesApi.options() });

  const apply = useMutation({
    mutationFn: () => envApi.applyTemplate(envId, Number(templateId)),
    onSuccess: () => {
      push('success', '已追加模板槽位');
      setTemplateId('');
      onDone();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const addSlot = useMutation({
    mutationFn: () => envApi.addSlots(envId, { resourceType, slotRole }),
    onSuccess: () => {
      push('success', '已新增槽位');
      setSlotRole('');
      onDone();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3">
      <div className="w-56">
        <Field label="追加套用模板">
          <Select
            value={templateId}
            placeholder="选择模板…"
            options={(templates.data ?? []).map((t) => ({
              value: String(t.id),
              label: `${t.name}（${t.slotCount} 槽位）`,
            }))}
            onChange={(e) => setTemplateId(e.target.value)}
          />
        </Field>
      </div>
      <Button variant="outline" disabled={!templateId || apply.isPending} onClick={() => apply.mutate()}>
        <RefreshCw size={13} />
        追加
      </Button>
      <div className="mx-1 h-8 w-px bg-slate-200" />
      <div className="w-40">
        <Field label="手动槽位类型">
          <Select
            value={resourceType}
            options={dict.typeOptions({ includeDisabled: false })}
            onChange={(e) => setResourceType(e.target.value)}
          />
        </Field>
      </div>
      <div className="w-40">
        <Field label="槽位名称">
          <Input value={slotRole} onChange={(e) => setSlotRole(e.target.value)} placeholder="如：备用调度节点" />
        </Field>
      </div>
      <Button variant="outline" disabled={!slotRole || addSlot.isPending} onClick={() => addSlot.mutate()}>
        <Plus size={13} />
        加槽位
      </Button>
    </div>
  );
}

/**
 * 编辑项目环境：环境创建后仍可修改名称、环境类型、运行状态、负责人与说明。
 * 环境类型变更只影响本环境的标识，不会重建槽位。
 */
function EditEnvModal({ env, onClose, onSaved }: { env: ProjectEnvDto | null; onClose: () => void; onSaved: () => void }) {
  const dict = useDict();
  const { push } = useToast();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [status, setStatus] = useState<EnvRunStatus>('PLANNING');
  const [owner, setOwner] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  // 打开时按当前环境回填
  useEffect(() => {
    if (!env) return;
    setName(env.name);
    setEnvironment(env.environment);
    setStatus(env.status);
    setOwner(env.owner ?? '');
    setDescription(env.description ?? '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      envApi.update(env!.id, {
        name,
        environment,
        status,
        owner: owner || null,
        description: description || null,
      }),
    onSuccess: () => {
      push('success', '环境已更新');
      onSaved();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  const submit = () => {
    if (!env) return;
    if (!name.trim()) {
      setError('请填写环境名称');
      return;
    }
    setError('');
    mutation.mutate();
  };

  return (
    <Modal
      open={Boolean(env)}
      title={`编辑环境 · ${env?.name ?? ''}`}
      desc="环境创建后仍可修改属性；槽位与已分配资源不受影响"
      width="max-w-2xl"
      onClose={onClose}
      onSave={submit}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={mutation.isPending} onClick={submit}>
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="环境名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：生产环境" />
          </Field>
          <Field label="环境类型" required>
            <Select
              value={environment}
              options={dict.envOptions()}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </Field>
          <Field label="运行状态">
            <Select
              value={status}
              options={ENV_RUN_STATUSES.map((s) => ({ value: s, label: ENV_RUN_STATUS_LABELS[s] }))}
              onChange={(e) => setStatus(e.target.value as EnvRunStatus)}
            />
          </Field>
          <Field label="负责人">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：张伟" />
          </Field>
        </div>
        <Field label="环境说明">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用途、上线窗口等" />
        </Field>
        <p className="text-[11px] text-slate-500">
          环境编码 {env ? <span className="font-mono">{env.environment}</span> : null}
          {env?.templateName ? ` · 套用模板 ${env.templateName}` : ' · 自定义环境'}，槽位填充 {env?.slotFilled ?? 0}/
          {env?.slotTotal ?? 0}
        </p>
      </div>
    </Modal>
  );
}

/** 新建环境：可选择一个模板自动展开槽位 */
function CreateEnvModal({
  open,
  projectId,
  defaultOwner,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: number;
  defaultOwner: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dict = useDict();
  const { push } = useToast();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [environment, setEnvironment] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [owner, setOwner] = useState(defaultOwner);
  const [status, setStatus] = useState<EnvRunStatus>('PLANNING');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  // 打开弹窗时按当前环境字典回填默认名称，让项目环境名称与字典保持一致
  useEffect(() => {
    if (!open) return;
    const first = dict.activeEnvironments[0]?.code ?? '';
    setEnvironment(first);
    setNameTouched(false);
    setName(first ? `${dict.envLabel(first)}环境` : '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dict.activeEnvironments.map((e) => `${e.code}:${e.label}`).join(',')]);

  const templates = useQuery({
    queryKey: ['templates-options'],
    queryFn: () => templatesApi.options(),
    enabled: open,
  });
  const picked = (templates.data ?? []).find((t) => String(t.id) === templateId);

  const mutation = useMutation({
    mutationFn: () =>
      projectsApi.createEnv(projectId, {
        name,
        environment,
        templateId: templateId ? Number(templateId) : undefined,
        owner: owner || undefined,
        status,
        description: description || undefined,
      }),
    onSuccess: (env) => {
      push('success', `环境已创建，生成 ${env.slotTotal} 个槽位`);
      setName('');
      setNameTouched(false);
      setDescription('');
      onSaved();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  return (
    <Modal
      open={open}
      title="新建项目环境"
      desc="选择模板后会自动展开对应数量的资源槽位，创建完成后再逐个分配资源"
      width="max-w-2xl"
      onClose={onClose}
      onSave={() => mutation.mutate()}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={!name || !environment || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? '创建中…' : '创建环境'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="环境名称" required hint="默认取自环境字典，改字典后可一键同步">
            <Input
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              placeholder="如：生产环境"
            />
          </Field>
          <Field label="环境类型" required>
            <Select
              value={environment}
              placeholder="请选择环境"
              options={dict.envOptions({ includeDisabled: false })}
              onChange={(e) => {
                setEnvironment(e.target.value);
                if (!nameTouched) setName(`${dict.envLabel(e.target.value)}环境`);
              }}
            />
          </Field>
          <Field label="套用模板" hint="留空则创建空白环境">
            <Select
              value={templateId}
              placeholder="不套用模板"
              options={(templates.data ?? []).map((t) => ({
                value: String(t.id),
                label: `${t.name}（${t.slotCount} 槽位）`,
              }))}
              onChange={(e) => setTemplateId(e.target.value)}
            />
          </Field>
          <Field label="运行状态">
            <Select
              value={status}
              options={ENV_RUN_STATUSES.map((s) => ({ value: s, label: ENV_RUN_STATUS_LABELS[s] }))}
              onChange={(e) => setStatus(e.target.value as EnvRunStatus)}
            />
          </Field>
          <Field label="负责人">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：张伟" />
          </Field>
        </div>

        {picked && (
          <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3">
            <p className="text-xs font-medium text-brand-800">
              模板「{picked.name}」将展开 {picked.slotCount} 个槽位
            </p>
            <ul className="mt-2 space-y-1">
              {(picked.description ? [picked.description] : []).map((d) => (
                <li key={d} className="text-[11px] text-brand-700">
                  {d}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Field label="环境说明">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用途、上线窗口等" />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * 槽位分配资源：
 * - 放开环境限制，支持跨环境引用（如准生产环境引用开发环境资源），但会显著提示
 * - 资源已被其他项目占用时展示占用明细
 * - 资源设置了容量时必须填写申请量，且不能超过剩余可用
 */
function AssignSlotModal({
  state,
  onClose,
  onSaved,
}: {
  state: { env: ProjectEnvDetail; slot: EnvSlotDto } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [resourceId, setResourceId] = useState('');
  const [amount, setAmount] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<SlotAssignWarning[]>([]);
  /** 保存成功后自增：告诉弹窗「内容已落库」，不要再提示未保存 */
  const [savedSeq, setSavedSeq] = useState(0);

  const slot = state?.slot;
  const candidates = useQuery({
    queryKey: ['slot-candidates', slot?.id, startAt, endAt],
    queryFn: () =>
      envApi.candidates(state!.env.id, slot!.id, {
        startAt: startAt || undefined,
        endAt: endAt || undefined,
      }),
    enabled: Boolean(slot),
  });

  // 打开时：已绑定资源则沿用原占用区间（换资源不重置期限），未绑定则从今天开始、长期
  useEffect(() => {
    if (!slot) return;
    setResourceId('');
    setAmount('');
    setStartAt(slot.startAt ? slot.startAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
    setEndAt(slot.endAt ? slot.endAt.slice(0, 10) : '');
    setWarnings([]);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot?.id]);

  // 切换资源时重置申请量，并给出该资源剩余容量的默认值
  useEffect(() => {
    setAmount('');
    setWarnings([]);
    setError('');
  }, [resourceId]);

  const picked = (candidates.data?.items ?? []).find((c) => String(c.resource.id) === resourceId);

  const assign = useMutation({
    mutationFn: () =>
      envApi.assign(state!.env.id, slot!.id, {
        resourceId: Number(resourceId),
        amount: amount === '' ? null : Number(amount),
        acknowledge: warnings.length > 0,
        startAt: startAt || null,
        // 结束时间为空即「不定期限的长期占用」
        endAt: endAt || null,
      }),
    onSuccess: (res) => {
      push(
        'success',
        res.warnings.length > 0
          ? `槽位已绑定资源（${res.warnings.length} 项提示已确认）`
          : '槽位已绑定资源',
      );
      setResourceId('');
      setAmount('');
      setWarnings([]);
      // 绑定即保存：先清掉未保存标记，再关闭，避免多余的「未保存」提示
      setSavedSeq((s) => s + 1);
      onSaved();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const next = (err.details as { warnings?: SlotAssignWarning[] } | undefined)?.warnings ?? [];
        if (next.length > 0) {
          setWarnings(next);
          setError('');
          return;
        }
      }
      setError(friendlyMessage(err));
    },
  });

  if (!state || !slot) return null;

  const demandRequired = picked?.demandRequired ?? false;
  // 结束时间必须晚于开始时间（长期占用的结束时间为空，不受此限）
  const periodInvalid = Boolean(startAt && endAt && new Date(endAt) <= new Date(startAt));
  const canSubmit =
    Boolean(resourceId) &&
    !periodInvalid &&
    !assign.isPending &&
    (!demandRequired || (amount !== '' && Number(amount) > 0));

  return (
    <Modal
      open
      width="max-w-2xl"
      title={`为「${slot.slotRole}」${slot.resourceId ? '更换资源' : '分配资源'}`}
      desc={
        slot.resourceId
          ? '更换后原资源的占用容量立即释放，占用起止默认沿用原区间，可在此调整'
          : '支持跨环境引用（会明确提示）；资源设置了容量时需填写申请量'
      }
      onClose={onClose}
      onSave={() => canSubmit && assign.mutate()}
      dirtyResetKey={savedSeq}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={!canSubmit || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending ? '提交中…' : warnings.length > 0 ? '我已确认，继续保存' : slot.resourceId ? '确认更换' : '确认绑定'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorBanner message={error} />}
        {slot.resourceId && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p>
              当前绑定：<span className="font-mono text-slate-500">{slot.resourceCode}</span> {slot.resourceName}
              {slot.demandAmount !== null ? `（占用 ${slot.demandAmount}）` : ''}
            </p>
            <p className="mt-0.5 text-slate-500">
              选择另一个资源并保存即完成更换：原资源释放占用，新资源按下方时间段计费/计量。
            </p>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">
              该资源存在 {warnings.length} 项引用提示，请确认后再绑定
            </p>
            {warnings.map((w) => (
              <div key={w.code} className="text-xs text-amber-800">
                <p>{w.message}</p>
                {w.references.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {w.references.map((r) => (
                      <li key={`${r.slotId}`} className="list-disc">
                        {r.projectName ?? '未归属项目'} / {r.envName}
                        <span className="text-amber-700">（{r.environmentLabel}）</span> · 槽位「{r.slotRole}」
                        {r.amount !== null ? ` · 占用 ${r.amount}` : ''}
                        {r.startAt ? ` · ${fmtDate(r.startAt)} → ${r.endAt ? fmtDate(r.endAt) : '长期'}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {w.capacity && (
                  <p className="mt-1 text-amber-700">
                    总容量 {w.capacity.total}
                    {w.capacity.unit ? ` ${w.capacity.unit}` : ''} · 已占用 {w.capacity.allocated} ·
                    剩余 {w.capacity.available}
                    {w.capacity.requested !== null ? ` · 本次申请 ${w.capacity.requested}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 占用期限：结束时间留空即不定期限的长期占用 */}
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <p className="text-xs font-semibold text-slate-700">占用期限</p>
            <span className="text-[11px] text-slate-400">结束时间留空即「不定期限的长期占用」</span>
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="开始时间">
              <Input type="date" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </Field>
            <Field label="结束时间" hint={endAt ? undefined : '长期占用'}>
              <Input type="date" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-500">快捷：</span>
            {[90, 180, 365].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setEndAt(plusDays(startAt, d))}
                className="rounded-md px-2 py-0.5 text-[11px] text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50"
              >
                {d} 天
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEndAt('')}
              className={`rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset ${
                endAt === ''
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'text-slate-600 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              长期
            </button>
            <span className="ml-1 text-[11px] text-slate-400">
              期限仅用于超期提醒，不会自动释放占用
            </span>
          </div>
        </div>

        {periodInvalid && (
          <p className="text-xs text-rose-600">结束时间必须晚于开始时间</p>
        )}

        {demandRequired && (
          <div className="w-64">
            <Field
              label={`申请容量${picked?.capacity?.unit ? `（${picked.capacity.unit}）` : ''}`}
              required
              hint={
                picked?.capacity
                  ? `总容量 ${picked.capacity.total}，已占用 ${picked.capacity.allocated}，剩余 ${picked.capacity.available}`
                  : undefined
              }
            >
              <Input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="如：1024"
              />
            </Field>
          </div>
        )}

        {candidates.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner className="h-5 w-5" />
          </div>
        ) : (candidates.data?.items ?? []).length === 0 ? (
          <EmptyState title="没有符合要求的资源" desc="请先在资源台账中新增对应类型的资源" />
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {(candidates.data?.items ?? []).map((c) => (
              <label
                key={c.resource.id}
                className={[
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm',
                  resourceId === String(c.resource.id)
                    ? 'border-brand-400 bg-brand-50'
                    : 'border-slate-200 hover:bg-slate-50',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="slot-resource"
                  className="mt-1 h-3.5 w-3.5 accent-brand-600"
                  checked={resourceId === String(c.resource.id)}
                  onChange={() => setResourceId(String(c.resource.id))}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-slate-500">{c.resource.code}</span>
                    <span className="text-slate-800">{c.resource.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={c.resource.status === 'IN_USE' ? 'green' : 'gray'}>
                      {c.resource.statusLabel}
                    </Badge>
                    <Badge tone={c.crossEnvironment ? 'amber' : 'gray'}>
                      {c.resource.environmentLabel}
                      {c.crossEnvironment ? ' · 跨环境' : ''}
                    </Badge>
                    {c.usedByOtherProject && (
                      <Badge tone="violet">已被其他项目引用 ×{c.usedBy.length}</Badge>
                    )}
                    {c.capacity && (
                      <Badge tone="blue">
                        容量 {c.capacity.allocated}/{c.capacity.total}
                        {c.capacity.unit ? ` ${c.capacity.unit}` : ''}
                      </Badge>
                    )}
                  </div>
                  {c.usedBy.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                      {c.usedBy.slice(0, 3).map((r) => (
                        <li key={r.slotId}>
                          {r.projectName ?? '未归属项目'} / {r.envName}（{r.environmentLabel}）· 「{r.slotRole}」
                          {r.amount !== null ? ` · 占用 ${r.amount}` : ''}
                          {r.startAt ? ` · ${fmtDate(r.startAt)} → ${r.endAt ? fmtDate(r.endAt) : '长期'}` : ''}
                        </li>
                      ))}
                      {c.usedBy.length > 3 && <li>…等 {c.usedBy.length} 处引用</li>}
                    </ul>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 编辑槽位的需求类型、名称与备注；已绑定资源的槽位不允许直接改类型。 */
function EditSlotModal({
  state,
  onClose,
  onSaved,
}: {
  state: { env: ProjectEnvDetail; slot: EnvSlotDto } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dict = useDict();
  const { push } = useToast();
  const [resourceType, setResourceType] = useState(state?.slot.resourceType ?? '');
  const [slotRole, setSlotRole] = useState(state?.slot.slotRole ?? '');
  const [remark, setRemark] = useState(state?.slot.remark ?? '');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      envApi.updateSlot(state!.env.id, state!.slot.id, {
        resourceType,
        slotRole,
        remark: remark.trim() || null,
      }),
    onSuccess: () => {
      push('success', '槽位信息已更新');
      onSaved();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  const typeLocked = Boolean(state?.slot.resourceId);
  const invalid = !resourceType || !slotRole.trim();

  return (
    <Modal
      open={Boolean(state)}
      width="max-w-xl"
      title={`编辑槽位 · ${state?.slot.slotRole ?? ''}`}
      desc="可修改槽位名称和备注；未绑定资源时也可调整需求资源类型"
      onClose={onClose}
      onSave={() => !invalid && mutation.mutate()}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={invalid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? '保存中…' : '保存修改'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Field
          label="需求资源类型"
          required
          hint={typeLocked ? '槽位已绑定资源，需先释放或更换资源后才能修改类型' : undefined}
        >
          <Select
            value={resourceType}
            disabled={typeLocked}
            options={dict.typeOptions({ includeDisabled: typeLocked })}
            onChange={(e) => setResourceType(e.target.value)}
          />
        </Field>
        <Field label="槽位名称" required>
          <Input value={slotRole} onChange={(e) => setSlotRole(e.target.value)} placeholder="如：备用调度节点" />
        </Field>
        <Field label="备注" hint="用于补充槽位用途、配额说明或交付要求">
          <Textarea value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * 续期弹窗：
 * - 顺延 N 天（已超期时从当前时间起算，避免续了还是过期）
 * - 指定新的结束日期
 * - 转为长期（不设结束时间）
 * 超期后资源不会被自动释放，这里是一键挽回的入口。
 */
function RenewSlotModal({
  state,
  onClose,
  onSaved,
}: {
  state: { env: ProjectEnvDetail; slot: EnvSlotDto } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [mode, setMode] = useState<'days' | 'date' | 'forever'>('days');
  const [days, setDays] = useState('90');
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  /** 保存成功后自增：清除未保存标记 */
  const [savedSeq, setSavedSeq] = useState(0);
  const slot = state?.slot;

  // 每次打开重置为默认「顺延 90 天」
  useEffect(() => {
    if (!state) return;
    setMode('days');
    setDays('90');
    setDate('');
    setError('');
  }, [state?.slot.id]);

  const renew = useMutation({
    mutationFn: () => {
      const body =
        mode === 'forever'
          ? { endAt: null }
          : mode === 'date'
            ? { endAt: date }
            : { days: Number(days) };
      return envApi.renew(state!.env.id, state!.slot.id, body);
    },
    onSuccess: (res) => {
      push('success', res.message ?? '已续期');
      setSavedSeq((s) => s + 1);
      onSaved();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  if (!state || !slot) return null;

  const invalid =
    (mode === 'days' && (!days || Number(days) < 1)) ||
    (mode === 'date' && !date);

  return (
    <Modal
      open
      width="max-w-lg"
      title={`为「${slot.slotRole}」续期`}
      desc={`${slot.resourceCode ?? ''} ${slot.resourceName ?? ''}`}
      onClose={onClose}
      onSave={() => !invalid && renew.mutate()}
      dirtyResetKey={savedSeq}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={invalid || renew.isPending} onClick={() => renew.mutate()}>
            {renew.isPending ? '提交中…' : '确认续期'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorBanner message={error} />}

        <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
          <p>
            当前占用：{fmtDate(slot.startAt)} → {slot.endAt ? fmtDate(slot.endAt) : '长期'}
            {slot.renewCount > 0 ? ` · 已续 ${slot.renewCount} 次` : ''}
          </p>
          {slot.overdueDays > 0 && (
            <p className="mt-1 font-medium text-rose-600">
              已超期 {slot.overdueDays} 天，容量仍被占用，续期后立即恢复正常。
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {([
            ['days', '顺延若干天'],
            ['date', '指定结束日期'],
            ['forever', '转为长期'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-dirty="1"
              onClick={() => setMode(value)}
              className={`rounded-lg px-2.5 py-1 text-xs ring-1 ring-inset ${
                mode === value
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'text-slate-600 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'days' && (
          <div className="space-y-2">
            <div className="w-40">
              <Field label="顺延天数" required hint="已超期时从今天重新起算">
                <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[30, 90, 180, 365].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(String(d))}
                  className="rounded-md px-2 py-0.5 text-[11px] text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50"
                >
                  +{d} 天
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'date' && (
          <div className="w-52">
            <Field label="新的结束日期" required hint="必须晚于占用开始时间">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
        )}

        {mode === 'forever' && (
          <p className="rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
            转为长期占用后不再有结束时间，时间轴上会显示为「长期」，不会产生超期提醒。
          </p>
        )}
      </div>
    </Modal>
  );
}
