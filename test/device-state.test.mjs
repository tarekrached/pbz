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
function fakeConn({ suppress = [], throwOn = null, frames = 150, withholdCompletion = false, framesThrow = false, dieOnWait = 0 } = {}) {
  const held = new Set(suppress);
  const inbox = [];
  let seq = 0;
  let waits = 0;
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
      // `dieOnWait` makes the Nth wait REJECT the way a transport death does,
      // as opposed to resolving null the way a timeout does. The difference is
      // the whole point of the error-preservation paths.
      if (dieOnWait && ++waits === dieOnWait) {
        throw new Error('websocket: device at fake-host:81 closed the connection mid-exchange (code 1006) — see "Device etiquette & recovery"');
      }
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
  assert.doesNotMatch(e.message, /pbz list/, 'that is the maybe-saved advice, not this state');
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

test('save: zero preview frames reports the frozen wall, whatever the acks said', async () => {
  // This used to distinguish "resume acked" from "resume lost" and report
  // live-but-unsaved for the first. It cannot: acks carry no request id, and a
  // straggler from the multi-chunk bytecode send is indistinguishable from the
  // resume's own, so a fuzz run bought `running-unsaved` with an unmatched ack
  // and zero frames drawn. With no frames there is no unambiguous evidence of
  // rendering, and a still-paused device is the likeliest reason there are
  // none — so the honest report is the pause, regardless of what was acked.
  const e = await failed(pbWith(fakeConn({ frames: 0 })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /no preview frames/, 'the original error must survive intact');
  assert.match(e.message, /may be sitting frozen/);
  assert.doesNotMatch(e.message, /WAS live on the device/, 'never claim rendering without frames');
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
  assert.match(e.message, /`pbz activate --host='fake-host' '[A-Za-z0-9]+'` settles it/, 'the command must carry the host and target the id');
  assert.doesNotMatch(e.message, /`pbz activate 'Sweep'`/, 'the bare name would hit the configured default device');
});

test('save: the recovery command is SHELL-quoted, not JSON-quoted', async () => {
  // JSON quoting leaves backticks and $ live for the shell, and this string is
  // written to be pasted into one.
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', 'a`reboot`$HOME'));
  assert.match(e.message, /'a`reboot`\$HOME'/, 'single quotes make the shell take it literally');
  assert.doesNotMatch(e.message, /"a`/, 'double quotes would let the shell run it');
});

test('save: an embedded single quote is escaped rather than breaking out', async () => {
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', "it's"));
  assert.match(e.message, /'it'\\''s'/);
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
  assert.ok(!('id' in e.device), 'run saves nothing, so the key must be ABSENT, not undefined');
  assert.doesNotMatch(e.message, /undefined/, 'the missing name must not leak');
  assert.doesNotMatch(e.message, /IS saved/);
});

test('run: the happy path annotates nothing', async () => {
  const res = await pbWith(fakeConn()).run('src');
  assert.ok(res.bytecode);
});

// The annotator must hand back exactly what it was given whenever it cannot
// safely annotate. Two mechanisms cover these four: the type guard rejects the
// non-objects (`typeof null === 'object'` is why null needs its own clause),
// and the assignment's own catch covers anything that refuses the property —
// frozen here, and equally sealed or read-only-`device`. Either way the
// original must survive: swapping it for a TypeError about the annotator is
// the failure this exists to prevent. All of these throw from INSIDE save()'s
// try (via `lz`, called by buildPBP); throwing from compile(), which runs
// before the try, would not reach the annotator at all.
for (const [label, make] of [
  ['a string', () => 'lz: bad input'],
  ['null', () => null],
  ['undefined', () => undefined],
  ['a frozen Error', () => Object.freeze(new Error('frozen'))],
]) {
  test(`the annotator hands back ${label} untouched rather than replacing it`, async () => {
    const thrown = make();
    const pb = pbWith(fakeConn());
    pb._tooling.lz = () => { throw thrown; };
    let caught = 'did not throw';
    try { await pb.save('src', 'Sweep'); } catch (e) { caught = e; }
    assert.equal(caught, thrown, 'the original throw must reach the caller unchanged');
    if (caught && typeof caught === 'object') {
      assert.equal(caught.device, undefined, 'and must not have acquired a device state');
    }
  });
}

test('an error whose message cannot be written is left alone', async () => {
  // The guard is about WRITABILITY, not type: a getter-only `message` (frozen
  // errors, DOMException) takes the same strict-mode assignment failure.
  const pb = pbWith(fakeConn());
  pb._tooling.lz = () => {
    const e = new Error('sealed');
    Object.defineProperty(e, 'message', { get: () => 'sealed', configurable: false });
    throw e;
  };
  const e = await failed(pb.save('src', 'Sweep'));
  assert.equal(e.message, 'sealed', 'the real failure must not become a TypeError about this helper');
});

test('save: the frames path reaches running-unsaved even with the resume ack lost', async () => {
  // The observable proof that frames promote. An earlier test claimed to cover
  // this but asserted at a point where later assignments had already overwritten
  // the promotion, so deleting it left the suite green.
  const e = await failed(pbWith(fakeConn({ suppress: ['resume'], throwOn: 'putSourceCode' })).save('src', 'Sweep'));
  assert.equal(e.device.state, 'running-unsaved', 'frames arrived, so the pause question is settled');
  assert.doesNotMatch(e.message, /sitting frozen/);
});

test('run: a send that throws before anything leaves the machine claims nothing', async () => {
  // run()'s side of the line-order rule, which was pinned only for save().
  const e = await failed(pbWith(fakeConn({ throwOn: 'setCode' })).run('src'));
  assert.match(e.message, /connection died/);
  assert.equal(e.device, undefined, 'nothing was sent, so nothing may be claimed');
});

test('an error that already carries a device state is not annotated twice', async () => {
  // The guard exists so a second annotation cannot glue one call's state onto
  // another call's error. It was correct but untested, and an untested guard is
  // one refactor away from being deleted as dead code.
  const pb = pbWith(fakeConn());
  pb._tooling.lz = () => {
    const e = new Error('already handled');
    e.device = { state: 'maybe-paused' };
    throw e;
  };
  const e = await failed(pb.save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused', 'the first state must survive');
  assert.doesNotMatch(e.message, /WAS live/, 'and no second note may be appended');
});

test('every state names the host in the commands it prints', async () => {
  // Round three's headline finding was advice that could run against the wrong
  // device. Two of the four states had no test pinning the host, which is how a
  // regression there would have gone unnoticed — including `maybe-paused`, the
  // only state run() can produce and where most save failures land.
  const cases = [
    [{ suppress: ['setCode'] }, 'maybe-paused'],
    [{ suppress: ['putSourceCode'] }, 'maybe-saved'],
    [{ throwOn: 'putSourceCode' }, 'running-unsaved'],
    [{ suppress: ['activate'] }, 'saved-maybe-inactive'],
  ];
  for (const [opts, expected] of cases) {
    const e = await failed(pbWith(fakeConn(opts)).save('src', 'Sweep'));
    assert.equal(e.device.state, expected);
    assert.match(e.message, /--host='fake-host'/, `${expected} must name the device it is talking about`);
  }
});

test('save: the reported id is the one actually written, not one re-derived from the name', async () => {
  // `import()` passes the .epe's own id through as opts.id, so id and
  // stableId(name) genuinely diverge there — and every other test saves without
  // opts.id, where they coincide and a re-derivation bug would be invisible.
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', 'Sweep', { id: 'ZZZfromTheEpe' }));
  assert.equal(e.device.id, 'ZZZfromTheEpe');
  assert.notEqual(e.device.id, stableId('Sweep'));
  assert.match(e.message, /'ZZZfromTheEpe'/, 'and the recovery command targets that id');
});

test('save: a file-supplied id is shell-quoted like everything else in the command', async () => {
  // opts.id comes from a .epe FILE, so it is not necessarily stableId() output.
  const e = await failed(pbWith(fakeConn({ suppress: ['activate'] })).save('src', 'Sweep', { id: 'a`reboot`' }));
  assert.match(e.message, /'a`reboot`'/, 'quoted, so a hostile .epe cannot execute on paste');
  assert.doesNotMatch(e.message, /activate --host='fake-host' a`/, 'never bare');
});

// --- drift guards -----------------------------------------------------------
// Add a fifth `left = '...'` state without a DEVICE_LEFT entry and nothing
// crashes: withDeviceState returns the error UNANNOTATED, which the documented
// contract reads as "nothing was sent and the wall was never touched" — the
// opposite of the truth, silently. No runtime test can reach it, so this reads
// the source, the way test/types.test.mjs guards the .d.mts.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const libSrc = readFileSync(path.join(import.meta.dirname, '../lib/pixelblaze.mjs'), 'utf8');
const dtsSrc = readFileSync(path.join(import.meta.dirname, '../lib/pixelblaze.d.mts'), 'utf8');

test('every state the code assigns has a message, and is declared in the types', () => {
  // Scraping source is fragile, so this is written to fail LOUD rather than
  // quietly stop guarding. An earlier version matched only `left = 'x'` with
  // single quotes, lowercase-and-hyphen names and exactly one space each side:
  // it caught one of seven spellings of the drift it exists to catch, and it
  // false-FAILED on cosmetic reformatting of the table or the union. Both
  // directions are checked now, and the self-checks below assert the scrapes
  // still find things at all.
  const assigned = new Set([...libSrc.matchAll(/\bleft\s*=\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]));
  const tableStart = libSrc.indexOf('const DEVICE_LEFT = {');
  assert.notEqual(tableStart, -1, 'DEVICE_LEFT table not found — this guard has stopped guarding');
  const table = libSrc.slice(tableStart, libSrc.indexOf('\n};', tableStart));
  const declared = new Set([...table.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)].map(m => m[1] ?? m[2] ?? m[3]));
  const unionSrc = dtsSrc.slice(dtsSrc.indexOf('export type DeviceLeftState'), dtsSrc.indexOf(';', dtsSrc.indexOf('export type DeviceLeftState')));
  const union = new Set([...unionSrc.matchAll(/'([^']+)'/g)].map(m => m[1]));

  // Self-checks: if a refactor breaks the scraping, fail here rather than
  // silently passing forever on empty sets.
  assert.ok(assigned.size >= 4, `scraped only ${assigned.size} assigned states — the scrape is broken`);
  assert.ok(declared.size >= 4, `scraped only ${declared.size} table entries — the scrape is broken`);
  assert.ok(union.size >= 4, `scraped only ${union.size} union members — the scrape is broken`);

  for (const state of assigned) assert.ok(declared.has(state), `state '${state}' is assigned but has no DEVICE_LEFT message`);
  for (const state of declared) assert.ok(union.has(state), `state '${state}' has a message but is missing from DeviceLeftState`);
  // The reverse direction too, or dead advice text rots in place: a message for
  // a state nothing assigns any more would otherwise pass forever.
  for (const state of declared) assert.ok(assigned.has(state), `state '${state}' has a message but nothing assigns it`);
  for (const state of union) assert.ok(declared.has(state), `state '${state}' is declared in the types but has no message`);
});
test('a thrown null survives the annotator untouched', async () => {
  // Without the object/null guards, `e.device = …` on null throws a SECOND,
  // unrelated TypeError from inside the annotator, destroying the original at
  // the moment a caller most needs it. The existing sibling test covers only
  // strings, so this was a real gap a mutation sweep found.
  const pb = pbWith(fakeConn());
  pb._tooling.lz = () => { throw null; }; // eslint-disable-line no-throw-literal
  let caught = 'did not throw';
  try { await pb.save('src', 'Sweep'); } catch (e) { caught = e; }
  assert.equal(caught, null, 'a thrown null must reach the caller unchanged');
});

test('a thrown undefined survives the annotator untouched', async () => {
  const pb = pbWith(fakeConn());
  pb._tooling.lz = () => { throw undefined; }; // eslint-disable-line no-throw-literal
  let caught = 'did not throw';
  try { await pb.save('src', 'Sweep'); } catch (e) { caught = e; }
  assert.equal(caught, undefined, 'a thrown undefined must reach the caller unchanged');
});

test('an error with an unwritable device property is returned, not replaced', async () => {
  // isExtensible does not cover this: the object accepts new properties, but
  // `device` specifically is read-only, so the assignment throws. Round four
  // moved that assignment out of the try, which turned a swallowed failure into
  // a TypeError replacing the real error — what the guard exists to prevent.
  const pb = pbWith(fakeConn());
  pb._tooling.lz = () => {
    const e = new Error('unwritable');
    Object.defineProperty(e, 'device', { value: undefined, writable: false, configurable: false });
    throw e;
  };
  let caught = 'did not throw';
  try { await pb.save('src', 'Sweep'); } catch (e) { caught = e; }
  assert.equal(caught.message, 'unwritable', 'the real failure must survive');
  assert.doesNotMatch(String(caught), /TypeError/);
});

test('run: a transport death on the resume claim keeps the transport error', async () => {
  // run()'s waits, in order: 1 setCode ack, 2 the setControls ack, 3 the
  // resume's own ack. Number 3 is where an earlier version had `.catch(() =>
  // null)`, which swallowed a transport death and threw a generic message in
  // its place — discarding the device address, the close code and the recovery
  // pointer. That fix had NO test: reintroducing the catch passed the whole
  // suite. The existing transport-level test kills the connection while run()
  // is still parked on wait 1, so it never reached this path.
  const e = await failed(pbWith(fakeConn({ dieOnWait: 3 })).run('src'));
  assert.match(e.message, /closed the connection mid-exchange \(code 1006\)/, "the transport's own error must survive");
  assert.match(e.message, /Device etiquette & recovery/);
  assert.doesNotMatch(e.message, /did not acknowledge both resume commands/, 'the generic message is for a TIMEOUT');
  assert.equal(e.device.state, 'maybe-paused');
});

test('save: zero frames with the device reporting fps>0 blames the stream, not the wall', async () => {
  // Measured live: a concurrent samplePreview() sends {sendUpdates:false} and
  // purges type-5 frames, stopping a save's collection mid-flight — so the save
  // sees zero frames while the wall renders perfectly. Zero frames therefore
  // has two opposite causes and the device's own fps distinguishes them.
  const conn = fakeConn({ frames: 0 });
  const original = conn.waitText.bind(conn);
  conn.waitText = async (prefix, ms, after) =>
    (prefix === '{"fps"' ? '{"fps":140.02}' : original(prefix, ms, after));
  const e = await failed(pbWith(conn).save('src', 'Sweep'));
  assert.equal(e.device.state, 'running-unsaved', 'fps>0 is proof it is rendering');
  assert.match(e.message, /concurrent read/, 'and the message names the likely cause');
  assert.doesNotMatch(e.message, /may be sitting frozen/, 'the wall is demonstrably not frozen');
});

test('save: zero frames with the device reporting fps 0 blames the wall', async () => {
  const conn = fakeConn({ frames: 0 });
  const original = conn.waitText.bind(conn);
  conn.waitText = async (prefix, ms, after) =>
    (prefix === '{"fps"' ? '{"fps":0}' : original(prefix, ms, after));
  const e = await failed(pbWith(conn).save('src', 'Sweep'));
  assert.equal(e.device.state, 'maybe-paused');
  assert.match(e.message, /may be sitting frozen/);
  assert.doesNotMatch(e.message, /concurrent read/);
});
