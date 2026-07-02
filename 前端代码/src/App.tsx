import { Routes, Route } from 'react-router-dom'
import { Toaster } from 'sonner'
import AppLayout from './components/layout/AppLayout'
import Dashboard from './pages/Dashboard'
import InventoryList from './pages/inventory/InventoryList'
import Stocktaking from './pages/inventory/Stocktaking'
import Inbound from './pages/inbound/Inbound'
import Outbound from './pages/outbound/Outbound'
import Categories from './pages/master/Categories'
import Materials from './pages/master/Materials'
import Suppliers from './pages/master/Suppliers'
import Locations from './pages/master/Locations'
import Projects from './pages/master/Projects'
import BOM from './pages/bom/BOM'
import CostAnalysis from './pages/report/CostAnalysis'
import Reconciliation from './pages/reconciliation/Reconciliation'
import Alerts from './pages/alerts/Alerts'
import Users from './pages/system/Users'
import Roles from './pages/system/Roles'
import Logs from './pages/system/Logs'
import PurchaseOrders from './pages/purchase/PurchaseOrders'
import Returns from './pages/returns/Returns'
import SupplierReturns from './pages/supplier-returns/SupplierReturns'
import Scraps from './pages/scraps/Scraps'
import Transfers from './pages/transfers/Transfers'
import Login from './pages/auth/Login'
import NotFound from './pages/NotFound'
// ===== ABC 成本核算页面（移植自 abc-productization 分支）=====
import EquipmentList from '@/pages/equipment/EquipmentList'
import EquipmentTypeList from '@/pages/equipment/EquipmentTypeList'
import EquipmentDepreciationStats from '@/pages/equipment/EquipmentDepreciationStats'
import LaborTimeList from '@/pages/labor/LaborTimeList'
import IndirectCostCenterList from '@/pages/cost-center/IndirectCostCenterList'
import CostDashboard from '@/pages/cost/CostDashboard'
import HospitalPnLDashboard from '@/pages/hospital-pnl/HospitalPnLDashboard'
import PartnerConfigPage from '@/pages/partner-config/PartnerConfigPage'
import AccountReconcilePage from '@/pages/account-reconcile/AccountReconcilePage'
import ImportConsolePage from '@/pages/import-console/ImportConsolePage'
import ImportWizardPage from '@/pages/import-wizard/ImportWizardPage'
import SlideCostAnalysis from '@/pages/cost/SlideCostAnalysis'
import { ProfitabilityAnalysis } from '@/pages/cost/ProfitabilityAnalysis'
import FeeComparison from '@/pages/cost/FeeComparison'
import SupplierCostAnalysis from '@/pages/cost/SupplierCostAnalysis'
import FeeMappingConfig from '@/pages/cost/FeeMappingConfig'
import CostTrend from '@/pages/cost/CostTrend'
import { ActivityCenterList } from '@/pages/cost/ActivityCenterList'
import { CostDriverList } from '@/pages/cost/CostDriverList'
import CostPoolList from '@/pages/cost/CostPoolList'
import BudgetManagement from '@/pages/cost/BudgetManagement'
import QualityCostAnalysis from '@/pages/cost/QualityCostAnalysis'
import CostVarianceAnalysis from '@/pages/cost/CostVarianceAnalysis'
import CostAlerts from '@/pages/cost/CostAlerts'
import AuditTrail from '@/pages/cost/AuditTrail'
import QuarterlyAdjustment from '@/pages/cost/QuarterlyAdjustment'
import PersonnelEfficiency from '@/pages/cost/PersonnelEfficiency'
import CostModelValidation from '@/pages/cost/CostModelValidation'

function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory" element={<InventoryList />} />
          <Route path="/stocktaking" element={<Stocktaking />} />
          <Route path="/inbound" element={<Inbound />} />
          <Route path="/outbound" element={<Outbound />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/locations" element={<Locations />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/bom" element={<BOM />} />
          <Route path="/cost-analysis" element={<CostAnalysis />} />
          <Route path="/reconciliation" element={<Reconciliation />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/users" element={<Users />} />
          <Route path="/roles" element={<Roles />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/supplier-returns" element={<SupplierReturns />} />
          <Route path="/scraps" element={<Scraps />} />
          <Route path="/transfers" element={<Transfers />} />
          {/* ===== ABC 成本核算路由（移植自 abc-productization 分支）===== */}
          <Route path="/equipment" element={<EquipmentList />} />
          <Route path="/equipment/types" element={<EquipmentTypeList />} />
          <Route path="/equipment/depreciation" element={<EquipmentDepreciationStats />} />
          <Route path="/labor-times" element={<LaborTimeList />} />
          <Route path="/indirect-costs" element={<IndirectCostCenterList />} />
          <Route path="/hospital-pnl" element={<HospitalPnLDashboard />} />
          <Route path="/account-reconcile" element={<AccountReconcilePage />} />
          <Route path="/partner-config" element={<PartnerConfigPage />} />
          <Route path="/import-console" element={<ImportConsolePage />} />
          <Route path="/import-wizard" element={<ImportWizardPage />} />
          <Route path="/abc/dashboard" element={<CostDashboard />} />
          <Route path="/abc/slide-cost" element={<SlideCostAnalysis />} />
          <Route path="/abc/profitability" element={<ProfitabilityAnalysis />} />
          <Route path="/abc/fee-comparison" element={<FeeComparison />} />
          <Route path="/abc/supplier-costs" element={<SupplierCostAnalysis />} />
          <Route path="/abc/fee-mappings" element={<FeeMappingConfig />} />
          <Route path="/abc/trend" element={<CostTrend />} />
          <Route path="/abc/activity-centers" element={<ActivityCenterList />} />
          <Route path="/abc/cost-drivers" element={<CostDriverList />} />
          <Route path="/abc/cost-pools" element={<CostPoolList />} />
          <Route path="/abc/budgets" element={<BudgetManagement />} />
          <Route path="/abc/quality-costs" element={<QualityCostAnalysis />} />
          <Route path="/abc/variance" element={<CostVarianceAnalysis />} />
          <Route path="/abc/alerts" element={<CostAlerts />} />
          <Route path="/abc/audit" element={<AuditTrail />} />
          <Route path="/abc/quarterly-adjustment" element={<QuarterlyAdjustment />} />
          <Route path="/abc/personnel-efficiency" element={<PersonnelEfficiency />} />
          <Route path="/abc/model-validation" element={<CostModelValidation />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster position="top-right" richColors />
    </>
  )
}

export default App
