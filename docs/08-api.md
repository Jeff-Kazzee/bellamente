# 08 - API Surface (single-tenant)

## Routes
- POST   /memories            create (Spec 03)
- GET    /memories            list (filters, pagination)
- GET    /memories/:id        get one (+ version history)
- PATCH  /memories/:id        new version (Spec 03)
- POST   /memories/:id/forget soft-forget
- POST   /search              recall (Spec 04)
- GET    /profile             read profile (Spec 07)
- PUT    /profile             write profile
- POST   /v1/chat/completions OpenAI-compatible proxy (Spec 06)

## Auth
Authorization: Bearer ${MINIMEM_API_KEY}. Missing/invalid -> 401.

## Errors (typed JSON { error })
- 400 InvalidForgetAfterError / validation
- 401 Unauthorized
- 404 SpaceNotFoundError / MemoryNotFoundError
- 500 server error

## Request log (optional, port of api_request)
type enum: memory_add, memory_update, memory_delete, memory_list, search_v4, chat.
Columns: org_id, key_id, model, input, output, status_code, created_at.
