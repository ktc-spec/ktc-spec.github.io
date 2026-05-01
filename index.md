# Patient-Shared Health Documents via SMART Health Links

> **Status:** Draft for July 2026
> **Version:** 0.9.0

## Introduction

This implementation guide defines a constrained profile of SMART Health Links (SHLinks) for patient-to-provider sharing of health data at the point of care. A patient presents a QR code; the provider's EHR scans it, downloads an encrypted FHIR Bundle containing USCDI data classes and elements, and persists the content in a manner associated with the patient's chart.

### Requirements

> 1. Patient app creates a SHLink pointing to a FHIR Bundle that may include:
>     - a) Patient-shared FHIR resources conforming to the profiles in the following Implementation Guides: US Core, CARIN BlueButton, and CARIN Digital Insurance Card.
>     - b) Patient-authored PDF documents represented as PatientSharedDocumentReference resources. This US Core DocumentReference profile carries the PDF in `content.attachment`.
>     - c) Patient-authored PDF documents SHOULD focus on information from the patient's perspective: their own words, story, priorities, concerns, goals, care experiences, corrections, and context. They SHOULD NOT simply repeat clinical facts already available as discrete FHIR resources. When clinical facts can be represented discretely, the sender SHOULD include the corresponding FHIR resources instead of repeating those facts only in narrative.
>
> 2. The provider can scan the SHLink QR, resolve + decrypt the data, and persist all received patient-shared health data.
>     - a) The EHR SHALL persist all received FHIR resources conforming to the profiles in the Implementation Guides listed in (1)(a) and (1)(b), so they are associated with the patient's chart and available later to authorized users.
>     - b) This is a functional persistence requirement. It does not require the EHR to store each received resource in the data layer that backs the EHR's FHIR API, or to mirror received resources through that API, nor even to store them natively in FHIR.
>     - c) The EHR MAY satisfy the persistence requirement through product-specific storage approaches, including filing structured data, storing a chart-associated copy of the received content, rendering content into a document or note, preserving the original Bundle, or another approach that maintains access and provenance.
>
> 3. At no point in this flow does a patient need to sign into an EHR Portal.

### Scope

This IG defines:

1. SHLink payload constraints for patient-shared health data
2. A FHIR Bundle profile for patient-shared content, including optional PatientSharedDocumentReference resources and optional additional discrete FHIR resources
3. Requirements for patient apps (senders) and EHRs (receivers)
4. An optional App Attestation extension for provenance signaling

### Actors

| Actor | Role |
|-------|------|
| Patient App | Generates SHLink QR containing encrypted FHIR Bundle with FHIR resources conformant to profiles in US Core, CARIN BlueButton, and CARIN Digital Insurance Card, including optional PatientSharedDocumentReference resources |
| Patient | Presents QR to provider |
| Provider EHR | Scans QR, downloads, and persists patient-shared FHIR resources, including PatientSharedDocumentReference resources |

---

## Workflow

```
┌──────────────┐                                    ┌──────────────┐
│  Patient App │                                    │  Provider    │
│              │                                    │  EHR         │
│ 1. Generate  │         2. Present QR              │              │
│    Bundle    │ ─────────────────────────────────► │ 3. Scan QR   │
│    + SHLink  │                                    │              │
│              │                                    │ 4. Decode    │
│              │                                    │    SHLink    │
│              │      5. HTTP GET (+recipient)      │              │
│              │ ◄───────────────────────────────── │              │
│              │                                    │              │
│              │       6. Encrypted payload         │              │
│              │ ─────────────────────────────────► │ 7. Decrypt   │
│              │                                    │    + Store   │
│ 8. Audit log │                                    │              │
└──────────────┘                                    └──────────────┘
```

