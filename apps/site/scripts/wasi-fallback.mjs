// Runs the command it is given. On an x64 Linux CPU without AVX2, where Astro 7's native
// compiler binding dies with SIGILL as it loads, it first points the napi-rs addons (the
// compiler, rolldown, satteri) at their wasm32-wasi builds, which pnpm installs because
// pnpm-workspace.yaml lists wasm32 in supportedArchitectures. Anywhere else, CI included, the
// command runs unchanged on the native bindings. Child processes inherit the setting, so the
// tests that spawn `astro build` are covered by wrapping `vitest run`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cpuFlags = () => {
  try {
    return readFileSync('/proc/cpuinfo', 'utf8');
  } catch {
    return '';
  }
};

if (process.platform === 'linux' && process.arch === 'x64' && !/\bavx2\b/.test(cpuFlags())) {
  // Newer napi-rs loaders skip the native binding outright when this is set.
  process.env.NAPI_RS_FORCE_WASI ??= 'true';
  // Older loaders (the compiler and satteri today) require this path instead of their platform
  // binding first. Nothing can exist under /dev/null, so the require fails and the loader falls
  // back to the wasm32-wasi package.
  // shortcut: relies on that fallback; drop it once both ship a loader that honours NAPI_RS_FORCE_WASI.
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH ??= '/dev/null/no-native-binding';
}

const [command, ...args] = process.argv.slice(2);
// Windows resolves node_modules/.bin's .cmd shims only through a shell.
const run = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (run.error) throw run.error;
// A child killed by a signal ends this process the same way, so a crash still reads as one.
if (run.signal) process.kill(process.pid, run.signal);
process.exit(run.status ?? 1);
