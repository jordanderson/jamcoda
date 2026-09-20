import type { Request, RequestHandler, Response } from 'express';

/**
 * Path params for a normal `/:id` route.
 *
 * Express types `req.params` as `string | string[]` to cover wildcard paths.
 * None of our routes use one, so handlers read plain strings and the wrapper
 * narrows once, below.
 */
type PathParams = Record<string, string>;

/**
 * Wrap a route handler so a thrown error becomes one logged 500 instead of an
 * unhandled rejection.
 *
 * `action` completes "Failed to ..." in both the log line and the response
 * body, so the two cannot drift apart. Routes that report the underlying error
 * to the client keep their own `try`/`catch` instead.
 */
export function route(
  action: string,
  handler: (req: Request<PathParams>, res: Response) => unknown
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req as Request<PathParams>, res);
    } catch (error) {
      console.error(`Failed to ${action}:`, error);
      // A streaming response (file download) may already have sent headers.
      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to ${action}` });
      }
    }
  };
}
