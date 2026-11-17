// Reads the generated homelab docs (a checkout of the private
// jay739/homelab-docker-services repo) and writes their aggregate counts into
// README.md and profile/homelab-stats.json.
//
// The docs repo is private because it maps every port, bind address and
// upstream on the network. Only the totals in STAT_KEYS leave it, and this
// script prints nothing but those totals, because Actions logs on a public
// repo are readable by anyone. A source that fails to parse stops the run
// with the README untouched: it never writes a zero for a number it could not
// read.
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

// Paths inside the docs checkout. All four are written by tools/gen_docs.py.
export const SOURCES = {
  topology: "docs/diagrams/topology.json",
  inventory: "docs/reference/inventory.md",
  ingress: "docs/reference/ingress.md",
  remoteHosts: "docs/reference/remote-hosts.md",
};

// The public contract: profile/homelab-stats.json carries exactly these keys,
// in this order, and README markers may name any of them or docs_updated.
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

// A count that can never honestly be zero. Seeing one means a parse went
// wrong, not that the homelab is empty.
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

/** A docs file the script needs is not in the checkout. */
export class SourceMissingError extends StatsError {}

/** A docs file no longer has the shape this script parses. */
export class SourceFormatError extends StatsError {
  constructor(file, problem) {
    super(
      `${file} ${problem}. tools/gen_docs.py may have changed its output format; ` +
        "update the matching parser in .github/scripts/update-homelab-stats.mjs.",
    );
  }
}

/** The numbers parsed, but they cannot be right. */
export class ImplausibleValueError extends StatsError {}

/** README.md has no markers, a broken marker, or a marker naming an unknown stat. */
export class MarkerError extends StatsError {}

const normalize = (text) => text.replace(/\r\n/g, "\n");

export function parseTopology(text) {
  let topo;
  try {
    topo = JSON.parse(text);
  } catch {
    // JSON.parse quotes a slice of its input in the message, and that input
    // is private, so report the failure without it.
    throw new SourceFormatError(SOURCES.topology, "is not valid JSON");
  }
  if (!topo || !Array.isArray(topo.services) || !Array.isArray(topo.hosts)) {
    throw new SourceFormatError(SOURCES.topology, "has no services or hosts array");
  }
  const { services, hosts } = topo;
  return {
    services_declared: services.length,
    compose_files: new Set(services.map((s) => s.file).filter(Boolean)).size,
    services_healthchecked: services.filter((s) => Boolean(s.healthcheck)).length,
    services_mem_limited: services.filter((s) => s.memory && s.memory !== "-").length,
    hosts: hosts.length,
  };
}

