import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('mini-exchange');

export function activeTraceparent(fallback?: string): string | undefined {
  const carrier: { traceparent?: string } = {};
  propagation.inject(context.active(), carrier);
  return (
    carrier.traceparent ??
    (/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/.test(fallback ?? '')
      ? fallback
      : undefined)
  );
}

export function traced<T>(
  name: string,
  traceparent: string | null | undefined,
  attributes: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(ROOT_CONTEXT, { traceparent });
  return tracer.startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
