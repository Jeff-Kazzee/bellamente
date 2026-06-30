# 03 - Memory Write

## Purpose
createMemory() - direct write path, verbatim port of $V2.

## Input (zod, from Ss8/hs8)
- memories: array (1..100) of:
  - content: string (1..10000)
  - isStatic?: boolean
  - forgetAfter?: ISO datetime | null
  - forgetReason?: string
  - metadata?: object
  - temporalContext?: object
- containerTag: string

## Algorithm
1. Upsert space by (containerTag, org_id); get spaceId. Missing -> SpaceNotFoundError (404).
2. embed(values=contents, taskType=RETRIEVAL_DOCUMENT).
3. For each: validate dim===768 and all finite; build row:
   { id, memory, spaceId, orgId, userId, version:1, isLatest:true, isStatic,
     isForgotten:false, rootMemoryId:id, sourceCount:1, metadata,
     forgetAfter, forgetReason: forgetAfter ? reason : null }.
4. One transaction:
   - insert ONE synthetic document:
     { content: contents joined by blank line, type:text, source:api, status:done,
       containerTags:[tag], title: "Direct memories (N)", chunkCount:0,
       metadata:{ sm_direct_memory:true } }
   - link document<->space
   - bulk-insert memory_entry rows
   - insert memory_document_source (relevanceScore:100, chunkId:null)
5. Upsert embeddings into vector index. Namespace = (orgId, containerTag).

## Update (PATCH)
Insert v+1 with parentMemoryId=old, rootMemoryId carried; set old isLatest=false.

## Forget
Set isForgotten=true (+optional reason). Bad dates -> InvalidForgetAfterError (400).

## Acceptance
- Round-trips via search immediately (same txn).
- Empty/invalid vectors are silently skipped, not inserted.
