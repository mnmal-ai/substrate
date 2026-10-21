import type { HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const mockServer = setupServer();

beforeAll(() =>
  mockServer.listen({
    // Pass ws:// requests through unintercepted so WsTransport tests can use
    // real WebSocketServer instances. HTTP unhandled requests still error.
    onUnhandledFrame({ frame, defaults }) {
      if (frame.protocol === 'ws') return;
      const { request } = frame.data as { request: Request };
      // Integration tests use real in-process servers on 127.0.0.1 — let them through.
      try {
        const { hostname } = new URL(request.url);
        if (hostname === '127.0.0.1' || hostname === 'localhost') return;
      } catch {
        // Malformed URL — fall through to error.
      }
      defaults.error();
    }
  })
);
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

export function mockHandlers(...handlers: HttpHandler[]): void {
  mockServer.use(...handlers);
}
