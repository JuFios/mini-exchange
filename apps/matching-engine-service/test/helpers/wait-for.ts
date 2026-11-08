export async function waitFor(
  check: () => Promise<boolean>,
  timeout = 5000,
  interval = 10,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
