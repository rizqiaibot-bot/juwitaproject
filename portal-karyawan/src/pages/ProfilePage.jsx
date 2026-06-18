import { User, Mail, Briefcase, Phone, MapPin } from 'lucide-react'

const EMPLOYEE_NAME = 'Muhamad Rizkin'
const EMPLOYEE_EMAIL = 'rizkin@juwita.com'
const EMPLOYEE_ROLE = 'Staf Operasional'
const EMPLOYEE_PHONE = '0812-3456-7890'
const EMPLOYEE_ADDRESS = 'Jl. Raya Juwita No. 45, Jakarta Selatan'

export default function ProfilePage() {
  return (
    <div className="max-w-lg mx-auto pb-24">
      <header className="bg-[#1e3a5f] text-white px-5 py-6 rounded-b-3xl">
        <p className="text-xs font-semibold tracking-widest text-blue-200 uppercase mb-1">Profil</p>
        <h1 className="text-xl font-bold">Profil Karyawan</h1>
      </header>
      <div className="px-4 -mt-4">
        <div className="bg-white rounded-2xl shadow-md p-6 text-center">
          <div className="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-3">
            <span className="text-3xl font-bold text-white">MR</span>
          </div>
          <h2 className="text-lg font-bold text-gray-800">{EMPLOYEE_NAME}</h2>
          <p className="text-sm text-gray-500 mb-6">{EMPLOYEE_ROLE}</p>

          <div className="space-y-3 text-left">
            <ProfileRow icon={<Mail size={18} />} label="Email" value={EMPLOYEE_EMAIL} />
            <ProfileRow icon={<Briefcase size={18} />} label="Jabatan" value={EMPLOYEE_ROLE} />
            <ProfileRow icon={<Phone size={18} />} label="Telepon" value={EMPLOYEE_PHONE} />
            <ProfileRow icon={<MapPin size={18} />} label="Alamat" value={EMPLOYEE_ADDRESS} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ProfileRow({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className="text-gray-400 flex-shrink-0">{icon}</div>
      <div>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="text-sm font-semibold text-gray-700">{value}</p>
      </div>
    </div>
  )
}
