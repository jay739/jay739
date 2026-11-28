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
const HISTORY_PATH = process.env.HISTORY_PATH || "profile/batcave-history.json";
const TIMEOUT_MS = 45_000;

// The public status page only exposes a 24-hour uptime, so the long view is
// built here: one reading per UTC day, the day's last run winning. Runs every
// six hours make each day's final reading cover roughly the 24 hours since the
// previous day's final reading, so the readings tile into back-to-back days.
export const HISTORY_DAYS = 30;
export const KEEP_DAYS = 90;

// Kuma heartbeat status codes.
export const STATUS = { DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 };

// A monitor whose newest check is older than this is shown as not checked and
// left out of every number. The public endpoint keeps returning a paused
// monitor's last 50 beats, so an empty list never signals a pause.
export const STALE_AFTER_MS = 60 * 60 * 1000;

const STATE_BY_STATUS = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

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

// Kuma stores heartbeat times in UTC as "YYYY-MM-DD HH:mm:ss.SSS".
export function parseKumaTime(time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(time || "");
  if (!m) throw new ImplausibleValueError(`'${time}' is not a heartbeat time`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// Per monitor: its state, 24-hour uptime and newest check. `now` is passed in
// so tests do not depend on the real clock.
export function parseHeartbeats(json, groups, now) {
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
        throw new ImplausibleValueError(`monitor ${m.id} has no heartbeats on the status page`);
      }
      if (typeof uptime !== "number" || !(uptime >= 0 && uptime <= 1)) {
        throw new ImplausibleValueError(`monitor ${m.id} 24h uptime is ${uptime}, expected a ratio from 0 to 1`);
      }
      const latest = list.reduce((a, b) => (String(b.time) > String(a.time) ? b : a));
      if (!(latest.status in STATE_BY_STATUS)) {
        throw new ImplausibleValueError(`monitor ${m.id} latest status is ${latest.status}`);
      }
      const stale = now.getTime() - parseKumaTime(String(latest.time)).getTime() > STALE_AFTER_MS;
      return { ...m, state: stale ? "stale" : STATE_BY_STATUS[latest.status], uptime, checkedAt: String(latest.time) };
    }),
  }));
}

export function summarize(groups, containers) {
  const monitors = groups.flatMap((g) => g.monitors);
  if (monitors.length === 0) throw new ImplausibleValueError("the status page lists no monitors");
  if (!Number.isInteger(containers) || containers <= 0) {
    throw new ImplausibleValueError(`batcave_containers is ${containers}, expected a positive whole number`);
  }
  const count = (state) => monitors.filter((m) => m.state === state).length;
  // A monitor nobody is checking has no current uptime, so it is left out.
  const checked = monitors.filter((m) => m.state !== "stale");
  if (checked.length === 0) {
    throw new ImplausibleValueError(`no monitor has been checked in the last ${STALE_AFTER_MS / 60000} minutes`);
  }
  return {
    groups,
    total: monitors.length,
    up: count("up"),
    down: count("down"),
    pending: count("pending"),
    maintenance: count("maintenance"),
    stale: count("stale"),
    mean: checked.reduce((s, m) => s + m.uptime, 0) / checked.length,
    lowest: Math.min(...checked.map((m) => m.uptime)),
    containers,
    checkedAt: checked.map((m) => m.checkedAt).sort().at(-1),
  };
}

// The UTC date a Kuma heartbeat time falls on, as YYYY-MM-DD.
export function dayOf(time) {
  return parseKumaTime(time).toISOString().slice(0, 10);
}

// Reads the stored history, refusing anything that is not a list of daily
// readings, so a damaged file stops the run instead of skewing the numbers.
export function parseHistory(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SourceFormatError("the uptime history file is not valid JSON");
  }
  if (!Array.isArray(data)) throw new SourceFormatError("the uptime history file is not a list");
  for (const [i, d] of data.entries()) {
    const ok =
      d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && typeof d.mean === "number" && d.mean >= 0 && d.mean <= 1;
    if (!ok) throw new SourceFormatError(`uptime history entry ${i} is not a { date, mean } reading`);
  }
  return data;
}

// Adds or replaces the reading for the summary's day, keeping KEEP_DAYS days.
export function recordDay(history, s) {
  const date = dayOf(s.checkedAt);
  const reading = { date, mean: s.mean, lowest: s.lowest, checked: s.total - s.stale, total: s.total };
  return [...history.filter((d) => d.date !== date), reading]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-KEEP_DAYS);
}

// The last `days` calendar days ending on `today`, with null for a day that
// has no reading. The mean covers measured days only, and says how many.
export function historyWindow(history, today, days = HISTORY_DAYS) {
  const byDate = new Map(history.map((d) => [d.date, d]));
  const end = new Date(`${today}T00:00:00Z`).getTime();
  const slots = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    slots.push({ date, mean: byDate.get(date)?.mean ?? null });
  }
  const measured = slots.filter((d) => d.mean !== null);
  const mean = measured.length ? measured.reduce((t, d) => t + d.mean, 0) / measured.length : null;
  return { days: slots, measured: measured.length, mean };
}

