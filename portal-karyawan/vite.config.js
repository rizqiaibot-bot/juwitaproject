import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/karyawan/',
  build: {
    outDir: '../karyawan',
    emptyOutDir: true,
  },
})
