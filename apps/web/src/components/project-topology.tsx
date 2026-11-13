import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  LocateFixed,
  Maximize2,
  Minimize2,
  Network,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { ENV_RUN_STATUS_LABELS, type ProjectDetail, type ResourceDto } from '@dw/shared';
import { friendlyMessage } from '../lib/api';
import { useDict } from '../lib/dict';
import { envApi } from '../lib/endpoints';
import { Badge, ErrorBanner, Modal, ModalCancelButton, Spinner, cn } from './ui';

const RESOURCE_STATUS_DOTS: Record<ResourceDto['status'], string> = {
  IDLE: 'bg-slate-400',
  RESERVED: 'bg-brand-400',
  IN_USE: 'bg-emerald-500',
  MAINTAINING: 'bg-amber-500',
  RETIRED: 'bg-rose-500',
};

const TYPE_ACCENTS = [
  'bg-signal-400',
  'bg-brand-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-sky-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-slate-500',
] as const;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const DRAG_THRESHOLD = 4;
const MAX_VISIBLE_CLUSTER_ROWS = 6;
const CLUSTER_CHROME_HEIGHT = 54;

const ENV_CANVAS = { width: 1120, height: 660 };
const RESOURCE_CANVAS_WIDTH = 1320;
const PROJECT_NODE = { width: 248, height: 122 };
const ENV_NODE = { width: 226, height: 98 };
const RESOURCE_ENV_NODE = { width: 286, height: 106 };
const CLUSTER = { width: 390, gap: 26, margin: 54, top: 198 };

interface TopologyResource {
  id: number;
  code: string;
  name: string;
  status: ResourceDto['status'];
  type: string;
  slotRoles: Set<string>;
  slotCount: number;
  sharedAcrossEnvironments: boolean;
}

interface ResourceTypeCluster {
  type: string;
  label: string;
  resources: TopologyResource[];
  accent: string;
  order: number;
}

interface PositionedCluster extends ResourceTypeCluster {
  x: number;
  y: number;
  height: number;
}

interface NodeOffset {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clusterHeight(resourceCount: number): number {
  const rows = Math.min(MAX_VISIBLE_CLUSTER_ROWS, Math.max(1, Math.ceil(resourceCount / 2)));
  return CLUSTER_CHROME_HEIGHT + 20 + rows * 44 + Math.max(0, rows - 1) * 5;
}

function TopologyIconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-[background-color,border-color,color,transform] hover:-translate-y-px hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0',
        active && 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700',
      )}
    >
      {children}
    </button>
  );
}

