import { runChaos } from './chaos-workload';

void runChaos('pause').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
