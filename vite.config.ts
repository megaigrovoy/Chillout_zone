import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // getUserMedia requires a secure context; localhost counts, but `--host`
    // exposure to a phone on the LAN does not, so keep it opt-in.
    host: false,
  },
})
