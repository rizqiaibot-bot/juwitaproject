import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import dayjs from 'dayjs'
import { Loader2, TrendingUp, Target } from 'lucide-react'

const EMPLOYEE_ID = 'c0a80121-0001-4000-8000-000000000001'

export default function KPIPage() {
  const currentMonth = dayjs().month() + 1
  const currentYear = dayjs().year()
  const [kpi, setKpi] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchKPI = useCallback(async () => {
    const { data } = await supabase
      .from('kpi')
      .select('*')
      .eq('employee_id', EMPLOYEE_ID)
      .eq('month', currentMonth)
      .eq('year', currentYear)
      .maybeSingle()
    setKpi(data)
    setLoading(false)
  }, [currentMonth, currentYear])

  useEffect(() => { fetchKPI() }, [fetchKPI])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>

  const metrics = kpi ? [
    { label: 'Kehadiran', value: kpi.attendance_score, weight: 30, color: 'bg-green-500' },
    { label: 'Ketepatan Waktu', value: kpi.punctuality_score, weight: 25, color: 'bg-blue-500' },
    { label: 'Lembur', value: kpi.overtime_score, weight: 15, color: 'bg-purple-500' },
    { label: 'Penyelesaian Task', value: kpi.task_completion_score, weight: 30, color: 'bg-orange-500' },
  ] : []

  return (
    <div className="max-w-lg mx-auto pb-24">
      <header className="bg-[#1e3a5f] text-white px-5 py-6 rounded-b-3xl">
        <p className="text-xs font-semibold tracking-widest text-blue-200 uppercase mb-1">KPI</p>
        <h1 className="text-xl font-bold">KPI Bulan Ini</h1>
        <p className="text-sm text-blue-200 mt-1">{dayjs().format('MMMM YYYY')}</p>
      </header>
      <div className="px-4 -mt-4 space-y-4">
        {kpi ? (
          <>
            <div className="bg-white rounded-2xl shadow-md p-6 text-center">
              <div className="relative w-32 h-32 mx-auto mb-4">
                <svg className="w-32 h-32 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#e5e7eb" strokeWidth="8" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#3b82f6" strokeWidth="8"
                    strokeDasharray={`${(kpi.total_score / 100) * 264} 264`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-extrabold text-blue-700">{kpi.total_score}</span>
                  <span className="text-xs text-gray-400 font-semibold">/ 100</span>
                </div>
              </div>
              <p className="text-gray-500 text-sm flex items-center justify-center gap-1">
                <Target size={14} className="text-blue-500" />
                Nilai Total KPI
              </p>
            </div>

            <div className="bg-white rounded-2xl shadow-md p-5">
              <h2 className="font-bold text-gray-800 flex items-center gap-2 mb-4">
                <TrendingUp size={18} className="text-blue-600" />
                Detail Metrik
              </h2>
              <div className="space-y-4">
                {metrics.map((m) => (
                  <div key={m.label}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-600 font-medium">{m.label}</span>
                      <span className="text-gray-400 text-xs">Bobot {m.weight}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full ${m.color} rounded-full transition-all`} style={{ width: `${m.value ?? 0}%` }} />
                      </div>
                      <span className="text-sm font-bold text-gray-700 w-10 text-right">{m.value ?? '-'}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="bg-white rounded-2xl shadow-md p-10 text-center text-gray-400">
            <TrendingUp size={48} className="mx-auto mb-3 opacity-30" />
            <p>Belum ada data KPI bulan ini</p>
          </div>
        )}
      </div>
    </div>
  )
}
