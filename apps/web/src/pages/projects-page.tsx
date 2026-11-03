import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectDto, type ProjectStatus } from '@dw/shared';
import { projectsApi, type ProjectQuery } from '../lib/endpoints';
import { friendlyMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  ModalCancelButton,
  Pagination,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '../components/ui';

const PAGE_SIZE = 20;

export function ProjectsPage() {
  const { push } = useToast();
  const { can: canDo } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState<ProjectQuery>({ page: 1, pageSize: PAGE_SIZE });
  const [form, setForm] = useState<{ open: boolean; initial: ProjectDto | null }>({ open: false, initial: null });
  const [pendingDelete, setPendingDelete] = useState<ProjectDto | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((prev) => (prev.q === keyword ? prev : { ...prev, q: keyword, page: 1 }));
    }, 350);
    return () => clearTimeout(timer);
  }, [keyword]);

  const list = useQuery({
    queryKey: ['projects', query],
    queryFn: () => projectsApi.list(query),
    placeholderData: keepPreviousData,
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => projectsApi.remove(id),
    onSuccess: () => {
      push('success', '项目已删除');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">需求项目</h1>
          <p className="text-xs text-slate-500">按需求项目组织多套环境（DEV / UAT / PROD），资源可归属到项目</p>
        </div>
        {canWrite && (
          <Button onClick={() => setForm({ open: true, initial: null })}>
            <Plus size={14} />
            新建项目
          </Button>
        )}
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
                  placeholder="搜索项目编码 / 名称 / 负责人"
                />
              </div>
            </Field>
          </div>
          <div className="w-40">
            <Field label="项目状态">
              <Select
                value={query.status ?? ''}
                placeholder="全部"
                options={PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABELS[s] }))}
                onChange={(e) =>
                  setQuery((prev) => ({ ...prev, status: e.target.value || undefined, page: 1 }))
                }
              />
            </Field>
          </div>
        </div>

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
            title="还没有项目"
            desc="新建一个需求项目，再为它创建多套环境并套用模板"
            action={
              canWrite && (
                <Button size="sm" onClick={() => setForm({ open: true, initial: null })}>
                  新建项目
                </Button>
              )
            }
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>编码</Th>
                <Th>项目名称</Th>
                <Th>负责人</Th>
                <Th>环境数</Th>
                <Th>资源数</Th>
                <Th>状态</Th>
                <Th>更新时间</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <Td className="font-mono text-xs text-slate-500">{p.code}</Td>
                <Td>
                  <Link
                    to={`/projects/${p.id}`}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-900 hover:text-brand-700"
                  >
                    <FolderKanban size={14} className="text-brand-600" />
                    {p.name}
                  </Link>
                </Td>
                <Td>{p.owner ?? '—'}</Td>
                <Td>{p.envCount}</Td>
                <Td>{p.resourceCount}</Td>
                <Td>
                  <Badge tone={p.status === 'ACTIVE' ? 'green' : 'gray'}>{PROJECT_STATUS_LABELS[p.status]}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {new Date(p.updatedAt).toLocaleString('zh-CN')}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && (
                      <Button variant="ghost" size="sm" onClick={() => setForm({ open: true, initial: p })}>
                        <Pencil size={13} />
                      </Button>
                    )}
                    {canDelete && (
                      <Button variant="ghost" size="sm" onClick={() => setPendingDelete(p)}>
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
            onChange={(page) => setQuery((prev) => ({ ...prev, page }))}
          />
        )}
      </Card>

      <ProjectFormModal
        open={form.open}
        initial={form.initial}
        onClose={() => setForm((s) => ({ ...s, open: false }))}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="删除项目"
        desc="删除前请先清空该项目下的所有环境"
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
          确认删除项目 <span className="font-medium">{pendingDelete?.name}</span> 吗？删除后其资源的归属会被清空。
        </p>
      </Modal>
    </div>
  );
}

function ProjectFormModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: ProjectDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const isEdit = Boolean(initial);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setCode(initial?.code ?? '');
    setName(initial?.name ?? '');
    setOwner(initial?.owner ?? '');
    setDescription(initial?.description ?? '');
    setStatus(initial?.status ?? 'ACTIVE');
    setError('');
  }, [open, initial]);

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        ...(isEdit ? {} : { code: code || undefined }),
        owner: owner || undefined,
        description: description || undefined,
        status,
      };
      return initial ? projectsApi.update(initial.id, payload) : projectsApi.create(payload);
    },
    onSuccess: () => {
      push('success', isEdit ? '项目已更新' : '项目已创建');
      onSaved();
      onClose();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑项目 · ${initial?.code}` : '新建项目'}
      desc={isEdit ? '修改将记录到变更审计' : '项目编码留空时自动生成'}
      width="max-w-xl"
      onClose={onClose}
      onSave={() => mutation.mutate()}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="项目名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：信贷风控数据集市" />
          </Field>
          <Field label="项目编码" hint={isEdit ? '创建后不可修改' : '留空自动生成'}>
            <Input
              value={code}
              disabled={isEdit}
              onChange={(e) => setCode(e.target.value)}
              placeholder="如：RISK-DM"
            />
          </Field>
          <Field label="负责人">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：张伟" />
          </Field>
          <Field label="项目状态">
            <Select
              value={status}
              options={PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABELS[s] }))}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            />
          </Field>
        </div>
        <Field label="项目说明">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="项目背景、业务范围等" />
        </Field>
      </div>
    </Modal>
  );
}
