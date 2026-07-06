import { Outlet } from 'react-router-dom'
import SidebarNav from './SidebarNav'
import BottomNav from './BottomNav'

export default function AppLayout() {
  return (
    <div className="min-h-svh bg-canvas md:flex">
      <SidebarNav />
      <div className="flex-1 md:min-w-0">
        <main className="mx-auto w-full max-w-md pb-24 md:max-w-none md:pb-10">
          <div className="md:mx-auto md:max-w-5xl md:px-4">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
