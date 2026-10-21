import { describe, expect, it } from 'vitest';
import { parseArgs } from './config.js';

describe('parseArgs', () => {
  it('parses positional target dir', () => {
    const { targetDir } = parseArgs(['./my-runtime']);
    expect(targetDir).toBe('./my-runtime');
  });

  it('parses --plugins as csv', () => {
    const { plugins } = parseArgs(['x', '--plugins=cortext,substrate-nl']);
    expect(plugins).toEqual(['cortext', 'substrate-nl']);
  });

  it('parses --store=memory', () => {
    const { store } = parseArgs(['x', '--store=memory']);
    expect(store).toBe('memory');
  });

  it('parses --store=postgres (default postgres compose)', () => {
    const { store } = parseArgs(['x', '--store=postgres']);
    expect(store).toBe('postgres');
  });

  it('parses --yes flag', () => {
    const { yes } = parseArgs(['x', '--yes']);
    expect(yes).toBe(true);
  });

  it('parses --port as number', () => {
    const { port } = parseArgs(['x', '--port=4000']);
    expect(port).toBe(4000);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['x', '--unknown'])).toThrow(/unknown flag/i);
  });

  it('parses --pg-port as number', () => {
    const { pgPort } = parseArgs(['x', '--pg-port=5443']);
    expect(pgPort).toBe(5443);
  });

  it('rejects invalid --pg-port', () => {
    expect(() => parseArgs(['x', '--pg-port=abc'])).toThrow(/positive integer/i);
  });

  it.each(['3abc', '70000', '0', ''])('rejects junk port %j', (v) => {
    expect(() => parseArgs(['x', `--port=${v}`])).toThrow(/positive integer/i);
    expect(() => parseArgs(['x', `--pg-port=${v}`])).toThrow(/positive integer/i);
  });

  it('parses --tls as flag (boolean true)', () => {
    const { tls } = parseArgs(['x', '--tls', '--tls-cert-path=/c', '--tls-key-path=/k']);
    expect(tls).toBe(true);
  });

  it('rejects --tls without --tls-cert-path / --tls-key-path', () => {
    expect(() => parseArgs(['x', '--tls'])).toThrow(
      /requires both --tls-cert-path and --tls-key-path/i
    );
    expect(() => parseArgs(['x', '--tls', '--tls-cert-path=/etc/ssl/cert.pem'])).toThrow(
      /requires both/i
    );
    expect(() => parseArgs(['x', '--tls', '--tls-key-path=/etc/ssl/key.pem'])).toThrow(
      /requires both/i
    );
  });

  it('accepts --tls with both paths', () => {
    const { tls, tlsCertPath, tlsKeyPath } = parseArgs([
      'x',
      '--tls',
      '--tls-cert-path=/etc/ssl/cert.pem',
      '--tls-key-path=/etc/ssl/key.pem'
    ]);
    expect(tls).toBe(true);
    expect(tlsCertPath).toBe('/etc/ssl/cert.pem');
    expect(tlsKeyPath).toBe('/etc/ssl/key.pem');
  });

  it('defaults --tls to false when absent', () => {
    const { tls } = parseArgs(['x']);
    expect(tls).toBe(false);
  });

  it('parses --tls-cert-path', () => {
    const { tlsCertPath } = parseArgs(['x', '--tls-cert-path=/etc/ssl/cert.pem']);
    expect(tlsCertPath).toBe('/etc/ssl/cert.pem');
  });

  it('parses --tls-key-path', () => {
    const { tlsKeyPath } = parseArgs(['x', '--tls-key-path=/etc/ssl/key.pem']);
    expect(tlsKeyPath).toBe('/etc/ssl/key.pem');
  });
});
