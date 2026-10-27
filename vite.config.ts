import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // BE (Azure) chỉ whitelist CORS cho http://localhost:5173 → ghim cổng này
    // để dev không bị "Failed to fetch" khi Vite tự nhảy sang 5174/5181.
    port: 5173,
    strictPort: true,
  },
})