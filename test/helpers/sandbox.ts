/** Run `fn` with `MYPY_NO_SANDBOX` set, restoring whatever the environment held afterwards. */
export async function withNoSandbox<T>(value: string, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.MYPY_NO_SANDBOX;
  process.env.MYPY_NO_SANDBOX = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MYPY_NO_SANDBOX;
    else process.env.MYPY_NO_SANDBOX = before;
  }
}
