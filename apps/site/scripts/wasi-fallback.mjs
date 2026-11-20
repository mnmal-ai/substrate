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
  // A napi-rs loader requires this path instead of its platform binding. Nothing can exist under
  // /dev/null, so the require fails and the loader falls back to the wasm32-wasi package.
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH ??= '/dev/null/no-native-binding';
}

const [command, ...args] = process.argv.slice(2);
const run = spawnSync(command, args, { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
