import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // Read config in Node, but expose exactly one public value to the bundle.
  // Never spread loadEnv output into define or client-side import.meta.env.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(env.NEON_AUTH_BASE_URL || env.VITE_NEON_AUTH_URL || ''),
    },
  }
})
