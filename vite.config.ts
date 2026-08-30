import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const jamcorderUrl = env.JAMCORDER_URL || 'http://jamcorder.local'

  return {
    plugins: [react()],
    // Vite only exposes VITE_-prefixed vars to the browser. Allowing the
    // JAMCORDER_ prefix too means one JAMCORDER_URL serves the backend, the
    // dev proxy, and the client badge. JAMCODA_ stays server-only.
    envPrefix: ['VITE_', 'JAMCORDER_'],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
        '@/components': path.resolve(import.meta.dirname, './src/components'),
        '@/hooks': path.resolve(import.meta.dirname, './src/hooks'),
        '@/api': path.resolve(import.meta.dirname, './src/api'),
        '@/utils': path.resolve(import.meta.dirname, './src/utils'),
      },
    },
    server: {
      proxy: {
        '/api/sync': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/files': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/annotations': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/prediction-reviews': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/ignored-sections': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api': {
          target: jamcorderUrl,
          changeOrigin: true,
        },
        '/docs': {
          target: jamcorderUrl,
          changeOrigin: true,
          rewrite: (path) => {
            if (path === '/docs') return '/docs/extensions'
            if (path === '/docs/') return '/docs/extensions/'
            return path
          },
        },
      },
    },
    preview: {
      proxy: {
        '/api/sync': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/files': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/annotations': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/prediction-reviews': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api/ignored-sections': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/api': {
          target: jamcorderUrl,
          changeOrigin: true,
        },
        '/docs': {
          target: jamcorderUrl,
          changeOrigin: true,
          rewrite: (path) => {
            if (path === '/docs') return '/docs/extensions'
            if (path === '/docs/') return '/docs/extensions/'
            return path
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      clearMocks: true,
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      alias: {
        '@magenta/music': path.resolve(import.meta.dirname, './src/test/mocks/magentaMusicMock.ts'),
      },
    },
  }
})
