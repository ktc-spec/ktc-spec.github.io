// KTC test-vector harness — dependency-free ES module, runs in Node 18+ and browsers.
// Published at /vectors/harness.mjs. Three layers:
//   1. A reference receiver pipeline (parse → KTC payload checks → fetch → decrypt →
//      bundle checks), each stage separable so implementations can swap their own.
//   2. makeFetchShim(): offline fetch built from a vector's `responses` map.
//   3. runVector(): executes the pipeline against one vector and grades the outcome.

const td = new TextDecoder();
const te = new TextEncoder();

export const STAGES = ['decode', 'payload', 'retrieve', 'decrypt', 'bundle'];

export class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

export function b64uDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Extract and decode a SHLink from any carrier: bare URI or viewer-prefixed URL. */
export function parseShlink(input) {
  const m = String(input).match(/shlink:\/([A-Za-z0-9_-]+)/);
  if (!m) throw new StageError('decode', 'no shlink:/ found in input');
  let payload;
  try {
    payload = JSON.parse(td.decode(b64uDecode(m[1])));
  } catch {
    throw new StageError('decode', 'payload is not base64url-encoded JSON');
  }
  if (typeof payload.url !== 'string' || typeof payload.key !== 'string') {
    throw new StageError('decode', 'payload missing url/key');
  }
  return payload;
}

/** KTC profile checks on a decoded payload. Returns findings; errors mean not-KTC. */
export function ktcPayloadChecks(payload, nowSec = Math.floor(Date.now() / 1000)) {
  const errors = [];
  const warnings = [];
  if (payload.flag !== 'U') errors.push(`flag must be exactly "U" (found ${JSON.stringify(payload.flag ?? null)})`);
  if (typeof payload.exp !== 'number') errors.push('exp is required (1..1) in this IG');
  else if (payload.exp <= nowSec) errors.push(`link is expired (exp ${new Date(payload.exp * 1000).toISOString()})`);
  try {
    if (b64uDecode(payload.key).length !== 32) errors.push('key must decode to 32 bytes');
  } catch {
    errors.push('key is not valid base64url');
  }
  if (typeof payload.url === 'string' && payload.url.length > 128) warnings.push('url exceeds 128 chars (base spec limit)');
  if (typeof payload.label === 'string' && payload.label.length > 80) warnings.push('label exceeds 80 chars (base spec limit)');
  return { errors, warnings };
}

/** Decrypt a compact JWE (alg dir, enc A256GCM), honoring zip: DEF (raw deflate). */
export async function decryptJWE(jwe, keyB64u) {
  const parts = String(jwe).trim().split('.');
  if (parts.length !== 5) throw new StageError('decrypt', `expected compact JWE (5 parts, got ${parts.length})`);
  let header;
  try {
    header = JSON.parse(td.decode(b64uDecode(parts[0])));
  } catch {
    throw new StageError('decrypt', 'unreadable JWE protected header');
  }
  if (header.alg !== 'dir' || header.enc !== 'A256GCM') {
    throw new StageError('decrypt', `unsupported alg/enc (${header.alg}/${header.enc})`);
  }
  const key = await crypto.subtle.importKey('raw', b64uDecode(keyB64u), 'AES-GCM', false, ['decrypt']);
  const ct = b64uDecode(parts[3]);
  const tag = b64uDecode(parts[4]);
  const sealed = new Uint8Array(ct.length + tag.length);
  sealed.set(ct);
  sealed.set(tag, ct.length);
  let plain;
  try {
    // compact JWE: [0]=protected, [1]=encrypted key (EMPTY for alg dir), [2]=IV,
    // [3]=ciphertext, [4]=tag — the empty segment is an easy off-by-one to hit.
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64uDecode(parts[2]), additionalData: te.encode(parts[0]) },
        key,
        sealed,
      ),
    );
  } catch {
    throw new StageError('decrypt', 'authentication failed — wrong key or tampered ciphertext (fail closed)');
  }
  if (header.zip === 'DEF') {
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    plain = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { header, plaintext: plain };
}

/** PatientSharedBundle profile-lite checks. Errors mean the bundle is non-conformant. */
export function bundleChecks(bundle) {
  const errors = [];
  const warnings = [];
  if (bundle?.resourceType !== 'Bundle') errors.push('decrypted payload is not a Bundle');
  if (bundle?.type !== 'collection') errors.push(`Bundle.type must be collection (found ${JSON.stringify(bundle?.type)})`);
  if (typeof bundle?.timestamp !== 'string') errors.push('Bundle.timestamp is required');
  const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
  if (entries.length < 2) errors.push(`entry is 2..* — Patient plus at least one content entry (found ${entries.length})`);
  const patients = entries.filter((e) => e?.resource?.resourceType === 'Patient');
  if (patients.length !== 1) errors.push(`exactly one Patient required (found ${patients.length})`);
  for (const [i, e] of entries.entries()) {
    const r = e?.resource;
    if (r?.resourceType !== 'DocumentReference') continue;
    const code = r?.type?.coding?.find?.((c) => c?.system === 'http://loinc.org')?.code;
    const isKtcKind = code === '51855-5' || code === '60591-5';
    const claimsCategory = r?.category?.some?.((cc) =>
      cc?.coding?.some?.((c) => c?.code === 'patient-shared'),
    );
    const att = r?.content?.[0]?.attachment;
    if (!isKtcKind && !claimsCategory) {
      // An ordinary DocumentReference (e.g. a clinical note carried from the record)
      // is valid USCDI content — the PatientSharedDocumentReference profile applies
      // only to the two patient-shared PDF kinds. Just flag unreachable attachments.
      if (att?.url && !att?.data) {
        warnings.push(`entry[${i}]: attachment.url is unreachable for SHL receivers — prefer inline data`);
      }
      continue;
    }
    if (!isKtcKind) {
      errors.push(`entry[${i}]: patient-shared category requires type LOINC 51855-5 or 60591-5`);
    }
    if (att?.contentType !== 'application/pdf') errors.push(`entry[${i}]: patient-shared PDF attachment.contentType must be application/pdf`);
    if (typeof att?.data !== 'string' || !att.data) errors.push(`entry[${i}]: attachment.data (inline base64) is required`);
    const hasPataast = r?.meta?.security?.some?.((c) => c?.code === 'PATAST');
    if (!hasPataast) warnings.push(`entry[${i}]: meta.security SHOULD include PATAST`);
  }
  return { errors, warnings };
}

