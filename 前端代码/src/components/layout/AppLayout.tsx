import { Outlet } from 'react-router-dom'
import AppSidebar from './AppSidebar'
import TopBar from './TopBar'

export default function AppLayout() {
  return (
    <div className="flex min-h-screen bg-[#f9fafb]">
      {/* Sidebar */}
      <AppSidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        {/* TopBar */}
        <TopBar />

        {/* Page content */}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
