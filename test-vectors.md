<script setup>
import { withBase } from 'vitepress'
import { data } from './test-vectors.data.ts'

const TIERS = [
  { key: 'decode',   title: 'Tier 1 — Decode',   blurb: 'Pure functions: SHLink carrier forms and payload decoding. No network needed.' },
  { key: 'retrieve', title: 'Tier 2 — Retrieve', blurb: 'HTTP behavior: missing files, expired links.' },
  { key: 'decrypt',  title: 'Tier 3 — Decrypt',  blurb: 'JWE handling: compression, tampering, key alphabet.' },
  { key: 'bundle',   title: 'Tier 4 — Bundle',   blurb: 'PatientSharedBundle profile, persistence floor, App Attestation.' },
]
const byTier = (t) => data.vectors.filter((v) => v.tier === t)
const scannable = data.vectors.filter((v) => v.input.qr)
const levelClass = (l) => ({ baseline: 'lv-base', robustness: 'lv-rob', negative: 'lv-neg' }[l] ?? '')

import { ref } from 'vue'
const copiedId = ref('')
async function copyLink(v) {
  try {
    await navigator.clipboard.writeText(v.input.qrContent ?? v.input.shlink)
    copiedId.value = v.id
    setTimeout(() => { if (copiedId.value === v.id) copiedId.value = '' }, 2000)
  } catch {}
}
</script>

# Test Vectors

> **Spec version:** {{ data.index.specVersion }} · **Generated:** {{ data.index.generated.slice(0, 10) }} · **Live vectors valid until:** {{ data.index.expires.slice(0, 10) }}

Machine-readable conformance vectors for KTC senders and receivers. Every vector is a
JSON file pairing an input (a SHLink, in bare and viewer-prefixed forms, plus a QR
image) with expected outcomes — the decoded payload, the SHA-256 of the decrypted
Bundle, or the pipeline stage at which a conformant receiver rejects.

All content is **synthetic** (Jessica Argonaut). Keys are published on purpose: the
decryption key travels inside every SHLink anyway, and these links protect nothing.

## Three ways to use them

**1. Live.** Payload `url`s point at static files on this site, which serves
`Access-Control-Allow-Origin: *` — so the links resolve from any receiver, including
browser-based ones, with no test server. (Static hosting can't enforce the
`recipient` parameter or exercise dynamic revocation/use counting — test those
against a reference implementation.)

**2. Offline, in CI.** Each vector embeds a `responses` map (URL → status, headers,
body file), so a harness can shim `fetch` and run with no network:

```js
import { makeFetchShim, runVector } from './harness.mjs' // served at /vectors/harness.mjs

const index = JSON.parse(await readFile('vectors/index.json', 'utf8'))
const vectors = await Promise.all(index.vectors.map(v => readJson(`vectors/${v.file}`)))
const fetchFn = makeFetchShim(vectors, f => readFile(`vectors/${f}`, 'utf8'))
for (const v of vectors) console.log(await runVector(v, { fetchFn }))
```

Download everything: [index.json](/vectors/index.json) ·
[harness.mjs](/vectors/harness.mjs) — or swap `runVector`'s reference pipeline for
calls into your own implementation and assert against `expect`.

**3. By hand.** Point your scanner at the [QR wall](#qr-wall) below, or paste any
SHLink — one of these, or one your own app produced — into the
[debugger](#shlink-debugger).

## Catalog

<div v-for="tier in TIERS" :key="tier.key">

### {{ tier.title }}

<p>{{ tier.blurb }}</p>

<table>
  <thead><tr><th>ID</th><th>Title</th><th>Level</th><th>Expected</th><th>Spec</th><th>Files</th></tr></thead>
  <tbody>
    <tr v-for="v in byTier(tier.key)" :key="v.id">
      <td><code>{{ v.id }}</code></td>
      <td><strong>{{ v.title }}</strong><br><span class="vec-desc">{{ v.description }}</span></td>
      <td><span :class="['vec-level', levelClass(v.level)]">{{ v.level }}</span></td>
      <td>{{ v.expect.outcome === 'success' ? 'resolves' : `reject @ ${v.expect.failStage}` }}</td>
      <td class="vec-files"><span v-for="t in v.tests" :key="t"><a :href="withBase('/' + t)" target="_blank" rel="noopener">{{ t }}</a><br></span></td>
      <td class="vec-files">
        <a :href="withBase(`/vectors/vectors/${v.id}.json`)" target="_blank" rel="noopener">vector</a><template v-if="v.expect.decrypted"> · <a :href="withBase('/vectors/' + v.expect.decrypted.bundle)" target="_blank" rel="noopener">bundle</a></template><template v-if="v.input.qr"> · <a :href="withBase('/vectors/' + v.input.qr)" target="_blank" rel="noopener">QR</a></template>
      </td>
    </tr>
  </tbody>
</table>

</div>

## QR Wall {#qr-wall}

Point a real scanner at the screen. Each QR encodes the bare `shlink:/` URI (the
prefixed-form vector encodes the `https://…#shlink:/…` URL instead). Compare what
your implementation shows against the expectation.

<div class="qr-wall">
  <div v-for="v in scannable" :key="v.id" class="qr-cell">
    <img :src="withBase('/vectors/' + v.input.qr)" :alt="`QR for ${v.id}`" loading="lazy" />
    <div class="qr-meta">
      <code>{{ v.id }}</code>
      <button type="button" class="qr-copy" @click="copyLink(v)">{{ copiedId === v.id ? 'Copied!' : 'Copy link' }}</button>
      <p>{{ v.expect.outcome === 'success'
          ? `You should see: ${v.expect.payload.label ?? '(no label)'} — Jessica Argonaut, DOB 1985-03-15, ${v.expect.decrypted.entries} entries.`
          : `Expected: clear error at the ${v.expect.failStage} stage.` }}</p>
    </div>
  </div>
</div>

## SHLink Debugger {#shlink-debugger}

Paste any SHLink — bare or viewer-prefixed, a vector from this page or one produced
by **your own Patient App** — and watch each pipeline stage pass or fail. Everything
runs in your browser (decode, fetch with `recipient=KTC Spec Debugger`, WebCrypto
decrypt incl. `zip: DEF`, profile checks); nothing is sent to any server other than
the link's own payload URL.

<ShlinkDebugger />

<style scoped>
.vec-desc { color: var(--vp-c-text-2); font-size: 0.85em; }
.vec-files { white-space: nowrap; }
.vec-level { font-size: 0.78em; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.lv-base { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.lv-rob  { background: var(--vp-c-yellow-soft); color: var(--vp-c-yellow-1); }
.lv-neg  { background: var(--vp-c-red-soft); color: var(--vp-c-red-1); }
.qr-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; margin-top: 16px; }
.qr-cell { border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 12px; }
.qr-cell img { width: 100%; image-rendering: pixelated; border-radius: 4px; }
.qr-meta code { font-size: 0.8em; }
.qr-copy { float: right; font-size: 0.75em; font-weight: 600; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--vp-c-brand-1); color: var(--vp-c-brand-1); background: transparent; cursor: pointer; }
.qr-copy:hover { background: var(--vp-c-brand-soft); }
.qr-meta p { font-size: 0.82em; color: var(--vp-c-text-2); margin: 6px 0 0; }
</style>
