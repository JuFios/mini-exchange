import { propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('mini-exchange');

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
