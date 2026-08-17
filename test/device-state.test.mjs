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
import { CHUNK_BYTES } from '../lib/protocol.mjs';

const previewFrame = () => { const b = Buffer.alloc(1 + PREVIEW_W * 3); b[0] = 5; return b; };

/**
 * A device that acks PER COMMAND, which is what the real one does and what an
 * earlier version of this fake got wrong. It counted ack WAITS instead, so
 * "setControls acked, {pause:false} lost" — the exact shape that made the
 * chunk's core invariant wrong — could not be expressed at all, and the test
 * named for the honesty rule was really testing a different event.
 *
 * `suppress` names the acks the device withholds: 'setCode', 'setControls',
 * 'resume', 'putSourceCode', 'activate'. `throwOn` makes a SEND throw the way a
 * dead connection does since Chunk 29, before any byte leaves the machine.
 */
function fakeConn({ suppress = [], throwOn = null, frames = 150, withholdCompletion = false, framesThrow = false } = {}) {
  const held = new Set(suppress);
  const inbox = [];
  let seq = 0;
  const ACK = '{"ack":1}';
  // Sequenced, and mark()/waitText honour it: the watermark is the mechanism
  // the whole invariant rests on, and a fake that ignores it cannot catch a
  // wait that claims an ack queued before its own command.
  const emit = (what, frame) => { if (!held.has(what)) inbox.push({ seq: ++seq, frame }); };
  return {
    sent: [],
    stale: () => emit('stale', ACK), // an ack left over from an earlier command
    mark: () => seq,
    dead: () => null,
    close: () => {},
    json(msg) {
      if (throwOn === 'setCode' && 'setCode' in msg) throw new Error('websocket: connection died');
      if (throwOn === 'activate' && 'activeProgramId' in msg) throw new Error('websocket: connection died');
      this.sent.push(msg);
      if ('setCode' in msg) emit('setCode', ACK);
      else if ('setControls' in msg) emit('setControls', ACK);
      else if (msg.pause === false) emit('resume', ACK);
      else if ('activeProgramId' in msg) emit('activate', '{"activeProgram":{"name":"X","activeProgramId":"abc"}}');
    },
    sendBytecode(blob, type) {
      if (throwOn === 'putSourceCode' && type === 1) throw new Error('websocket: connection died');
      if (type !== 1) return;
      // ONE ACK PER FRAME, derived from the real blob, with only the last
      // carrying the completion marker — that is what the device does, and a
      // fixed count decoupled from the payload let the loop go untested.
      const chunks = Math.max(1, Math.ceil(blob.length / CHUNK_BYTES));
      for (let i = 0; i < chunks - 1; i++) emit('putSourceCode', ACK);
      emit('putSourceCode', withholdCompletion ? ACK : '{"ack":1,"saveProgramSourceFile":true}');
    },
    async waitText(prefix, ms, after = -1) {
      const i = inbox.findIndex(e => e.seq > after && e.frame.startsWith(prefix));
      return i < 0 ? null : inbox.splice(i, 1)[0].frame; // null == timed out
    },
    async collectFrames() {
      if (framesThrow) throw new Error('websocket: connection died');
      return Array.from({ length: frames }, previewFrame);
    },
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

test('save: a withheld setCode ack reports only that the device MAY be paused', async () => {
  const e = await failed(pbWith(fakeConn({ suppress: ['setCode'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /may be sitting frozen/);
  assert.match(e.message, /fps 0/, 'the note must give a way to check');
  assert.doesNotMatch(e.message, /IS saved/, 'nothing was written and nothing may say so');
  assert.doesNotMatch(e.message, /`pbz list`/, 'that is the maybe-saved advice, not this state');
  assert.doesNotMatch(e.message, /WAS live/, 'the resume never happened');
});

test('save: setControls acked but the RESUME lost stays maybe-paused', async () => {
  // THE regression. Two commands go out and each acks on its own, so the first
  // wait claims setControls'. Advancing there was the honesty rule inverted,
  // and it made a frozen wall report itself as rendering. The window where this
  // is undecidable runs from the resume until frames arrive, so the failure is
  // injected there — once frames arrive the device has PROVED it is rendering.
  const e = await failed(pbWith(fakeConn({ suppress: ['resume'], framesThrow: true })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /may be sitting frozen/);
  assert.doesNotMatch(e.message, /WAS live on the device/, 'the resume was never acknowledged');
});

test('save: preview frames are accepted as proof of rendering when the ack was lost', async () => {
  // The converse of the test above: a lost resume ack is forgiven the moment
  // the device draws something, because frames are the stronger evidence.
  const e = await failed(pbWith(fakeConn({ suppress: ['resume', 'activate'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'saved-maybe-inactive');
  assert.doesNotMatch(e.message, /may additionally be sitting paused/);
});

test('save: zero preview frames, resume acked, reports live-but-unsaved', async () => {
  const e = await failed(pbWith(fakeConn({ frames: 0 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'running-unsaved');
  assert.match(e.message, /no preview frames/, 'the original error must survive intact');
  assert.match(e.message, /WAS live on the device/, 'past tense: a reboot may already have ended it');
  assert.match(e.message, /absent from `pbz list`/);
  assert.doesNotMatch(e.message, /may be sitting frozen/, 'the resume WAS acked here');
});

test('save: zero preview frames with the resume LOST reports the frozen wall instead', async () => {
  // Item 8's own case over a paused device. A still-paused device is the most
  // likely reason there were no frames, so answering the error's own "Is the
  // pattern rendering?" with "yes, definitely" was the worst possible reply.
  const e = await failed(pbWith(fakeConn({ frames: 0, suppress: ['resume'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /no preview frames/);
  assert.match(e.message, /may be sitting frozen/, 'the likeliest cause of zero frames');
  assert.doesNotMatch(e.message, /WAS live on the device/);
});

test('save: a withheld putSourceCode ack does not advise deleting anything', async () => {
  // The advice used to be "delete it before retrying". stableId means a
  // re-save updates in place, so on every re-save the name is ALREADY listed —
  // and following that advice destroys the previous good copy.
  const e = await failed(pbWith(fakeConn({ suppress: ['putSourceCode'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-saved');
  assert.match(e.message, /may or may not have landed/);
  assert.match(e.message, /retrying is safe/);
  assert.doesNotMatch(e.message, /delete/i, 'never advise deleting: a re-save overwrites in place');
  assert.doesNotMatch(e.message, /IS saved to the device/);
});

test('save: acks for early chunks do not count as the write completing', async () => {
  // The device acks EVERY frame and only the last carries the completion
  // marker, so claiming the first ack advanced the cursor on chunk 1 of N.
  // The fake derives its ack count from the real blob, so this genuinely
  // exercises the loop rather than a hand-set number.
  const e = await failed(pbWith(fakeConn({ withholdCompletion: true, suppress: ['activate'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-saved', 'plain chunk acks must not earn "saved"');
  assert.doesNotMatch(e.message, /IS saved to the device/);
});

test('save: the completion marker is found across a multi-chunk write', async () => {
  // The positive half: a real multi-chunk blob (150 preview frames make one)
  // must still reach `saved-maybe-inactive`, so the loop cannot be "fixed" by
  // simply never promoting.
  const conn = fakeConn({ suppress: ['activate'] });
  const e = await failed(pbWith(conn).save('src', 'Sweep'));
  assert.equal(e.device.state, 'saved-maybe-inactive');
});

test('save: a stale ack queued before the write cannot satisfy its completion wait', async () => {
  // The watermark is what stops an ack from an earlier command answering a
  // later one. Without it, a leftover ack would be claimed as chunk 1 and shift
  // the whole sequence by one.
  const conn = fakeConn({ suppress: ['activate'] });
  const pb = pbWith(conn);
  // Emitted during the preview collection, i.e. BEFORE save() takes the mark
  // for the write. Hooking a later step would make it seq > mark and therefore
  // legitimately claimable, which is a test bug rather than a device one.
  const original = conn.collectFrames.bind(conn);
  conn.collectFrames = async (...a) => { const f = await original(...a); conn.stale(); return f; };
  const e = await failed(pb.save('src', 'Sweep'));
  assert.equal(e.device.state, 'saved-maybe-inactive', 'a stale ack must not consume the completion slot');
});

test('save: a withheld activate reports it IS saved, with the true reboot behaviour', async () => {
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'saved-maybe-inactive');
  assert.equal(e.device.id, stableId('Sweep'), 'save reports the id it actually wrote');
  assert.match(e.message, /IS saved to the device/);
  // Verified live three times: the boot pointer follows the most recently
  // SAVED pattern, so the intuitive "reverts to the previous one" is backwards.
  assert.match(e.message, /boots whichever pattern was saved most recently/);
  assert.doesNotMatch(e.message, /revert to the previously active/, 'that claim is false on this firmware');
  assert.match(e.message, /`pbz activate 'Sweep'` settles it/);
});

test('save: the recovery command is SHELL-quoted, not JSON-quoted', async () => {
  // JSON quoting leaves backticks and $ live for the shell, and this string is
  // written to be pasted into one.
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', 'a`reboot`$HOME'));
  assert.match(e.message, /pbz activate 'a`reboot`\$HOME'/, 'single quotes make the shell take it literally');
  assert.doesNotMatch(e.message, /activate "a`/, 'double quotes would let the shell run it');
});

test('save: an embedded single quote is escaped rather than breaking out', async () => {
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', "it's"));
  assert.match(e.message, /pbz activate 'it'\\''s'/);
});

test('save: a send that throws before anything leaves the machine claims nothing', async () => {
  // Chunk 29 made json()/sendBytecode() throw synchronously on a dead
  // connection, BEFORE a byte moves. The documented contract is that no
  // `device` property means the device was never touched.
  const e = await failed(pbWith(fakeConn({ throwOn: 'setCode' })).save('src', 'Sweep'));
  assert.match(e.message, /connection died/);
  assert.equal(e.device, undefined, 'nothing was sent, so nothing may be claimed');
});

test('save: a putSourceCode send that throws does not claim the data was sent', async () => {
  const e = await failed(pbWith(fakeConn({ throwOn: 'putSourceCode' })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'running-unsaved', 'the live push happened; the flash write did not');
  assert.doesNotMatch(e.message, /pattern data was sent/);
});

test('save: a compile failure never reaches the device and says nothing about it', async () => {
  const e = await failed(pbWith(fakeConn(), { compileThrows: true }).save('src', 'Sweep'));
  assert.match(e.message, /syntax error/);
  assert.equal(e.device, undefined);
});

test('save: the happy path annotates nothing', async () => {
  const res = await pbWith(fakeConn()).save('src', 'Sweep');
  assert.equal(res.frames, 150);
  assert.ok(res.previewBytes > 0);
});

test('save: no save-side state can coexist with an unconfirmed resume', async () => {
  // Not a wish, a structural fact: every save-side state is downstream of the
  // preview frames, and frames prove the renderer is running. This pins it so
  // nobody adds a "paused and saved" combination that cannot occur.
  const e = await failed(pbWith(fakeConn({ suppress: ['resume', 'putSourceCode'] })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-saved', 'frames arrived, so the pause question is settled');
  assert.doesNotMatch(e.message, /sitting frozen/);
});

test('run: a lost resume ack fails loudly instead of reporting success', async () => {
  // Two acks for the pair is verified live (22ms and 44ms), so a missing second
  // one is a real signal, not a firmware quirk. Returning ok here is how
  // `pbz run` printed "ok (live, not saved)" over a frozen wall.
  const e = await failed(pbWith(fakeConn({ suppress: ['resume'] })).run('src'));
  assert.ok(e, 'must not resolve');
  assert.equal(e.device.state, 'maybe-paused');
  assert.equal(e.device.id, undefined, 'run saves nothing, so there is no id');
  assert.doesNotMatch(e.message, /undefined/, 'the missing name must not leak');
  assert.doesNotMatch(e.message, /IS saved/);
});

test('run: the happy path annotates nothing', async () => {
  const res = await pbWith(fakeConn()).run('src');
  assert.ok(res.bytecode);
});

test('a thrown non-Error passes through untouched rather than being replaced', async () => {
  // Assigning a property to a string throws in strict mode, which would swap
  // the real failure for a TypeError pointing at the annotation helper.
  const pb = pbWith(fakeConn());
  pb.compile = async () => { throw 'lz: bad input'; }; // eslint-disable-line no-throw-literal
  const e = await failed(pb.save('src', 'Sweep'));
  assert.equal(e, 'lz: bad input');
});
