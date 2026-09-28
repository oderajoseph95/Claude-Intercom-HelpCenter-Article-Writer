/**
 * text.mjs: title normalisation, similarity, and a small line diff. No dependencies.
 */

const STOP = new Set(("a an the and or of to in on for with by at from is are be can do does did i my me we our you your it its this that " +
  "how what why when where which who will would should could not no yes if into as about after before than then there their them they").split(" "));

/** "How do I export my orders to CSV?" -> "export orders csv". Used for duplicate titles. */
export function normTitle(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(" ");
}

export function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

/** A deliberately tiny stemmer: orders -> order, exporting -> export. Good enough for matching. */
export function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

export function shingles(text, k = 3) {
  const w = String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const titleSimilarity = (a, b) => jaccard(tokens(a), tokens(b));

/** A question title: ends with "?" or starts like one. */
export const isQuestionTitle = (t) => /\?\s*$/.test(String(t)) ||
  /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will|could)\b/i.test(String(t).trim());

// ── line diff ───────────────────────────────────────────────────────────────────────────────
/** LCS line diff. Returns [{op: " "|"-"|"+", line}]. Inputs are capped to keep it fast. */
export function diffLines(a, b, cap = 3000) {
  const A = String(a ?? "").replace(/\r\n/g, "\n").split("\n").slice(0, cap);
  const B = String(b ?? "").replace(/\r\n/g, "\n").split("\n").slice(0, cap);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: " ", line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", line: A[i++] });
    else out.push({ op: "+", line: B[j++] });
  }
  while (i < n) out.push({ op: "-", line: A[i++] });
  while (j < m) out.push({ op: "+", line: B[j++] });
  return out;
}

/** Only changed lines with one line of context, as printable text. */
export function formatDiff(d, { context = 1, labelA = "a", labelB = "b" } = {}) {
  if (!d.some((x) => x.op !== " ")) return "  (no changes)";
  const keep = new Set();
  d.forEach((x, idx) => { if (x.op !== " ") for (let k = idx - context; k <= idx + context; k++) keep.add(k); });
  const lines = [`  --- ${labelA}`, `  +++ ${labelB}`];
  let last = -2;
  d.forEach((x, idx) => {
    if (!keep.has(idx)) return;
    if (idx !== last + 1) lines.push("  ...");
    lines.push(`  ${x.op} ${x.line}`);
    last = idx;
  });
  return lines.join("\n");
}

export const hasChanges = (d) => d.some((x) => x.op !== " ");

/** Stable, short content hash (FNV-1a), used to spot edits made on Intercom. */
export function hash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
