import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // backend/ serves the ops API; keep the dev server on the same origin as prod.
    proxy: {
      "/snapshot": "http://127.0.0.1:4488", "/apply": "http://127.0.0.1:4488",
      // desktop app's ingest/gate backend
      "/rubbish": "http://127.0.0.1:4490", "/events": "http://127.0.0.1:4490",
      "/toolcall": "http://127.0.0.1:4490",
    },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  plugins: [react()],
})
