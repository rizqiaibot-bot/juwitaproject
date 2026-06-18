import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import dayjs from 'dayjs'
import 'dayjs/locale/id'
import { Loader2, Clock, LogOut, Coffee, AlertCircle, ChevronRight, TrendingUp, Calendar, UserCheck, Clock3, Timer } from 'lucide-react'

dayjs.locale('id')

const EMPLOYEE_ID = 'c0a80121-0001-4000-8000-000000000001'
const EMPLOYEE_NAME = 'Muhamad Rizkin'

export default function HomePage() {
  const today = dayjs().format('YYYY-MM-DD')
  const currentMonth = dayjs().month() + 1
  const currentYear = dayjs().year()

  const [attendance, setAttendance] = useState(null)
  const [tasks, setTasks] = useState([])
  const [kpi, setKpi] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [attRes, taskRes, kpiRes, sumRes] = await Promise.all([
        supabase.from('attendance').select('*').eq('employee_id', EMPLOYEE_ID).eq('date', today).maybeSingle(),
        supabase.from('tasks').select('*').eq('employee_id', EMPLOYEE_ID).eq('date', today).order('created_at'),
        supabase.from('kpi').select('*').eq('employee_id', EMPLOYEE_ID).eq('month', currentMonth).eq('year', currentYear).maybeSingle(),
        supabase.from('monthly_summary').select('*').eq('employee_id', EMPLOYEE_ID).eq('month', currentMonth).eq('year', currentYear).maybeSingle(),
      ])

      if (attRes.error && attRes.error.code !== 'PGRST116') throw attRes.error
      if (taskRes.error) throw taskRes.error
      if (kpiRes.error && kpiRes.error.code !== 'PGRST116') throw kpiRes.error
      if (sumRes.error && sumRes.error.code !== 'PGRST116') throw sumRes.error

      setAttendance(attRes.data)
      setTasks(taskRes.data || [])
      setKpi(kpiRes.data)
      setSummary(sumRes.data)
    } catch (err) {
      console.error('Error fetching data:', err)
      setError('Gagal mengambil data dari server. Pastikan Supabase terkoneksi.')
    } finally {
      setLoading(false)
    }
  }, [today, currentMonth, currentYear])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleBreak = async () => {
    if (!attendance) return
    const now = dayjs().format('HH:mm:ss')
    if (attendance.is_break) {
      await supabase.from('attendance').update({ is_break: false, break_end: now }).eq('id', attendance.id)
    } else {
      await supabase.from('attendance').update({ is_break: true, break_start: now }).eq('id', attendance.id)
    }
    fetchData()
  }

  const handleCheckout = async () => {
    if (!attendance) return
    const now = dayjs().format('HH:mm:ss')
    await supabase.from('attendance').update({ check_out: now }).eq('id', attendance.id)
    fetchData()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
        <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
        <p className="text-gray-600 mb-4">{error}</p>
        <button onClick={fetchData} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition">
          Coba Lagi
        </button>
      </div>
    )
  }

  const displayDate = dayjs().format('dddd, D MMMM YYYY')

  return (
    <div className="max-w-lg mx-auto">
      {/* HEADER */}
      <header className="bg-[#1e3a5f] text-white px-5 py-6 rounded-b-3xl">
        <p className="text-xs font-semibold tracking-widest text-blue-200 uppercase mb-1">Portal Karyawan</p>
        <h1 className="text-xl font-bold">{EMPLOYEE_NAME}</h1>
        <p className="text-sm text-blue-200 mt-1">{displayDate}</p>
      </header>

      <div className="px-4 -mt-4 space-y-4 pb-24">
        {/* ABSENSI CARD */}
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <Clock size={18} className="text-blue-600" />
              Absensi Hari Ini
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <InfoItem label="Jam Masuk" value={attendance?.check_in || '-'} />
            <InfoItem label="Jam Pulang" value={attendance?.check_out || '-'} />
            <InfoItem label="Telat" value="-" />
            <InfoItem label="Lembur" value={attendance?.overtime_minutes ? `${attendance.overtime_minutes}m` : '-'} />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleBreak}
              disabled={!attendance}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition ${
                attendance?.is_break
                  ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                  : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <Coffee size={16} />
              {attendance?.is_break ? 'Selesai Istirahat' : 'Mulai Istirahat'}
            </button>
            <button
              onClick={handleCheckout}
              disabled={!attendance || attendance?.check_out}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogOut size={16} />
              Check Out
            </button>
          </div>
        </div>

        {/* TUGAS CARD */}
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <ClipboardListIcon />
              Tugas Hari Ini
            </h2>
            <a href="/tugas" className="text-blue-600 text-xs font-semibold flex items-center gap-1 hover:underline">
              Buka halaman tugas <ChevronRight size={14} />
            </a>
          </div>
          {tasks.length === 0 ? (
            <div className="text-center py-4">
              <AlertCircle size={32} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-500 text-sm font-medium">Tidak ada tugas hari ini</p>
              <p className="text-gray-400 text-xs mt-1">Hubungi supervisor jika seharusnya ada tugas</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    t.status === 'done' ? 'bg-green-500 border-green-500' : 'border-gray-300'
                  }`}>
                    {t.status === 'done' && <CheckIcon />}
                  </div>
                  <span className={`text-sm ${t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                    {t.description}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* KPI CARD */}
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-600" />
              KPI Bulan Ini
            </h2>
          </div>
          {kpi ? (
            <>
              <div className="flex items-center justify-center mb-4">
                <div className="relative w-28 h-28">
                  <svg className="w-28 h-28 -rotate-90" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="42" fill="none" stroke="#e5e7eb" strokeWidth="8" />
                    <circle cx="50" cy="50" r="42" fill="none" stroke="#3b82f6" strokeWidth="8"
                      strokeDasharray={`${(kpi.total_score / 100) * 264} 264`} strokeLinecap="round" />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-extrabold text-blue-700">{kpi.total_score}</span>
                    <span className="text-[10px] text-gray-400 font-semibold">/ 100</span>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <KPIMetric label="Kehadiran" value={kpi.attendance_score} weight={30} pct={94} />
                <KPIMetric label="Ketepatan Waktu" value={kpi.punctuality_score} weight={25} pct={100} />
                <KPIMetric label="Lembur" value={kpi.overtime_score} weight={15} pct={100} />
                <KPIMetric label="Penyelesaian Task" value={kpi.task_completion_score} weight={30} pct={0} />
              </div>
            </>
          ) : (
            <div className="text-center py-6 text-gray-400 text-sm">Belum ada data KPI bulan ini</div>
          )}
        </div>

        {/* RINGKASAN BULAN INI */}
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-gray-800 flex items-center gap-2">
              <Calendar size={18} className="text-blue-600" />
              Ringkasan Bulan Ini
            </h2>
          </div>
          {summary ? (
            <div className="grid grid-cols-2 gap-4">
              <SummaryItem icon={<UserCheck size={20} />} label="Hadir" value={summary.present_days} color="text-green-600" bg="bg-green-50" />
              <SummaryItem icon={<Clock3 size={20} />} label="Terlambat" value={summary.late_days} color="text-yellow-600" bg="bg-yellow-50" />
              <SummaryItem icon={<AlertCircle size={20} />} label="Alpha" value={summary.alpha_days} color="text-red-600" bg="bg-red-50" />
              <SummaryItem icon={<Timer size={20} />} label="Lembur" value={`${summary.overtime_hours}j`} color="text-blue-600" bg="bg-blue-50" />
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400 text-sm">Belum ada ringkasan bulan ini</div>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoItem({ label, value }) {
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-xs text-gray-500 font-medium mb-1">{label}</p>
      <p className="text-sm font-bold text-gray-800">{value}</p>
    </div>
  )
}

function KPIMetric({ label, value, weight, pct }) {
  const barPct = value ? (value / 100) * 100 : 0
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600 font-medium">{label} <span className="text-gray-400">({pct}%, bobot {weight}%)</span></span>
        <span className="font-bold text-gray-700">{value ?? '-'}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${barPct}%` }} />
      </div>
    </div>
  )
}

function SummaryItem({ icon, label, value, color, bg }) {
  return (
    <div className={`${bg} rounded-xl p-4 flex items-center gap-3`}>
      <div className={color}>{icon}</div>
      <div>
        <p className="text-2xl font-extrabold text-gray-800">{value}</p>
        <p className="text-xs text-gray-500 font-medium">{label}</p>
      </div>
    </div>
  )
}

function ClipboardListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