export function parseInventory(text) {
  const match = normalize(text).match(/^- Containers on the daemon: \*\*(\d+)\*\*$/m);
  if (!match) {
    throw new SourceFormatError(SOURCES.inventory, "has no 'Containers on the daemon: **N**' line");
  }
  return { batcave_containers: Number(match[1]) };
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\*\*|`/g, ""));
}

// Rows of the first Markdown table in `text` whose header begins with Domain,
// as objects keyed by header text, with backticks and bold stripped.
function domainTable(text, file) {
  const lines = normalize(text).split("\n");
  const start = lines.findIndex((line) => /^\|\s*Domain\s*\|/.test(line));
  if (start === -1) throw new SourceFormatError(file, "has no '| Domain |' table");
  if (!/^\|\s*:?-{3,}/.test(lines[start + 1] || "")) {
    throw new SourceFormatError(file, "has a Domain table with no separator row");
  }
  const header = splitRow(lines[start]);
  for (const column of ["Domain", "Enabled", "Status"]) {
    if (!header.includes(column)) {
      throw new SourceFormatError(file, `has a Domain table with no ${column} column`);
    }
  }
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = splitRow(lines[i]);
    rows.push(Object.fromEntries(header.map((name, j) => [name, cells[j] ?? ""])));
  }
  return rows;
}

// A site counts only if it is switched on, reaches a container that exists,
// and is a real hostname rather than a catch-all.
const isServed = (row) =>
  row.Enabled === "yes" && !row.Status.includes("DANGLING") && !row.Domain.startsWith("*.");

function servedSites(text, file, declared) {
  const rows = domainTable(text, file);
  if (rows.length !== declared) {
    throw new SourceFormatError(
      file,
      `lists ${rows.length} proxy host rows but its summary line says ${declared}`,
    );
  }
  return rows.filter(isServed).length;
}

export function parseIngress(text) {
  const file = SOURCES.ingress;
  const match = normalize(text).match(/^(\d+) proxy hosts configured/m);
  if (!match) throw new SourceFormatError(file, "has no 'N proxy hosts configured' line");
  return { batcave_https_sites: servedSites(text, file, Number(match[1])) };
}

export function parseRemoteHosts(text) {
  const file = SOURCES.remoteHosts;
  const sections = normalize(text).split(/^## /m).slice(1);
  if (sections.length === 0) throw new SourceFormatError(file, "has no '## <host>' sections");

  let containers = 0;
  let sites = 0;
  for (const section of sections) {
    const host = section.slice(0, section.indexOf("\n")).trim();
    // The line is "`user@address`, N containers." Only N is captured, so the
    // address never reaches a variable, a message or the log.
    const count = section.match(/^`[^`\n]*`, (\d+) containers\.$/m);
    if (!count) throw new SourceFormatError(file, `has no 'N containers.' line for host ${host}`);
    containers += Number(count[1]);

    const ingressAt = section.search(/^### Ingress on /m);
    if (ingressAt === -1) continue;
    const ingress = section.slice(ingressAt);
    const declared = ingress.match(/^(\d+) proxy hosts\./m);
    if (!declared) {
      throw new SourceFormatError(file, `has no 'N proxy hosts.' line for host ${host}`);
    }
    sites += servedSites(ingress, file, Number(declared[1]));
  }
  return { remote_containers: containers, remote_https_sites: sites };
}

export function toIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ImplausibleValueError(`'${value}' is not a date the docs could have been updated on`);
  }
  return date.toISOString().slice(0, 10);
}

// The date of the last commit that changed the generated docs. The workflow
// checks the docs repo out with full history so this sees past HEAD.
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

export function combineStats({ topology, inventory, ingress, remote, docsUpdated }) {
  return {
    docs_updated: docsUpdated,
    batcave_containers: inventory.batcave_containers,
    homelab_containers: inventory.batcave_containers + remote.remote_containers,
    services_declared: topology.services_declared,
    compose_files: topology.compose_files,
    services_healthchecked: topology.services_healthchecked,
    services_mem_limited: topology.services_mem_limited,
    https_sites: ingress.batcave_https_sites + remote.remote_https_sites,
    hosts: topology.hosts,
  };
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
        `${key} is 0, which means a docs file parsed as empty. README left unchanged.`,
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stats.docs_updated || "")) {
    throw new ImplausibleValueError("docs_updated is not a YYYY-MM-DD date");
  }
  return stats;
}

export async function collectStats(docsDir, docsUpdated) {
  const read = async (rel) => {
    try {
      return await readFile(path.join(docsDir, rel), "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      throw new SourceMissingError(
        `${rel} is missing from ${docsDir}. Check that the docs checkout step ran ` +
          "and that HOMELAB_DOCS_DIR points at it.",
      );
    }
  };
  const [topology, inventory, ingress, remote] = await Promise.all(
    [SOURCES.topology, SOURCES.inventory, SOURCES.ingress, SOURCES.remoteHosts].map(read),
  );
  return validateStats(
    combineStats({
      topology: parseTopology(topology),
      inventory: parseInventory(inventory),
      ingress: parseIngress(ingress),
      remote: parseRemoteHosts(remote),
      docsUpdated,
    }),
  );
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
