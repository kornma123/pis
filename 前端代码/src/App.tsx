import { Routes, Route, Navigate } from 'react-router-dom'
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
import HospitalCmDashboard from '@/pages/hospital-cm/HospitalCmDashboard'
import PartnerConfigPage from '@/pages/partner-config/PartnerConfigPage'
import AccountReconcilePage from '@/pages/account-reconcile/AccountReconcilePage'
import ImportConsolePage from '@/pages/import-console/ImportConsolePage'
import ImportWizardPage from '@/pages/import-wizard/ImportWizardPage'
import LisCasesPage from '@/pages/lis-cases/LisCasesPage'

function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* 旧「医院盈利看板」从未上线（PM #108）→ 重定向到院级贡献毛利看板。放在 AppLayout 之外（顶层）：
            AppLayout 的可达性守卫会把不在 accessiblePaths 的路径先重定向到 /，会抢在内层 <Navigate> 之前，
            故顶层拦截确保 /hospital-pnl → /hospital-cm（而非落到仪表盘）。*/}
        <Route path="/hospital-pnl" element={<Navigate to="/hospital-cm" replace />} />
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
          <Route path="/hospital-cm" element={<HospitalCmDashboard />} />
          <Route path="/account-reconcile" element={<AccountReconcilePage />} />
          <Route path="/partner-config" element={<PartnerConfigPage />} />
          <Route path="/import-console" element={<ImportConsolePage />} />
          <Route path="/import-wizard" element={<ImportWizardPage />} />
          <Route path="/lis-cases" element={<LisCasesPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster position="top-right" richColors />
    </>
  )
}

export default App
