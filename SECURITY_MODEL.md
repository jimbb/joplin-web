# Security model — Joplin Web

_Generated from Devin's threat model and the owner's answers (2026-11-25). Edit freely: future security scans read this file._

## Overview and trust boundaries
Web client for a self-hosted Joplin Server: React SPA (`client/`) and Express backend (`server/`) that speaks Joplin's sync protocol and keeps a per-session in-memory cache. No database. Boundaries: browser ↔ Express API (session cookie) ↔ Joplin Server (user's own credentials); note content is untrusted input to rendering.

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

## Out of scope / accepted risk
None stated by the owner.

## Open questions
- None outstanding.
