---
# What the reader sees
title: "<A question your customer would type into Google or your Help Center search. 'How do I export my orders to CSV?' not 'CSV export module'.>"
description: "<One line under the title. Finish: 'After reading this you will be able to...'>"

# Where it lives on Intercom (matched BY NAME against your live Help Center)
collection: "<Collection name exactly as it appears in Intercom>"
section: ""            # optional: a section inside that collection. Blank publishes directly under it.

# Publishing state
state: draft           # draft | published. Only a HUMAN changes this to published, after review.

# What this was written FROM. The gate checks these exist and warns when they change after last_synced.
sources:
  - <path/to/the/code/that/implements/this>
  - <path/to/the/ui/strings/file>

# Written back by publish.mjs. Do not hand-edit.
intercom_id: null
intercom_url: null
last_synced: null
---

# <The title again, word for word. Stripped on publish so Intercom does not show it twice.>

<Two sentences. The outcome first: what can the reader do now, and why it matters to them. No feature name in the first sentence.>

<!-- Reviewer notes go in HTML comments like this one. They are stripped and never publish. -->

## Before you start

<Only if something is genuinely required: a plan, a permission, a setting. If nothing is, delete this section.>

## How to <do the thing>

1. <The EXACT button label from the UI strings file, in bold. If the button says "Save changes", write **Save changes**.>
2. <One action per step. A step with "and" in it is two steps.>

## What each setting does

| Setting | What it does |
|---|---|
| <label, copied from the UI strings> | <help text, copied from the UI strings, then made plainer if needed> |

## What happens next

<What the reader sees afterwards, what their customer sees, how long it takes. If money moves, say what, who confirms it, and where the proof shows up.>

## What this does NOT do

- <The thing people reasonably assume it does, and it does not.>
- <A limit: a plan, a region, an order type. Say why, in their words.>

## Frequently asked

**<A question support actually gets, in the words people actually use.>**

<The honest answer. "Not yet" is allowed. A roadmap promise is not.>

## Related

- [<The article that answers their next question>](<other-article-file.md>)
