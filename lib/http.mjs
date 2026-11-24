// HTTP to the device, with a failure message that names the real cause.
//
// Node's fetch() rejects every network failure with the same bare
// `TypeError: fetch failed`, the system error code tucked away in `.cause`.
// That bare message cost a night once: macOS Local Network privacy was
// refusing node (EHOSTUNREACH, instantly, nothing ever left the machine) and
// "fetch failed" read as a sick device. So: keep "fetch failed" as the
// message's first words (anything matching on it still matches), add the URL
// and the code, attach the code as `err.code`, and for the can't-route codes
// say how to tell this machine's problem from the device's.

// Codes where the request most likely never reached the device. EHOSTUNREACH
// is what macOS Local Network privacy produces; ENETUNREACH also shows up for
// a host that is simply absent from the LAN (measured: ~10 s, Node 26), so the
// hint is phrased as a test to run, not a verdict.
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

export function unreachableHint(host) {
  return ` — this machine could not route to ${host}. If \`curl http://${host}/\` works from` +
    ' the same terminal, macOS Local Network privacy is blocking node and the device is fine' +
    ' (see "Device etiquette & recovery"); rebooting the device will not help.';
}

/**
 * Wrap a fetch() network failure (not an HTTP status, which callers check
 * themselves) in an Error carrying the URL, the system code and a hint.
 * `err.code` is the system code when there is one; `err.cause` is the original.
 */
export function describeFetchError(url, e) {
  const code = e?.cause?.code;
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const err = new Error(
    `fetch failed: ${url}${code ? ` (${code})` : e?.cause?.message ? ` (${e.cause.message})` : ''}` +
    `${UNREACHABLE.has(code) ? unreachableHint(host) : ''}`,
    { cause: e });
  if (code) err.code = code;
  return err;
}

export async function httpFetch(url, init, fetchImpl = globalThis.fetch) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    // An abort is the caller's own doing; pass it through untouched.
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
    throw describeFetchError(url, e);
  }
}
