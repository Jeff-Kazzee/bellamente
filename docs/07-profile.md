# 07 - Profile

## Purpose
Build + inject the user profile.

## Storage
- space.metadata.profile = { static: string[], dynamic: string[] }
- space.entity_context = per-container custom processing prompt.

## Formatting (verbatim constants)
- Show all static items.
- Show up to RECENT_MEMORIES_DISPLAY_LIMIT=10 dynamic items, then "...and N more recent memories".
- BULLET_POINT = "  * " (unicode bullet in original).

## Injection template (verbatim - do not paraphrase)
[ADDITIONAL CONTEXT - User Profile Information]
The following is background information about the user to help personalize your responses.
This information has been automatically collected from their previous interactions and documents:

{formattedProfile}

Note: This context is provided for personalization purposes. Use it naturally when relevant,
but don't explicitly mention that you have access to this profile unless directly asked.

## Application
Appended to request.system (string concat; or .content if object; else set).

## [DESIGN]
How dynamic is populated. Original treats it as static JSON on the space record. v1 may
recompute from recent memories - decision deferred.
