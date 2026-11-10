import { cookies } from 'next/headers';
import { ACCESS_COOKIE, claims } from '../../../lib/session';
import { Exchange } from './exchange';

export default function ExchangePage({ params }: { params: { instrument: string } }) {
  const admin = claims(cookies().get(ACCESS_COOKIE)?.value)?.roles?.includes('admin') ?? false;
  return <Exchange key={params.instrument} symbol={params.instrument} admin={admin} />;
}
