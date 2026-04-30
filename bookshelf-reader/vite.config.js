import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'turnbook-js': path.resolve(__dirname, 'public/vendor/js/turn.js')
    }
  },
  server: {
    host: '0.0.0.0',
    port: 80,
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE,
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    include: ['vue', 'axios'],
    exclude: ['turnbook-js']
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor'
          }
          return undefined
        }
      }
    }
  }
})
