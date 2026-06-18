import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import TaskPage from './pages/TaskPage'
import KPIPage from './pages/KPIPage'
import ProfilePage from './pages/ProfilePage'

export default function App() {
  return (
    <BrowserRouter basename="/karyawan">
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/tugas" element={<TaskPage />} />
          <Route path="/kpi" element={<KPIPage />} />
          <Route path="/profil" element={<ProfilePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
