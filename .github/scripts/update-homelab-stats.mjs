// Reads the totals file that the private jay739/homelab-docker-services repo
// generates (docs/reference/stats.json, written by tools/gen_docs.py) and
// writes those totals into README.md and profile/homelab-stats.json.
//
// stats.json is the one file built to leave that private repo: counts only,
// nothing that names a service, host, port or address. This script still
// prints nothing but the totals, because Actions logs on a public repo are
// readable by anyone. A missing key or an impossible count stops the run with
// the README untouched: it never writes a zero for a number it could not read.
//
// README.md marks each number that should update itself like this:
//   <!--hl:batcave_containers-->63<!--/hl-->
//   <!--hl:batcave_containers-->`63`<!--/hl-->   (backticks are kept)
// GitHub does not render the comments, inline or inside table cells. They do
// show inside a fenced code block, so never put a marker in one.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DOCS_DIR = process.env.HOMELAB_DOCS_DIR || ".homelab-docs";
const README_PATH = process.env.README_PATH || "README.md";
const STATS_PATH = process.env.STATS_PATH || "profile/homelab-stats.json";

// Path inside the docs checkout, written by tools/gen_docs.py.
export const SOURCE = "docs/reference/stats.json";

// The public contract: profile/homelab-stats.json carries exactly these keys,
// in this order, and README markers may name any of them or docs_updated.
// tools/gen_docs.py must write every one of them; it may add others, which are
// ignored here until this list names them.
export const STAT_KEYS = [
  "batcave_containers", // running on batcave's Docker daemon
  "homelab_containers", // batcave plus every remote host the docs enumerate
  "services_declared", // services in batcave's compose files
  "compose_files",
  "services_healthchecked",
  "services_mem_limited",
  "https_sites", // enabled proxy hosts with a live upstream, wildcards excluded
  "hosts", // machines in the topology, enumerated or not
];
export const README_KEYS = [...STAT_KEYS, "docs_updated"];

// A count that can never honestly be zero. Seeing one means the generator
// went wrong, not that the homelab is empty.
const MUST_BE_POSITIVE = [
  "batcave_containers",
  "homelab_containers",
  "services_declared",
  "compose_files",
  "https_sites",
  "hosts",
];

// Every failure this script expects is one of these four.
export class StatsError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The totals file, or the docs history, is not in the checkout. */
export class SourceMissingError extends StatsError {}

/** The totals file is not the JSON object this script expects. */
export class SourceFormatError extends StatsError {
  constructor(problem) {
    super(
      `${SOURCE} ${problem}. Check that tools/gen_docs.py still writes every key in ` +
        "STAT_KEYS in .github/scripts/update-homelab-stats.mjs, or update the list.",
    );
  }
}

/** The numbers parsed, but they cannot be right. */
export class ImplausibleValueError extends StatsError {}

/** README.md has no markers, a broken marker, or a marker naming an unknown stat. */
export class MarkerError extends StatsError {}

export function parseStatsFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // JSON.parse quotes a slice of its input in the message. The file should
    // hold only counts, but keep its content out of the public log regardless.
    throw new SourceFormatError("is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SourceFormatError("is not a JSON object");
  }
  const missing = STAT_KEYS.filter((key) => !(key in data));
  if (missing.length > 0) throw new SourceFormatError(`has no ${missing.join(", ")}`);
  return Object.fromEntries(STAT_KEYS.map((key) => [key, data[key]]));
}

export function toIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ImplausibleValueError(`'${value}' is not a date the docs could have been updated on`);
  }
  return date.toISOString().slice(0, 10);
}

// The date of the last commit that changed the generated docs, not just the
// totals: an architecture change that moves no count still counts. The
// workflow checks the docs repo out with full history so this sees past HEAD.
export function lastDocsChange(docsDir, env = process.env) {
  if (env.HOMELAB_DOCS_UPDATED) return toIsoDate(env.HOMELAB_DOCS_UPDATED);
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["-C", docsDir, "log", "-1", "--format=%cI", "--", "docs/reference", "docs/diagrams"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    // Handled below with the same message as an empty history.
  }
  if (!out) {
    throw new SourceMissingError(
      `could not read the docs history in ${docsDir}. Check the docs repo out with ` +
        "fetch-depth: 0, or set HOMELAB_DOCS_UPDATED to an ISO date.",
    );
  }
  return toIsoDate(out);
}

