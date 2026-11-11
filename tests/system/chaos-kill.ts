import assert from 'node:assert/strict';
import { runChaos, type Fault } from './chaos-workload';

const points = [
  'after_writes_before_commit',
  'after_commit_before_memory',
  'relay_after_xadd_before_published',
  'settlement_after_commit_before_ack',
  'external',
] as const;
const fault = process.argv[2] ?? points[0];
assert(
  points.some((point) => point === fault),
  `Unknown crash point: ${fault}`,
);

void runChaos(fault as Fault).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