// Never rounds up: 99.996% shows as 99.99%, and only a perfect day shows 100%.
export function formatUptime(ratio) {
  if (ratio >= 1) return "100%";
  return `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`;
}

export function formatCheckedAt(time) {
  const d = parseKumaTime(time);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const hm = d.toISOString().slice(11, 16);
  return `${date}, ${hm} UTC`;
}

export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

export const THEMES = {
  dark: {
    background: "#0F172A", border: "#334155", label: "#F59E0B", nums: "#f8fafc", text: "#cbd5e1", muted: "#94a3b8",
    up: "#22c55e", down: "#ef4444", pending: "#f59e0b", stale: "#64748b",
  },
  light: {
    background: "#ffffff", border: "#e2e8f0", label: "#b45309", nums: "#0f172a", text: "#334155", muted: "#475569",
    up: "#15803d", down: "#b91c1c", pending: "#b45309", stale: "#94a3b8",
  },
};

const STATE_LABEL = { up: "up", down: "down", pending: "pending", maintenance: "in maintenance", stale: "not checked" };

function stateColor(c, state) {
  if (state === "up") return c.up;
  if (state === "down") return c.down;
  if (state === "stale") return c.stale;
  return c.pending;
}

export function headline(s) {
  if (s.up === s.total) return `All ${s.total} services up`;
  if (s.down > 0) return `${s.down} of ${s.total} down`;
  const rest = [
    s.pending && `${s.pending} pending`,
    s.maintenance && `${s.maintenance} in maintenance`,
    s.stale && `${s.stale} not checked`,
  ].filter(Boolean);
  return `${s.up} of ${s.total} up, ${rest.join(", ")}`;
}

// Green only when everything is up, red only when something is down, amber for
// anything in between (retrying, maintenance, not checked).
export function headlineColor(c, s) {
  if (s.up === s.total) return c.up;
  if (s.down > 0) return c.down;
  return c.pending;
}

// A day's bar: green from 99.9%, amber from 99%, red below, grey if unmeasured.
function dayColor(c, mean) {
  if (mean === null) return c.stale;
  if (mean >= 0.999) return c.up;
  if (mean >= 0.99) return c.pending;
  return c.down;
}

export function historyLabel(win) {
  if (win.mean === null) return "no days measured yet";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const span = win.measured === win.days.length ? plural(win.days.length, "day") : plural(win.measured, "measured day");
  return `${formatUptime(win.mean)} over ${span}`;
}

// A day counts as an incident when its average uptime across the checks fell
// below this: roughly a quarter of an hour with everything down, or a few hours
// with one service down.
export const INCIDENT_BELOW = 0.99;

const dayBefore = (date) => new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

// The day of the latest incident on record, or null. Kuma's uptime is a rolling
// 24 hours, so an outage still drags the next day's early readings down until the
// window moves past it. While today and yesterday both read low, the incident
// stays dated yesterday, so the counter does not drop back to zero the next day.
export function lastIncident(history, today) {
  const low = new Set(history.filter((d) => d.mean < INCIDENT_BELOW).map((d) => d.date));
  const last = [...low].sort().at(-1);
  if (!last) return null;
  return last === today && low.has(dayBefore(today)) ? dayBefore(today) : last;
}

// What the counter shows. With no incident on record it counts the days the record
// covers and marks the figure open-ended, since nothing older is known.
export function incidentCounter(history, today) {
  const last = lastIncident(history, today);
  if (last) {
    const day = history.find((d) => d.date === last);
    return { days: daysBetween(last, today), since: last, open: false, downMinutes: downtimeMinutes(day) };
  }
  return { days: daysBetween(history[0]?.date ?? today, today) + 1, since: null, open: true };
}

// Plain words, threshold included, so a first-time reader needs no definition:
// "1 day since uptime dipped below 99%", read down the figure and its two lines.
export function incidentStat(counter) {
  if (counter.open) return [`${counter.days}+`, "days with uptime", "of 99% or more"];
  return [String(counter.days), counter.days === 1 ? "day since uptime" : "days since uptime", "dipped below 99%"];
}

// Roughly how long the worst-hit service was down that day: its 24-hour uptime is
// the share of the day it was up. Older records without a per-service reading fall
// back to the day's average.
export function downtimeMinutes(day) {
  const ratio = typeof day?.lowest === "number" ? day.lowest : day?.mean;
  return typeof ratio === "number" ? Math.round((1 - ratio) * 24 * 60) : null;
}

