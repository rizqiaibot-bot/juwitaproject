import { Outlet } from 'react-router-dom'
import MainMenu from '../components/MainMenu'

export default function Layout() {
  return (
    <div className="flex flex-col min-h-screen pb-16">
      <main className="flex-1">
        <Outlet />
      </main>
      <MainMenu />
    </div>
  )
}
