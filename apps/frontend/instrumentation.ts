import { frontendProxyToken } from './lib/api';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    frontendProxyToken();
  } catch (error) {
    // Next 14 журналює виняток із register і залишає HTTP-сервер запущеним.
    const message = error instanceof Error ? error.message : String(error);
    await new Promise<void>((resolve) => process.stderr.write(message + '\n', () => resolve()));
    process.exit(1);
  }
}
