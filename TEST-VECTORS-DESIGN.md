# KTC Test Vectors — Design

*(Internal design record; excluded from the published site. The published surface is
`/test-vectors` and `public/vectors/`.)*

## Goals

1. **Catch real interop failures.** The first two third-party scanner failures observed
   in the field were (a) `atob()` on base64url payloads and (b) no `zip: DEF` inflate.
   Both are now vectors. Every vector traces to a spec statement (or a documented
   base-spec tolerance).
2. **Zero-infrastructure, forever-live.** U-flag retrieval is a plain GET, so the
   encrypted payloads are hosted as static files on this GitHub Pages site itself.
   GitHub Pages serves `Access-Control-Allow-Origin: *`, so browser-based receivers
   (including the in-page debugger) can fetch them.
3. **Offline-runnable.** Every vector embeds a `responses` map (URL → status/headers/
   body file) so a CI harness can shim `fetch` and run with no network at all.
4. **Self-testing spec page.** The `/test-vectors` page renders a QR wall (point a real
   scanner at the screen) and an interactive debugger (paste any SHLink — including one
   produced by *your* app — and see exactly which pipeline step fails).

## Vector schema

`public/vectors/index.json`:

```json
{
  "specVersion": "0.10.2",
  "generated": "<ISO build time>",
  "expires": "<ISO — exp used in live vectors, build + 1 year>",
  "vectors": [ { "id", "title", "tier", "level", "file" } ]
}
```

Each `public/vectors/vectors/<id>.json`:

```json
{
  "id": "ktc-d3-zip-def",
  "title": "...",
  "tier": "decode | retrieve | decrypt | bundle",
  "level": "baseline | robustness | negative",
  "tests": ["#decryption"],            // spec anchor(s) this vector exercises
  "description": "...",
  "input": {
    "shlink": "shlink:/...",            // null for negative-input vectors w/ raw input
    "viewerPrefixed": "https://.../#shlink:/...",
    "qr": "qr/<id>.png",                // present for scannable vectors
    "raw": "..."                        // negative vectors: the literal bad input
  },
  "expect": {
    "outcome": "success | reject",
    "failStage": "decode|payload|retrieve|decrypt|bundle",   // reject vectors
    "payload": { ...decoded payload... },                    // success vectors
    "decrypted": { "sha256": "...", "bundle": "bundles/<name>.json", "entries": N },
    "notes": ["human-readable assertions"]
  },
  "responses": {
    "<payload url>": { "status": 200, "headers": {"content-type": "application/jose"}, "bodyFile": "files/<name>.jwe" },
    "<gone url>":    { "status": 404 }
  }
}
```

Conventions:

- **`responses` is the offline contract.** A harness intercepts fetch with this map;
  online, the same URLs resolve against the live site (the map's truth is the site).
- **Negative vectors carry `expect.failStage`** — implementations assert "my pipeline
  rejected at or before this stage and did not crash or render garbage."
- Bundles are shared: many decode/decrypt variants point at the same bundle file.

## Determinism

The generator (`tools/generate-vectors.mjs`) is deterministic given the build clock:

- Keys: `SHA-256("ktc-vector-key:" + id)` → 32 bytes. Published on purpose — vectors
  are synthetic (Jessica Argonaut), and the decryption key lives in the SHLink anyway.
- IVs: first 12 bytes of `SHA-256("ktc-vector-iv:" + id)`. Safe: every vector has a
  distinct key, so IV determinism cannot cause nonce reuse under one key.
- `exp`: build time + 1 year (KTC requires exp; vectors must stay scannable between
  deploys). `index.json.expires` surfaces the date; each deploy refreshes it. The one
  exception is the *expired* vector, pinned to a constant past timestamp.
- App Attestation: a fixed P-256 keypair embedded in the generator (intentionally
  public test key); JWKS hosted at `vectors/attestation/.well-known/jwks.json` under
  `iss = https://ktc-spec.github.io/vectors/attestation`.

Artifacts are **generated, not committed** (`public/vectors/` is gitignored);
`npm run gen` is chained into `docs:dev` / `docs:build`, so CI and local dev always
build them fresh from the committed generator.

## Catalog

| Tier | Vectors |
|---|---|
| decode | bare baseline; viewer-prefixed; base64url alphabet (`-`/`_` in encoding — the `atob` trap); UTF-8 label (em dash etc.); no label; **negative:** missing exp (valid base SHL, not KTC), flag `P`, empty flag (manifest flow), truncated payload |
| retrieve | gone-404 (revoked); expired payload (pinned past exp; receiver SHOULD error before fetching) |
| decrypt | plain JWE (baseline, uncompressed); `zip: DEF` (base-spec MAY — receivers should inflate); tampered ciphertext (auth tag MUST fail; fail closed); key whose base64url contains `-`/`_` |
| bundle | minimal (Patient + Story PDF); discrete-only (no DocumentReference); both PDF kinds (distinguish by `type`); persistence-core (the SHALL-persist four US Core resource types); CARIN DIC Coverage; attestation valid / attestation unverifiable (MUST NOT block); **negative:** bundle type `document`, single-entry bundle |

Live-server behaviors that static hosting cannot express (`recipient` enforcement,
use-count exhaustion, dynamic revocation, audit) are out of scope for static vectors;
the page points at reference implementations for those.

## Site surface

- `/test-vectors` page, built from a VitePress data loader over `public/vectors/`:
  - per-tier tables: ID, what it tests, level, spec-anchor links (traceability),
    downloads (vector JSON, JWE, bundle, QR).
  - **QR wall**: every scannable vector's QR with "scanning this you should see …".
  - **SHLink debugger** (`ShlinkDebugger.vue`): paste a bare/prefixed SHLink → decode →
    KTC payload checks → fetch (`recipient=KTC Spec Debugger`) → JWE header → decrypt
    (WebCrypto; `DecompressionStream('deflate-raw')` for `zip: DEF`) → bundle checks.
    Renders a step checklist with the failing step highlighted. CORS-blocked hosts:
    paste the raw JWE instead. Works for vectors AND for testing your own sender.
- `public/vectors/harness.mjs` — dependency-free ES module: `makeFetchShim(dir)`,
  `referenceResolve(shlink, fetch)` (a conformant reference receiver), and
  `runVector(vector, opts)`. `tools/selftest.mjs` runs every vector through it
  offline (`npm run test:vectors`) — this is also the generator's own regression test.

## Security notes

- All content is synthetic. Keys/IVs/attestation private key are deliberately public.
- The debugger fetches user-supplied URLs from the visitor's browser (no server-side
  fetch exists), and sends `recipient=KTC Spec Debugger` so audit logs are honest.
