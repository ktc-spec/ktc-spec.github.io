<!-- In-browser SHLink pipeline debugger. Reuses the published harness module
     (/vectors/harness.mjs) so the page and the CI harness can never diverge.
     Runs entirely client-side; the only network request is the link's payload URL. -->
<template>
  <div class="dbg">
    <textarea
      v-model="input"
      rows="4"
      placeholder="shlink:/eyJ…  — or —  https://viewer.example/#shlink:/eyJ…"
      spellcheck="false"
    />
    <div class="dbg-row">
      <button :disabled="busy || !input.trim()" @click="run">{{ busy ? 'Running…' : 'Run pipeline' }}</button>
      <label><input type="checkbox" v-model="useRawJwe" /> payload host blocks CORS — paste the raw JWE instead</label>
    </div>
    <textarea
      v-if="useRawJwe"
      v-model="rawJwe"
      rows="3"
      placeholder="eyJhbGciOiJkaXIi…  (compact JWE — the body your GET returned)"
      spellcheck="false"
    />

    <ol v-if="steps.length" class="dbg-steps">
      <li v-for="s in steps" :key="s.name" :class="s.status">
        <span class="dbg-icon">{{ { pass: '✓', fail: '✗', warn: '!', skip: '·' }[s.status] }}</span>
        <div>
          <strong>{{ s.name }}</strong>
          <div v-for="(line, i) in s.lines" :key="i" class="dbg-line">{{ line }}</div>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { withBase } from 'vitepress'

const input = ref('')
const rawJwe = ref('')
const useRawJwe = ref(false)
const busy = ref(false)
const steps = ref([])

const step = (name, status, lines = []) => steps.value.push({ name, status, lines })

async function run() {
  busy.value = true
  steps.value = []
  const H = await import(/* @vite-ignore */ withBase('/vectors/harness.mjs'))
  try {
    // 1. decode (accepts bare and prefixed carriers)
    let payload
    try {
      payload = H.parseShlink(input.value)
      const pretty = { ...payload, key: payload.key.slice(0, 6) + '…' }
      step('Decode SHLink payload', 'pass', [JSON.stringify(pretty)])
    } catch (e) {
      step('Decode SHLink payload', 'fail', [e.message, 'Check: base64url (not plain base64/atob), UTF-8 text, shlink:/ substring extraction.'])
      return
    }

    // 2. KTC payload conformance
    const checks = H.ktcPayloadChecks(payload)
    if (checks.errors.length) {
      step('KTC payload checks', 'fail', checks.errors)
      return
    }
    step('KTC payload checks', checks.warnings.length ? 'warn' : 'pass',
      checks.warnings.length ? checks.warnings : ['flag U · exp valid · 32-byte key'])

    // 3. retrieve
    let jwe
    if (useRawJwe.value && rawJwe.value.trim()) {
      jwe = rawJwe.value.trim()
      step('Retrieve encrypted payload', 'skip', ['Using pasted JWE (CORS bypass).'])
    } else {
      try {
        const u = new URL(payload.url)
        u.searchParams.set('recipient', 'KTC Spec Debugger')
        const res = await fetch(u.toString())
        if (!res.ok) {
          step('Retrieve encrypted payload', 'fail', [`HTTP ${res.status} — expired, revoked, exhausted, or wrong URL.`])
          return
        }
        const ct = res.headers.get('content-type') ?? '(none)'
        jwe = await res.text()
        step('Retrieve encrypted payload', ct.includes('application/jose') ? 'pass' : 'warn',
          [`HTTP ${res.status} · content-type ${ct} · ${jwe.length} chars`,
           ...(ct.includes('application/jose') ? [] : ['content-type should be application/jose'])])
      } catch (e) {
        step('Retrieve encrypted payload', 'fail',
          [`fetch failed: ${e.message}`, 'If this is a CORS block, tick the raw-JWE box above and paste the body.'])
        return
      }
    }

    // 4. decrypt (honors zip: DEF)
    let header, plaintext
    try {
      ;({ header, plaintext } = await H.decryptJWE(jwe, payload.key))
      step('Decrypt JWE', 'pass', [
        `header ${JSON.stringify(header)}`,
        header.zip === 'DEF' ? 'zip: DEF present — inflated with raw deflate (RFC 1951)' : 'uncompressed',
        `${plaintext.length} plaintext bytes`,
      ])
    } catch (e) {
      step('Decrypt JWE', 'fail', [e.message,
        'Common causes: base64-vs-base64url key decoding; ignoring the zip: DEF header; wrong IV segment (compact JWE part 3 of 5).'])
      return
    }

    // 5. bundle profile
    let bundle
    try {
      bundle = JSON.parse(new TextDecoder().decode(plaintext))
    } catch {
      step('Parse Bundle', 'fail', ['Plaintext is not JSON. If the JWE header says zip: DEF, it must be inflated after decryption.'])
      return
    }
    const b = H.bundleChecks(bundle)
    const pt = bundle.entry?.find((e) => e?.resource?.resourceType === 'Patient')?.resource
    const summary = [
      `Bundle: ${bundle.entry?.length ?? 0} entries`,
      pt ? `Patient: ${(pt.name?.[0]?.given ?? []).join(' ')} ${pt.name?.[0]?.family ?? ''} · DOB ${pt.birthDate ?? '?'}` : 'no Patient found',
      ...['DocumentReference', 'Condition', 'MedicationRequest', 'AllergyIntolerance', 'Immunization', 'Coverage']
        .map((t) => [t, bundle.entry?.filter((e) => e?.resource?.resourceType === t).length ?? 0])
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n} × ${t}`),
    ]
    if (b.errors.length) step('PatientSharedBundle checks', 'fail', [...b.errors, ...summary])
    else step('PatientSharedBundle checks', b.warnings.length ? 'warn' : 'pass', [...b.warnings, ...summary])
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.dbg textarea { width: 100%; font-family: var(--vp-font-family-mono); font-size: 12px; padding: 10px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-soft); resize: vertical; }
.dbg-row { display: flex; gap: 16px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
.dbg-row button { background: var(--vp-c-brand-1); color: white; border: 0; padding: 8px 18px; border-radius: 6px; font-weight: 600; cursor: pointer; }
.dbg-row button:disabled { opacity: 0.5; cursor: default; }
.dbg-row label { font-size: 0.85em; color: var(--vp-c-text-2); display: flex; gap: 6px; align-items: center; }
.dbg-steps { list-style: none; padding: 0; margin-top: 12px; }
.dbg-steps li { display: flex; gap: 10px; padding: 10px 12px; border-left: 3px solid var(--vp-c-divider); margin-bottom: 6px; background: var(--vp-c-bg-soft); border-radius: 0 6px 6px 0; }
.dbg-steps li.pass { border-left-color: var(--vp-c-green-1); }
.dbg-steps li.fail { border-left-color: var(--vp-c-red-1); }
.dbg-steps li.warn { border-left-color: var(--vp-c-yellow-1); }
.dbg-icon { font-weight: 700; width: 1.2em; }
li.pass .dbg-icon { color: var(--vp-c-green-1); }
li.fail .dbg-icon { color: var(--vp-c-red-1); }
li.warn .dbg-icon { color: var(--vp-c-yellow-1); }
.dbg-line { font-family: var(--vp-font-family-mono); font-size: 11.5px; color: var(--vp-c-text-2); overflow-wrap: anywhere; margin-top: 2px; }
</style>
