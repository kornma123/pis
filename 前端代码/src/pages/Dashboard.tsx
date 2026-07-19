import { useNavigate } from 'react-router-dom'
import {
  Package, AlertTriangle, ArrowDownToLine, ArrowUpFromLine,
  ClipboardCheck, BarChart3, Clock, FlaskConical, ShoppingCart,
  Activity, TrendingUp, Wallet,
} from 'lucide-react'
import {
  useDashboardPage,
  type DashboardLoadStatus,
  type DashboardResource,
} from './dashboard/hooks/useDashboardPage'
import { StatCard } from './dashboard/components/StatCard'
import { QuickAction } from './dashboard/components/QuickAction'
import { ActivityItem } from './dashboard/components/ActivityItem'
import { SimpleBarChart } from './dashboard/components/SimpleBarChart'
import { AlertPanel } from './dashboard/components/AlertPanel'
import { CategoryDistribution } from './dashboard/components/CategoryDistribution'
import { canAccess, canSeeCost } from '@/lib/permissions'

const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`

interface TrendPanelProps {
  title: string
  data: Array<{ label: string; value: number }> | null
  color: string
}

function TrendPanel({ title, data, color }: TrendPanelProps) {
  if (data && data.length > 0) {
    return <div data-testid="dashboard-trend-chart"><SimpleBarChart title={title} data={data} color={color} /></div>
  }

  return (
    <section aria-label={title} className="bg-white rounded-lg p-5 border border-gray-200 shadow-sm min-h-52">
      <h3 className="text-base font-semibold text-gray-900 mb-5">{title}</h3>
      <div className="h-32 flex items-center justify-center text-center">
        <p className="text-sm text-gray-500">
          {data === null ? '月度趋势数据尚未接通' : '本期暂无月度趋势数据'}
        </p>
      </div>
    </section>
  )
}

function DataFailurePanel({ title }: { title: string }) {
  return (
    <section
      aria-label={title}
      className="bg-white rounded-lg p-5 border border-amber-300 shadow-sm"
    >
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <p className="text-sm font-medium text-amber-700">不可用</p>
      <p className="text-sm text-gray-500 mt-1">数据没能加载</p>
    </section>
  )
}

interface KpiCardConfig {
  key: string
  title: string
  value: string | number | null
  icon: React.ElementType
  colorClass: string
  bgClass: string
  subtitle: string
  unavailableMessage?: string
  status: DashboardLoadStatus
  resource: DashboardResource
  onClick: () => void
}

export default function Dashboard() {
  const navigate = useNavigate()
  const page = useDashboardPage()

  // 能力驱动：每张卡片/操作/板块按当前用户权限显隐（数据驱动 RBAC，多角色按并集，
  // 自然产出按角色差异化的仪表盘——病理极简无成本、技术员库存+对账、采购采购单、财务成本、主任全局）。
  const showInventory = canAccess('inventory', 'R')
  const showInbound = canAccess('inbound', 'R')
  const showOutbound = canAccess('outbound', 'R')
  const showProjects = canAccess('projects', 'R')
  const showPurchaseOrders = canAccess('purchase_orders', 'R')
  const showCost = canSeeCost() && canAccess('abc_dashboard', 'R')
  const showProfit = showCost && canAccess('profitability', 'R')
  const showAlerts = showInventory && canAccess('alerts', 'R')

  const statusMessages: string[] = []
  const addResourceStatus = (title: string, status: DashboardLoadStatus) => {
    if (status === 'error') statusMessages.push(`${title}加载失败`)
    if (status === 'retrying') statusMessages.push(`${title}正在重试`)
  }
  if (showInventory) addResourceStatus('库存物料', page.loadState.inventory)
  if (showProjects) addResourceStatus('检测项目数', page.loadState.projects)
  if (showInbound) addResourceStatus('本月入库', page.loadState.monthlyInbound)
  if (showOutbound) addResourceStatus('本月出库', page.loadState.monthlyOutbound)
  if (showPurchaseOrders) addResourceStatus('采购订单数', page.loadState.purchaseOrders)
  if (showCost) {
    addResourceStatus('本月成本', page.loadState.cost)
    if (page.loadState.cost === 'success' && page.costSummary?.quality !== 'final') {
      statusMessages.push(`本月成本不可用：${page.costSummary?.qualityMessage || '暂无可靠数据'}`)
    }
  }

  const recentStatuses = [
    ...(showInbound ? [page.loadState.recentInbound] : []),
    ...(showOutbound ? [page.loadState.recentOutbound] : []),
  ]
  const activityRetrying = recentStatuses.includes('retrying')
  const activityFailed = recentStatuses.some(status => status === 'error' || status === 'retrying')
  const activityReady = recentStatuses.length > 0 && recentStatuses.every(status => status === 'success')
  const activityPartiallyAvailable = page.activities.length > 0 || recentStatuses.includes('success')
  if (activityFailed) {
    statusMessages.push(`${activityPartiallyAvailable ? '部分活动' : '最近活动'}${activityRetrying ? '正在重试' : '加载失败'}`)
  }

  const statusMessage = page.loading
    ? ''
    : statusMessages.length > 0
      ? statusMessages.join('；')
      : '仪表盘可见数据已更新'
  const dashboardStatusAnnouncer = (
    <p
      className="sr-only"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-label="仪表盘数据状态"
    >
      {statusMessage}
    </p>
  )

  if (page.loading) {
    return (
      <>
        {dashboardStatusAnnouncer}
        <div
          className="space-y-6 animate-pulse motion-reduce:animate-none"
          role="status" aria-live="polite" aria-atomic="true"
          aria-busy="true"
          aria-label="正在加载仪表盘"
        >
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 bg-gray-200 rounded-lg" />
            ))}
          </div>
        </div>
      </>
    )
  }

  // ---- KPI 卡片（按能力过滤）----
  const kpiCards = [
    showInventory && {
      key: 'inventory', title: '库存物料', value: page.stats?.totalMaterials ?? null,
      icon: Package, colorClass: 'text-blue-500', bgClass: 'bg-blue-50',
      subtitle: '库存物料种类', status: page.loadState.inventory, resource: 'inventory',
      onClick: () => navigate('/inventory'),
    },
    showProjects && {
      key: 'projects', title: '检测项目数', value: page.projectCount,
      icon: FlaskConical, colorClass: 'text-purple-500', bgClass: 'bg-purple-50',
      subtitle: '在用检测项目', status: page.loadState.projects, resource: 'projects',
      onClick: () => navigate('/projects'),
    },
    showInbound && {
      key: 'inbound', title: '本月入库', value: page.monthlyInbound,
      icon: ArrowDownToLine, colorClass: 'text-green-500', bgClass: 'bg-green-50',
      subtitle: '本月已完成入库单', status: page.loadState.monthlyInbound, resource: 'monthlyInbound',
      onClick: () => navigate('/inbound'),
    },
    showOutbound && {
      key: 'outbound', title: '本月出库', value: page.monthlyOutbound,
      icon: ArrowUpFromLine, colorClass: 'text-blue-500', bgClass: 'bg-blue-50',
      subtitle: '本月已完成出库单', status: page.loadState.monthlyOutbound, resource: 'monthlyOutbound',
      onClick: () => navigate('/outbound'),
    },
    showPurchaseOrders && {
      key: 'po', title: '采购订单数', value: page.poCount,
      icon: ShoppingCart, colorClass: 'text-indigo-500', bgClass: 'bg-indigo-50',
      subtitle: '采购订单总数', status: page.loadState.purchaseOrders, resource: 'purchaseOrders',
      onClick: () => navigate('/purchase-orders'),
    },
    showCost && {
      key: 'cost', title: '本月成本',
      value: page.costSummary?.quality === 'final' && page.costSummary.totalCost !== null
        ? yuan(page.costSummary.totalCost)
        : null,
      icon: Wallet, colorClass: 'text-rose-500', bgClass: 'bg-rose-50',
      subtitle: '本月 ABC 核算成本', status: page.loadState.cost, resource: 'cost',
      unavailableMessage: page.costSummary?.qualityMessage,
      onClick: () => navigate('/abc/dashboard'),
    },
    showProfit && {
      key: 'profit', title: '利润率',
      value: page.costSummary?.quality === 'final' && page.costSummary.profitRate !== null
        ? `${page.costSummary.profitRate}%`
        : null,
      icon: TrendingUp, colorClass: 'text-emerald-500', bgClass: 'bg-emerald-50',
      subtitle: page.costSummary?.totalProfit == null ? '利润数据不可用' : `利润 ${yuan(page.costSummary.totalProfit)}`,
      status: page.loadState.cost, resource: 'cost', onClick: () => navigate('/abc/profitability'),
      unavailableMessage: page.costSummary?.qualityMessage,
    },
    showAlerts && {
      key: 'alerts', title: '预警数量', value: page.stats?.alertCount ?? null,
      icon: AlertTriangle, colorClass: 'text-orange-500', bgClass: 'bg-orange-50',
      subtitle: '需关注处理', status: page.loadState.inventory, resource: 'inventory',
      onClick: () => navigate('/alerts'),
    },
  ].filter(Boolean) as KpiCardConfig[]

  // ---- 快捷操作（按写权限/能力过滤）----
  const quickActions = [
    canAccess('inbound', 'W') && { key: 'inbound', label: '入库登记', desc: '录入新到耗材批次', icon: ArrowDownToLine, colorClass: 'text-green-500', bgClass: 'bg-green-50', onClick: () => navigate('/inbound') },
    canAccess('outbound', 'W') && { key: 'outbound', label: '出库领用', desc: '记录耗材消耗', icon: ArrowUpFromLine, colorClass: 'text-blue-500', bgClass: 'bg-blue-50', onClick: () => navigate('/outbound') },
    canAccess('stocktaking', 'W') && { key: 'stocktaking', label: '库存盘点', desc: '核对实际库存', icon: ClipboardCheck, colorClass: 'text-purple-500', bgClass: 'bg-purple-50', onClick: () => navigate('/stocktaking') },
    canAccess('reconciliation', 'R') && { key: 'reconciliation', label: '消耗对账', desc: '实际消耗 vs 标准', icon: Activity, colorClass: 'text-cyan-500', bgClass: 'bg-cyan-50', onClick: () => navigate('/reconciliation') },
    canAccess('purchase_orders', 'W') && { key: 'po', label: '采购订单', desc: '创建/跟进采购', icon: ShoppingCart, colorClass: 'text-indigo-500', bgClass: 'bg-indigo-50', onClick: () => navigate('/purchase-orders') },
    canAccess('projects', 'R') && { key: 'projects', label: '检测项目', desc: '查看/维护项目', icon: FlaskConical, colorClass: 'text-fuchsia-500', bgClass: 'bg-fuchsia-50', onClick: () => navigate('/projects') },
    showCost && { key: 'cost', label: '成本看板', desc: '查看 ABC 成本', icon: BarChart3, colorClass: 'text-rose-500', bgClass: 'bg-rose-50', onClick: () => navigate('/abc/dashboard') },
  ].filter(Boolean) as Array<{ key: string; label: string; desc: string; icon: React.ElementType; colorClass: string; bgClass: string; onClick: () => void }>

  const showConsumeTrend = showOutbound
  const showActivity = showInbound || showOutbound

  return (
    <>
      {dashboardStatusAnnouncer}
      <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900 tracking-tight leading-tight">仪表盘</h1>
          <p className="text-sm text-gray-500 mt-1.5">
            {page.today} · 欢迎使用 COREONE 实验室耗材管理系统
          </p>
        </div>
      </div>

      <section
        aria-label="数据覆盖与口径"
        className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">数据覆盖与口径</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              指标只展示已接通且通过当前口径校验的数据；请求失败、缺字段与未定版都保持不可用。
            </p>
          </div>
          {(showInventory || showConsumeTrend) && (
            <p className="shrink-0 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
              趋势口径：未接入月度数据源
            </p>
          )}
        </div>
        {showCost && (
          <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-3 py-2.5 text-sm">
            <span className="font-medium text-gray-700">成本口径：</span>
            {page.loadState.cost === 'success' && page.costSummary?.quality === 'final' ? (
              <span className="text-emerald-700">已定版，可查看当前成本指标</span>
            ) : (
              <span className="text-amber-700">
                成本口径不可用于经营判断
                {page.costSummary?.qualityMessage ? `：${page.costSummary.qualityMessage}` : ''}
              </span>
            )}
          </div>
        )}
      </section>

      {/* KPI Cards */}
      {kpiCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiCards.map(c => (
            <StatCard
              key={c.key}
              title={c.title}
              value={c.value}
              icon={c.icon}
              colorClass={c.colorClass}
              bgClass={c.bgClass}
              subtitle={c.subtitle}
              unavailableMessage={c.unavailableMessage}
              status={c.status}
              onClick={c.onClick}
              onRetry={() => page.retry(c.resource)}
            />
          ))}
        </div>
      )}

      {/* Quick Actions */}
      {quickActions.length > 0 && (
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-4">快捷操作</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {quickActions.map(a => (
              <QuickAction key={a.key} label={a.label} desc={a.desc} icon={a.icon} colorClass={a.colorClass} bgClass={a.bgClass} onClick={a.onClick} />
            ))}
          </div>
        </div>
      )}

      {/* Charts + Activities */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {showInventory && (
          <div className="lg:col-span-2">
            <TrendPanel title="库存趋势（近 6 个月）" data={page.stockTrend} color="#3b82f6" />
          </div>
        )}

        {showActivity && (
          <div
            aria-busy={activityRetrying || undefined}
            className={`bg-white rounded-lg p-5 border border-gray-200 shadow-sm ${showInventory ? '' : 'lg:col-span-3'}`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900">最近活动</h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={activityRetrying ? undefined : page.retryActivities}
                  aria-disabled={activityRetrying || undefined}
                  aria-label={activityRetrying ? '正在重试最近活动' : activityFailed ? '重试最近活动' : '刷新最近活动'}
                  className="min-h-10 px-2 rounded-md text-xs text-blue-600 hover:text-blue-700 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  {activityRetrying ? '重试中' : activityFailed ? '重试' : '刷新'}
                </button>
                {canAccess('logs', 'R') && (
                  <button onClick={() => navigate('/logs')} className="min-h-10 px-2 rounded-md text-xs text-blue-500 hover:text-blue-600 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">查看全部</button>
                )}
              </div>
            </div>
            {activityFailed ? (
              <div className="mb-4 p-3 rounded-md border border-amber-200 bg-amber-50">
                <p className="text-sm font-medium text-amber-800">
                  {activityPartiallyAvailable
                    ? activityRetrying ? '部分活动正在重试' : '部分活动加载失败'
                    : activityRetrying ? '最近活动正在重试' : '最近活动加载失败'}
                </p>
                <p className="text-xs text-gray-600 mt-1">已加载的活动仍会保留，失败来源不会按空数据处理。</p>
              </div>
            ) : null}
            {page.activities.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {page.activities.map(item => (<ActivityItem key={item.id} item={item} />))}
              </div>
            ) : activityReady ? (
              <div className="py-8 text-center">
                <Clock className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">暂无最近活动</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Bottom Row（按能力显隐；病理/财务等无库存管理则隐藏，避免空板块） */}
      {showInventory && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {showConsumeTrend && (
            <div className="lg:col-span-1">
              <TrendPanel title="消耗趋势（近 6 个月）" data={page.consumeTrend} color="#22c55e" />
            </div>
          )}
          {page.loadState.inventory === 'error' || page.loadState.inventory === 'retrying' ? (
            <DataFailurePanel title="分类分布" />
          ) : (
            <CategoryDistribution stats={page.stats} />
          )}
          {showAlerts ? (
            page.loadState.inventory === 'error' || page.loadState.inventory === 'retrying' ? (
              <DataFailurePanel title="预警信息" />
            ) : (
              <AlertPanel stats={page.stats} onViewAll={() => navigate('/alerts')} />
            )
          ) : null}
        </div>
      )}
      </div>
    </>
  )
}
