// Companion to device-state.test.mjs, which drives save() through a fake
// CONNECTION object. That fake could quietly disagree with the real transport,
// so these two drive the real protocol.mjs through an injected fake SOCKET and
// prove the annotation survives both ways a step can actually fail:
//
//   1. a genuine expectText timeout (the 3s default — the only slow test here,
//      which is why it lives in its own file so `node --test` overlaps it with
//      the other files' waits rather than summing them), and
//   2. a Chunk 29 transport death, where the error is not ours at all: it comes
//      from queue.fail() and must reach the caller with protocol.mjs's own
//      message INTACT and our note appended, not flattened into a new Error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pixelblaze } from '../lib/pixelblaze.mjs';

class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.closed = true; this.onclose?.(); }
  deliver(data) { this.onmessage?.({ data }); }
}

async function withFakeSocket(fn) {
  const real = globalThis.WebSocket;
  let sock;
  globalThis.WebSocket = class extends FakeWS { constructor(u) { super(u); sock = this; } };
  try { return await fn(() => sock); } finally { globalThis.WebSocket = real; }
}

function stubbedPb() {
  const pb = new Pixelblaze('fake-host');
  pb._tooling = { compile: () => ({}), lz: (s) => Buffer.from(s, 'utf8'), lzDecompress: () => '', normalizeMap: () => [] };
  pb.compile = async () => ({ program: { exports: {} }, bytecode: Buffer.from([1, 2, 3, 4]) });
  return pb;
}

const failed = (p) => p.then(() => null, (e) => e);

test('a real ack timeout through the real transport still gets annotated', async () => {
  // Nothing answers, so expectText runs out its full 3s default and throws its
  // own timeout message. ~3s, by design: this is the honest end-to-end path.
  await withFakeSocket(async () => {
    const pb = stubbedPb();
    const e = await failed(pb.save('src', 'Sweep'));
    assert.match(e.message, /timed out after 3000ms/, 'the real timeout error, not a fake');
    assert.equal(e.device.state, 'maybe-paused');
    assert.match(e.message, /may be sitting frozen/);
    pb.close();
  });
});

test('a transport death is annotated WITHOUT losing the transport\'s own message', async () => {
  // The Chunk 29 error carries the device address and a pointer at the recovery
  // playbook, and both must survive. This is the case that argues for annotating
  // in place instead of wrapping in a fresh Error.
  await withFakeSocket(async (getSock) => {
    const pb = stubbedPb();
    const saving = failed(pb.save('src', 'Sweep'));
    // Let the connection open and the first send go out, then hang up.
    await new Promise(r => setTimeout(r, 30));
    getSock().onclose?.({ code: 1006 });
    const e = await saving;
    assert.match(e.message, /closed the connection mid-exchange \(code 1006\)/, "protocol.mjs's own text must survive");
    assert.match(e.message, /Device etiquette & recovery/, 'including its pointer at the playbook');
    assert.equal(e.device.state, 'maybe-paused');
    assert.match(e.message, /may be sitting frozen/, 'and our note is appended, not substituted');
  });
});

test('a save annotation cannot leak onto a concurrent reader\'s error', async () => {
  // The transport used to hand every waiter ONE shared Error instance, so
  // annotating the one a save caught wrote on the object a concurrent read was
  // also holding — and reads on one instance are explicitly supported. Each
  // rejection now gets its own instance.
  await withFakeSocket(async (getSock) => {
    const pb = stubbedPb();
    const saving = failed(pb.save('src', 'Sweep'));
    const reading = failed(pb.getStatus());     // a monitor loop, the supported concurrency
    await new Promise(r => setTimeout(r, 30));
    getSock().onclose?.({ code: 1006 });
    const [saveErr, readErr] = [await saving, await reading];
    assert.ok(saveErr.device, 'the save reports what it left');
    assert.equal(readErr.device, undefined, "the reader's error must not carry the save's state");
    assert.doesNotMatch(readErr.message, /sitting frozen/, "nor the save's note");
    assert.notEqual(saveErr, readErr, 'and they must not be the same object');
  });
});

test('run: a transport death keeps the transport\'s own error, not a generic one', async () => {
  // run() now fails loudly when the resume goes unacknowledged. An earlier cut
  // of that swallowed the rejection and threw a fresh generic Error in its
  // place, discarding the device address, the close code and the recovery
  // pointer — undoing Chunk 29 on this path. `pbz power <pattern>` goes through
  // run() too, so it is not only `pbz run` that would have lost them.
  await withFakeSocket(async (getSock) => {
    const pb = stubbedPb();
    const running = failed(pb.run('src'));
    await new Promise(r => setTimeout(r, 30));
    getSock().onclose?.({ code: 1006 });
    const e = await running;
    assert.match(e.message, /closed the connection mid-exchange \(code 1006\)/, 'the transport error must survive');
    assert.match(e.message, /Device etiquette & recovery/);
    assert.doesNotMatch(e.message, /did not acknowledge both resume commands/, 'the generic message is for a TIMEOUT, not a death');
    assert.equal(e.device.state, 'maybe-paused');
  });
});
