import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 同事要能直接连,不能只绑本机回环
    port: 5173,
    proxy: {
      // 前端请求 /api/xxx 时,开发环境下转发给后端的 8080
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
