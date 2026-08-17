#!/usr/bin/env node
/**
 * Mutation check: reintroduce known bugs and prove the suite goes red.
 *
 * Every defect this plugin has shipped failed SILENTLY — no throw, no error
 * log, a bot that looked connected and did nothing. Line coverage does not
 * catch that class of bug: a line runs during a test whether or not anything
 * asserts on what it did. `src/decisions.ts` sat at 100% statement coverage
 * while three of its behaviours had no assertion behind them, including two a
 * commit message claimed to have covered.
 *
 * So this is the check that coverage cannot make: break the code on purpose,
 * and fail if the tests still pass.
 *
 *   npm run test:mutations
 *   npm run test:mutations -- --filter=verbs   # one mutation, by id substring
 *   npm run test:mutations -- --list           # show the catalogue, run nothing
 *
 * Adding a mutation is the cheapest way to lock in a bug you just fixed:
 * describe the user-visible failure in `breaks`, and point `find`/`replace` at
 * the guard that prevents it.
 *
 * A mutation whose `find` anchor no longer matches is a HARD FAILURE, not a
 * skip. A silently-skipped mutation is the same false confidence this script
 * exists to remove — if you refactor the source, re-anchor the mutation.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @type {Array<{id: string, file: string, breaks: string, find: string, replace: string}>}
 * `breaks` states the user-visible consequence, so a MISSED result reads as a
 * product risk rather than a coverage statistic.
 */
const MUTATIONS = [
  {
    id: "confirmation-branch",
    file: "src/decisions.ts",
    breaks:
      "request_confirmation items stop being answerable — half of BLA-154 silently reverts to a web link.",
    find: `  if (fresh.kind === "request_confirmation") {
    return { id: fresh.id, kind: "request_confirmation", payload: fresh.payload as RequestConfirmationPayload };
  }`,
    replace: `  if (fresh.kind === "request_confirmation") {
    return null;
  }`,
  },
  {
    id: "stale-interaction",
    file: "src/decisions.ts",
    breaks:
      "An interaction answered in the web UI since the /attention snapshot is still offered as buttons; the answer is rejected and the user is told nothing.",
    find: '  if (!fresh || fresh.status !== "pending") return null;',
    replace: "  if (!fresh) return null;",
  },
  {
    id: "free-text-questions",
    file: "src/decisions.ts",
    breaks:
      "Questions with a designer-declared free-text option are rendered as buttons, so the answer the designer asked for cannot be given.",
    find: "    if (!isAskUserQuestionsAnswerable(payload)) return null;",
    replace: "    // guard removed",
  },
  {
    id: "inline-resolvable",
    file: "src/decisions.ts",
    breaks:
      "The host's inlineResolvable verdict is overridden and items it declined to expose inline are answered from Telegram anyway.",
    find: "    inlineResolvable: raw.inlineResolvable === true,",
    replace: "    inlineResolvable: true,",
  },
  {
    id: "decision-verbs",
    file: "src/decisions.ts",
    breaks:
      "The host's own decisionVerbs are dropped, so the Options line disappears and the bot is free to invent labels the host never offered.",
    find: `  const verbs = Array.isArray(raw.decisionVerbs)
    ? (raw.decisionVerbs as Array<Record<string, unknown>>)
        .map((v) => (typeof v.label === "string" ? v.label : ""))
        .filter(Boolean)
    : [];`,
    replace: "  const verbs: string[] = [];",
  },
  {
    id: "callback-double-answer",
    file: "src/interaction-answers.ts",
    breaks:
      "A button press is submitted without re-checking the interaction is still pending, so a stale message answers something already resolved.",
    find: '  if (!fresh || fresh.status !== "pending") {',
    replace: "  if (false) {",
  },
];

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);
const selected = filter ? MUTATIONS.filter((m) => m.id.includes(filter)) : MUTATIONS;

if (args.includes("--list")) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(24)} ${m.file}\n${" ".repeat(25)}${m.breaks}`);
  process.exit(0);
}

if (selected.length === 0) {
  console.error(`No mutation matches --filter=${filter}. Use --list to see the catalogue.`);
  process.exit(1);
}

const abs = (f) => path.join(ROOT, f);

/** Refuse to run against edits we could lose if this crashes mid-mutation. */
function assertTargetsClean() {
  const files = [...new Set(selected.map((m) => m.file))];
  const res = spawnSync("git", ["status", "--porcelain", "--", ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("Could not read git status; refusing to mutate files in place.");
    process.exit(1);
  }
  if (res.stdout.trim()) {
    console.error(
      "Uncommitted changes in the files this script rewrites:\n" +
        res.stdout +
        "\nCommit or stash them first — a crash mid-run would restore over your edits.",
    );
    process.exit(1);
  }
}

function runSuite() {
  // --bail=1 because the only question is whether the suite goes red at all.
  const res = spawnSync("npx", ["vitest", "run", "--reporter=dot", "--bail=1"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return res.status !== 0;
}

assertTargetsClean();

/** Files rewritten right now, restored on any exit path including Ctrl-C. */
const open = new Map();
const restoreAll = () => {
  for (const [file, original] of open) writeFileSync(file, original);
  open.clear();
};
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreAll();
  process.exit(143);
});

const results = [];
try {
  for (const m of selected) {
    const file = abs(m.file);
    const original = readFileSync(file, "utf8");

    if (!original.includes(m.find)) {
      results.push({ id: m.id, status: "STALE", note: `anchor not found in ${m.file}` });
      console.log(`STALE   ${m.id} — anchor not found in ${m.file}`);
      continue;
    }

    open.set(file, original);
    writeFileSync(file, original.replace(m.find, m.replace));
    try {
      const caught = runSuite();
      results.push({ id: m.id, status: caught ? "CAUGHT" : "MISSED", note: m.breaks });
      console.log(`${caught ? "CAUGHT " : "MISSED "} ${m.id}`);
    } finally {
      writeFileSync(file, original);
      open.delete(file);
    }
  }
} finally {
  restoreAll();
}

const bad = results.filter((r) => r.status !== "CAUGHT");
console.log("\n===== mutation check =====");
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}`);
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);

const missed = bad.filter((r) => r.status === "MISSED");
const stale = bad.filter((r) => r.status === "STALE");

if (missed.length) {
  console.log("\nUnguarded behaviour — the code broke and the suite stayed green:");
  for (const r of missed) console.log(`  ${r.id}: ${r.note}`);
  console.log("\nAdd an assertion that fails for each mutation above.");
}

if (stale.length) {
  console.log("\nNot checked at all — the mutation no longer applies to the source:");
  for (const r of stale) console.log(`  ${r.id}: ${r.note}`);
  console.log("\nRe-anchor these against the refactored code; a skipped mutation proves nothing.");
}

process.exit(bad.length ? 1 : 0);
