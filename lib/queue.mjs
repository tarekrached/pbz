// The device's message queues and their waiters, split out from the socket so
// they can be tested without one. This is where a whole class of bug lived, so
// it earns its own file and its own tests.
//
// The device talks unprompted. A status frame arrives roughly once a second on
// every connection, and some requests emit more frames than their caller
// consumes. On a reused connection those pile up, and a waiter that takes the
// oldest prefix match will return one of them: an answer to a question nobody
// asked, from before the write it is meant to reflect. Concretely, that made a
// read after a write report the pre-write value, and made an activate() report
// success against a frame left over from an earlier call.
//
// The fix is a sequence number per message plus an explicit watermark. Take a
// mark() BEFORE sending, wait only for messages after it, and nothing already
// queued can satisfy the request.

const MAX_QUEUED = 256; // unclaimed frames (mostly ~1/s status) must not grow without bound

export function makeQueues({ maxQueued = MAX_QUEUED, now = () => Date.now(), pollMs = 10 } = {}) {
  const texts = [];
  const binaries = [];
  let seq = 0;

  // Set once the transport underneath is gone (see protocol.mjs `die`). A dead
  // connection is NOT a slow device: without this, every parked waiter runs out
  // its own full timeout and then reports a timeout, which reads as "the device
  // ignored the command" when the truth is "nothing was listening". Waiters
  // reject rather than resolving null, so callers get the transport's own error
  // instead of their generic timeout message.
  let failure = null;
  const pending = new Set();

  const push = (queue, value) => {
    queue.push({ seq: ++seq, value });
    if (queue.length > maxQueued) queue.splice(0, queue.length - maxQueued);
    return seq;
  };

  const waitEntry = (queue, match, ms, after) => new Promise((res, rej) => {
    const take = () => {
      const idx = queue.findIndex(e => e.seq > after && match(e.value));
      return idx >= 0 ? queue.splice(idx, 1)[0] : null;
    };
    // Already dead, but still worth one look: the answer may have landed in the
    // same event-loop batch that delivered the close.
    if (failure) {
      const entry = take();
      if (entry) res(entry); else rej(failure()); // a fresh instance per waiter
      return;
    }
    const t0 = now();
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearInterval(iv); pending.delete(abort); fn(v); };
    const tick = () => {
      const entry = take();
      if (entry) { finish(res, entry); return; }
      if (now() - t0 > ms) finish(res, null);
    };
    // The transport died. Poll ONE more time before giving up. Waiters run on a
    // pollMs interval and the ws implementation dispatches buffered message
    // events and then the close event in the same batch, so a response that has
    // already arrived is routinely up to pollMs short of being claimed.
    // Rejecting without this last look turns a write the device genuinely
    // completed into a reported failure — the confident-wrong-answer class that
    // Chunk 24 existed to remove, arrived at from the other direction.
    const abort = (err) => { tick(); finish(rej, err); };
    const iv = setInterval(tick, pollMs);
    pending.add(abort);
    tick(); // don't pay a poll interval for a message that already arrived
  });
  const waitOn = async (queue, match, ms, after) =>
    (await waitEntry(queue, match, ms, after))?.value ?? null;

  return {
    /** Current watermark. Take this BEFORE sending a request. */
    mark: () => seq,
    pushText: (msg) => push(texts, msg),
    pushBinary: (buf) => push(binaries, buf),

    /**
     * The transport died: reject every parked waiter with `err` now, and every
     * later one on arrival. Idempotent — the first cause wins, because the
     * close event that follows an error would otherwise overwrite the more
     * specific reason with a generic one.
     *
     * Queued messages are deliberately NOT cleared: frames that arrived before
     * the drop are still real, and `peekBinary`/`purgeBinary` callers (which
     * never block) can still read them.
     */
    fail: (makeErr) => {
      if (failure) return;
      failure = makeErr;
      // A FRESH error per waiter. Handing every rejection one shared instance
      // means anything that annotates an error it caught (pixelblaze.mjs's
      // device-state note) writes on an object other callers also hold, and a
      // concurrent read picks up a save's annotation.
      for (const abort of [...pending]) abort(makeErr());
      pending.clear();
    },

    /** The failure `fail()` recorded, as a fresh Error, or null while healthy. */
    failure: () => (failure ? failure() : null),

    /**
     * `after` defaults to -1 (match anything queued) so a reader of purely
     * unsolicited frames can opt in. Every request/response pair should pass a
     * real mark().
     */
    waitText: (prefix, ms = 3000, after = -1) =>
      waitOn(texts, (m) => m.startsWith(prefix), ms, after),

    /** `type` filters on the frame-type byte so a stray frame of another type can't match. */
    waitBinary: (ms = 3000, type, after = -1) =>
      waitOn(binaries, (b) => type == null || b[0] === type, ms, after),

    /**
     * Read a chunked binary response, ending on the framing's OWN last-chunk
     * flag (bit 4) rather than on a receive timeout.
     *
     * Ending on a timeout silently truncates whenever an inter-chunk gap
     * exceeds it, and this device is documented to stall for far longer than
     * any sane timeout: a short pattern list reads as "no pattern matching", a
     * partial source blob throws an opaque decompress error, and a truncated
     * jpeg is written without complaint. A gap that really does exceed `ms` is
     * now an error rather than a quiet short read.
     *
     * `headerBytes` is how much of each frame to drop: 2 for the frame header,
     * 19 where a 17-byte ascii id follows it.
     */
    collectChunks: async (type, { ms = 3000, after = -1, headerBytes = 2, onProgress } = {}) => {
      const parts = [];
      let since = after;
      for (;;) {
        const entry = await waitEntry(binaries, (b) => b[0] === type, ms, since);
        // `onProgress` fires per CLAIMED chunk, which is the honest "this
        // connection is in use" signal for a transfer that outlives the idle
        // backstop. Re-arming on every inbound message is the version that
        // failed before (the ~1/s unsolicited status frames made the backstop
        // dead code); a claim only happens when a caller is actively reading.
        if (entry) onProgress?.();
        if (!entry) {
          throw new Error(`device stopped sending mid-transfer (frame type ${type}, ${parts.length} chunk(s) received)`);
        }
        // Advance to the seq of the frame just taken, NOT to the queue's current
        // head: chunks already sitting in the queue would otherwise be skipped
        // and the transfer would look truncated.
        since = entry.seq;
        const frame = entry.value;
        parts.push(frame.subarray(headerBytes));
        if (frame[1] & 4) break; // last-chunk flag
      }
      return Buffer.concat(parts);
    },

    /** Drop every queued binary frame of `type` (preview frames nobody claimed). */
    purgeBinary: (type) => {
      for (let i = binaries.length - 1; i >= 0; i--) if (binaries[i].value[0] === type) binaries.splice(i, 1);
    },

    /** Binary frames after `after` matching `type`, without consuming them. */
    peekBinary: (type, after) => binaries.filter(e => e.seq > after && e.value[0] === type).map(e => e.value),

    _sizes: () => ({ texts: texts.length, binaries: binaries.length }),
  };
}
