import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface StubServer {
  url: string;
  close(): Promise<void>;
}

/** A cleartext HTTP/2 stub server on loopback, with node's request/response compat API. */
export async function h2Server(
  handler: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void
): Promise<StubServer> {
  const server = http2.createServer(handler);
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    // A client's idle session would hold close() open.
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.destroy();
        server.close(() => resolve());
      })
  };
}
