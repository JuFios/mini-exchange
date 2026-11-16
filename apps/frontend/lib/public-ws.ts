export function publicWsUrl() {
  const url = new URL(
    process.env.ENGINE_PUBLIC_WS_URL ?? process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001',
  );
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid public WebSocket URL');
  }
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('Invalid public WebSocket URL');
  if (process.env.COOKIE_SECURE === 'true' && !['wss:', 'https:'].includes(url.protocol))
    throw new Error('Secure cookies require a secure public WebSocket URL');
  return url;
}
