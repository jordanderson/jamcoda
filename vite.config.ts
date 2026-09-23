import { defineConfig } from 'vitest/config'
import { loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * Prefixes served by the local Express backend.
 *
 * This list must stay in sync with the routers mounted in `server/index.ts`.
 * Anything not matched here falls through to the `/api` catch-all below and is
 * proxied to the physical Jamcorder device instead, which fails in a way that
 * looks like a device problem rather than a config one -- so the list is
 * declared once and reused by both the dev and preview servers.
 */
const LOCAL_API_PREFIXES = [
  '/api/sync',
  '/api/files',
  '/api/annotations',
  '/api/prediction-reviews',
  '/api/settings',
] as const

const LOCAL_API_TARGET = 'http://localhost:3001'

function buildProxy(jamcorderUrl: string): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {}

  for (const prefix of LOCAL_API_PREFIXES) {
    proxy[prefix] = {
      target: LOCAL_API_TARGET,
      changeOrigin: true,
    }
  }

  // Everything else under /api belongs to the device itself.
  proxy['/api'] = {
    target: jamcorderUrl,
    changeOrigin: true,
  }

  proxy['/docs'] = {
    target: jamcorderUrl,
    changeOrigin: true,
    rewrite: (requestPath: string) => {
      if (requestPath === '/docs') return '/docs/extensions'
      if (requestPath === '/docs/') return '/docs/extensions/'
      return requestPath
    },
  }

  return proxy
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const jamcorderUrl = env.JAMCORDER_URL || 'http://jamcorder.local'
  const proxy = buildProxy(jamcorderUrl)

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@core': path.resolve(import.meta.dirname, './core'),
        '@server': path.resolve(import.meta.dirname, './server'),
        '@models': path.resolve(import.meta.dirname, './server/models'),
        '@routes': path.resolve(import.meta.dirname, './server/routes'),
        '@utils': path.resolve(import.meta.dirname, './server/utils'),
        '@config': path.resolve(import.meta.dirname, './server/config'),
        '@/components': path.resolve(import.meta.dirname, './src/components'),
        '@/hooks': path.resolve(import.meta.dirname, './src/hooks'),
        '@/api': path.resolve(import.meta.dirname, './src/api'),
        '@/utils': path.resolve(import.meta.dirname, './src/utils'),
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: { proxy },
    preview: { proxy },
    test: {
      // Two projects, because the tiers need different environments: the
      // client renders into jsdom, the server opens a real SQLite file.
      projects: [
        {
          extends: true,
          test: {
            name: 'client',
            environment: 'jsdom',
            setupFiles: './src/test/setup.ts',
            css: true,
            clearMocks: true,
            include: ['src/**/*.test.{ts,tsx}', 'core/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'server',
            environment: 'node',
            include: ['server/**/*.test.ts', 'ml/**/*.test.ts', 'electron/**/*.test.ts'],
          },
        },
      ],
    },
  }
})
