import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/api';

// NOTE (стартовий код): проксі поки що без передачі Authorization —
// автентифікацію на фронтенді потрібно підключити (див. ТЗ щодо
// перенесеного модуля автентифікації).
export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    const trades = await engineFetch('/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return NextResponse.json(trades);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