/**
 * Reference receiver: run the full pipeline. Throws StageError at the failing stage;
 * on success returns {payload, header, bundle, plaintext, payloadChecks, bundleResult}.
 */
export async function referenceResolve(input, fetchFn = globalThis.fetch, { recipient = 'KTC vector harness', nowSec } = {}) {
  const payload = parseShlink(input);
  const payloadChecks = ktcPayloadChecks(payload, nowSec);
  if (payloadChecks.errors.length > 0) {
    throw Object.assign(new StageError('payload', payloadChecks.errors.join('; ')), { payload, payloadChecks });
  }
  const url = new URL(payload.url);
  url.searchParams.set('recipient', recipient);
  let res;
  try {
    res = await fetchFn(url.toString());
  } catch (e) {
    throw new StageError('retrieve', `fetch failed: ${e?.message ?? e}`);
  }
  if (!res.ok) throw new StageError('retrieve', `HTTP ${res.status}`);
  const jwe = await res.text();
  const { header, plaintext } = await decryptJWE(jwe, payload.key);
  let bundle;
  try {
    bundle = JSON.parse(td.decode(plaintext));
  } catch {
    throw new StageError('decrypt', 'decrypted plaintext is not JSON (forgot to inflate zip: DEF?)');
  }
  const bundleResult = bundleChecks(bundle);
  if (bundleResult.errors.length > 0) {
    throw Object.assign(new StageError('bundle', bundleResult.errors.join('; ')), { payload, bundle, bundleResult });
  }
  return { payload, payloadChecks, header, plaintext, bundle, bundleResult };
}

/**
 * Offline fetch built from vectors' `responses` maps. `loadBody(bodyFile)` resolves a
 * relative artifact path to text — filesystem in Node, fetch-relative in browsers.
 */
export function makeFetchShim(vectors, loadBody) {
  const map = new Map();
  for (const v of Array.isArray(vectors) ? vectors : [vectors]) {
    for (const [url, r] of Object.entries(v.responses ?? {})) map.set(url, r);
  }
  return async (input) => {
    const url = new URL(String(input));
    url.search = ''; // responses are keyed without query params (recipient etc.)
    const r = map.get(url.toString());
    if (!r) return new Response(null, { status: 404 });
    const body = r.bodyFile ? await loadBody(r.bodyFile) : null;
    return new Response(r.status === 404 ? null : body, { status: r.status, headers: r.headers ?? {} });
  };
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Run one vector through the reference pipeline and grade against its expectations. */
export async function runVector(vector, { fetchFn, nowSec } = {}) {
  const input = vector.input.shlink ?? vector.input.raw;
  const details = [];
  try {
    const result = await referenceResolve(input, fetchFn, { nowSec });
    if (vector.expect.outcome === 'reject') {
      return { id: vector.id, pass: false, details: [`expected rejection at ${vector.expect.failStage}, but pipeline succeeded`] };
    }
    if (vector.expect.payload) {
      const got = JSON.stringify(result.payload);
      const want = JSON.stringify(vector.expect.payload);
      if (got !== want) details.push(`payload mismatch:\n  got  ${got}\n  want ${want}`);
    }
    if (vector.expect.decrypted) {
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', result.plaintext)));
      if (digest !== vector.expect.decrypted.sha256) details.push('decrypted sha256 mismatch');
      if (result.bundle.entry?.length !== vector.expect.decrypted.entries) {
        details.push(`entry count ${result.bundle.entry?.length} != ${vector.expect.decrypted.entries}`);
      }
    }
    // Prefixed form must decode identically when present.
    if (vector.input.viewerPrefixed) {
      const viaPrefix = parseShlink(vector.input.viewerPrefixed);
      if (JSON.stringify(viaPrefix) !== JSON.stringify(result.payload)) details.push('viewer-prefixed form decoded differently');
    }
    return { id: vector.id, pass: details.length === 0, details };
  } catch (e) {
    if (!(e instanceof StageError)) return { id: vector.id, pass: false, details: [`unexpected error: ${e?.message ?? e}`] };
    if (vector.expect.outcome !== 'reject') return { id: vector.id, pass: false, details: [`unexpected ${e.stage} failure: ${e.message}`] };
    if (e.stage !== vector.expect.failStage) {
      return { id: vector.id, pass: false, details: [`rejected at ${e.stage}, expected ${vector.expect.failStage} (${e.message})`] };
    }
    return { id: vector.id, pass: true, details: [`rejected at ${e.stage} as expected: ${e.message}`] };
  }
}
