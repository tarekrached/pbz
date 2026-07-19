// Pins the status frame's wire contract (see PBZ-PLAN.md Chunk 13 — read-
// method layering). getStatus() itself needs a live connection (it's device
// I/O, a poor fit for test-first per Testing & conventions), so this just
// guards that the fixture — captured live off firmware v3.67 — parses with
// the field names getInfo()/the CLI info printer depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE = '{"fps":54.29417,"vmerr":0,"vmerrpc":-1,"mem":9474,"exp":0,"renderType":1,"uptime":64627486,"storageUsed":495976,"storageSize":1378241,"rr0":1,"rr1":14,"rebootCounter":0}';

test('status frame parses with wire field names intact', () => {
  const status = JSON.parse(FIXTURE);
  for (const key of ['fps', 'vmerr', 'vmerrpc', 'mem', 'exp', 'renderType', 'uptime', 'storageUsed', 'storageSize', 'rr0', 'rr1', 'rebootCounter']) {
    assert.ok(key in status, `missing wire field: ${key}`);
  }
  assert.equal(typeof status.fps, 'number');
  assert.equal(typeof status.uptime, 'number');
});
