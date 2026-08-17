// PBZ-PLAN.md Chunk 30 (post-publish item 8): run() and save() change what the
// wall is showing on their FIRST step and only finish several steps later, so a
// failure in between leaves the device holding something nobody asked for. The
// errors used to say nothing about it.
//
// Every test asserts TWICE: what the message claims, and what it must NOT
// claim. The over-claim is the failure mode here — a state cursor that runs one
// step ahead produces a plausible, confident, wrong message rather than a
// crash, and only the negative assertions catch that.
//
// The transport is a plain fake connection object rather than a fake socket:
// what is under test is save()'s state cursor, not the wire. That also keeps
// the zero-frame test instant, where going through the real collectFrames would
// poll out its full 6s window (save passes no `ms`). Two companion tests in
// device-state-transport.test.mjs drive the real transport so this fake cannot
// quietly lie about the states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pixelblaze } from '../lib/pixelblaze.mjs';
import { PREVIEW_W } from '../lib/preview.mjs';
import { stableId } from '../lib/pbp.mjs';

const previewFrame = () => { const b = Buffer.alloc(1 + PREVIEW_W * 3); b[0] = 5; return b; };

/**
 * `failAckAt` is the 1-based index of the ack wait that goes unanswered. In
 * save() those are, in order: 1 setCode, 2 resume, 3 the second-ack claim,
 * 4 putSourceCode. In run(): 1 setCode, 2 resume, 3 the (swallowed) claim.
 * A null return is what waitText really does on timeout, which is what makes
 * expectText throw.
 */
function fakeConn({ failAckAt = null, frames = 150, failActivate = false } = {}) {
  let acks = 0;
  return {
    mark: () => 0,
    json: () => {},
    sendBytecode: () => {},
    dead: () => null,
    close: () => {},
    async waitText(prefix) {
      if (prefix === '{"ack"') { acks += 1; return acks === failAckAt ? null : '{"ack":1}'; }
      return failActivate ? null : '{"activeProgram":{"name":"Sweep","activeProgramId":"abc"}}';
    },
    async collectFrames() { return Array.from({ length: frames }, previewFrame); },
  };
}

function pbWith(conn, { compileThrows = false } = {}) {
  const pb = new Pixelblaze('fake-host');
  // Seeding _tooling short-circuits loadTooling's HTTP fetch, so no captured
  // web UI is needed (the fixture is deliberately not committed).
  pb._tooling = { compile: () => ({}), lz: (s) => Buffer.from(s, 'utf8'), lzDecompress: () => '', normalizeMap: () => [] };
  pb.compile = async () => {
    if (compileThrows) throw new Error('compile: syntax error at line 3');
    return { program: { exports: {} }, bytecode: Buffer.from([1, 2, 3, 4]) };
  };
  pb._getConn = async () => conn;
  return pb;
}

const failed = (p) => p.then(() => null, (e) => e);

test('save: a failed setCode ack reports only that the device MAY be paused', async () => {
  const e = await failed(pbWith(fakeConn({ failAckAt: 1 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /may be sitting frozen/);
  assert.match(e.message, /fps 0/, 'the note must give a way to check');
  // NOT /saved/i: the recovery text legitimately says `a saved pattern`. The
  // over-claim to guard against is a claim about THIS pattern.
  assert.doesNotMatch(e.message, /IS saved/, 'nothing was written and nothing may say so');
  assert.doesNotMatch(e.message, /`pbz list`/, 'that is the maybe-saved advice, not this state');
  assert.doesNotMatch(e.message, /IS rendering/, 'the resume never happened');
});

test('save: a failed RESUME ack stays maybe-paused and must not claim it is running', async () => {
  // The easiest over-claim in the method: the resume was sent, so it is
  // tempting to advance the cursor. It was never acknowledged, so the device
  // may equally well still be paused. This test is the whole honesty rule.
  const e = await failed(pbWith(fakeConn({ failAckAt: 2 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.doesNotMatch(e.message, /IS rendering on the device/, 'the resume was never acknowledged');
  assert.doesNotMatch(e.message, /IS saved/);
});

test('save: zero preview frames reports the pattern as rendering but unsaved', async () => {
  // Item 8's own reported case: it throws about thumbnails, and the thing the
  // user actually needs to know is that the wall changed.
  const e = await failed(pbWith(fakeConn({ frames: 0 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'running-unsaved');
  assert.match(e.message, /no preview frames/, 'the original error must survive intact');
  assert.match(e.message, /IS rendering on the device now/);
  assert.match(e.message, /absent from `pbz list`/);
  assert.doesNotMatch(e.message, /may be sitting frozen/, 'the resume WAS acked, so this is not the pause case');
});

test('save: a failed putSourceCode ack says the write may not have landed', async () => {
  const e = await failed(pbWith(fakeConn({ failAckAt: 4 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-saved');
  assert.match(e.message, /sent but never acknowledged/);
  assert.match(e.message, /partial transfer commits nothing/, 'verified live: truncation leaves no entry');
  assert.match(e.message, /`pbz list`/, 'the advice has to be actionable');
  assert.doesNotMatch(e.message, /IS saved to the device/, 'we never got the ack, so we cannot claim it landed');
});

test('save: a failed activate reports it IS saved, and names the finishing command', async () => {
  const e = await failed(pbWith(fakeConn({ failActivate: true })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'saved-maybe-inactive');
  assert.equal(e.device.id, stableId('Sweep'), 'save reports the id it actually wrote');
  assert.match(e.message, /IS saved to the device/);
  assert.match(e.message, /may revert to the previously active pattern on reboot/);
  assert.match(e.message, /`pbz activate "Sweep"` finishes the job/);
});

test('save: a name needing quotes stays copy-pasteable in the recovery command', async () => {
  const e = await failed(pbWith(fakeConn({ failActivate: true })).save('src', 'my "odd" name'));
  assert.match(e.message, /`pbz activate "my \\"odd\\" name"` finishes the job/);
});

test('save: a failure before anything is sent claims nothing at all', async () => {
  // The absence of `.device` is part of the contract: it means the device was
  // never touched. A note here would be a pure fabrication.
  const e = await failed(pbWith(fakeConn(), { compileThrows: true }).save('src', 'Sweep'));
  assert.match(e.message, /syntax error/);
  assert.equal(e.device, undefined, 'nothing reached the device, so nothing may be claimed');
});

test('save: the happy path annotates nothing', async () => {
  const res = await pbWith(fakeConn()).save('src', 'Sweep');
  assert.equal(res.frames, 150);
  assert.ok(res.previewBytes > 0);
});

test('run: a failed resume reports the frozen wall, with no name to quote', async () => {
  // run() takes a source and has no name, so the note must read correctly
  // without one — and must never mention saving, which run() never does.
  const e = await failed(pbWith(fakeConn({ failAckAt: 2 })).run('src'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.equal(e.device.id, undefined, 'run saves nothing, so there is no id to report');
  assert.match(e.message, /may be sitting frozen/);
  assert.doesNotMatch(e.message, /undefined/, 'the missing name must not leak into the message');
  assert.doesNotMatch(e.message, /IS saved/, 'run never saves anything');
});

test('run: reaching its own success state annotates nothing, even though the device changed', async () => {
  // run()'s contract IS "live, not saved", so the state it leaves on success is
  // the one the caller asked for. Nothing to report.
  const res = await pbWith(fakeConn()).run('src');
  assert.ok(res.bytecode);
});
