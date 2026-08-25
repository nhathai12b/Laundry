import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  },
  build: {
    // Tách vendor ổn định (react, router, axios...) ra chunk riêng:
    // đổi code app không làm mất cache vendor phía trình duyệt —
    // deploy mới người dùng chỉ tải lại phần app nhỏ
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-utils': ['axios', 'date-fns'],
        },
      },
    },
    // Chunk trang lớn nhất (Home/Timesheets) vẫn dưới ngưỡng này sau khi split
    chunkSizeWarningLimit: 700,
  },
})
