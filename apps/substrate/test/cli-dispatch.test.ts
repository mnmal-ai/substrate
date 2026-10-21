import { describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { runCli } from '../src/cli.js';

vi.mock('../src/mcp/server.js', () => ({ runMcp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main.js', () => ({ runServe: vi.fn().mockResolvedValue(undefined) }));

/**
 * Unit tests for the `substrate` binary dispatcher.
 *
 * Covers help / unknown-subcommand paths AND the keep-alive contract for
 * `serve` and `mcp`: both subcommand impls return as soon as their server is
 * connected, but bin/substrate.ts unconditionally `process.exit`s after runCli
 * resolves — so runCli MUST block forever for those two subcommands. Without
 * this guard, the host (a browser making HTTP, or an MCP client over stdio)
 * sees an instant EOF / connection drop.
 */
describe('runCli dispatcher', () => {
  it('prints help and exits 1 when no subcommand is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runCli([]);
      expect(code).toBe(1);
      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('substrate <subcommand>');
      expect(printed).toContain('serve');
      expect(printed).toContain('mcp');
      expect(printed).toContain('init');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('prints help and exits 0 on --help', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runCli(['--help']);
      expect(code).toBe(0);
      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('substrate <subcommand>');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('prints help and exits 0 on -h', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runCli(['-h']);
      expect(code).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it.each(['serve', 'mcp', 'init', 'check-enums'])(
    '%s --help prints help and exits 0 without running the subcommand',
    async (sub) => {
      const { runServe } = await import('../src/main.js');
      vi.mocked(runServe).mockClear();
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        expect(await runCli([sub, '--help'])).toBe(0);
        const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(printed).toContain('substrate <subcommand>');
        expect(runServe).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
      }
    }
  );

  // Regression: if `mcp` stops blocking after runMcp() resolves,
  // process.exit(0) fires immediately and the MCP client loses the server.
  it('blocks indefinitely for the mcp subcommand (does not let process.exit fire)', async () => {
    const cli = runCli(['mcp']);
    const sentinel = Symbol('still-running');
    const winner = await Promise.race([
      cli,
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 200))
    ]);
    expect(winner).toBe(sentinel);
  });

  it('blocks indefinitely for the serve subcommand (does not let process.exit fire)', async () => {
    const cli = runCli(['serve']);
    const sentinel = Symbol('still-running');
    const winner = await Promise.race([
      cli,
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 200))
    ]);
    expect(winner).toBe(sentinel);
  });

  it.each(['--version', '-v', 'version'])(
    'prints the package version and exits 0 on %s',
    async (flag) => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const code = await runCli([flag]);
        expect(code).toBe(0);
        const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(printed).toBe(`${pkg.version}\n`);
      } finally {
        stdoutSpy.mockRestore();
      }
    }
  );

  it('exits 1 with a clear error on unknown subcommand', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runCli(['bogus']);
      expect(code).toBe(1);
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toContain("unknown subcommand 'bogus'");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('lists federate in the help output', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCli(['--help']);
      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('federate');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('prints the federate verb list and exits 1 when no verb is given', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runCli(['federate']);
      expect(code).toBe(1);
      const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('enroll');
      expect(printed).toContain('join');
      expect(printed).toContain('check');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('exits 1 on an unknown federate verb', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runCli(['federate', 'wat'])).toBe(1);
      const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain("unknown verb 'wat'");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
