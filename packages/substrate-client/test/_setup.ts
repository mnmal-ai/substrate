/**
 * msw for the test files that mock the network. Import it from such a file; it
 * is not a global setup file, because msw's socket interception stalls the
 * node:http2 connections the real-server tests make. msw intercepts the
 * platform fetch, so these files route `substrateFetch` through it.
 */

import type { HttpHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { setSubstrateFetch } from '../src/transport/default-fetch.js';

export const mockServer = setupServer();

beforeAll(() => {
  setSubstrateFetch((input, init) => globalThis.fetch(input, init));
  mockServer.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

export function mockHandlers(...handlers: HttpHandler[]): void {
  mockServer.use(...handlers);
}
