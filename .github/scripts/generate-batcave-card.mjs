// Renders the "Batcave, right now" card (a dark and a light SVG) from the
// public Uptime Kuma status page at status.jay739.dev/status/batcave, plus the
// container count this repo already publishes in profile/homelab-stats.json.
//
// Only public data is read: the status page's config and heartbeat endpoints
// need no credentials, and they expose monitor names and up/down history but
// no hosts, URLs or addresses. The card shows measured numbers only. If the
// status page cannot be read, or what comes back is not plausible, the run
// fails and the previous card stays in place rather than showing a guess.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATUS_BASE = process.env.STATUS_BASE || "https://status.jay739.dev";
const SLUG = process.env.STATUS_SLUG || "batcave";
const STATS_PATH = process.env.STATS_PATH || "profile/homelab-stats.json";
const OUT_PATH = process.env.OUT_PATH || "profile/batcave-card.svg";
const OUT_PATH_LIGHT = process.env.OUT_PATH_LIGHT || "profile/batcave-card-light.svg";
const TIMEOUT_MS = 45_000;

// Kuma heartbeat status codes.
export const STATUS = { DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 };

export class CardError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The status page or the stats file could not be read at all. */
export class SourceUnavailableError extends CardError {}

/** A response arrived but is not the shape this script expects. */
export class SourceFormatError extends CardError {}

/** The data parsed, but the numbers cannot be right. */
export class ImplausibleValueError extends CardError {}

// Monitors in group order, as the status page lists them. Group names are
// trimmed because Kuma keeps whatever whitespace was typed into the editor.
export function parseStatusPage(json) {
  const groups = json?.publicGroupList;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new SourceFormatError("status page has no publicGroupList; check that the page is published");
  }
  return groups.map((g, i) => {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.monitorList)) {
      throw new SourceFormatError(`status page group ${i} has no name or monitorList`);
    }
    return {
      name: g.name.trim(),
      monitors: g.monitorList.map((m, j) => {
        if (!Number.isInteger(m?.id) || typeof m?.name !== "string") {
          throw new SourceFormatError(`status page group ${i} monitor ${j} has no id or name`);
        }
        return { id: m.id, name: m.name.trim() };
      }),
    };
  });
}

// Per monitor: the latest status and the 24-hour uptime ratio.
export function parseHeartbeats(json, groups) {
  const beats = json?.heartbeatList;
  const uptimes = json?.uptimeList;
  if (!beats || typeof beats !== "object" || !uptimes || typeof uptimes !== "object") {
    throw new SourceFormatError("heartbeat response has no heartbeatList or uptimeList");
  }
  return groups.map((g) => ({
    name: g.name,
    monitors: g.monitors.map((m) => {
      const list = beats[String(m.id)];
      const uptime = uptimes[`${m.id}_24`];
      if (!Array.isArray(list) || list.length === 0) {
        throw new ImplausibleValueError(`monitor ${m.id} has no heartbeats; it may be paused`);
      }
      if (typeof uptime !== "number" || !(uptime >= 0 && uptime <= 1)) {
        throw new ImplausibleValueError(`monitor ${m.id} 24h uptime is ${uptime}, expected a ratio from 0 to 1`);
      }
      const latest = list.reduce((a, b) => (String(b.time) > String(a.time) ? b : a));
      if (!Object.values(STATUS).includes(latest.status)) {
        throw new ImplausibleValueError(`monitor ${m.id} latest status is ${latest.status}`);
      }
      return { ...m, status: latest.status, uptime, checkedAt: String(latest.time) };
    }),
  }));
}

export function summarize(groups, containers) {
  const monitors = groups.flatMap((g) => g.monitors);
  if (monitors.length === 0) throw new ImplausibleValueError("the status page lists no monitors");
  if (!Number.isInteger(containers) || containers <= 0) {
    throw new ImplausibleValueError(`batcave_containers is ${containers}, expected a positive whole number`);
  }
  const up = monitors.filter((m) => m.status === STATUS.UP).length;
  const down = monitors.filter((m) => m.status === STATUS.DOWN).length;
  const mean = monitors.reduce((s, m) => s + m.uptime, 0) / monitors.length;
  const lowest = Math.min(...monitors.map((m) => m.uptime));
  const checkedAt = monitors.map((m) => m.checkedAt).sort().at(-1);
  return { groups, total: monitors.length, up, down, mean, lowest, containers, checkedAt };
}

// Never rounds up: 99.996% shows as 99.99%, and only a perfect day shows 100%.
export function formatUptime(ratio) {
  if (ratio >= 1) return "100%";
  return `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`;
}

