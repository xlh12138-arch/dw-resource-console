import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Copy, Pencil, Plus, Rocket, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type EnvTemplateDto,
} from '@dw/shared';
import { useDict } from '../lib/dict';
import { projectsApi, templatesApi, type TemplateItemInput } from '../lib/endpoints';
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
  Switch,
  Table,
  Td,
  Th,
} from '../components/ui';

const PAGE_SIZE = 20;

export function TemplatesPage() {
  const dict = useDict();
  void dict;
  const { push } = useToast();
  const { can: canDo } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const [query, setQuery] = useState({ page: 1, pageSize: PAGE_SIZE });
  const [form, setForm] = useState<{ open: boolean; initial: EnvTemplateDto | null }>({ open: false, initial: null });
  const [pendingDelete, setPendingDelete] = useState<EnvTemplateDto | null>(null);
  const [instantiate, setInstantiate] = useState<EnvTemplateDto | null>(null);

  const list = useQuery({
    queryKey: ['templates', query],
    queryFn: () => templatesApi.list(query),
    placeholderData: keepPreviousData,
  });

  const clone = useMutation({
    mutationFn: (id: number) => templatesApi.clone(id),
    onSuccess: () => {
      push('success', '模板已复制');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => templatesApi.remove(id),
    onSuccess: () => {
      push('success', '模板已删除');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">项目环境模板</h1>
        </div>
        {canWrite && (
          <Button onClick={() => setForm({ open: true, initial: null })}>
            <Plus size={14} />
            新建模板
          </Button>
        )}
      </div>

      <Card>
        {list.isError && (
          <div className="p-5">
            <ErrorBanner message={friendlyMessage(list.error)} />
          </div>
        )}
        {list.isLoading ? (
          <div className="flex h-56 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="还没有环境模板"
            desc="把常见的资源组合沉淀成模板，建环境时直接套用"
            action={
              canWrite && (
                <Button size="sm" onClick={() => setForm({ open: true, initial: null })}>
                  新建模板
                </Button>
              )
            }
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>编码</Th>
                <Th>模板名称</Th>
                <Th>资源组合</Th>
                <Th>槽位数</Th>
                <Th>被引用</Th>
                <Th>更新时间</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {rows.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <Td className="font-mono text-xs text-slate-500">{t.code}</Td>
                <Td className="font-medium text-slate-900">{t.name}</Td>
                <Td className="max-w-md">
                  <TemplateCombination id={t.id} />
                </Td>
                <Td>{t.slotCount}</Td>
                <Td>{t.usageCount}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {new Date(t.updatedAt).toLocaleString('zh-CN')}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setInstantiate(t)}>
                          <Rocket size={13} className="text-brand-600" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setForm({ open: true, initial: t })}>
                          <Pencil size={13} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => clone.mutate(t.id)}>
                          <Copy size={13} />
                        </Button>
                      </>
                    )}
                    {canDelete && (
                      <Button variant="ghost" size="sm" onClick={() => setPendingDelete(t)}>
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

      <TemplateFormModal
        open={form.open}
        initial={form.initial}
        onClose={() => setForm((s) => ({ ...s, open: false }))}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['templates'] });
          void queryClient.invalidateQueries({ queryKey: ['templates-options'] });
        }}
      />

      <InstantiateModal
        template={instantiate}
        onClose={() => setInstantiate(null)}
        onCreated={(projectId) => {
          setInstantiate(null);
          void queryClient.invalidateQueries({ queryKey: ['templates'] });
          return projectId;
        }}
      />

      <Modal
        open={Boolean(pendingDelete)}
        title="删除模板"
        desc="已被项目环境引用的模板需先解除引用"
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
          确认删除模板 <span className="font-medium">{pendingDelete?.name}</span> 吗？
        </p>
      </Modal>
    </div>
  );
}

