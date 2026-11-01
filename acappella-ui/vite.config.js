import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 只把两个大块单独拆出去（OSMD 1.4MB、lamejs 只在导出 MP3 时用），
        // 其余 node_modules 全部并进一个 vendor。
        //
        // 不能再按「react 相关」和「其余」拆成两个 chunk：@radix-ui 在 vendor、
        // 它依赖的 @floating-ui 会落到 misc，而 @floating-ui 又要引 react，
        // 于是 misc 和 vendor 互相 import，形成循环 chunk。实测产出的包里
        // React 还没初始化就被另一个 chunk 使用，启动直接
        // TypeError: Cannot read properties of undefined (reading 'useLayoutEffect')，
        // 页面白屏。合并成一个 vendor 就没有环。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('opensheetmusicdisplay')) return 'osmd'
          if (id.includes('lamejs')) return 'lamejs'
          return 'vendor'
        },
      },
    },
  },
})
