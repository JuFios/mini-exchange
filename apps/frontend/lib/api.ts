const ENGINE_URL = process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001';

export async function engineFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Matching engine API ${res.status}: ${body}`);
  }
  return res.json();
}
