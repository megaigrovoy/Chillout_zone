import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * On GitHub Pages the site is served from /<repo>/, so assets must be
 * requested relative to that prefix rather than the domain root. The workflow
 * passes the repo name in; local builds and custom-domain deploys leave it
 * unset and keep the plain "/" base.
 */
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // getUserMedia requires a secure context; localhost counts, but `--host`
    // exposure to a phone on the LAN does not, so keep it opt-in.
    host: false,
  },
})
