import type { RequestHandler } from 'express';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return LOOPBACK_HOSTNAMES.has(url.hostname) && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}

/**
 * Admit only requests addressed to this server over loopback from its own
 * origin.
 *
 * Binding to 127.0.0.1 keeps the LAN out but not web pages the user has open:
 * a page can POST to `http://127.0.0.1:<port>` directly (no preflight for a
 * form-style request), or rebind its own hostname to 127.0.0.1 and become
 * same-origin. The `Host` check defeats the rebind, since the browser still
 * sends the attacker's hostname; the `Origin` check rejects cross-site
 * requests, which browsers always label. Same-origin GETs carry no `Origin`
 * and pass.
 */
export function loopbackGuard(port: number): RequestHandler {
  return (req, res, next) => {
    if (!isLoopbackHost(req.headers.host, port)) {
      res.status(403).json({ error: 'Forbidden host' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      if (!isLoopbackHost(originHost, port)) {
        res.status(403).json({ error: 'Forbidden origin' });
        return;
      }
    }
    next();
  };
}
