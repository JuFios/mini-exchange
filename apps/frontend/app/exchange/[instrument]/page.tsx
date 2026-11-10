import { Exchange } from './exchange';

export default function ExchangePage({ params }: { params: { instrument: string } }) {
  return <Exchange symbol={params.instrument} />;
}
