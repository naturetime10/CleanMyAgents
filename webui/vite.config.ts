import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // backend/ serves the ops API; keep the dev server on the same origin as prod.
    proxy: { "/snapshot": "http://127.0.0.1:4488", "/apply": "http://127.0.0.1:4488" },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  plugins: [react()],
})
