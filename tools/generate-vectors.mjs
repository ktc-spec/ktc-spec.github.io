#!/usr/bin/env node
// KTC test-vector generator (see TEST-VECTORS-DESIGN.md).
// Deterministic given the build clock: keys/IVs derive from vector ids via SHA-256;
// only `exp` (build + 1 year) and QR PNGs vary between builds. Outputs everything
// under public/vectors/ (gitignored — always regenerated).

import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'vectors');
const SITE = 'https://ktc-spec.github.io';
const SPEC_VERSION = '0.10.2';

const NOW = Math.floor(Date.now() / 1000);
const EXP = NOW + 365 * 86_400; // KTC requires exp; vectors must outlive deploy gaps
const EXPIRED = 1706745600; // 2024-02-01 — pinned past timestamp, stable forever

// --- encoding ---------------------------------------------------------------------

const te = new TextEncoder();
const B64U = { '+': '-', '/': '_' };
const b64u = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/[+/]/g, (c) => B64U[c]).replace(/=+$/, '');
const b64uJson = (obj) => b64u(te.encode(JSON.stringify(obj)));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** Deterministic 32-byte key / 12-byte IV per vector id. Safe: one key per vector. */
const keyFor = async (id) => sha256(te.encode(`ktc-vector-key:${id}`));
const ivFor = async (id) => (await sha256(te.encode(`ktc-vector-iv:${id}`))).slice(0, 12);

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- JWE (compact, alg dir, enc A256GCM) ------------------------------------------

async function encryptJWE(plaintext, keyBytes, ivBytes, { cty = 'application/fhir+json', zip = false } = {}) {
  const header = { alg: 'dir', enc: 'A256GCM', cty, ...(zip ? { zip: 'DEF' } : {}) };
  const protectedB64 = b64uJson(header);
  const body = zip ? await deflateRaw(plaintext) : plaintext;
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData: te.encode(protectedB64) },
      key,
      body,
    ),
  );
  const ct = sealed.slice(0, -16);
  const tag = sealed.slice(-16);
  return `${protectedB64}..${b64u(ivBytes)}.${b64u(ct)}.${b64u(tag)}`;
}

// --- App Attestation (fixed, intentionally public P-256 test key) ------------------

const ATTESTATION_JWK = {
  kty: 'EC', crv: 'P-256', kid: 'ktc-test-2026', alg: 'ES256',
  x: 'yXEoEu9M_-vIa8OZV3p2_TfFBXCS5pVcKq24vD0TagQ',
  y: 'yQrUqADxg6Fh5zaQv5SqaPaIZSOZQtME4oatjdZZLfY',
  d: 'B4gN0v36C2ZfeXrnj3PJPI4nVb1JWljQeKrkwyKo6lk',
};
const ATTESTATION_ISS = `${SITE}/vectors/attestation`;

