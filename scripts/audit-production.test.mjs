import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedFinding } from './audit-production.mjs';

test('rejects a new advisory, an expired decision and a changed installed version', () => {
  const report = {
    vulnerabilities: {
      example: {
        nodes: ['node_modules/example'],
        via: [{ severity: 'critical', url: 'https://github.com/advisories/GHSA-known' }],
      },
    },
  };
  const lock = { packages: { 'node_modules/example': { version: '1.2.3' } } };
  const decisions = {
    example: { versions: ['1.2.3'], advisories: ['GHSA-known'], expires: '2026-12-16' },
  };
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(acceptedFinding('example', report, lock, decisions, now), true);
  assert.equal(
    acceptedFinding('example', report, lock, decisions, Date.parse('2026-12-17T00:00:00Z')),
    false,
  );
  report.vulnerabilities.example.via[0].url = 'https://github.com/advisories/GHSA-new';
  assert.equal(acceptedFinding('example', report, lock, decisions, now), false);
  report.vulnerabilities.example.via[0].url = 'https://github.com/advisories/GHSA-known';
  lock.packages['node_modules/example'].version = '1.2.4';
  assert.equal(acceptedFinding('example', report, lock, decisions, now), false);
});
