# Frontend ↔ Backend API Coverage Report

Backend: `docs/frontend/openapi.json` · Frontend: `/home/shodiyor/Desktop/Elchi-Frontend`

## Summary

- Backend operations (method+path): **228**
- Backend ops whose path the frontend references (path-level): **227**
- ❌ Backend ops with NO frontend reference at all: **1**
- ⚠️ Path wired but specific method missing (review): **1**
- 🔴 Frontend paths matching no backend route (stale/wrong): **0**
- Registry entries parsed: 188 · resolved call sites: 239 · unresolved dynamic calls: 0

Legend: `:p` = a dynamic path segment (id/token/etc).

## ❌ A. Missing in frontend (backend endpoints never referenced)

These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**

### Identity (1)
- `GET /` — Gateway health check via identity service

## ⚠️ B. Method gaps (path is used, but this method is not wired)

The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.

### Webhooks
- `POST /webhooks/{slug}` — Inbound provider webhook (HMAC-verified downstream, no JWT)

## 🔴 C. Stale / wrong frontend paths (no backend match)

These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.

_None._
## D. Unresolved dynamic calls (could not determine path)

Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.

_None._