async function signAttestation() {
  const header = { alg: 'ES256', kid: ATTESTATION_JWK.kid };
  const claims = {
    iss: ATTESTATION_ISS,
    iat: 1767225600, // fixed: 2026-01-01 (attestation has no exp by design)
    jti: '6f1f47a3-0d0e-4b3a-9a44-1b2c3d4e5f60', // fixed UUID — vectors are deterministic
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(claims)}`;
  const key = await crypto.subtle.importKey(
    'jwk', ATTESTATION_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput)),
  );
  return `${signingInput}.${b64u(sig)}`;
}

// --- Synthetic content (Jessica Argonaut — entirely fictional) ---------------------

// Minimal but structurally complete one-page PDF (xref + trailer present).
const TINY_PDF = (() => {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    '4 0 obj\n<< /Length 60 >>\nstream\nBT /F1 18 Tf 72 720 Td (KTC test vector document) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
})();

const PATIENT_URN = 'urn:uuid:b5e506f4-e14c-4e27-9543-4b8d1e1f3e2a';
const patient = {
  fullUrl: PATIENT_URN,
  resource: {
    resourceType: 'Patient',
    name: [{ given: ['Jessica'], family: 'Argonaut' }],
    birthDate: '1985-03-15',
    gender: 'female',
  },
};

const docRef = (urnTail, loinc, display, description) => ({
  fullUrl: `urn:uuid:c7a2f8e1-3d4b-5c6a-9e8f-${urnTail}`,
  resource: {
    resourceType: 'DocumentReference',
    meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'PATAST', display: 'patient asserted' }] },
    status: 'current',
    type: { coding: [{ system: 'http://loinc.org', code: loinc, display }] },
    category: [{ coding: [{ system: 'https://cms.gov/fhir/CodeSystem/patient-shared-category', code: 'patient-shared', display: 'Patient-Shared' }] }],
    subject: { reference: PATIENT_URN },
    author: [{ reference: PATIENT_URN }],
    date: '2026-01-30T12:00:00Z',
    description,
    content: [{ attachment: { contentType: 'application/pdf', data: TINY_PDF } }],
  },
});
const storyPdf = () => docRef('0a1b2c3d4e5f', '51855-5', 'Patient Note', 'Patient-shared narrative');
const renderedPdf = () => docRef('0a1b2c3d4e60', '60591-5', 'Patient summary Document', 'FHIR-Rendered summary');

// The four resource types receivers SHALL persist (US Core-shaped instances).
const persistenceCore = () => [
  {
    fullUrl: 'urn:uuid:11111111-0000-4000-8000-000000000001',
    resource: {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
      code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertensive disorder' }], text: 'Hypertension' },
      subject: { reference: PATIENT_URN },
      onsetDateTime: '2022-04-01',
    },
  },
  {
    fullUrl: 'urn:uuid:11111111-0000-4000-8000-000000000002',
    resource: {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '979480', display: 'lisinopril 10 MG Oral Tablet' }], text: 'Lisinopril 10 mg' },
      subject: { reference: PATIENT_URN },
      authoredOn: '2025-11-02',
      dosageInstruction: [{ text: '1 tablet daily' }],
    },
  },
  {
    fullUrl: 'urn:uuid:11111111-0000-4000-8000-000000000003',
    resource: {
      resourceType: 'AllergyIntolerance',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
      code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980', display: 'penicillin G' }], text: 'Penicillin' },
      patient: { reference: PATIENT_URN },
      reaction: [{ manifestation: [{ text: 'Hives' }] }],
    },
  },
  {
    fullUrl: 'urn:uuid:11111111-0000-4000-8000-000000000004',
    resource: {
      resourceType: 'Immunization',
      status: 'completed',
      vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208', display: 'COVID-19 vaccine, mRNA, BNT162b2' }], text: 'COVID-19 vaccine' },
      patient: { reference: PATIENT_URN },
      occurrenceDateTime: '2025-10-12',
    },
  },
];

const carinCoverage = () => ({
  fullUrl: 'urn:uuid:22222222-0000-4000-8000-000000000001',
  resource: {
    resourceType: 'Coverage',
    status: 'active',
    subscriberId: 'KTC123456789',
    beneficiary: { reference: PATIENT_URN },
    payor: [{ display: 'Argonaut Health Plan' }],
    class: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] }, value: 'GRP-001', name: 'Argonaut Group Plan' }],
  },
});

const bundle = (entries, metaExtension) => ({
  resourceType: 'Bundle',
  ...(metaExtension ? { meta: { extension: metaExtension } } : {}),
  type: 'collection',
  timestamp: '2026-01-30T12:00:00Z',
  entry: entries,
});

// --- SHLink construction ------------------------------------------------------------

const fileUrl = (name) => `${SITE}/vectors/files/${name}.jwe`;
const shlinkOf = (payload) => `shlink:/${b64uJson(payload)}`;
const viewerPrefixed = (shlink) => `https://shlink-viewer.example.org/#${shlink}`;

// --- Generation ---------------------------------------------------------------------

const utf8Bytes = (obj) => te.encode(JSON.stringify(obj));

async function main() {
  await rm(OUT, { recursive: true, force: true });
  for (const d of ['vectors', 'files', 'bundles', 'qr', 'attestation/.well-known']) {
    await mkdir(join(OUT, d), { recursive: true });
  }

  const bundles = {
    minimal: bundle([patient, storyPdf()]),
    'discrete-only': bundle([patient, ...persistenceCore()]),
    'both-pdfs': bundle([patient, storyPdf(), renderedPdf(), ...persistenceCore()]),
    'persistence-core': bundle([patient, ...persistenceCore(), renderedPdf()]),
    'carin-dic': bundle([patient, carinCoverage(), renderedPdf()]),
    attestation: bundle([patient, storyPdf()], [{ url: 'https://cms.gov/fhir/StructureDefinition/app-attestation', valueString: await signAttestation() }]),
    'bad-type-document': { ...bundle([patient, storyPdf()]), type: 'document' },
    'bad-single-entry': bundle([patient]),
  };
  for (const [name, b] of Object.entries(bundles)) {
    await writeFile(join(OUT, 'bundles', `${name}.json`), JSON.stringify(b, null, 2));
  }

  const vectors = [];
  /**
   * Build one success-path vector: encrypt `bundleName` under this id's key, write the
   * JWE, build the shlink + QR, and record expectations + the offline responses map.
   */
  async function vector({ id, title, tier, level, tests, description, bundleName, zip = false, label, exp = EXP, tamper, qrForm = 'bare', notes = [] }) {
    const keyBytes = await keyFor(id);
    const plaintext = utf8Bytes(bundles[bundleName]);
    let jwe = await encryptJWE(plaintext, keyBytes, await ivFor(id), { zip });
    if (tamper) {
      const parts = jwe.split('.');
      parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1); // flip a ciphertext char
      jwe = parts.join('.');
    }
    const fileName = id;
    await writeFile(join(OUT, 'files', `${fileName}.jwe`), jwe);

    const payload = {
      url: fileUrl(fileName),
      flag: 'U',
      key: b64u(keyBytes),
      exp,
      ...(label !== null ? { label: label ?? `KTC vector ${id}` } : {}),
    };
    const shlink = shlinkOf(payload);
    // QRs default to the bare URI (scanner apps are the audience); the prefixed-form
    // vector carries the prefixed URL in its QR instead.
    await QRCode.toFile(join(OUT, 'qr', `${id}.png`), qrForm === 'prefixed' ? viewerPrefixed(shlink) : shlink, { errorCorrectionLevel: 'M', width: 480 });

    const failStage = tamper ? 'decrypt' : exp === EXPIRED ? 'payload' : null;
    const v = {
      id, title, tier, level, tests, description,
      input: { shlink, viewerPrefixed: viewerPrefixed(shlink), qr: `qr/${id}.png` },
      expect: {
        outcome: failStage ? 'reject' : 'success',
        ...(failStage ? { failStage } : {}),
        payload,
        ...(failStage
          ? {}
          : {
              decrypted: {
                sha256: hex(await sha256(plaintext)),
                bundle: `bundles/${bundleName}.json`,
                entries: bundles[bundleName].entry.length,
              },
            }),
        notes,
      },
      responses: {
        [payload.url]: { status: 200, headers: { 'content-type': 'application/jose' }, bodyFile: `files/${fileName}.jwe` },
      },
    };
    vectors.push(v);
    return v;
  }

  /** Negative decode-stage vector: bad input string, no hosted file. */
  function negative({ id, title, tests, description, raw, failStage, notes = [] }) {
    vectors.push({
      id, title, tier: 'decode', level: 'negative', tests, description,
      input: { raw },
      expect: { outcome: 'reject', failStage, notes },
      responses: {},
    });
  }

  // --- Tier 1: decode ---------------------------------------------------------------
  await vector({
    id: 'ktc-d1-baseline', title: 'Bare SHLink, baseline', tier: 'decode', level: 'baseline',
    tests: ['#shlink-payload-decoded'], bundleName: 'minimal',
    description: 'Canonical bare shlink:/ URI. U flag, exp, label, uncompressed JWE, minimal Bundle (Patient + Patient Story PDF).',
    label: "Jessica Argonaut's health summary",
    notes: ['Every field of expect.payload must round-trip through your decoder.'],
  });
  await vector({
    id: 'ktc-d2-prefixed', title: 'Viewer-prefixed SHLink', tier: 'decode', level: 'baseline',
    tests: ['#shlink-constraints', '#workflow'], bundleName: 'minimal',
    description: 'The same link conveyed as https://viewer.example/#shlink:/… — the form patients paste in the ahead-of-time check-in workflow. Receivers extract the shlink:/ substring. This vector\'s QR encodes the PREFIXED form.',
    label: 'Prefixed form — same payload either way', qrForm: 'prefixed',
    notes: ['input.viewerPrefixed is the primary input here; input.shlink must decode identically.'],
  });
  {
    // Payload whose base64url ENCODING contains '-' and '_' — the atob() trap.
    const id = 'ktc-d3-b64url';
    const keyBytes = await keyFor(id);
    const plaintext = utf8Bytes(bundles.minimal);
    const jwe = await encryptJWE(plaintext, keyBytes, await ivFor(id), {});
    await writeFile(join(OUT, 'files', `${id}.jwe`), jwe);
    // Pure-ASCII JSON can NEVER produce '-'/'_' in base64url (those need high-bit
    // byte patterns), so naive atob() decoders survive systematically on plain labels
    // and break exactly when a label carries non-ASCII. Force it with UTF-8 content.
    let payload = null;
    for (let i = 0; i < 4096; i++) {
      const candidate = { url: fileUrl(id), flag: 'U', key: b64u(keyBytes), exp: EXP, label: `\u{1F9EA}${'x'.repeat(i % 4)}\u{1F517}\u{1F4E6} sonde num\u{E9}ro ${i}` };
      const enc = b64uJson(candidate);
      if (enc.includes('-') && enc.includes('_')) { payload = candidate; break; }
    }
    if (!payload) throw new Error('could not construct -/_ payload');
    const shlink = shlinkOf(payload);
    await QRCode.toFile(join(OUT, 'qr', `${id}.png`), shlink, { errorCorrectionLevel: 'M', width: 480 });
    vectors.push({
      id, title: 'base64url alphabet (the atob trap)', tier: 'decode', level: 'baseline',
      tests: ['#shlink-payload-decoded'],
      description: "Payload whose base64url encoding contains both '-' and '_'. Decoders using plain base64/atob() fail here; correct base64url decoding succeeds. Observed failure in a real scanner.",
      input: { shlink, viewerPrefixed: viewerPrefixed(shlink), qr: `qr/${id}.png` },
      expect: {
        outcome: 'success', payload,
        decrypted: { sha256: hex(await sha256(plaintext)), bundle: 'bundles/minimal.json', entries: bundles.minimal.entry.length },
        notes: ["The encoded payload contains '-' and '_' by construction."],
      },
      responses: { [payload.url]: { status: 200, headers: { 'content-type': 'application/jose' }, bodyFile: `files/${id}.jwe` } },
    });
  }
  await vector({
    id: 'ktc-d4-utf8-label', title: 'UTF-8 label', tier: 'decode', level: 'baseline',
    tests: ['#shlink-payload-decoded'], bundleName: 'minimal',
    description: 'Label contains multi-byte UTF-8 (em dash, accents). Decoders that treat decoded bytes as latin1 show mojibake; the expected label string is published.',
    label: 'Jessica Argonaut — résumé de santé',
    notes: ['expect.payload.label must match exactly, including “—” and “é”.'],
  });
  await vector({
    id: 'ktc-d5-no-label', title: 'No label', tier: 'decode', level: 'baseline',
    tests: ['#shlink-payload-decoded'], bundleName: 'minimal', label: null,
    description: 'label is 0..1 — absent here. Receivers must not require it.',
  });
  negative({
    id: 'ktc-d6-no-exp', title: 'Missing exp (valid base SHL, not KTC)',
    tests: ['#shlink-payload-decoded'],
    raw: shlinkOf({ url: fileUrl('ktc-d1-baseline'), flag: 'U', key: b64u(await keyFor('ktc-d1-baseline')) }),
    failStage: 'payload',
    description: 'exp is required by this IG (1..1). A payload without it is a conformant base-spec SHLink but NOT a KTC link; receivers validating KTC conformance flag it.',
    notes: ['A pure base-SHL receiver may still resolve this; a KTC validator must report the missing exp.'],
  });
  negative({
    id: 'ktc-d7-flag-p', title: 'Flag P (out of KTC scope)',
    tests: ['#shlink-payload-decoded'],
    raw: shlinkOf({ url: fileUrl('ktc-d1-baseline'), flag: 'P', key: b64u(await keyFor('ktc-d1-baseline')), exp: EXP }),
    failStage: 'payload',
    description: 'KTC requires flag exactly "U". P (passcode + manifest flow) is valid base SHL but out of scope here.',
  });
  negative({
    id: 'ktc-d8-flag-empty', title: 'Empty flag (manifest flow, out of KTC scope)',
    tests: ['#shlink-payload-decoded'],
    raw: shlinkOf({ url: fileUrl('ktc-d1-baseline'), flag: '', key: b64u(await keyFor('ktc-d1-baseline')), exp: EXP }),
    failStage: 'payload',
    description: 'No U flag means the URL is a manifest endpoint (POST), not a direct file. Out of KTC scope; receivers must not GET it as if it were U-flagged.',
  });
  negative({
    id: 'ktc-d9-truncated', title: 'Truncated payload',
    tests: ['#shlink-payload-decoded'],
    raw: 'shlink:/eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29t',
    failStage: 'decode',
    description: 'Garbage in: the base64url JSON is cut off. Decoders must reject without crashing.',
  });

  // --- Tier 2: retrieve ---------------------------------------------------------------
  {
    const id = 'ktc-r1-gone';
    const goneUrl = `${SITE}/vectors/files/${id}-revoked.jwe`; // never written → live 404
    const payload = { url: goneUrl, flag: 'U', key: b64u(await keyFor(id)), exp: EXP, label: 'Revoked link' };
    const shlink = shlinkOf(payload);
    await QRCode.toFile(join(OUT, 'qr', `${id}.png`), shlink, { errorCorrectionLevel: 'M', width: 480 });
    vectors.push({
      id, title: 'Gone: payload URL returns 404', tier: 'retrieve', level: 'robustness',
      tests: ['#retrieval-protocol'],
      description: 'A well-formed, unexpired link whose file is gone (revoked / exhausted). Receivers show a clear, friendly error — never a crash, never partial data.',
      input: { shlink, viewerPrefixed: viewerPrefixed(shlink), qr: `qr/${id}.png` },
      expect: { outcome: 'reject', failStage: 'retrieve', payload, notes: ['HTTP 404; the receiver-facing error should not be a stack trace.'] },
      responses: { [goneUrl]: { status: 404 } },
    });
  }
  await vector({
    id: 'ktc-r2-expired', title: 'Expired link', tier: 'retrieve', level: 'robustness',
    tests: ['#expiration'], bundleName: 'minimal', exp: EXPIRED,
    label: 'Expired in 2024',
    description: 'exp is in the past (pinned constant). Receivers SHOULD display an expiration error when scanned — ideally before fetching at all. The file is still hosted, so behavior past the exp check is observable.',
    notes: ['The payload exp is authoritative for this check; do not rely on the HTTP layer.'],
  });

  // --- Tier 3: decrypt ----------------------------------------------------------------
  await vector({
    id: 'ktc-e1-zip-def', title: 'JWE with zip: DEF', tier: 'decrypt', level: 'robustness',
    tests: ['#decryption'], bundleName: 'persistence-core', zip: true,
    label: 'Compressed payload',
    description: 'The base SHL spec permits zip: DEF (raw RFC 1951 deflate before encryption); this IG does not rule it out. Receivers should inflate when the header declares it. Observed failure in a real scanner.',
    notes: ["Check the JWE protected header; if zip == 'DEF', inflate (deflate-raw) after decrypting."],
  });
  await vector({
    id: 'ktc-e2-tampered', title: 'Tampered ciphertext', tier: 'decrypt', level: 'negative',
    tests: ['#decryption', '#security-considerations'], bundleName: 'minimal', tamper: true,
    label: 'Tampered — must fail closed',
    description: 'One ciphertext character flipped. AES-GCM authentication MUST fail; the receiver must fail closed and never render partially-decrypted output.',
  });
  {
    // Key whose base64url form contains '-' and '_' (search a salted derivation space;
    // the PUBLISHED id and URL stay stable regardless of the salt found).
    const id = 'ktc-e3-key-urlsafe';
    let keyBytes = null;
    for (let i = 0; i < 4096; i++) {
      const k = await keyFor(`${id}~${i}`);
      const enc = b64u(k);
      if (enc.includes('-') && enc.includes('_')) { keyBytes = k; break; }
    }
    if (!keyBytes) throw new Error('could not find urlsafe key');
    const plaintext = utf8Bytes(bundles.minimal);
    const jwe = await encryptJWE(plaintext, keyBytes, await ivFor(id), {});
    await writeFile(join(OUT, 'files', `${id}.jwe`), jwe);
    const payload = { url: fileUrl(id), flag: 'U', key: b64u(keyBytes), exp: EXP, label: 'URL-safe key alphabet' };
    const shlink = shlinkOf(payload);
    await QRCode.toFile(join(OUT, 'qr', `${id}.png`), shlink, { errorCorrectionLevel: 'M', width: 480 });
    vectors.push({
      id, title: 'Key with base64url-only characters', tier: 'decrypt', level: 'baseline',
      tests: ['#decryption'],
      description: "The 43-char key contains '-' and '_'. Decoders converting via plain base64 corrupt the key and fail the auth tag.",
      input: { shlink, viewerPrefixed: viewerPrefixed(shlink), qr: `qr/${id}.png` },
      expect: {
        outcome: 'success', payload,
        decrypted: { sha256: hex(await sha256(plaintext)), bundle: 'bundles/minimal.json', entries: bundles.minimal.entry.length },
        notes: ["expect.payload.key contains '-' and '_' by construction."],
      },
      responses: { [payload.url]: { status: 200, headers: { 'content-type': 'application/jose' }, bodyFile: `files/${id}.jwe` } },
    });
  }

  // --- Tier 4: bundle -----------------------------------------------------------------
  await vector({
    id: 'ktc-b1-discrete-only', title: 'Discrete resources only (no DocumentReference)', tier: 'bundle', level: 'baseline',
    tests: ['#fhir-bundle-profile-patientsharedbundle'], bundleName: 'discrete-only',
    label: 'Discrete FHIR only',
    description: 'Apps MAY share only discrete FHIR resources. No PDF anywhere; receivers must not require one.',
  });
  await vector({
    id: 'ktc-b2-both-pdfs', title: 'Both PDF kinds in one Bundle', tier: 'bundle', level: 'baseline',
    tests: ['#documentreference-profile-patientshareddocumentreference'], bundleName: 'both-pdfs',
    label: 'Story + FHIR-Rendered',
    description: 'FHIR-Rendered PDF (60591-5) and Patient Story PDF (51855-5) together. Receivers SHALL distinguish them by type and treat them as distinct documents.',
  });
  await vector({
    id: 'ktc-b3-persistence-core', title: 'The SHALL-persist four', tier: 'bundle', level: 'baseline',
    tests: ['#conformance-requirements'], bundleName: 'persistence-core',
    label: 'Persistence floor',
    description: 'US Core-shaped Condition, MedicationRequest, AllergyIntolerance, and Immunization plus a FHIR-Rendered PDF. A conformant receiver persists all five chart-associated.',
    notes: ['Assert each of the four resource types (and the DocumentReference) survives to the chart.'],
  });
  await vector({
    id: 'ktc-b4-carin-dic', title: 'CARIN DIC Coverage', tier: 'bundle', level: 'baseline',
    tests: ['#fhir-bundle-profile-patientsharedbundle'], bundleName: 'carin-dic',
    label: 'Insurance card',
    description: 'Coverage per CARIN Digital Insurance Card — an in-scope MAY for senders; receivers SHOULD persist it as part of full-USCDI content.',
  });
  await vector({
    id: 'ktc-b5-attestation', title: 'App Attestation (valid)', tier: 'bundle', level: 'baseline',
    tests: ['#app-attestation-optional'], bundleName: 'attestation',
    label: 'Attested bundle',
    description: `Bundle.meta.extension carries an ES256 JWS. iss = ${ATTESTATION_ISS}; JWKS at {iss}/.well-known/jwks.json (hosted by this site). Verification should succeed; the key is an intentionally public test key.`,
    notes: ['Verify: decode JWT, fetch JWKS by iss, match kid, check ES256 signature.'],
  });
  {
    // Same bundle, signature broken: receivers SHOULD NOT block processing.
    const id = 'ktc-b6-attestation-broken';
    const att = await signAttestation();
    const broken = att.slice(0, -4) + (att.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const b = bundle([patient, storyPdf()], [{ url: 'https://cms.gov/fhir/StructureDefinition/app-attestation', valueString: broken }]);
    await writeFile(join(OUT, 'bundles', 'attestation-broken.json'), JSON.stringify(b, null, 2));
    bundles['attestation-broken'] = b;
    await vector({
      id, title: 'App Attestation (unverifiable)', tier: 'bundle', level: 'robustness',
      tests: ['#app-attestation-optional'], bundleName: 'attestation-broken',
      label: 'Broken attestation — must not block',
      description: 'The attestation signature fails verification. Receivers SHALL NOT block Bundle processing — show no provenance indicator and continue.',
      notes: ['expect.outcome is success: the BUNDLE processes fine; only the provenance indicator is withheld.'],
    });
  }
  await vector({
    id: 'ktc-b7-bad-type', title: 'Bundle.type is document (invalid)', tier: 'bundle', level: 'negative',
    tests: ['#fhir-bundle-profile-patientsharedbundle'], bundleName: 'bad-type-document',
    label: 'Wrong bundle type',
    description: 'type must be collection. Receivers reject or flag — and never crash.',
    notes: ['Decryption succeeds; the profile check fails. expect.failStage is bundle.'],
  });
  await vector({
    id: 'ktc-b8-single-entry', title: 'Patient-only Bundle (invalid)', tier: 'bundle', level: 'negative',
    tests: ['#fhir-bundle-profile-patientsharedbundle'], bundleName: 'bad-single-entry',
    label: 'No content entries',
    description: 'entry is 2..* — a Patient with no content entry violates the profile.',
    notes: ['Decryption succeeds; the profile check fails. expect.failStage is bundle.'],
  });
  // Mark the two bundle-stage negatives (decrypt succeeds, profile fails)
  for (const v of vectors) {
    if (v.id === 'ktc-b7-bad-type' || v.id === 'ktc-b8-single-entry') {
      v.expect.outcome = 'reject';
      v.expect.failStage = 'bundle';
    }
  }

  // --- attestation JWKS + harness + index ----------------------------------------------
  const { d: _priv, key_ops: _ops, ...publicJwk } = ATTESTATION_JWK;
  await writeFile(
    join(OUT, 'attestation', '.well-known', 'jwks.json'),
    JSON.stringify({ keys: [publicJwk] }, null, 2),
  );
  await copyFile(join(ROOT, 'tools', 'harness.mjs'), join(OUT, 'harness.mjs'));

  for (const v of vectors) await writeFile(join(OUT, 'vectors', `${v.id}.json`), JSON.stringify(v, null, 2));
  await writeFile(
    join(OUT, 'index.json'),
    JSON.stringify(
      {
        specVersion: SPEC_VERSION,
        generated: new Date(NOW * 1000).toISOString(),
        expires: new Date(EXP * 1000).toISOString(),
        site: SITE,
        attestation: { iss: ATTESTATION_ISS, jwks: `${ATTESTATION_ISS}/.well-known/jwks.json` },
        vectors: vectors.map((v) => ({ id: v.id, title: v.title, tier: v.tier, level: v.level, file: `vectors/${v.id}.json` })),
      },
      null,
      2,
    ),
  );
  console.log(`generated ${vectors.length} vectors → public/vectors/ (exp ${new Date(EXP * 1000).toISOString().slice(0, 10)})`);
}

await main();
