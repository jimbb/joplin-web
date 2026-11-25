# Security model — Joplin Web

_Generated from Devin's threat model and the owner's answers (2026-11-25). Edit freely: future security scans read this file._

## Overview and trust boundaries
Web client for a self-hosted Joplin Server: React SPA (`client/`) and Express backend (`server/`) that speaks Joplin's sync protocol and keeps a per-session in-memory cache. No database (the `deploy/askgem` branch adds owner-only JSON files for preferences and 2FA). Boundaries: browser ↔ Express API (session cookie) ↔ Joplin Server (user's own credentials); note content is untrusted input to rendering.

## Owner answers
- This repository is used for the owner's own deployment only. Nothing is ruled out; every attacker matters.

## Components
| Name | Code |
|---|---|
| Joplin Web | `server/src/**`, `client/src/**`, `docker/`, `docker-compose.yml` |

## Entry points
Login (proxied to Joplin Server); REST API for notes, notebooks, tags, search and resources; note content synced from other Joplin clients.

## Assets
Notes and attachments; Joplin Server session tokens held server-side; availability of the single server process.

## Attackers
Anyone who can reach the published port; a Joplin account holder (or anything that syncs a note into the account); a malicious web page driving the user's browser (CSRF); supply chain.

## Existing controls
Origin check (`server/src/middleware/origin-check.ts`), helmet and rate limiting (`server/src/app.ts`), id validation and conflict detection in `server/src/services/note-writer.ts`, refusal of writes to encrypted items.

## Security invariants
- **CSRF (CWE-352):** every state-changing route passes `createOriginCheck`.
- **Path/ID injection (CWE-20):** ids match `^[0-9a-f]{32}$` before any Joplin path is built.
- **XSS (CWE-79):** rendered Markdown (KaTeX, Mermaid) is sanitised; note HTML never runs script.
- **ReDoS (CWE-1333):** user- or note-controlled text and search patterns never go through backtracking regexes without length limits (gaps: note preview regex, wildcard search).
- **Data integrity:** updates keep unknown properties and conflict detection (`baseUpdatedTime` → 409).
- **Secrets:** session tokens stay server-side; cookies are HttpOnly.

## Deploy branch (`deploy/askgem`, the code that actually runs)
`main` tracks upstream; the running site is `deploy/askgem`, which adds server code that the sections above do not cover:

| Feature | Code | Entry point |
|---|---|---|
| Web clipper | `server/src/services/web-clipper.ts`, `server/src/routes/clip.ts` | `POST /api/clip`, `/api/clip/html` (signed in) |
| Email ingest | `createEmailWebhookRouter` in `server/src/routes/clip.ts` | `POST /email` (webhook secret, logs in as a service Joplin account) |
| AI ask / organize | `server/src/services/ask-ai.ts`, `server/src/services/organizer.ts`, `server/src/routes/{ask,organize}.ts` | signed in; calls `AI_BASE_URL` |
| OCR | `server/src/services/ocr-bridge.ts` | calls the configured OCR service |
| 2FA and preferences | `server/src/services/{totp,two-factor-store,preferences-store,auth-cookies}.ts`, `server/src/routes/{two-factor,preferences}.ts` | signed in |

Extra assets: TOTP secrets and recovery codes, the email-ingest webhook secret and service-account password, AI and OCR endpoint keys.
Extra attackers: the pages the clipper fetches; senders of email that reaches the ingest webhook; note or page text that tries to steer the AI (prompt injection).

- **SSRF (CWE-918):** the clipper refuses private, loopback, link-local and reserved addresses for the first URL, after DNS resolution and on every redirect hop (`redirect: 'manual'`), and caps size and time for both pages and images.
- **Webhook auth (CWE-306):** `/email` stays off (404) unless the secret and service account are set, and checks the secret with `verifySecret`.
- **AI output is data (CWE-1427):** organize jobs only propose changes; nothing changes until `POST /api/organize/jobs/:id/apply`, and `/undo` reverts it. AI text is rendered through the same sanitiser as notes.
- **2FA (CWE-287/307):** TOTP codes are single-use (`lastUsedStep`), a pending 2FA login allows 5 attempts then locks, and login routes are rate-limited; the 2FA and preferences stores are written atomically with mode 0600 in a 0700 directory.
- **CSRF (CWE-352):** the new `/api/` routers sit behind the same `createOriginCheck`.

## Out of scope / accepted risk
None stated by the owner.

## Open questions
- None outstanding.
