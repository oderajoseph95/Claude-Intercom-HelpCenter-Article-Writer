---
name: plan
description: Turn the help-center audit into two plans for a human to approve - a collection structure built from the product's features, and a correction plan with a FIX, REWRITE, MERGE, DELETE, KEEP or WRITE verdict and evidence for every article and uncovered feature.
argument-hint: "[collections|corrections]"
disable-model-invocation: true
---

# Plan the corrections

Rules: `${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/SKILL.md`. `S` = `${CLAUDE_PLUGIN_ROOT}/scripts`. `$ARGUMENTS` may limit this to `collections` or `corrections`; the default is both.

1. This needs `.help-center/help-center-audit.json`. If it is missing or more than a day old, run `/intercom-help-center:audit` first.
2. **Collections** (`${CLAUDE_PLUGIN_ROOT}/skills/intercom-help-center/references/collections.md`): `node S/plan-collections.mjs`. Show the tree, the moves and the REVIEW list. Ask: approve · change it · keep the current structure. Apply changes through `collectionMap` or `audit.standardCollections` in config and re-run. On approval: `node S/plan-collections.mjs --approve --by "<the user's name>"`.
3. **Corrections**: `node S/correction-plan.mjs`. Then have the `help-center-auditor` agent verify items against the code: every DELETE (is the feature really gone?), every WRITE (did it really ship; which files and strings?), every MERGE (which article is the keeper?). It edits reasons and evidence in the plan; it never approves.
4. Present `.help-center/help-center-plan.md` grouped by verdict, with counts. Ask: approve all · pick items · none. DELETE and MERGE items need an explicit yes each.
5. Record the answer: `node S/correction-plan.mjs --approve all|P001,P004|none --by "<the user's name>"`.
6. Next step: `/intercom-help-center:fix`.

Nothing in this command changes Intercom.