> **Try it:** A working prototype with a sample QR code is available at [pshd-shl.exe.xyz/prototype.html](https://pshd-shl.exe.xyz/prototype.html).

---

## SHLink Constraints

This IG profiles the [SMART Health Links specification](https://hl7.org/fhir/uv/smart-health-cards-and-links/STU1/links-specification.html) with the following constraints.

### SHLink Payload (decoded)

```json
{
  "url": "https://patient-app.example.com/Y9xwkUdtmN9wwoJoN3ffJIhX2UGvCL1JnlPVNL3kDWM",
  "flag": "U",
  "key": "rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q",
  "exp": 1706745600,
  "label": "Jessica Argonaut's health summary"
}
```

| Field | Cardinality | Constraint |
|-------|-------------|------------|
| `url` | 1..1 | Endpoint returning encrypted payload |
| `flag` | 1..1 | `U` (direct retrieval; this is the SHLink default) |
| `key` | 1..1 | Decryption key |
| `exp` | 1..1 | **Required.** Expiration timestamp. SHOULD be short-lived for sensitive data. |
| `label` | 0..1 | Human-readable description |

Patient Apps SHALL generate SHLinks with the `U` flag, meaning the link resolves directly to a single encrypted file without requiring a passcode. Since this is the default SHLink behavior, most implementations will already conform.

---

## Retrieval Protocol

With the `U` flag, the SHLink URL resolves directly to a single encrypted file (bypassing the manifest).

### Request

The EHR retrieves the encrypted payload via HTTP GET. The EHR **SHALL** supply a `recipient` query parameter identifying the requesting organization.

```http
GET https://patient-app.example.com/Y9xwkUdtmN9wwoJoN3ffJIhX2UGvCL1JnlPVNL3kDWM
    ?recipient=Verona+Health+System
```

| Parameter | Cardinality | Description |
|-----------|-------------|-------------|
| `recipient` | 1..1 | Organization name requesting access. Appropriate for display to patient in audit log. |

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/jose
```

Body contains a JWE (JSON Web Encryption) compact serialization string.

### Decryption

Per the SHLink specification, files are encrypted using JWE with:
- `"alg": "dir"` (direct encryption with shared symmetric key)
- `"enc": "A256GCM"` (AES-256-GCM)
- `"cty": "application/fhir+json"` (content type of decrypted payload)

The EHR decrypts using the 32-byte `key` from the SHLink payload (base64url-decoded) to obtain the FHIR Bundle.

**Example JWE structure (compact serialization):**
```
eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwiY3R5IjoiYXBwbGljYXRpb24vZmhpcitqc29uIn0
..
<IV>
.
<ciphertext>
.
<authentication tag>
```

The decrypted payload is a FHIR Bundle conforming to the PatientSharedBundle profile.

---

## FHIR Bundle Profile: PatientSharedBundle

The decrypted payload is a FHIR Bundle conforming to this profile.

**Canonical URL:** `https://cms.gov/fhir/StructureDefinition/patient-shared-bundle`

### Structure

```
Bundle (type: collection)
├── Patient (1..1)
├── DocumentReference (0..*) - PatientSharedDocumentReference profile
│   └── content.attachment - embedded PDF (base64)
└── [Additional FHIR resources]* (0..*)
```

The Bundle SHALL contain a Patient resource and at least one additional patient-shared content entry. Content entries MAY include (1) PatientSharedDocumentReference resources, and (2) additional FHIR resources conforming to profiles in US Core, CARIN BlueButton, and CARIN Digital Insurance, or (3) both. Discrete FHIR resources SHOULD be included when available for clinical facts represented in patient-authored PDFs.

### Constraints

| Element | Cardinality | Constraint |
|---------|-------------|------------|
| `type` | 1..1 | Fixed: `collection` |
| `timestamp` | 1..1 | When bundle was assembled |
| `entry` | 2..* | Minimum: Patient and at least one patient-shared content entry |
| `entry:patient` | 1..1 | Patient resource |
| `entry:documentReference` | 0..* | Conforms to PatientSharedDocumentReference when a patient-authored PDF document is included |

> **Note:** Resources in this Bundle SHOULD NOT include `meta.profile`. Receivers SHALL NOT require `meta.profile` to be present.

### Example

```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "timestamp": "2026-01-30T12:00:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:b5e506f4-e14c-4e27-9543-4b8d1e1f3e2a",
      "resource": {
        "resourceType": "Patient",
        "name": [{"given": ["Jessica"], "family": "Argonaut"}],
        "birthDate": "1985-03-15",
        "gender": "female"
      }
    },
    {
      "fullUrl": "urn:uuid:c7a2f8e1-3d4b-5c6a-9e8f-0a1b2c3d4e5f",
      "resource": {
        "resourceType": "DocumentReference",
        "meta": {
          "security": [{
            "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
            "code": "PATAST",
            "display": "patient asserted"
          }]
        },
        "status": "current",
        "type": {
          "coding": [{
            "system": "http://loinc.org",
            "code": "60591-5",
            "display": "Patient summary Document"
          }]
        },
        "category": [{
          "coding": [{
            "system": "https://cms.gov/fhir/CodeSystem/patient-shared-category",
            "code": "patient-shared",
            "display": "Patient-Shared"
          }]
        }],
        "subject": {
          "reference": "urn:uuid:b5e506f4-e14c-4e27-9543-4b8d1e1f3e2a"
        },
        "author": [{
          "reference": "urn:uuid:b5e506f4-e14c-4e27-9543-4b8d1e1f3e2a"
        }],
        "date": "2026-01-30T12:00:00Z",
        "description": "Patient-shared health summary",
        "content": [{
          "attachment": {
            "contentType": "application/pdf",
            "data": "JVBERi0xLjQKJeLjz9..."
          }
        }]
      }
    }
  ]
}
```

---

## DocumentReference Profile: PatientSharedDocumentReference

**Canonical URL:** `https://cms.gov/fhir/StructureDefinition/patient-shared-document-reference`

**Based on:** [US Core DocumentReference](http://hl7.org/fhir/us/core/StructureDefinition-us-core-documentreference.html)

This profile aligns with the US Core [Writing Clinical Notes](https://build.fhir.org/ig/HL7/US-Core/writing-clinical-notes.html) guidance for patient-asserted content.

### Constraints

| Element | Cardinality | Constraint |
|---------|-------------|------------|
| `meta.security` | 0..* | SHOULD include `PATAST` (patient asserted) from `http://terminology.hl7.org/CodeSystem/v3-ObservationValue` |
| `status` | 1..1 | Fixed: `current` |
| `type` | 1..1 | Fixed: LOINC `60591-5` (Patient summary Document) |
| `category` | 1..* | SHALL include `https://cms.gov/fhir/CodeSystem/patient-shared-category#patient-shared` |
| `subject` | 1..1 | Reference(Patient) in same Bundle |
| `author` | 1..* | SHALL include Reference(Patient) — the patient is the author/sharer |
| `date` | 1..1 | When document was shared |
| `content` | 1..1 | |
| `content.attachment.contentType` | 1..1 | `application/pdf` |
| `content.attachment.data` | 1..1 | Base64-encoded PDF |

> **Note:** This profile applies only when a patient-authored PDF document is included. The PatientSharedBundle does not require a DocumentReference; apps MAY share only discrete FHIR resources.

---

## Terminology

### CodeSystem: PatientSharedCategory

**Canonical URL:** `https://cms.gov/fhir/CodeSystem/patient-shared-category`

| Code | Display | Definition |
|------|---------|------------|
| `patient-shared` | Patient-Shared | Document shared by the patient via patient-mediated exchange |

```json
{
  "resourceType": "CodeSystem",
  "id": "patient-shared-category",
  "url": "https://cms.gov/fhir/CodeSystem/patient-shared-category",
  "version": "0.3.0",
  "name": "PatientSharedCategory",
  "title": "Patient-Shared Document Category",
  "status": "draft",
  "experimental": true,
  "description": "Code indicating a document was shared by the patient via patient-mediated exchange such as SMART Health Links",
  "caseSensitive": true,
  "content": "complete",
  "concept": [
    {
      "code": "patient-shared",
      "display": "Patient-Shared",
      "definition": "Document shared by the patient or their authorized representative via patient-mediated exchange"
    }
  ]
}
```

---

## Conformance Requirements

### Patient App (Sender)

**SHALL:**
- Generate SHLink with `flag` = `U`
- Include `exp` (expiration) in SHLink payload
- Serve encrypted payload without requiring authentication
- Return encrypted FHIR Bundle conforming to PatientSharedBundle profile
- Represent any patient-authored PDF document as a PatientSharedDocumentReference resource
- Accept `recipient` query parameter on retrieval endpoint
- Audit each SHLink access with recipient and timestamp

**SHOULD:**
- Set short-lived expiration for sensitive data
- Enable patient to view audit log of who accessed their SHLink
- Minimize IP geofencing to enable reasonable international use
- Include Patient resource with sufficient demographics for matching
- Include `meta.security` with `PATAST` on DocumentReference (when present)

**MAY:**
- Include FHIR resources conforming to profiles in the following Implementation Guides: US Core, CARIN BlueButton, and CARIN Digital Insurance Card
- Include an App Attestation extension (see [App Attestation](#app-attestation-optional))
- Include a PatientSharedDocumentReference resource

### Provider EHR (Receiver)

**SHALL:**
- Scan and decode SHLink QR codes
- Supply `recipient` query parameter identifying requesting organization
- Decrypt payload using key from SHLink
- Parse PatientSharedBundle
- Persist all received FHIR resources conforming to profiles in the following Implementation Guides: US Core, CARIN BlueButton, and CARIN Digital Insurance Card; so they are associated with the patient's chart and available later to authorized users
- Present persisted patient-shared FHIR content to authorized clinical users
- Indicate patient-shared provenance in clinical UI

**SHALL NOT:**
- Require `meta.profile` to be present on any resource
- Block Bundle processing when App Attestation is absent or fails verification

**SHOULD:**
- Display patient demographics from Bundle for verification
- Support clinician review before filing to chart
- Display an error message when an expired SHLink is scanned
- Verify App Attestation when present and display provenance indicator to clinician

**MAY:**
- Parse and display discrete FHIR resources from Bundle
- Ingest discrete data into structured EHR fields
- Support consumption of PatientSharedDocumentReference resources and other FHIR resources from the Bundle

The receiver persistence requirement is functional: all received content SHALL remain associated with the patient's chart and available for later access by authorized users. This requirement does not require the EHR to store each received resource in the data layer that backs the EHR's FHIR API, or to mirror received resources through that API. EHRs MAY satisfy this requirement through product-specific storage approaches, including filing structured data, storing a chart-associated copy of the received content, rendering content into a document or note, preserving the original Bundle, or another approach that maintains access and provenance.

---

## App Attestation (Optional)

When a provider scans a patient's SHLink QR code, they have no way to know whether the Bundle was produced by a recognized health app or assembled by hand. This optional extension addresses that gap: a Patient App can include a signed attestation that tells the receiver "a known app participated in creating this Bundle."

**This is a provenance signal, not a content signature.** The distinction is deliberate:

- **Patient-supplied data has inherent trust limitations.** The patient controlled this data before sharing it. A cryptographic signature over the content would imply integrity guarantees that cannot actually be delivered — the patient could have modified values after the app generated them. A content signature would give providers false confidence, which is worse than no signature.
- **The right question is "did a known app participate?" not "is this data tamper-proof?"** This attestation answers that question honestly, without requiring apps to implement full payload signing or exposing PHI to signing infrastructure.

### Structure

The attestation is a signed JWT (compact JWS) placed in `Bundle.meta.extension`:

```json
{
  "resourceType": "Bundle",
  "meta": {
    "extension": [{
      "url": "https://cms.gov/fhir/StructureDefinition/app-attestation",
      "valueString": "eyJhbGciOiJFUzI1NiIsImtpZCI6Ijk4..."
    }]
  },
  "type": "collection",
  "entry": [ "..." ]
}
```

### JWT Header

| Field | Value |
|-------|-------|
| `alg` | `ES256` |
| `kid` | Key ID matching a key in the issuer's JWKS |

### JWT Claims

All three claims are required. No other claims are defined.

| Claim | Description |
|-------|-------------|
| `iss` | App's canonical URL (e.g., `https://healthapp.example`). Must match a domain in the trust framework's app list. |
| `iat` | Unix timestamp (seconds since epoch) when the attestation was minted. |
| `jti` | UUID uniquely identifying this attestation. |

The JWT intentionally contains no PHI and no content hash. It does not include an `exp` claim — the SHLink's own `exp` field governs payload lifetime.

### Key Discovery

Receivers resolve the app's signing key via JWKS discovery at a well-known path under the `iss` URL:

```
GET {iss}/.well-known/jwks.json
```

The JWKS must contain the public key matching `kid` from the JWT header. Keys must be EC P-256 (`"kty": "EC"`, `"crv": "P-256"`).

Apps participating in the trust framework SHALL publish a JWKS document at this path. The JWKS MAY contain multiple keys to support rotation.

### Verification

1. Extract the JWS string from the `app-attestation` extension
2. Decode the JWT header and claims; extract `iss` and `kid`
3. Confirm `iss` appears in the trust framework's app list *(how this list is distributed and maintained is out of scope for this IG)*
4. Fetch `{iss}/.well-known/jwks.json`; locate the public key by `kid`
5. Verify the ES256 signature

If verification succeeds, the receiver MAY display a provenance indicator (e.g., "✓ Created with HealthApp — recognized by CMS trust framework"). Verification failure or absence of the extension **SHOULD NOT** block processing of the Bundle — this is an optional enhancement, not a gate.

---

## Security Considerations

### Encryption

Per the SHLink specification, files are encrypted using JSON Web Encryption (JWE) compact serialization:

| Parameter | Value |
|-----------|-------|
| `alg` | `dir` (direct encryption — key used directly, no key wrapping) |
| `enc` | `A256GCM` (AES-256-GCM authenticated encryption) |
| `cty` | `application/fhir+json` (content type of plaintext) |

The 32-byte symmetric key is embedded in the SHLink payload as a base64url-encoded URL fragment (43 characters). Transmitting the key as a URL fragment rather than a query parameter means it is not forwarded to servers or captured in server logs. Security relies on:
1. The key never being transmitted to the server separately
2. Physical control of the QR by the patient

### Expiration

The `exp` field is **required** in this profile. Apps SHOULD set short-lived expirations appropriate to the use case:

| Scenario | Suggested Expiration |
|----------|---------------------|
| In-person visit (QR on phone screen) | 5–15 minutes |
| Printed QR for scheduled appointment | 24–48 hours |
| Ongoing care relationship | Per patient preference |

### App Attestation Key Security

Apps that publish a JWKS for App Attestation SHOULD:
- Protect private keys using hardware security modules or equivalent key management infrastructure
- Rotate signing keys periodically and maintain multiple active keys in JWKS to support seamless rotation
- Revoke compromised keys promptly

### Audit

Patient Apps SHALL maintain audit logs of SHLink access including:
- Timestamp
- Recipient organization (from query parameter)


:::info
### Guidance: Retrieving SHLink Payloads

SHLink payload URLs should be treated as untrusted external input. This IG does not define a required CMS hosting-domain allowlist; receivers are expected to secure retrieval rather than depend on pre-coordinated hosting domains.

Receivers SHOULD retrieve payloads through a hardened, isolated retrieval service rather than from core EHR application servers. That service SHOULD:

- allow only HTTPS retrieval
- block loopback, private, link-local, multicast, and internal network targets, consistent with [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- validate DNS results and protect against DNS rebinding
- re-validate every redirect target before following it
- enforce short timeouts and response type checks
- have no access to internal EHR services, databases, cloud metadata endpoints, or application credentials
- treat decrypted FHIR and embedded PDFs as untrusted patient-supplied content, with validation and sandboxed handling where appropriate, consistent with [OWASP file handling guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

This approach aligns with [NIST Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final): protect resources with least-privilege, isolated components rather than relying on network location or a static perimeter.
:::


---

## References

- [SMART Health Links Specification (STU1)](https://hl7.org/fhir/uv/smart-health-cards-and-links/STU1/links-specification.html)
- [US Core DocumentReference](http://hl7.org/fhir/us/core/StructureDefinition-us-core-documentreference.html)
- [US Core Writing Clinical Notes](https://build.fhir.org/ig/HL7/US-Core/writing-clinical-notes.html)
- [International Patient Summary (IPS)](http://hl7.org/fhir/uv/ips/)
- [USCDI v3](https://www.healthit.gov/isa/united-states-core-data-interoperability-uscdi)