export function ProjectTopologyModal({
  open,
  project,
  onClose,
  onOpenResource,
}: {
  open: boolean;
  project: ProjectDetail;
  onClose: () => void;
  onOpenResource: (resourceId: number) => void;
}) {
  const dict = useDict();
  const [drillEnvId, setDrillEnvId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, NodeOffset>>({});
  const [draggingNodeKey, setDraggingNodeKey] = useState<string | null>(null);
  const [compactViewport, setCompactViewport] = useState(false);
  const [hoveredEnvId, setHoveredEnvId] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const nodeDragCleanupRef = useRef<(() => void) | null>(null);

  const drillEnvironment = project.environments.find((env) => env.id === drillEnvId) ?? null;
  const envDetail = useQuery({
    queryKey: ['env', drillEnvironment?.id],
    queryFn: () => envApi.get(drillEnvironment!.id),
    enabled: open && drillEnvironment !== null,
  });

  useEffect(() => {
    if (open) return;
    setDrillEnvId(null);
    setFullscreen(false);
    setHoveredEnvId(null);
    setDraggingNodeKey(null);
    setNodeOffsets({});
    nodeDragCleanupRef.current?.();
    nodeDragCleanupRef.current = null;
  }, [open]);

  useEffect(() => {
    setNodeOffsets({});
    setDraggingNodeKey(null);
    nodeDragCleanupRef.current?.();
    nodeDragCleanupRef.current = null;
  }, [drillEnvId]);

  useEffect(
    () => () => {
      nodeDragCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (drillEnvId !== null && !project.environments.some((env) => env.id === drillEnvId)) {
      setDrillEnvId(null);
    }
  }, [drillEnvId, project.environments]);

  const resourceReferences = new Map<number, Set<number>>();
  for (const reference of project.slotRefs) {
    const environments = resourceReferences.get(reference.resourceId) ?? new Set<number>();
    environments.add(reference.envId);
    resourceReferences.set(reference.resourceId, environments);
  }

  const resources = new Map<number, TopologyResource>();
  let assignedSlotCount = 0;
  for (const slot of envDetail.data?.slots ?? []) {
    if (slot.resourceId === null) continue;
    assignedSlotCount += 1;
    const current = resources.get(slot.resourceId) ?? {
      id: slot.resourceId,
      code: slot.resourceCode ?? `#${slot.resourceId}`,
      name: slot.resourceName ?? '未命名资源',
      status: slot.resourceStatus ?? 'IDLE',
      type: slot.resourceType,
      slotRoles: new Set<string>(),
      slotCount: 0,
      sharedAcrossEnvironments: (resourceReferences.get(slot.resourceId)?.size ?? 0) > 1,
    };
    current.slotRoles.add(slot.slotRole);
    current.slotCount += 1;
    resources.set(slot.resourceId, current);
  }

  const resourceNodes = [...resources.values()].sort(
    (a, b) =>
      dict.typeLabel(a.type).localeCompare(dict.typeLabel(b.type), 'zh-CN') ||
      a.code.localeCompare(b.code, 'zh-CN', { numeric: true }),
  );

  const typeOrder = new Map(
    dict.resourceTypes.map((type, index) => [type.code, type.sortOrder ?? index]),
  );
  const groupedResources = new Map<string, TopologyResource[]>();
  for (const resource of resourceNodes) {
    const group = groupedResources.get(resource.type) ?? [];
    group.push(resource);
    groupedResources.set(resource.type, group);
  }
  const typeClusters: ResourceTypeCluster[] = [...groupedResources.entries()]
    .map(([type, items]) => ({
      type,
      label: dict.typeLabel(type),
      resources: items,
      accent: TYPE_ACCENTS[(typeOrder.get(type) ?? 0) % TYPE_ACCENTS.length],
      order: typeOrder.get(type) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.order - b.order);

  const positionedClusters: PositionedCluster[] = [];
  if (drillEnvironment && typeClusters.length > 0) {
    const columnHeights = [0, 0, 0];
    const columnOffsets = [0, 24, 12];
    const packingOrder = [...typeClusters].sort(
      (a, b) => b.resources.length - a.resources.length || a.order - b.order,
    );
    for (const cluster of packingOrder) {
      const column = columnHeights.indexOf(Math.min(...columnHeights));
      const height = clusterHeight(cluster.resources.length);
      positionedClusters.push({
        ...cluster,
        x: CLUSTER.margin + column * (CLUSTER.width + CLUSTER.gap),
        y: CLUSTER.top + columnHeights[column] + columnOffsets[column],
        height,
      });
      columnHeights[column] += height + 18;
    }
  }

  const drillCanvasHeight = Math.max(
    720,
    CLUSTER.top +
      Math.max(
        0,
        ...positionedClusters.map((cluster) => cluster.y - CLUSTER.top + cluster.height),
      ) +
      70,
  );
  const canvasWidth = drillEnvironment ? RESOURCE_CANVAS_WIDTH : ENV_CANVAS.width;
  const canvasHeight = drillEnvironment ? drillCanvasHeight : ENV_CANVAS.height;

  const fitGraph = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const padding = 24;
    const scale = clamp(
      Math.min(
        (viewport.clientWidth - padding * 2) / canvasWidth,
        (viewport.clientHeight - padding * 2) / canvasHeight,
        1.05,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    setZoom(scale);
    setPan({
      x: (viewport.clientWidth - canvasWidth * scale) / 2,
      y: Math.max(18, (viewport.clientHeight - canvasHeight * scale) / 2),
    });
  }, [canvasHeight, canvasWidth]);

  const resetGraph = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const padding = 24;
    const fitScale = Math.min(
      (viewport.clientWidth - padding * 2) / canvasWidth,
      (viewport.clientHeight - padding * 2) / canvasHeight,
      1.05,
    );
    const scale = clamp(Math.max(fitScale, drillEnvironment ? 0.65 : 0.68), MIN_ZOOM, MAX_ZOOM);
    setZoom(scale);
    setPan({
      x: (viewport.clientWidth - canvasWidth * scale) / 2,
      y: Math.max(18, (viewport.clientHeight - canvasHeight * scale) / 2),
    });
  }, [canvasHeight, canvasWidth, drillEnvironment]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (fullscreen) fitGraph();
      else resetGraph();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    open,
    drillEnvironment?.id,
    envDetail.dataUpdatedAt,
    fullscreen,
    compactViewport,
    fitGraph,
    resetGraph,
  ]);

  useEffect(() => {
    if (!open) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      setCompactViewport(viewport.clientWidth < 640);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (fullscreen) fitGraph();
        else resetGraph();
      });
    });
    observer.observe(viewport);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, fullscreen, fitGraph, resetGraph]);

  const applyZoom = (next: number, anchorX?: number, anchorY?: number) => {
    const viewport = viewportRef.current;
    const nextZoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (!viewport || Math.abs(nextZoom - zoom) < 0.001) return;
    const x = anchorX ?? viewport.clientWidth / 2;
    const y = anchorY ?? viewport.clientHeight / 2;
    setPan((current) => ({
      x: x - (x - current.x) * (nextZoom / zoom),
      y: y - (y - current.y) * (nextZoom / zoom),
    }));
    setZoom(nextZoom);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    applyZoom(
      zoom * (event.deltaY > 0 ? 0.9 : 1.1),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const offsetOf = (key: string): NodeOffset => nodeOffsets[key] ?? { x: 0, y: 0 };

  const beginNodeDrag = (key: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    nodeDragCleanupRef.current?.();
    const origin = offsetOf(key);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const blockClick = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      setDraggingNodeKey(null);
      nodeDragCleanupRef.current = null;
    };
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setDraggingNodeKey(key);
      }
      moveEvent.preventDefault();
      setNodeOffsets((current) => ({
        ...current,
        [key]: {
          x: origin.x + deltaX,
          y: origin.y + deltaY,
        },
      }));
    };
    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (moved) {
        window.addEventListener('click', blockClick, true);
        window.setTimeout(() => window.removeEventListener('click', blockClick, true), 0);
      }
      cleanup();
    };

    nodeDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  const requestClose = () => {
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    onClose();
  };

  if (!open) return null;

  const projectCenter = { x: ENV_CANVAS.width / 2, y: ENV_CANVAS.height / 2 };
  const projectOffset = offsetOf('project');
  const projectPosition = {
    x: projectCenter.x + projectOffset.x,
    y: projectCenter.y + projectOffset.y,
  };
  const environmentCount = project.environments.length;
  const environmentStartAngle =
    environmentCount === 2
      ? compactViewport
        ? -Math.PI / 2
        : -Math.PI / 4
      : environmentCount === 4
        ? -Math.PI / 4
        : -Math.PI / 2;
  const environmentRadiusX =
    compactViewport && environmentCount <= 2 ? 0 : compactViewport ? 150 : 392;
  const environmentRadiusY =
    compactViewport && environmentCount <= 2
      ? 222
      : compactViewport
        ? 196
        : environmentCount === 1
          ? 0
          : 232;
  const environmentNodes = project.environments.map((env, index) => {
    const angle =
      environmentCount === 1 ? 0 : environmentStartAngle + (index * Math.PI * 2) / environmentCount;
    const offset = offsetOf(`env:${env.id}`);
    const centerX = projectCenter.x + Math.cos(angle) * environmentRadiusX + offset.x;
    const centerY = projectCenter.y + Math.sin(angle) * environmentRadiusY + offset.y;
    return {
      env,
      centerX,
      centerY,
      left: centerX - ENV_NODE.width / 2,
      top: centerY - ENV_NODE.height / 2,
      color: dict.envColor(env.environment) ?? 'var(--color-brand-600)',
    };
  });

  const drillCenterX = RESOURCE_CANVAS_WIDTH / 2;
  const baseDrillEnvTop = 38;
  const drillEnvOffset = offsetOf('resource-env');
  const drillEnvCenterX = drillCenterX + drillEnvOffset.x;
  const drillEnvTop = baseDrillEnvTop + drillEnvOffset.y;
  const drillEnvColor =
    (drillEnvironment && dict.envColor(drillEnvironment.environment)) ?? 'var(--color-brand-600)';
  const movedClusters = positionedClusters.map((cluster) => {
    const offset = offsetOf(`type:${cluster.type}`);
    return {
      ...cluster,
      x: cluster.x + offset.x,
      y: cluster.y + offset.y,
    };
  });
  const resourceTypeCount = typeClusters.length;

  return (
    <Modal
      open
      width="max-w-[calc(100vw-2rem)]"
      title={`资源拓扑 · ${project.name}`}
      onClose={requestClose}
      footer={<ModalCancelButton onClick={onClose}>关闭</ModalCancelButton>}
    >
      <div
        className={cn(
          'flex min-w-0 flex-col gap-3',
          fullscreen && 'fixed inset-0 z-[55] overflow-hidden bg-[#f5f4f0] p-3 sm:p-5',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {drillEnvironment && (
              <TopologyIconButton label="返回环境层级" onClick={() => setDrillEnvId(null)}>
                <ArrowLeft size={15} />
              </TopologyIconButton>
            )}
            <div className="min-w-0">
              <p className="text-[10px] text-slate-400">
                {drillEnvironment ? '环境资源' : '项目视图'}
              </p>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                <p className="truncate text-sm font-medium text-slate-900">
                  {drillEnvironment ? drillEnvironment.name : project.name}
                </p>
                {drillEnvironment && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: drillEnvColor }}
                  />
                )}
              </div>
            </div>
            <div className="ml-1 hidden items-center gap-1.5 text-[11px] text-slate-400 sm:flex">
              {drillEnvironment ? (
                <>
                  <span>{resourceTypeCount} 类资源</span>
                  <span>·</span>
                  <span>{resourceNodes.length} 个资源</span>
                  <span>·</span>
                  <span>{assignedSlotCount} 个槽位</span>
                </>
              ) : (
                <>
                  <span>{environmentCount} 个环境</span>
                  <span>·</span>
                  <span>{project.slotRefs.length} 个槽位引用</span>
                </>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <TopologyIconButton
              label="缩小"
              onClick={() => applyZoom(zoom / 1.15)}
              disabled={zoom <= MIN_ZOOM + 0.001}
            >
              <ZoomOut size={15} />
            </TopologyIconButton>
            <span
              className="w-12 text-center font-mono text-[10px] tabular-nums text-slate-500"
              aria-live="polite"
            >
              {Math.round(zoom * 100)}%
            </span>
            <TopologyIconButton
              label="放大"
              onClick={() => applyZoom(zoom * 1.15)}
              disabled={zoom >= MAX_ZOOM - 0.001}
            >
              <ZoomIn size={15} />
            </TopologyIconButton>
            <TopologyIconButton label="适应画布" onClick={fitGraph}>
              <LocateFixed size={15} />
            </TopologyIconButton>
            <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden="true" />
            <TopologyIconButton
              label={fullscreen ? '退出全屏' : '全屏'}
              active={fullscreen}
              onClick={() => setFullscreen((current) => !current)}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </TopologyIconButton>
            {fullscreen && (
              <TopologyIconButton label="关闭拓扑" onClick={onClose}>
                <X size={15} />
              </TopologyIconButton>
            )}
          </div>
        </div>

        {envDetail.isError ? <ErrorBanner message={friendlyMessage(envDetail.error)} /> : null}

        {environmentCount === 0 ? (
          <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-xs text-slate-500">
            项目还没有环境
          </div>
        ) : (
          <div
            ref={viewportRef}
            tabIndex={0}
            role="application"
            aria-label={`${project.name}资源拓扑`}
            onWheel={handleWheel}
            onKeyDown={(event) => {
              if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                applyZoom(zoom * 1.15);
              } else if (event.key === '-') {
                event.preventDefault();
                applyZoom(zoom / 1.15);
              } else if (event.key === '0') {
                event.preventDefault();
                fitGraph();
              }
            }}
            className={cn(
              'console-grid relative min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal-400',
              fullscreen ? 'flex-1' : 'h-[calc(100vh-230px)] min-h-[430px]',
            )}
            style={{ userSelect: 'none' }}
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{
                width: canvasWidth,
                height: canvasHeight,
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                willChange: 'transform',
              }}
            >
              <svg
                className="pointer-events-none absolute inset-0"
                width={canvasWidth}
                height={canvasHeight}
                viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                aria-hidden="true"
              >
                {drillEnvironment ? (
                  <>
                    {movedClusters.map((cluster, index) => {
                      const startX = drillEnvCenterX;
                      const startY = drillEnvTop + RESOURCE_ENV_NODE.height;
                      const endX = cluster.x + CLUSTER.width / 2;
                      const endY = cluster.y - 2;
                      const midY = startY + (endY - startY) * 0.52;
                      return (
                        <path
                          key={cluster.type}
                          d={`M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`}
                          fill="none"
                          stroke="var(--color-slate-300)"
                          strokeLinecap="round"
                          strokeOpacity={0.72 - (index % 4) * 0.08}
                          strokeWidth="1.4"
                        />
                      );
                    })}
                  </>
                ) : (
                  <>
                    <ellipse
                      cx={projectCenter.x}
                      cy={projectCenter.y}
                      rx={environmentRadiusX}
                      ry={environmentRadiusY || 1}
                      fill="none"
                      stroke="var(--color-slate-300)"
                      strokeDasharray="4 8"
                      strokeOpacity="0.7"
                    />
                    {environmentNodes.map((node) => (
                      <path
                        key={node.env.id}
                        d={`M ${projectPosition.x} ${projectPosition.y} C ${
                          (projectPosition.x + node.centerX) / 2
                        } ${projectPosition.y}, ${(projectPosition.x + node.centerX) / 2} ${
                          node.centerY
                        }, ${node.centerX} ${node.centerY}`}
                        fill="none"
                        stroke={node.color}
                        strokeLinecap="round"
                        strokeOpacity={hoveredEnvId === node.env.id ? 0.62 : 0.28}
                        strokeWidth={hoveredEnvId === node.env.id ? 2 : 1.35}
                      />
                    ))}
                  </>
                )}
              </svg>

              {drillEnvironment ? (
                <>
                  <div
                    title="拖动环境节点"
                    onPointerDown={(event) => beginNodeDrag('resource-env', event)}
                    className={cn(
                      'absolute flex cursor-grab flex-col justify-center rounded-[10px] border border-slate-200 bg-white px-4 shadow-[0_12px_30px_rgba(23,24,21,0.10)]',
                      draggingNodeKey === 'resource-env' && 'cursor-grabbing',
                    )}
                    style={{
                      left: drillEnvCenterX - RESOURCE_ENV_NODE.width / 2,
                      top: drillEnvTop,
                      width: RESOURCE_ENV_NODE.width,
                      height: RESOURCE_ENV_NODE.height,
                      borderLeft: `4px solid ${drillEnvColor}`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-[15px] font-medium text-slate-900">
                        {drillEnvironment.name}
                      </p>
                      <Badge tone="blue">{assignedSlotCount} 槽位</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {drillEnvironment.environmentLabel} ·{' '}
                      {ENV_RUN_STATUS_LABELS[drillEnvironment.status]}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {resourceTypeCount} 类资源 · {resourceNodes.length} 个节点
                    </p>
                  </div>

                  {movedClusters.map((cluster) => (
                    <section
                      key={cluster.type}
                      title={`拖动${cluster.label}资源簇`}
                      onPointerDown={(event) => beginNodeDrag(`type:${cluster.type}`, event)}
                      className={cn(
                        'absolute cursor-grab overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm',
                        draggingNodeKey === `type:${cluster.type}` && 'cursor-grabbing',
                      )}
                      style={{
                        left: cluster.x,
                        top: cluster.y,
                        width: CLUSTER.width,
                        height: cluster.height,
                      }}
                    >
                      <header className="flex h-[52px] items-center gap-2.5 border-b border-slate-100 px-3">
                        <span
                          className={cn('h-6 w-1 shrink-0 rounded-full', cluster.accent)}
                          aria-hidden="true"
                        />
                        <Boxes size={14} className="shrink-0 text-slate-400" />
                        <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-800">
                          {cluster.label}
                        </p>
                        <Badge tone="gray">{cluster.resources.length}</Badge>
                      </header>
                      <div
                        className="grid content-start grid-cols-2 gap-[5px] overflow-y-auto overflow-x-hidden overscroll-contain p-2.5 pr-1.5 scrollbar-gutter-stable"
                        style={{
                          height: cluster.height - CLUSTER_CHROME_HEIGHT,
                          touchAction: 'pan-y',
                        }}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        {cluster.resources.map((resource) => (
                          <button
                            key={resource.id}
                            type="button"
                            onClick={() => onOpenResource(resource.id)}
                            title={`${resource.code} · ${resource.name} · ${resource.slotCount} 个槽位`}
                            aria-label={`查看资源详情：${resource.code} ${resource.name}`}
                            className="group flex h-[44px] min-w-0 flex-col justify-center rounded-md border border-slate-200 bg-white px-2 text-left transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-signal-400 hover:bg-signal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  RESOURCE_STATUS_DOTS[resource.status],
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-slate-400">
                                {resource.code}
                              </span>
                              {resource.sharedAcrossEnvironments && (
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-500"
                                  title="跨环境共享资源"
                                />
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] font-medium text-slate-800">
                              {resource.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}

                  {!envDetail.isLoading && !envDetail.isError && resourceNodes.length === 0 && (
                    <div className="absolute left-1/2 top-[310px] -translate-x-1/2 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-5 text-center text-xs text-slate-500">
                      当前环境还没有绑定资源
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div
                    title="拖动项目节点"
                    onPointerDown={(event) => beginNodeDrag('project', event)}
                    className={cn(
                      'absolute flex cursor-grab flex-col justify-center rounded-[12px] border border-brand-700 bg-brand-600 px-5 text-white shadow-[0_18px_42px_rgba(23,24,21,0.20)]',
                      draggingNodeKey === 'project' && 'cursor-grabbing',
                    )}
                    style={{
                      left: projectPosition.x - PROJECT_NODE.width / 2,
                      top: projectPosition.y - PROJECT_NODE.height / 2,
                      width: PROJECT_NODE.width,
                      height: PROJECT_NODE.height,
                    }}
                  >
                    <div className="flex items-center gap-2 text-white/55">
                      <Network size={14} />
                      <span className="text-[10px]">项目</span>
                    </div>
                    <p className="mt-2 truncate text-[16px] font-medium">{project.name}</p>
                    <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-white/50">
                      <span className="truncate font-mono">{project.code}</span>
                      <span className="shrink-0">{project.resourceCount} 个资源</span>
                    </div>
                  </div>

                  {environmentNodes.map(({ env, left, top, color }) => (
                    <button
                      key={env.id}
                      type="button"
                      onClick={() => setDrillEnvId(env.id)}
                      onPointerDown={(event) => beginNodeDrag(`env:${env.id}`, event)}
                      onMouseEnter={() => setHoveredEnvId(env.id)}
                      onMouseLeave={() => setHoveredEnvId(null)}
                      title={`查看${env.name}的资源`}
                      aria-label={`查看${env.name}的资源`}
                      className={cn(
                        'absolute flex cursor-grab flex-col justify-center rounded-lg border border-slate-200 bg-white px-3.5 text-left shadow-[0_8px_22px_rgba(23,24,21,0.08)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_28px_rgba(23,24,21,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400',
                        draggingNodeKey === `env:${env.id}` && 'cursor-grabbing',
                      )}
                      style={{
                        left,
                        top,
                        width: ENV_NODE.width,
                        height: ENV_NODE.height,
                        borderLeft: `4px solid ${color}`,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900">
                          {env.name}
                        </span>
                        <ChevronRight size={14} className="shrink-0 text-slate-300" />
                      </div>
                      <p className="mt-1 truncate text-[10px] text-slate-500">
                        {env.environmentLabel} · {ENV_RUN_STATUS_LABELS[env.status]}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                        <span>
                          {env.slotFilled}/{env.slotTotal} 个槽位
                        </span>
                        <span className="text-slate-300">{env.templateName ?? '无模板'}</span>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>

            {envDetail.isLoading && drillEnvironment && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/55 backdrop-blur-[1px]">
                <Spinner className="h-6 w-6" />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
