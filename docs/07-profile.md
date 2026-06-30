# 07 - Profile

## Purpose
Build + inject the user profile. Clean-room wording.

## Storage
- space.metadata.profile = { static: string[], dynamic: string[] }
- space.entity_context = per-container custom processing prompt.

## Formatting
- Show all static items.
- Show up to RECENT_DISPLAY_LIMIT=10 dynamic items, then "(+N more recent items)".
- Bullet = "  - ".

## Injection block (ours)
[User memory context]
Known facts about the current user, gathered from earlier sessions and saved documents. Use them
to tailor your responses when they are relevant:

{formattedProfile}

Treat this purely as background - weave it in naturally and do not call attention to having a
stored profile unless the user asks about it.

## Application
Appended to request.system (string concat; or .content if object; else set).
