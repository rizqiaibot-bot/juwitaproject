import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import dayjs from 'dayjs'
import { Loader2, AlertCircle, CheckCircle, Circle } from 'lucide-react'

const EMPLOYEE_ID = 'c0a80121-0001-4000-8000-000000000001'

export default function TaskPage() {
  const today = dayjs().format('YYYY-MM-DD')
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('employee_id', EMPLOYEE_ID)
        .eq('date', today)
        .order('created_at')
      if (error) throw error
      setTasks(data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  const toggleTask = async (task) => {
    const newStatus = task.status === 'done' ? 'pending' : 'done'
    const { error } = await supabase
      .from('tasks')
      .update({ status: newStatus })
      .eq('id', task.id)
    if (!error) fetchTasks()
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>

  return (
    <div className="max-w-lg mx-auto pb-24">
      <header className="bg-[#1e3a5f] text-white px-5 py-6 rounded-b-3xl">
        <p className="text-xs font-semibold tracking-widest text-blue-200 uppercase mb-1">Tugas</p>
        <h1 className="text-xl font-bold">Tugas Hari Ini</h1>
        <p className="text-sm text-blue-200 mt-1">{dayjs().format('dddd, D MMMM YYYY')}</p>
      </header>
      <div className="px-4 -mt-4">
        <div className="bg-white rounded-2xl shadow-md p-5">
          {error && (
            <div className="flex items-center gap-2 text-red-500 mb-4">
              <AlertCircle size={18} /> {error}
            </div>
          )}
          {tasks.length === 0 ? (
            <div className="text-center py-8">
              <AlertCircle size={40} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 font-medium">Tidak ada tugas hari ini</p>
              <p className="text-gray-400 text-sm mt-1">Hubungi supervisor jika seharusnya ada tugas</p>
            </div>
          ) : (
            <div className="space-y-1">
              {tasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => toggleTask(t)}
                  className="w-full flex items-center gap-3 py-3 px-2 rounded-lg hover:bg-gray-50 transition text-left"
                >
                  {t.status === 'done' ? (
                    <CheckCircle size={20} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <Circle size={20} className="text-gray-300 flex-shrink-0" />
                  )}
                  <span className={t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-700'}>
                    {t.description}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
