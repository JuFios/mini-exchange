const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const allowlist = require('./audit-allowlist.json');

const { name } = JSON.parse(readFileSync('package.json', 'utf8'));
const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (audit.error) throw audit.error;
const report = JSON.parse(audit.stdout);
if (report.error || !report.metadata || !report.vulnerabilities) {
  throw new Error(`npm audit did not produce a report: ${audit.stdout}`);
}

console.log(`${name} audit: ${JSON.stringify(report.metadata.vulnerabilities)}`);
if (audit.status === 0) process.exit(0);

const findings = Object.values(report.vulnerabilities)
  .flatMap((vulnerability) => vulnerability.via)
  .filter((advisory) => typeof advisory === 'object' &&
    ['high', 'critical'].includes(advisory.severity));

if (audit.status !== 1 || findings.length === 0) {
  throw new Error(`npm audit exited unexpectedly with status ${audit.status}`);
}

for (const { name: dependency, severity, url } of findings) {
  const id = url.split('/').at(-1);
  if (allowlist[name]?.[dependency]?.includes(id)) {
    console.log(`Allowlisted ${severity} advisory for ${dependency}: ${url}`);
  } else {
    console.error(`Unreviewed ${severity} advisory for ${dependency}: ${url}`);
    process.exitCode = 1;
  }
}
