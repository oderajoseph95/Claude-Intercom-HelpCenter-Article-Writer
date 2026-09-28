# Collections: categorizing the Help Center

Readers browse by what they are trying to do, which maps to features. So the proposed structure is built from the features in the code, not from how articles happen to be filed today.

## The proposed tree

```
Getting started
<one collection per feature>        or, when features have an `area`:
                                    <Area>
                                      <Feature>   (a section per feature)
Billing
Troubleshooting
```

- The three standard names come from `audit.standardCollections` in config; rename them there (for example to match an existing "Getting Started").
- Any feature can be placed by hand: `collectionMap` in config, `{"csv-export": "Orders › Exporting"}`. Any depth works.
- Articles about a feature go to that feature's collection, including its troubleshooting articles. Articles about plans, invoices or refunds go to Billing; "why is X not working" articles with no feature go to Troubleshooting; install and first-steps articles go to Getting started.
- Anything that matches nothing is **REVIEW**: it stays where it is until a human places it.
- Existing collections the tree does not use are listed, never deleted.

## The conversation

1. `node S/plan-collections.mjs` (needs `help-center-audit.json`).
2. Show the tree from `help-center-collections.plan.md`, the number of moves, and the REVIEW list.
3. Ask (AskUserQuestion): **Approve this structure** · **Change it** (then ask what; update `collectionMap` or `audit.standardCollections`; re-run) · **Keep the current structure** (skip restructuring; the correction plan still runs).
4. For REVIEW articles, ask where each goes (or leave them).
5. On approval: `node S/plan-collections.mjs --approve --by "<name>"`.
6. Dry run, then apply in batches: see [publishing.md](publishing.md#applying-a-collections-plan).

## Things to say out loud

- Moving an article changes its breadcrumb, not its URL.
- Collections and sections created through the API start empty and appear in the Help Center once they hold a published article.
- The plan never renames a collection. If the user wants "Getting Started" instead of "Getting started", set the standard names in config so the plan matches the existing collection.
