/**
 * Shared CLI error carrying a process exit code. Used by `substrate-admin` and by
 * the `substrate federate` verbs that write direct-to-pg.
 */
export class AdminCliError extends Error {
  override readonly name = 'AdminCliError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
