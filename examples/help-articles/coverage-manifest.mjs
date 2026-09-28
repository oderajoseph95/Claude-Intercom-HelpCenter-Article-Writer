/**
 * Example coverage manifest. Copy this into your repo and replace the features.
 *
 * Every shipped feature owes one cell per KIND. A cell is exactly one of:
 *   { article: "<path to .md>" }                          written
 *   { deferred: "<30+ char reason naming a ticket>" }     owed, tracked
 *   { na: "<30+ char reason this kind does not apply>" }  argued, not asserted
 * Several kinds may point at the same file: one thorough article can cover what, how and FAQ.
 *
 * Optional per feature, used by the audit to match live articles to features:
 *   label     what users call it          keywords  extra words users search for
 *   strings   UI string key prefixes      sources   the code files that implement it
 *   area      groups features into one collection in the proposed structure
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"];

// What a ticket reference looks like in YOUR tracker. Default in the gate: ABC-123 or #123.
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+|#\d+/;

// The UI strings files the audit and the writer read labels from.
export const STRINGS = ["src/en.json"];

// Where "shipped" comes from. Read it from the repo so a new feature cannot slip past:
// a feature registry, a routes folder, a "done" folder of specs, a changelog.
export function shipped({ root }) {
  return JSON.parse(readFileSync(join(root, "src/features.json"), "utf8")).shipped;
}

const EXPORT_ARTICLE = "help-articles/articles/getting-started/export-csv.md";

export const FEATURES = {
  "csv-export": {
    label: "Export orders",
    area: "Orders",
    keywords: ["csv", "spreadsheet", "download"],
    strings: ["settings.export"],
    sources: ["src/export.js"],
    kinds: {
      "what-and-when": { article: EXPORT_ARTICLE },
      "customer-use": { na: "export is a merchant-only admin screen; shoppers never see it or anything it produces" },
      "setup": { article: EXPORT_ARTICLE },
      "comparison": { na: "there is only one export path in the app, so there is no X versus Y to explain" },
      "troubleshooting": { article: EXPORT_ARTICLE, note: "covered by the FAQ section of the same article" },
    },
  },
  "order-tags": {
    label: "Tag edited orders",
    area: "Orders",
    keywords: ["tag", "tags", "edited"],
    strings: ["settings.tags"],
    kinds: {
      "what-and-when": { deferred: "tagging article not written yet, tracked on the board as HELP-42" },
      "customer-use": { na: "tags are internal to the merchant's admin; the shopper never sees an order tag" },
      "setup": { deferred: "setup walkthrough waits on the final settings screen, tracked as HELP-42" },
      "comparison": { na: "no other feature writes order tags, so there is nothing to confuse it with" },
      "troubleshooting": { deferred: "a 'why wasn't my order tagged' FAQ is owed, tracked as HELP-42" },
    },
  },
};
