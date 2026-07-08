import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3011',
        changeOrigin: true
      },
      '/data': {
        target: 'http://localhost:3011',
        changeOrigin: true
      },
      '/download-pdf': {
        target: 'http://localhost:3011',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html')
      }
    }
  }
})
