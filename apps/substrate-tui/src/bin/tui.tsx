import { readConfig } from '../config.js';
import { colorDepthEnv } from '../terminal.js';

const USAGE =
  'usage: substrate-tui   (env: SUBSTRATE_URL, optional SUBSTRATE_NAMESPACE, SUBSTRATE_AGENT_KEY_ID + SUBSTRATE_AGENT_KEY_PATH;\n' +
  '                    SUBSTRATE_TUI_BACKGROUND=#rrggbb|none, SUBSTRATE_TUI_CLEAR=0 to keep the screen,\n' +
  '                    SUBSTRATE_TUI_COLOR=256 for terminals without truecolor;\n' +
  '                    admin: SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_PATH [+ SUBSTRATE_ADMIN_KEY_ID], SUBSTRATE_TUI_ADMIN_IDLE_MINUTES)\n';

async function main(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`substrate-tui needs an interactive terminal.\n${USAGE}`);
    return 2;
  }
  const config = readConfig(process.env, process.cwd());
  if ('error' in config) {
    process.stderr.write(`substrate-tui: ${config.error}\n`);
    return 2;
  }
  // Colour depth before Ink loads: chalk decides it once, at import.
  Object.assign(process.env, colorDepthEnv(process.env));
  // Loaded lazily so the usage/refusal paths above never pull in Ink or the client.
  const [{ createTui }, { makeDeps }, { prepareTerminal }, { terminalOptions }] = await Promise.all(
    [
      import('../app.js'),
      import('../deps.js'),
      import('@mnmal-ai/surface-core/pure'),
      import('../terminal.js')
    ]
  );
  let deps: ReturnType<typeof makeDeps>;
  try {
    deps = makeDeps(config);
  } catch (err) {
    process.stderr.write(`substrate-tui: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const restore = prepareTerminal(process.stdout, terminalOptions(process.env));
  try {
    await createTui(deps).run();
  } finally {
    restore();
  }
  return 0;
}

process.exitCode = await main();
