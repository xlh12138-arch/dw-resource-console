import type {
  DictReferences,
  DictSyncResult,
  EnvSlotDto,
  EnvTemplateDetail,
  EnvTemplateDto,
  EnvTimeline,
  ProjectDetail,
  ProjectDto,
  ProjectEnvDetail,
  ProjectEnvDto,
  EnvironmentDto,
  ResourceChild,
  ResourceDetail,
  ResourceDto,
  ResourceTimeline,
  ResourceTypeDetail,
  ResourceTypeDto,
  SlotAssignWarning,
  SlotCandidates,
} from '@dw/shared';
import { api, type AuditLogDto, type StatsOverview, type UserDto } from './api';

export interface Paged<T> {
  items: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ResourceQuery {
  q?: string;
  type?: string;
  environment?: string;
  status?: string;
  datacenter?: string;
  owner?: string;
  /** 标签：支持逗号分隔多值（同时包含） */
  tag?: string;
  projectId?: number;
  projectEnvId?: number;
  /** 按资源 id 精确定位（子资源跳父资源时只看该资源） */
  id?: number;
  /** 逗号分隔的 id 集合：导出勾选资源时只取这些 id */
  ids?: string;
  /** 只看某父资源下的子资源 */
  parentId?: number;
  /** 只看顶层资源（不含子资源） */
  rootOnly?: boolean;
  unassigned?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?:
    | 'updatedAt'
    | 'createdAt'
    | 'name'
    | 'code'
    | 'type'
    | 'environment'
    | 'status'
    | 'datacenter'
    | 'owner'
    | `attr:${string}`;
  sortOrder?: 'asc' | 'desc';
}

function toQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const resourcesApi = {
  list: (query: ResourceQuery) => api.get<Paged<ResourceDto>>(`/resources${toQuery(query)}`),
  /** 详情：额外返回容量明细、被引用情况与父子层级 */
  get: (id: number) => api.get<ResourceDetail>(`/resources/${id}`),
  create: (body: unknown) => api.post<ResourceDto>('/resources', body),
  update: (id: number, body: unknown) => api.patch<ResourceDto>(`/resources/${id}`, body),
  remove: (id: number) => api.del<{ id: number }>(`/resources/${id}`),
  checkIp: (ip: string) =>
    api.get<{ ip: string; available: boolean; conflicts: { code: string; name: string; typeLabel: string }[] }>(
      `/resources/check-ip${toQuery({ ip })}`,
    ),
  exportCsv: (query: ResourceQuery) => api.text(`/resources/export${toQuery(query)}`),
  importCsv: (body: { type: string; csv: string; onConflict: 'skip' | 'overwrite' }) =>
    api.post<{
      total: number;
      created: number;
      updated: number;
      skipped: number;
      errors: {
        row: number;
        message: string;
        /** 出问题字段；空数组表示无法定位到具体列 */
        fields: { field: string; label: string; message: string }[];
      }[];
    }>('/resources/import', body),
  audit: (id: number) =>
    api.get<{ action: string; actorName: string; createdAt: string; changes: unknown }[]>(`/resources/${id}/audit`),
  /** 子资源清单 */
  children: (id: number) => api.get<ResourceChild[]>(`/resources/${id}/children`),
  /** 资源占用时间轴（跨项目 / 跨环境，含超期与共用） */
  timeline: (id: number) => api.get<ResourceTimeline>(`/resources/${id}/timeline`),
  /** 标签清单（台账筛选与标签云） */
  tags: () => api.get<{ tag: string; count: number }[]>('/resources/tags'),
  /** 存量资源批量标注到某个项目 */
  bulkAssign: (body: { ids: number[]; projectId: number | null; projectEnvId?: number | null }) =>
    api.post<{ updated: number; ids: number[] }>('/resources/bulk-assign', body),
};

/* ------------------------------- 项目 / 项目环境 ------------------------------- */

export interface ProjectQuery {
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export const projectsApi = {
  list: (query: ProjectQuery) => api.get<Paged<ProjectDto>>(`/projects${toQuery(query)}`),
  options: () => api.get<ProjectDto[]>('/projects/options'),
  get: (id: number) => api.get<ProjectDetail>(`/projects/${id}`),
  create: (body: {
    name: string;
    code?: string;
    owner?: string;
    description?: string;
    status?: string;
  }) => api.post<ProjectDto>('/projects', body),
  update: (id: number, body: { name?: string; owner?: string; description?: string; status?: string }) =>
    api.patch<ProjectDto>(`/projects/${id}`, body),
  remove: (id: number) => api.del<{ id: number }>(`/projects/${id}`),
  envs: (projectId: number) => api.get<ProjectEnvDto[]>(`/projects/${projectId}/environments`),
  createEnv: (projectId: number, body: Record<string, unknown>) =>
    api.post<ProjectEnvDetail>(`/projects/${projectId}/environments`, body),
  /** 把资源移出项目；includeSlots=true 时一并解除该项目下的槽位引用 */
  detach: (projectId: number, resourceId: number, includeSlots: boolean) =>
    api.post<{
      resourceId: number;
      unlabeled: boolean;
      unboundSlots: number;
      remainingSlotRefs: number;
    }>(`/projects/${projectId}/resources/${resourceId}/detach`, { includeSlots }),
};

export const envApi = {
  get: (id: number) => api.get<ProjectEnvDetail>(`/project-environments/${id}`),
  update: (id: number, body: Record<string, unknown>) =>
    api.patch<ProjectEnvDetail>(`/project-environments/${id}`, body),
  remove: (id: number) => api.del<{ id: number }>(`/project-environments/${id}`),
  addSlots: (id: number, body: { resourceType: string; slotRole: string; quantity?: number }) =>
    api.post<ProjectEnvDetail>(`/project-environments/${id}/slots`, body),
  updateSlot: (
    id: number,
    slotId: number,
    body: { resourceType?: string; slotRole?: string; remark?: string | null },
  ) =>
    api.patch<{ slot: EnvSlotDto; env: ProjectEnvDetail }>(
      `/project-environments/${id}/slots/${slotId}`,
      body,
    ),
  /** 槽位候选资源：含跨环境 / 已被占用 / 时间重叠 / 容量余量提示 */
  candidates: (id: number, slotId: number, period?: { startAt?: string; endAt?: string }) =>
    api.get<SlotCandidates>(`/project-environments/${id}/slots/${slotId}/candidates${toQuery(period ?? {})}`),
  /** 绑定资源：amount 为申请的容量，startAt/endAt 为占用期限（endAt 为空表示长期） */
  assign: (
    id: number,
    slotId: number,
    body: {
      resourceId: number;
      amount?: number | null;
      acknowledge?: boolean;
      startAt?: string | null;
      endAt?: string | null;
    },
  ) =>
    api.post<{ slot: EnvSlotDto; env: ProjectEnvDetail; warnings: SlotAssignWarning[] }>(
      `/project-environments/${id}/slots/${slotId}/assign`,
      body,
    ),
  unassign: (id: number, slotId: number) =>
    api.del<{ slot: EnvSlotDto; env: ProjectEnvDetail }>(`/project-environments/${id}/slots/${slotId}/assign`),
  /** 续期：endAt 为新的结束时间（null 表示长期），days 为顺延天数 */
  renew: (id: number, slotId: number, body: { endAt?: string | null; days?: number }) =>
    api.post<{ slot: EnvSlotDto; env: ProjectEnvDetail; message: string }>(
      `/project-environments/${id}/slots/${slotId}/renew`,
      body,
    ),
  /** 释放：立即释放占用（含容量），槽位保留 */
  release: (id: number, slotId: number) =>
    api.post<{ slot: EnvSlotDto; env: ProjectEnvDetail }>(
      `/project-environments/${id}/slots/${slotId}/release`,
      {},
    ),
  /** 调整占用期限 */
  updatePeriod: (id: number, slotId: number, body: { startAt?: string | null; endAt?: string | null }) =>
    api.patch<{ slot: EnvSlotDto; env: ProjectEnvDetail }>(
      `/project-environments/${id}/slots/${slotId}/period`,
      body,
    ),
  /** 环境占用时间轴 */
  timeline: (id: number) => api.get<EnvTimeline>(`/project-environments/${id}/timeline`),
  removeSlot: (id: number, slotId: number) =>
    api.del<ProjectEnvDetail>(`/project-environments/${id}/slots/${slotId}`),
  applyTemplate: (id: number, templateId: number) =>
    api.post<ProjectEnvDetail>(`/project-environments/${id}/apply-template`, { templateId }),
};

/* ------------------------------- 环境模板 ------------------------------- */

export interface TemplateItemInput {
  resourceType: string;
  slotRole: string;
  quantity: number;
  required: boolean;
  remark?: string;
}

export const templatesApi = {
  list: (query: { q?: string; page?: number; pageSize?: number }) =>
    api.get<Paged<EnvTemplateDto>>(`/env-templates${toQuery(query)}`),
  options: () => api.get<EnvTemplateDto[]>('/env-templates/options'),
  get: (id: number) => api.get<EnvTemplateDetail>(`/env-templates/${id}`),
  create: (body: { name: string; code?: string; description?: string; items: TemplateItemInput[] }) =>
    api.post<EnvTemplateDetail>('/env-templates', body),
  update: (
    id: number,
    body: { name?: string; description?: string; items?: TemplateItemInput[] },
  ) => api.patch<EnvTemplateDetail>(`/env-templates/${id}`, body),
  remove: (id: number) => api.del<{ id: number }>(`/env-templates/${id}`),
  clone: (id: number) => api.post<EnvTemplateDetail>(`/env-templates/${id}/clone`),
  instantiate: (
    id: number,
    body: { projectId: number; name: string; environment: string; owner?: string; description?: string },
  ) => api.post<ProjectEnvDetail>(`/env-templates/${id}/instantiate`, body),
};

export const statsApi = {
  overview: () => api.get<StatsOverview>('/stats/overview'),
};

export const auditApi = {
  list: (query: { action?: string; actor?: string; targetType?: string; page?: number; pageSize?: number }) =>
    api.get<Paged<AuditLogDto>>(`/audit-logs${toQuery(query)}`),
};

export const usersApi = {
  list: () => api.get<Paged<UserDto>>('/users'),
  create: (body: { username: string; password: string; displayName: string; role: string }) =>
    api.post<UserDto>('/users', body),
  update: (id: number, body: { displayName?: string; role?: string; status?: string }) =>
    api.patch<UserDto>(`/users/${id}`, body),
  /** 应由管理员调用；返回重置后的明文密码，仅本次可见 */
  resetPassword: (id: number) =>
    api.post<{ user: UserDto; password: string }>(`/users/${id}/reset-password`, undefined),
};

export const metaApi = {
  get: () =>
    api.get<{
      resourceTypes: { value: string; label: string; prefix: string }[];
      environments: { value: string; label: string; tone: string }[];
      statuses: { value: string; label: string }[];
      roles: { value: string; label: string }[];
        attrFields: Record<
          string,
          {
            key: string;
            label: string;
            kind: string;
            required?: boolean;
            defaultValue?: string;
            unit?: string;
            options?: { value: string; label: string }[];
          }[]
        >;
      typeColumns: Record<string, string[]>;
    }>('/meta'),
};

/* ------------------------------- 字典配置 ------------------------------- */

export interface ResourceTypeFieldInput {
  id?: number;
  key: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
  unit?: string;
  isIp: boolean;
  sortOrder: number;
}

export interface ResourceTypeInput {
  code: string;
  label: string;
  prefix: string;
  description?: string;
  ipUniqueByPort?: boolean;
  listColumns?: string[];
  enabled?: boolean;
  sortOrder?: number;
  fields: ResourceTypeFieldInput[];
}

export interface ResourceTypeUpdatePayload extends Partial<ResourceTypeInput> {
  sync?: boolean;
  keyRenames?: { from: string; to: string }[];
  dropUnknownFields?: boolean;
}

/** 环境字典写操作的返回：字典本体 + 编码同步结果 + 名称同步情况 */
export interface EnvironmentMutationResult {
  detail: EnvironmentDto;
  sync: DictSyncResult | null;
  references: DictReferences | null;
  pendingNameSync: number;
  nameSynced: number;
}

export interface EnvironmentInput {
  code: string;
  label: string;
  tone?: string;
  description?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export const dictApi = {
  types: (includeDisabled = true) =>
    api.get<ResourceTypeDto[]>(`/resource-types${toQuery({ includeDisabled })}`),
  typeOptions: () => api.get<{ value: string; label: string; prefix: string }[]>('/resource-types/options'),
  type: (code: string) => api.get<ResourceTypeDetail>(`/resource-types/${code}`),
  typeReferences: (code: string) => api.get<DictReferences>(`/resource-types/${code}/references`),
  createType: (body: ResourceTypeInput) =>
    api.post<{ detail: ResourceTypeDetail; sync: DictSyncResult | null; pendingAttrSync: number; references: DictReferences | null }>(
      '/resource-types',
      body,
    ),
  updateType: (code: string, body: ResourceTypeUpdatePayload) =>
    api.patch<{ detail: ResourceTypeDetail; sync: DictSyncResult | null; pendingAttrSync: number; references: DictReferences | null }>(
      `/resource-types/${code}`,
      body,
    ),
  removeType: (code: string, migrateTo?: string) =>
    api.del<DictSyncResult>(`/resource-types/${code}`, migrateTo ? { migrateTo } : undefined),
  syncTypeAttrs: (code: string, body: { keyRenames?: { from: string; to: string }[]; dropUnknown?: boolean }) =>
    api.post<{ updated: number; pending: number }>(`/resource-types/${code}/sync-attrs`, body),

  environments: (includeDisabled = true) => api.get<EnvironmentDto[]>(`/environments${toQuery({ includeDisabled })}`),
  environmentOptions: () => api.get<{ value: string; label: string; tone: string }[]>('/environments/options'),
  environmentReferences: (code: string) => api.get<DictReferences>(`/environments/${code}/references`),
  createEnvironment: (body: EnvironmentInput) => api.post<EnvironmentMutationResult>('/environments', body),
  updateEnvironment: (
    code: string,
    body: Partial<EnvironmentInput> & { sync?: boolean; syncNames?: boolean },
  ) => api.patch<EnvironmentMutationResult>(`/environments/${code}`, body),
  removeEnvironment: (code: string, migrateTo?: string) =>
    api.del<DictSyncResult>(`/environments/${code}`, migrateTo ? { migrateTo } : undefined),
};
