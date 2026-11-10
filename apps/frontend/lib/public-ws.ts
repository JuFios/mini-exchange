export function publicWsUrl() {
  const url = new URL(
    process.env.ENGINE_PUBLIC_WS_URL ?? process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001',
  );
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid public WebSocket URL');
  }
  return url;
}