export function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 30) / 2;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// The line under the 30-day row, or null when no dip is on record.
export function dipLine(counter) {
  if (!counter || counter.open || counter.downMinutes == null) return null;
  const day = new Date(`${counter.since}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Last dip on ${day}: the worst-hit service was down about ${formatDuration(counter.downMinutes)}`;
}

export function renderCard(s, theme = "dark", win = null, incident = null) {
  const c = THEMES[theme];
  const dip = win ? dipLine(incident) : null;
  const W = 600, H = win ? (dip ? 284 : 256) : 200;
  const tone = headlineColor(c, s);
  const head = escapeXml(headline(s));
  const stats = [
    [formatUptime(s.mean), "24h uptime"],
    [formatUptime(s.lowest), "lowest service"],
    [String(s.containers), "containers"],
    ...(incident ? [incidentStat(incident)] : []),
  ];
  const step = stats.length > 3 ? 142 : 190;
  const statSvg = stats
    .map(([n, label, more], i) => {
      const x = 30 + i * step;
      const second = more ? `<text x="${x}" y="133" class="lbl">${escapeXml(more)}</text>` : "";
      return `<text x="${x}" y="98" class="num">${escapeXml(n)}</text><text x="${x}" y="118" class="lbl">${escapeXml(label)}</text>${second}`;
    })
    .join("");
  let gx = 30;
  const groupSvg = s.groups
    .map((g) => {
      const label = `${escapeXml(g.name)} ${g.monitors.filter((m) => m.state === "up").length}/${g.monitors.length}`;
      let out = `<text x="${gx}" y="156" class="grp">${label}</text>`;
      g.monitors.forEach((m, i) => {
        const title = `${escapeXml(m.name)}: ${STATE_LABEL[m.state]}`;
        out += `<rect x="${gx + i * 14}" y="166" width="10" height="10" rx="2" fill="${stateColor(c, m.state)}"><title>${title}</title></rect>`;
      });
      gx += Math.max(label.length * 7.4, g.monitors.length * 14) + 34;
      return out;
    })
    .join("");
  const historySvg = win
    ? `<text x="30" y="206" class="lbl">LAST ${win.days.length} DAYS</text>` +
      `<text x="${W - 30}" y="206" text-anchor="end" class="grp">${escapeXml(historyLabel(win))}</text>` +
      win.days
        .map((d, i) => {
          const day = d.mean === null ? "not measured" : formatUptime(d.mean);
          return `<rect x="${30 + i * 18}" y="214" width="14" height="16" rx="3" fill="${dayColor(c, d.mean)}"${d.mean === null ? ' fill-opacity="0.45"' : ""}><title>${d.date}: ${day}</title></rect>`;
        })
        .join("")
    : "";
  const historyAria = win && win.mean !== null ? `, ${historyLabel(win)}` : "";
  const dipAria = dip ? `, ${dip.charAt(0).toLowerCase()}${dip.slice(1)}` : "";
  const incidentAria = incident ? `, ${incidentStat(incident).join(" ")}${dipAria}` : "";
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Batcave: ${head}, ${formatUptime(s.mean)} 24-hour uptime from Uptime Kuma${escapeXml(historyAria)}, ${s.containers} containers from the homelab docs${incidentAria}">
  <style>
    text { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .title { fill: ${c.label}; font-size: 15px; font-weight: 700; letter-spacing: 0.5px; }
    .pill { fill: ${tone}; font-size: 13px; font-weight: 600; }
    .num { fill: ${c.nums}; font-size: 28px; font-weight: 700; }
    .lbl { fill: ${c.muted}; font-size: 12px; }
    .grp { fill: ${c.text}; font-size: 12px; }
    .foot { fill: ${c.muted}; font-size: 10.5px; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.background}" stroke="${c.border}" />
  <text x="30" y="40" class="title">BATCAVE, RIGHT NOW</text>
  <circle cx="${W - 196}" cy="35" r="5" fill="${tone}" />
  <text x="${W - 184}" y="40" class="pill">${head}</text>
  ${statSvg}
  ${groupSvg}
  ${historySvg}
  ${dip ? `<text x="30" y="253" class="grp">${escapeXml(dip)}</text>` : ""}
  <text x="${W - 30}" y="${H - 12}" text-anchor="end" class="foot">Uptime Kuma checks · containers from homelab docs · ${escapeXml(formatCheckedAt(s.checkedAt))}</text>
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

async function readHistory(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return []; // the first run starts the record
    throw err;
  }
  return parseHistory(text);
}

async function main() {
  const now = process.env.CARD_NOW ? new Date(process.env.CARD_NOW) : new Date();
  const page = await getJson(`${STATUS_BASE}/api/status-page/${SLUG}`);
  const beats = await getJson(`${STATUS_BASE}/api/status-page/heartbeat/${SLUG}`);
  const groups = parseHeartbeats(beats, parseStatusPage(page), now);
  const summary = summarize(groups, await readContainers(STATS_PATH));
  const history = recordDay(await readHistory(HISTORY_PATH), summary);
  const today = dayOf(summary.checkedAt);
  const win = historyWindow(history, today);
  const incident = incidentCounter(history, today);
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 1)}\n`, "utf8");
  for (const [file, theme] of [[OUT_PATH, "dark"], [OUT_PATH_LIGHT, "light"]]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, renderCard(summary, theme, win, incident), "utf8");
  }
  console.log(
    `Batcave card: ${headline(summary)}, mean ${formatUptime(summary.mean)}, lowest ${formatUptime(summary.lowest)}, ` +
      `${summary.containers} containers, checked ${summary.checkedAt}; ${historyLabel(win)}; ${incidentStat(incident).join(" ")}${dipLine(incident) ? `; ${dipLine(incident)}` : ""}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof CardError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
