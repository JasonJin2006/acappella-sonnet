import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('opensheetmusicdisplay')) return 'osmd'
            if (id.includes('lamejs')) return 'lamejs'
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|@radix-ui|lucide-react|clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id))
              return 'vendor'
            return 'misc'
          }
        },
      },
    },
  },
})
