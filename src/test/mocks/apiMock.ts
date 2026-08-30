import { vi } from 'vitest'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface MockCall {
  method: string
  url: string
  body: string | null
}

interface MockRequest {
  method: string
  url: URL
  body: string | null
  json: <T = unknown>() => T
}

type MockResponse =
  | Response
  | {
      status?: number
      body?: unknown
      headers?: Record<string, string>
    }

interface MockRoute {
  method?: HttpMethod
  path: string | RegExp
  handler: (request: MockRequest) => MockResponse | Promise<MockResponse>
}

function buildResponse(result: MockResponse): Response {
  if (result instanceof Response) {
    return result
  }

  return new Response(
    result.body === undefined ? null : JSON.stringify(result.body),
    {
      status: result.status ?? 200,
      headers: {
        'Content-Type': 'application/json',
        ...(result.headers ?? {}),
      },
    }
  )
}

function matchesPath(routePath: string | RegExp, url: URL): boolean {
  if (routePath instanceof RegExp) {
    return routePath.test(url.pathname + url.search)
  }

  if (routePath.includes('?')) {
    return `${url.pathname}${url.search}` === routePath
  }

  return url.pathname === routePath
}

export function installApiMock(initialRoutes: MockRoute[]) {
  let routes = [...initialRoutes]
  const calls: MockCall[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url
    const url = new URL(urlString, 'http://localhost')
    const method = (init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method ?? 'GET')).toUpperCase()
    const body = typeof init?.body === 'string'
      ? init.body
      : init?.body === undefined || init?.body === null
        ? null
        : String(init.body)

    calls.push({
      method,
      url: `${url.pathname}${url.search}`,
      body,
    })

    const route = routes.find((candidate) => {
      const methodMatches = !candidate.method || candidate.method === method
      return methodMatches && matchesPath(candidate.path, url)
    })

    if (!route) {
      throw new Error(`Unhandled API mock request: ${method} ${url.pathname}${url.search}`)
    }

    const request: MockRequest = {
      method,
      url,
      body,
      json: <T,>() => (body ? (JSON.parse(body) as T) : ({} as T)),
    }

    const result = await route.handler(request)
    return buildResponse(result)
  })

  vi.stubGlobal('fetch', fetchMock)

  return {
    setRoutes(nextRoutes: MockRoute[]) {
      routes = [...nextRoutes]
    },
    restore() {
      vi.unstubAllGlobals()
    },
    getCalls() {
      return [...calls]
    },
    countCalls(method: HttpMethod, path: string): number {
      return calls.filter((call) => call.method === method && call.url === path).length
    },
    fetchMock,
  }
}

export type { MockRoute, MockRequest, MockCall, HttpMethod }