// Kuma stores heartbeat times in UTC as "YYYY-MM-DD HH:mm:ss.SSS".
export function formatCheckedAt(time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(time || "");
  if (!m) throw new ImplausibleValueError(`'${time}' is not a heartbeat time`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${date}, ${m[4]}:${m[5]} UTC`;
}

export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

export const THEMES = {
  dark: {
    background: "#0F172A", border: "#334155", label: "#F59E0B", nums: "#f8fafc", text: "#cbd5e1", muted: "#94a3b8",
    up: "#22c55e", down: "#ef4444", pending: "#f59e0b",
  },
  light: {
    background: "#ffffff", border: "#e2e8f0", label: "#b45309", nums: "#0f172a", text: "#334155", muted: "#475569",
    up: "#15803d", down: "#b91c1c", pending: "#b45309",
  },
};

function statusColor(c, status) {
  if (status === STATUS.UP) return c.up;
  if (status === STATUS.DOWN) return c.down;
  return c.pending;
}

export function headline(s) {
  if (s.up === s.total) return `All ${s.total} services up`;
  if (s.down > 0) return `${s.down} of ${s.total} down`;
  return `${s.up} of ${s.total} up, ${s.total - s.up} pending`;
}

export function renderCard(s, theme = "dark") {
  const c = THEMES[theme];
  const W = 600, H = 200;
  const ok = s.up === s.total;
  const head = escapeXml(headline(s));
  const stats = [
    [formatUptime(s.mean), "24h uptime"],
    [formatUptime(s.lowest), "lowest service"],
    [String(s.containers), "containers"],
  ];
  const statSvg = stats
    .map(([n, label], i) => {
      const x = 30 + i * 190;
      return `<text x="${x}" y="98" class="num">${escapeXml(n)}</text><text x="${x}" y="118" class="lbl">${escapeXml(label)}</text>`;
    })
    .join("");
  let gx = 30;
  const groupSvg = s.groups
    .map((g) => {
      const label = `${escapeXml(g.name)} ${g.monitors.filter((m) => m.status === STATUS.UP).length}/${g.monitors.length}`;
      let out = `<text x="${gx}" y="156" class="grp">${label}</text>`;
      g.monitors.forEach((m, i) => {
        const title = `${escapeXml(m.name)}: ${m.status === STATUS.UP ? "up" : m.status === STATUS.DOWN ? "down" : "pending"}`;
        out += `<rect x="${gx + i * 14}" y="166" width="10" height="10" rx="2" fill="${statusColor(c, m.status)}"><title>${title}</title></rect>`;
      });
      gx += Math.max(label.length * 7.4, g.monitors.length * 14) + 34;
      return out;
    })
    .join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Batcave right now: ${head}, ${formatUptime(s.mean)} 24-hour uptime, ${s.containers} containers">
  <style>
    text { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .title { fill: ${c.label}; font-size: 15px; font-weight: 700; letter-spacing: 0.5px; }
    .pill { fill: ${ok ? c.up : c.down}; font-size: 13px; font-weight: 600; }
    .num { fill: ${c.nums}; font-size: 28px; font-weight: 700; }
    .lbl { fill: ${c.muted}; font-size: 12px; }
    .grp { fill: ${c.text}; font-size: 12px; }
    .foot { fill: ${c.muted}; font-size: 10.5px; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.background}" stroke="${c.border}" />
  <text x="30" y="40" class="title">BATCAVE, RIGHT NOW</text>
  <circle cx="${W - 196}" cy="35" r="5" fill="${ok ? c.up : c.down}" />
  <text x="${W - 184}" y="40" class="pill">${head}</text>
  ${statSvg}
  ${groupSvg}
  <text x="${W - 30}" y="188" text-anchor="end" class="foot">Measured by Uptime Kuma · ${escapeXml(formatCheckedAt(s.checkedAt))}</text>
</svg>
`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch (err) {
    throw new SourceUnavailableError(`could not reach ${url} (${err.name}). Check that the status page is up.`);
  }
  if (!res.ok) throw new SourceUnavailableError(`${url} answered HTTP ${res.status}. Check that the page is published.`);
  try {
    return await res.json();
  } catch {
    throw new SourceFormatError(`${url} did not return JSON`);
  }
}

async function readContainers(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new SourceUnavailableError(`${file} is missing; the homelab stats workflow writes it`);
  }
  try {
    return JSON.parse(text).batcave_containers;
  } catch {
    throw new SourceFormatError(`${file} is not valid JSON`);
  }
}

async function main() {
  const page = await getJson(`${STATUS_BASE}/api/status-page/${SLUG}`);
  const beats = await getJson(`${STATUS_BASE}/api/status-page/heartbeat/${SLUG}`);
  const groups = parseHeartbeats(beats, parseStatusPage(page));
  const summary = summarize(groups, await readContainers(STATS_PATH));
  for (const [file, theme] of [[OUT_PATH, "dark"], [OUT_PATH_LIGHT, "light"]]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, renderCard(summary, theme), "utf8");
  }
  console.log(
    `Batcave card: ${headline(summary)}, mean ${formatUptime(summary.mean)}, lowest ${formatUptime(summary.lowest)}, ` +
      `${summary.containers} containers, checked ${summary.checkedAt}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof CardError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
