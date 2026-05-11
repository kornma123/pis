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
import Alerts from './pages/alerts/Alerts'
import Users from './pages/system/Users'
import Roles from './pages/system/Roles'
import Logs from './pages/system/Logs'
import Login from './pages/auth/Login'
import NotFound from './pages/NotFound'

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
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/users" element={<Users />} />
          <Route path="/roles" element={<Roles />} />
          <Route path="/logs" element={<Logs />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster position="top-right" richColors />
    </>
  )
}

export default App