export function validateStats(stats) {
  for (const key of STAT_KEYS) {
    const value = stats[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new ImplausibleValueError(`${key} is ${value}, expected a whole number`);
    }
  }
  for (const key of MUST_BE_POSITIVE) {
    if (stats[key] === 0) {
      throw new ImplausibleValueError(
        `${key} is 0, which means the generator read an empty source. README left unchanged.`,
      );
    }
  }
  for (const key of ["services_healthchecked", "services_mem_limited"]) {
    if (stats[key] > stats.services_declared) {
      throw new ImplausibleValueError(
        `${key} (${stats[key]}) exceeds services_declared (${stats.services_declared})`,
      );
    }
  }
  if (stats.homelab_containers < stats.batcave_containers) {
    throw new ImplausibleValueError(
      `homelab_containers (${stats.homelab_containers}) is below batcave_containers ` +
        `(${stats.batcave_containers})`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stats.docs_updated || "")) {
    throw new ImplausibleValueError("docs_updated is not a YYYY-MM-DD date");
  }
  return stats;
}

export async function collectStats(docsDir, docsUpdated) {
  let text;
  try {
    text = await readFile(path.join(docsDir, SOURCE), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    throw new SourceMissingError(
      `${SOURCE} is missing from ${docsDir}. Check that the docs checkout step ran, ` +
        "that HOMELAB_DOCS_DIR points at it, and that tools/gen_docs.py writes the file.",
    );
  }
  return validateStats({ docs_updated: docsUpdated, ...parseStatsFile(text) });
}

export function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const formatValue = (key, stats) =>
  key === "docs_updated" ? formatDate(stats.docs_updated) : String(stats[key]);

const MARKER = /<!--hl:([a-z_]+)-->(`?)([^<`\n]*)\2<!--\/hl-->/g;

export function renderReadme(readme, stats) {
  const openers = (readme.match(/<!--hl:/g) || []).length;
  if (openers === 0) {
    throw new MarkerError(
      "README has no <!--hl:KEY-->value<!--/hl--> markers. Wrap each number that " +
        "should update itself, for example <!--hl:batcave_containers-->63<!--/hl-->.",
    );
  }
  let matched = 0;
  const out = readme.replace(MARKER, (_, key, tick) => {
    matched++;
    if (!README_KEYS.includes(key)) {
      throw new MarkerError(`README names unknown stat '${key}'. Known: ${README_KEYS.join(", ")}.`);
    }
    return `<!--hl:${key}-->${tick}${formatValue(key, stats)}${tick}<!--/hl-->`;
  });
  if (matched !== openers) {
    throw new MarkerError(
      `${openers - matched} README marker(s) are malformed. Each needs the form ` +
        "<!--hl:KEY-->value<!--/hl--> on one line, with a lowercase KEY.",
    );
  }
  return out;
}

export function renderStatsJson(stats) {
  const ordered = { docs_updated: stats.docs_updated };
  for (const key of STAT_KEYS) ordered[key] = stats[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

async function main() {
  const stats = await collectStats(DOCS_DIR, lastDocsChange(DOCS_DIR));
  const readme = await readFile(README_PATH, "utf8");
  const updated = renderReadme(readme, stats);

  await mkdir(path.dirname(STATS_PATH), { recursive: true });
  await writeFile(STATS_PATH, renderStatsJson(stats), "utf8");
  if (updated !== readme) await writeFile(README_PATH, updated, "utf8");

  // Totals and a date only: this log is public.
  console.log(`Homelab stats: ${README_KEYS.map((k) => `${k}=${stats[k]}`).join(" ")}`);
  console.log(updated === readme ? "README unchanged" : "README updated");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof StatsError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
