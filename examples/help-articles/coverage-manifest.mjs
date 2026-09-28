/**
 * Example coverage manifest. Copy this into your repo and replace the features.
 *
 * Every shipped feature owes one cell per KIND. A cell is exactly one of:
 *   { article: "<path to .md>" }                          written
 *   { deferred: "<30+ char reason naming a ticket>" }     owed, tracked
 *   { na: "<30+ char reason this kind does not apply>" }  argued, not asserted
 * Several kinds may point at the same file: one thorough article can cover what, how and FAQ.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["what-and-when", "customer-use", "setup", "comparison", "troubleshooting"];

// What a ticket reference looks like in YOUR tracker. Default in the gate: ABC-123 or #123.
export const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+|#\d+/;

// Where "shipped" comes from. Read it from the repo so a new feature cannot slip past:
// a feature registry, a routes folder, a "done" folder of specs, a changelog.
export function shipped({ root }) {
  return JSON.parse(readFileSync(join(root, "src/features.json"), "utf8")).shipped;
}

const EXPORT_ARTICLE = "help-articles/articles/getting-started/how-do-i-export-my-orders-to-csv.md";

export const FEATURES = {
  "csv-export": {
    label: "Export orders to CSV",
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
    kinds: {
      "what-and-when": { deferred: "tagging article not written yet, tracked on the board as HELP-42" },
      "customer-use": { na: "tags are internal to the merchant's admin; the shopper never sees an order tag" },
      "setup": { deferred: "setup walkthrough waits on the final settings screen, tracked as HELP-42" },
      "comparison": { na: "no other feature writes order tags, so there is nothing to confuse it with" },
      "troubleshooting": { deferred: "a 'why wasn't my order tagged' FAQ is owed, tracked as HELP-42" },
    },
  },
};
