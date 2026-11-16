import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const high = new Set(['high', 'critical']);

export function acceptedFinding(
  name,
  report,
  lock,
  exceptions,
  now = Date.now(),
  seen = new Set(),
) {
  if (seen.has(name)) return false;
  const finding = report.vulnerabilities[name];
  const exception = exceptions[name];
  if (!finding || !exception || now >= Date.parse(`${exception.expires}T23:59:59Z`)) return false;
  if (!Number.isFinite(Date.parse(`${exception.expires}T23:59:59Z`))) return false;
  if (!finding.nodes.every((path) => exception.versions.includes(lock.packages[path]?.version)))
    return false;
  const next = new Set([...seen, name]);
  return finding.via.every((advisory) =>
    typeof advisory === 'string'
      ? acceptedFinding(advisory, report, lock, exceptions, now, next)
      : !high.has(advisory.severity) ||
        exception.advisories.includes(advisory.url.split('/').at(-1)),
  );
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const decisions = JSON.parse(
    readFileSync(resolve(root, 'dependency-audit-exceptions.json'), 'utf8'),
  );
  const logs = process.env.AUDIT_LOG_DIR ?? mkdtempSync(resolve(tmpdir(), 'exchange-audit-'));
  mkdirSync(logs, { recursive: true });
  let blocked = false;
  for (const app of ['matching-engine-service', 'settlement-service', 'frontend']) {
    const cwd = resolve(root, 'apps', app);
    const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const report = JSON.parse(result.stdout);
    writeFileSync(resolve(logs, `${app}.json`), JSON.stringify(report, null, 2) + '\n');
    if (![0, 1].includes(result.status) || report.error || !report.metadata)
      throw new Error(`Dependency audit failed for ${app}`);
    const lock = JSON.parse(readFileSync(resolve(cwd, 'package-lock.json'), 'utf8'));
    const exceptions = Object.fromEntries(
      Object.entries(decisions)
        .filter(([key]) => key.startsWith(app + ':'))
        .map(([key, value]) => [key.slice(app.length + 1), value]),
    );
    const rejected = Object.entries(report.vulnerabilities)
      .filter(
        ([name, finding]) =>
          high.has(finding.severity) && !acceptedFinding(name, report, lock, exceptions),
      )
      .map(([name]) => name);
    console.log(
      JSON.stringify({
        app,
        vulnerabilities: report.metadata.vulnerabilities,
        unaccepted: rejected,
      }),
    );
    blocked ||= rejected.length > 0;
  }
  if (blocked) throw new Error('Unaccepted high or critical production advisories');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
