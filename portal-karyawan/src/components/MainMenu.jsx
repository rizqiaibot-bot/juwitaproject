import { NavLink, useLocation } from 'react-router-dom'
import { Home, ClipboardList, BarChart3, User } from 'lucide-react'

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/tugas', icon: ClipboardList, label: 'Tugas' },
  { to: '/kpi', icon: BarChart3, label: 'KPI' },
  { to: '/profil', icon: User, label: 'Profil' },
]

export default function MainMenu() {
  const location = useLocation()

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50">
      <div className="max-w-lg mx-auto flex justify-around items-center h-16 px-4">
        {navItems.map(({ to, icon: Icon, label }) => {
          const isActive = location.pathname === to
          return (
            <NavLink
              key={to}
              to={to}
              className={`flex flex-col items-center gap-1 px-3 py-1 rounded-lg transition-colors ${
                isActive
                  ? 'text-blue-700'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <Icon size={22} strokeWidth={isActive ? 2.5 : 1.5} />
              <span className="text-[10px] font-semibold">{label}</span>
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}
