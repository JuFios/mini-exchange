import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const engineMetrics = new Registry();

const counter = <Label extends string>(name: string, help: string, ...labelNames: Label[]) =>
  new Counter({ name, help, labelNames, registers: [engineMetrics] });
const gauge = <Label extends string>(name: string, help: string, ...labelNames: Label[]) =>
  new Gauge({ name, help, labelNames, registers: [engineMetrics] });

export const rateLimited = counter('rate_limited_total', 'Requests denied by the limiter', 'scope');
export const ordersRejected = counter(
  'orders_rejected_total',
  'Order submissions rejected',
  'reason',
);
export const commandsApplied = counter(
  'engine_commands_applied_total',
  'Committed commands',
  'instrument',
);
export const commandSeconds = new Histogram({
  name: 'engine_command_apply_seconds',
  help: 'Time to apply a command and commit',
  labelNames: ['instrument'],
  registers: [engineMetrics],
});
export const recoverySeconds = new Histogram({
  name: 'engine_recovery_seconds',
  help: 'Time to recover an instrument',
  labelNames: ['instrument'],
  registers: [engineMetrics],
});
export const takeovers = counter(
  'engine_takeovers_total',
  'Ownership acquired after another epoch',
  'instrument',
);
export const seqGaps = counter(
  'engine_seq_gap_total',
  'Instruments halted after a sequence gap',
  'instrument',
);
export const backlog = gauge('engine_backlog', 'Accepted commands still to apply', 'instrument');
export const owner = gauge('engine_owner', 'Locally owned instrument', 'instrument');
export const unpublished = gauge('outbox_unpublished', 'Outbox records waiting for publication');
export const wsClients = gauge('ws_clients', 'Connected Engine.IO transports');

for (const scope of ['auth', 'login_email', 'public', 'orders', 'orders_minute', 'ws_subscribe']) {
  rateLimited.inc({ scope }, 0);
}
ordersRejected.inc({ reason: 'internal' }, 0);
