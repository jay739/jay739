// Writes the "Try the live demos" line into README.md between the DEMOS
// markers, from the public Uptime Kuma status page status.jay739.dev/status/demos.
// Kuma checks each demo's backend privately; the page exposes only whether each
// one is up. This reuses the Batcave card's parsing, so states mean the same
// thing in both places, including "not checked" for a monitor nobody is running.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CardError, parseStatusPage, parseHeartbeats } from "./generate-batcave-card.mjs";

const STATUS_BASE = process.env.STATUS_BASE || "https://status.jay739.dev";
const SLUG = process.env.DEMOS_SLUG || "demos";
const README_PATH = process.env.README_PATH || "README.md";
const DEMOS_PAGE = "https://jay739.dev/ai-tools";

// Each link opens its demo straight away (the page reads ?tool= on load and
// never starts a job from it). Keys are the monitor names on the Kuma page, so
// a monitor that is renamed or added links to the AI Tools page itself.
export const DEMO_LINKS = {
  "PDF to Podcast": `${DEMOS_PAGE}?tool=podcast-generator`,
  "RAG Chatbot": `${DEMOS_PAGE}?tool=chatbot`,
  "Image Generator": `${DEMOS_PAGE}?tool=image-generator`,
};

// Object.hasOwn, so a monitor named after an Object property such as
// "constructor" gets the page link, not a function.
export function demoLink(name) {
  return Object.hasOwn(DEMO_LINKS, name) ? DEMO_LINKS[name] : DEMOS_PAGE;
}

const TIMEOUT_MS = 45_000;

export const START = "<!-- DEMOS:START -->";
export const END = "<!-- DEMOS:END -->";

/** README.md has no DEMOS block. */
export class MarkerError extends CardError {}

/** The demos status page could not be read. */
export class DemosUnavailableError extends CardError {}

const STATE_TEXT = {
  up: ["🟢", "up"],
  down: ["🔴", "down right now"],
  pending: ["🟡", "retrying"],
  maintenance: ["🟡", "in maintenance"],
  stale: ["⚪", "not checked"],
};

// Monitor names come from Kuma, so Markdown control characters are escaped.
export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_[\]()<>#|]/g, (c) => `\\${c}`);
}

export function renderLine(groups) {
  const monitors = groups.flatMap((g) => g.monitors);
  if (monitors.length === 0) throw new DemosUnavailableError("the demos status page lists no monitors");
  const parts = monitors.map((m) => {
    const [dot, word] = STATE_TEXT[m.state];
    return `${dot} [${escapeMarkdown(m.name)}](${demoLink(m.name)}) ${word}`;
  });
  return `**Try the live demos:** ${parts.join(" · ")}`;
}

// The line sits on its own line between the markers: a line that starts with
// an HTML comment is passed through as raw HTML, so its Markdown would not render.
export function replaceBlock(readme, line) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new MarkerError(`README has no ${START} ... ${END} block. Add both markers where the line should go.`);
  }
  return `${readme.slice(0, start + START.length)}\n${line}\n${readme.slice(end)}`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch (err) {
    throw new DemosUnavailableError(`could not reach ${url} (${err.name}). Check that the demos status page exists and is published.`);
  }
  if (!res.ok) throw new DemosUnavailableError(`${url} answered HTTP ${res.status}. Check that the demos status page is published.`);
  return res.json();
}

async function main() {
  const now = process.env.CARD_NOW ? new Date(process.env.CARD_NOW) : new Date();
  const page = await getJson(`${STATUS_BASE}/api/status-page/${SLUG}`);
  const beats = await getJson(`${STATUS_BASE}/api/status-page/heartbeat/${SLUG}`);
  const groups = parseHeartbeats(beats, parseStatusPage(page), now);
  const readme = await readFile(README_PATH, "utf8");
  const updated = replaceBlock(readme, renderLine(groups));
  if (updated !== readme) await writeFile(README_PATH, updated, "utf8");
  const states = groups.flatMap((g) => g.monitors).map((m) => `${m.name}=${m.state}`);
  console.log(`Demos: ${states.join(", ")}; README ${updated === readme ? "unchanged" : "updated"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof CardError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