/** 列表里展示模板的资源组合（按需加载明细） */
function TemplateCombination({ id }: { id: number }) {
  const dict = useDict();
  const detail = useQuery({
    queryKey: ['template', id],
    queryFn: () => templatesApi.get(id),
    staleTime: 30_000,
  });
  if (detail.isLoading) return <span className="text-xs text-slate-400">加载中…</span>;
  const items = detail.data?.items ?? [];
  if (items.length === 0) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i.id} tone="blue">
          {dict.typeLabel(i.resourceType)}×{i.quantity}
          <span className="ml-1 text-[10px] text-slate-500">{i.slotRole}</span>
        </Badge>
      ))}
    </div>
  );
}

/** 新建 / 编辑模板：核心是资源类型自由组合 */
function TemplateFormModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: EnvTemplateDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dict = useDict();
  const { push } = useToast();
  const isEdit = Boolean(initial);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<TemplateItemInput[]>([]);
  const [error, setError] = useState('');
  const hydratedTemplateId = useRef<number | null>(null);

  const detail = useQuery({
    queryKey: ['template', initial?.id],
    queryFn: () => templatesApi.get(initial!.id),
    enabled: Boolean(initial) && open,
  });

  useEffect(() => {
    if (!open) return;
    hydratedTemplateId.current = null;
    setCode(initial?.code ?? '');
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setItems(initial ? [] : [{ resourceType: '', slotRole: '', quantity: 1, required: true }]);
    setError('');
  }, [open, initial]);

  // 详情只回填一次，避免查询刷新覆盖用户刚添加或删除的资源行。
  useEffect(() => {
    if (!open || !initial || !detail.data || hydratedTemplateId.current === initial.id) return;
    hydratedTemplateId.current = initial.id;
    setItems(
      detail.data.items.map((item) => ({
        resourceType: item.resourceType,
        slotRole: item.slotRole,
        quantity: item.quantity,
        required: item.required,
        remark: item.remark ?? undefined,
      })),
    );
  }, [open, initial, detail.data]);

  const totalSlots = items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
  const itemsInvalid = items.some((item) => !item.resourceType || !item.slotRole.trim());

  const patchItem = (index: number, patch: Partial<TemplateItemInput>) =>
    setItems((prev) => prev.map((it, idx) => (idx === index ? { ...it, ...patch } : it)));

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        ...(isEdit ? {} : { code: code || undefined }),
        description: description || undefined,
        items: items.map((i) => ({
          resourceType: i.resourceType,
          slotRole: i.slotRole,
          quantity: Number(i.quantity) || 1,
          required: Boolean(i.required),
          remark: i.remark || undefined,
        })),
      };
      return initial ? templatesApi.update(initial.id, payload) : templatesApi.create(payload);
    },
    onSuccess: () => {
      push('success', isEdit ? '模板已更新' : '模板已创建');
      onSaved();
      onClose();
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  return (
    <Modal
      open={open}
      width="max-w-4xl"
      title={isEdit ? `编辑模板 · ${initial?.code}` : '新建项目环境模板'}
      desc="每个条目表示一类资源的需求：槽位名称用于区分用途，数量决定展开出的槽位个数"
      onClose={onClose}
      onSave={() => mutation.mutate()}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">
            共 {items.length} 类资源 · 展开 {totalSlots} 个槽位
          </span>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button disabled={!name || items.length === 0 || itemsInvalid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? '保存中…' : '保存模板'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="模板名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：标准数仓项目-生产" />
          </Field>
          <Field label="模板编码" hint={isEdit ? '创建后不可修改' : '留空自动生成'}>
            <Input value={code} disabled={isEdit} onChange={(e) => setCode(e.target.value)} placeholder="如：STD-PROD" />
          </Field>
          <Field label="模板说明">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="适用场景" />
          </Field>
        </div>

        <div className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <Boxes size={13} />
              资源组合
            </p>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isEdit && detail.isLoading}
              onClick={() =>
                setItems((prev) => [
                  ...prev,
                  { resourceType: '', slotRole: '', quantity: 1, required: true },
                ])
              }
            >
              <Plus size={13} />
              添加资源类型
            </Button>
          </div>
          <div className="divide-y divide-slate-100">
            {isEdit && detail.isLoading ? (
              <div className="flex h-24 items-center justify-center">
                <Spinner className="h-5 w-5" />
              </div>
            ) : items.map((item, index) => (
              <div key={index} className="flex flex-wrap items-end gap-3 px-4 py-3">
                <div className="w-52">
                  <Field label="资源类型">
                    <Select
                      value={item.resourceType}
                      placeholder="请选择资源类型"
                      options={dict.typeOptions()}
                      onChange={(e) =>
                        patchItem(index, {
                          resourceType: e.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
                <div className="w-48">
                  <Field label="槽位名称">
                    <Input
                      value={item.slotRole}
                      onChange={(e) => patchItem(index, { slotRole: e.target.value })}
                      placeholder="如：调度主节点"
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field label="数量">
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={item.quantity}
                      onChange={(e) => patchItem(index, { quantity: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                <div className="flex h-9 items-center">
                  <Switch
                    checked={item.required}
                    label="是否必需"
                    hint={item.required ? '必需' : '可选'}
                    onChange={(next) => patchItem(index, { required: next })}
                  />
                </div>
                <div className="ml-auto flex h-9 items-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={items.length === 1}
                    onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== index))}
                  >
                    <Trash2 size={13} className="text-rose-600" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          提示：数量大于 1 时，套用模板会自动展开为「槽位名称-1、槽位名称-2 …」多个槽位，便于逐个分配实际资源。
        </p>
      </div>
    </Modal>
  );
}

/** 直接套用模板在某个项目下创建环境 */
function InstantiateModal({
  template,
  onClose,
  onCreated,
}: {
  template: EnvTemplateDto | null;
  onClose: () => void;
  onCreated: (projectId: number) => number;
}) {
  const dict = useDict();
  const { push } = useToast();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<string>('DEV');
  const [owner, setOwner] = useState('');
  const [error, setError] = useState('');

  const projects = useQuery({
    queryKey: ['projects-options'],
    queryFn: () => projectsApi.options(),
    enabled: Boolean(template),
  });

  useEffect(() => {
    if (template) {
      setName('');
      setProjectId('');
      setOwner('');
      setError('');
    }
  }, [template]);

  // 字典到位后校正一次默认环境，避免默认值不在候选项里时下拉显示空白
  useEffect(() => {
    if (dict.loading) return;
    const options = dict.envOptions({ includeDisabled: false });
    if (options.length > 0 && !options.some((o) => o.value === environment)) {
      setEnvironment(String(options[0]!.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict.loading]);

  const mutation = useMutation({
    mutationFn: () =>
      templatesApi.instantiate(template!.id, {
        projectId: Number(projectId),
        name,
        environment,
        owner: owner || undefined,
      }),
    onSuccess: (env) => {
      push('success', `已在项目下创建环境，生成 ${env.slotTotal} 个槽位`);
      const pid = onCreated(env.projectId);
      navigate(`/projects/${pid}`);
    },
    onError: (err) => setError(friendlyMessage(err)),
  });

  return (
    <Modal
      open={Boolean(template)}
      width="max-w-xl"
      title={`套用模板 · ${template?.name ?? ''}`}
      desc={`将展开 ${template?.slotCount ?? 0} 个资源槽位，创建后再逐个分配实际资源`}
      onClose={onClose}
      onSave={() => mutation.mutate()}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button
            disabled={!projectId || !name || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? '创建中…' : '创建环境'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="目标项目" required>
            <Select
              value={projectId}
              placeholder="请选择项目"
              options={(projects.data ?? []).map((p) => ({
                value: String(p.id),
                label: `${p.name}（${p.code}）`,
              }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </Field>
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
          <Field label="负责人">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：张伟" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
