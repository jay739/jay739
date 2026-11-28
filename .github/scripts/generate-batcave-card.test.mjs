// Run with: node --test .github/scripts/generate-batcave-card.test.mjs
//
// Every fixture is invented, so nothing here describes the real status page.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CardError,
  SourceFormatError,
  ImplausibleValueError,
  STALE_AFTER_MS,
  THEMES,
  parseStatusPage,
  parseHeartbeats,
  parseKumaTime,
  summarize,
  formatUptime,
  formatCheckedAt,
  escapeXml,
  headline,
  headlineColor,
  renderCard,
  KEEP_DAYS,
  dayOf,
  parseHistory,
  recordDay,
  historyWindow,
  historyLabel,
  incidentCounter,
  incidentStat,
  lastIncident,
  dipLine,
  downtimeMinutes,
  formatDuration,
  StaleSourceError,
  OUTAGES_STALE_AFTER_MS,
  parseOutages,
  dipOutage,
  DIP_LINE_CHARS,
  wrapLine,
} from "./generate-batcave-card.mjs";

const NOW = new Date("2026-01-02T03:10:00Z");

const PAGE = {
  publicGroupList: [
    { name: "Alpha\n", monitorList: [{ id: 1, name: " One " }] },
    { name: "Beta", monitorList: [{ id: 2, name: "Two" }, { id: 3, name: "Three" }] },
  ],
};

const beat = (status, time) => ({ status, time, msg: "", ping: 10 });
const BEATS = {
  heartbeatList: {
    1: [beat(1, "2026-01-02 03:00:00.000"), beat(1, "2026-01-02 03:01:00.000")],
    2: [beat(0, "2026-01-02 03:00:30.000"), beat(1, "2026-01-02 03:02:00.000")],
    3: [beat(1, "2026-01-02 03:00:00.000")],
  },
  uptimeList: { "1_24": 1, "2_24": 0.995, "3_24": 0.99996 },
};

const throwsClean = (fn, type) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof type, `expected ${type.name}, got ${err.name}: ${err.message}`);
    assert.ok(err instanceof CardError);
    return true;
  });

const withLatest = (id, status, time) => {
  const b = structuredClone(BEATS);
  b.heartbeatList[id] = [beat(status, time)];
  return b;
};

test("parseStatusPage trims group and monitor names and keeps order", () => {
  const groups = parseStatusPage(PAGE);
  assert.deepEqual(groups.map((g) => g.name), ["Alpha", "Beta"]);
  assert.deepEqual(groups[0].monitors, [{ id: 1, name: "One" }]);
});

test("parseStatusPage rejects an unpublished or malformed page", () => {
  throwsClean(() => parseStatusPage({}), SourceFormatError);
  throwsClean(() => parseStatusPage({ publicGroupList: [] }), SourceFormatError);
  throwsClean(() => parseStatusPage({ publicGroupList: [{ name: "A", monitorList: [{ name: "x" }] }] }), SourceFormatError);
});

test("parseHeartbeats takes each monitor's latest beat by time, not list order", () => {
  const shuffled = structuredClone(BEATS);
  shuffled.heartbeatList[2].reverse();
  const groups = parseHeartbeats(shuffled, parseStatusPage(PAGE), NOW);
  assert.equal(groups[1].monitors[0].state, "up");
  assert.equal(groups[1].monitors[0].checkedAt, "2026-01-02 03:02:00.000");
});

test("parseHeartbeats refuses missing beats and impossible uptimes", () => {
  const groups = parseStatusPage(PAGE);
  const noBeats = structuredClone(BEATS);
  noBeats.heartbeatList[3] = [];
  throwsClean(() => parseHeartbeats(noBeats, groups, NOW), ImplausibleValueError);
  const badUptime = structuredClone(BEATS);
  badUptime.uptimeList["2_24"] = 1.5;
  throwsClean(() => parseHeartbeats(badUptime, groups, NOW), ImplausibleValueError);
  throwsClean(() => parseHeartbeats({ heartbeatList: {} }, groups, NOW), SourceFormatError);
});

test("a monitor with no check inside the window is not checked, and leaves the numbers", () => {
  // Monitor 2 last reported long ago with a perfect day, as a paused monitor does.
  const old = new Date(NOW.getTime() - STALE_AFTER_MS - 60_000).toISOString().replace("T", " ").replace("Z", "");
  const b = withLatest(2, 1, old);
  b.uptimeList["2_24"] = 1;
  b.uptimeList["3_24"] = 0.9;
  const s = summarize(parseHeartbeats(b, parseStatusPage(PAGE), NOW), 7);
  assert.equal(s.stale, 1);
  assert.equal(s.up, 2);
  assert.equal(headline(s), "2 of 3 up, 1 not checked");
  assert.equal(s.mean, (1 + 0.9) / 2);
  assert.equal(s.lowest, 0.9);
  assert.equal(s.checkedAt, "2026-01-02 03:01:00.000");
  assert.ok(renderCard(s, "dark").includes("Two: not checked"));
});

test("a page where nothing was checked recently is refused", () => {
  const later = new Date(NOW.getTime() + STALE_AFTER_MS + 5 * 60_000);
  throwsClean(() => summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), later), 7), ImplausibleValueError);
});

test("pending and maintenance are amber with their own words; only down is red", () => {
  const c = THEMES.dark;
  const pending = summarize(parseHeartbeats(withLatest(3, 2, "2026-01-02 03:05:00.000"), parseStatusPage(PAGE), NOW), 7);
  assert.equal(headline(pending), "2 of 3 up, 1 pending");
  assert.equal(headlineColor(c, pending), c.pending);
  const maint = summarize(parseHeartbeats(withLatest(3, 3, "2026-01-02 03:05:00.000"), parseStatusPage(PAGE), NOW), 7);
  assert.equal(headline(maint), "2 of 3 up, 1 in maintenance");
  assert.ok(renderCard(maint, "light").includes("Three: in maintenance"));
  const down = summarize(parseHeartbeats(withLatest(3, 0, "2026-01-02 03:05:00.000"), parseStatusPage(PAGE), NOW), 7);
  assert.equal(headline(down), "1 of 3 down");
  assert.equal(headlineColor(c, down), c.down);
});

test("summarize counts states and finds the mean, lowest and newest check", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  assert.equal(s.total, 3);
  assert.equal(s.up, 3);
  assert.equal(headline(s), "All 3 services up");
  assert.equal(s.lowest, 0.995);
  assert.ok(Math.abs(s.mean - (1 + 0.995 + 0.99996) / 3) < 1e-12);
  assert.equal(s.checkedAt, "2026-01-02 03:02:00.000");
});

test("summarize refuses a missing container count", () => {
  const groups = parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW);
  throwsClean(() => summarize(groups, undefined), ImplausibleValueError);
  throwsClean(() => summarize(groups, 0), ImplausibleValueError);
});

test("formatUptime never rounds up to a better number", () => {
  assert.equal(formatUptime(1), "100%");
  assert.equal(formatUptime(0.99996), "99.99%");
  assert.equal(formatUptime(0.9993), "99.93%");
  assert.equal(formatUptime(0.5), "50.00%");
});

test("Kuma times are read as UTC", () => {
  assert.equal(parseKumaTime("2026-11-26 02:46:39.876").toISOString(), "2026-11-26T02:46:39.000Z");
  assert.equal(formatCheckedAt("2026-11-26 02:46:39.876"), "Nov 26, 2026, 02:46 UTC");
  throwsClean(() => formatCheckedAt("yesterday"), ImplausibleValueError);
});

test("renderCard escapes names, names its sources and shows a down service", () => {
  const page = { publicGroupList: [{ name: "A&B", monitorList: [{ id: 1, name: "<x>" }] }] };
  const beats = { heartbeatList: { 1: [beat(0, "2026-01-02 03:00:00.000")] }, uptimeList: { "1_24": 0.9 } };
  const svg = renderCard(summarize(parseHeartbeats(beats, parseStatusPage(page), NOW), 5), "light");
  assert.ok(svg.includes("A&amp;B"));
  assert.ok(svg.includes("&lt;x&gt;: down"));
  assert.ok(!svg.includes("<x>"));
  assert.ok(svg.includes("1 of 1 down"));
  assert.ok(svg.includes("containers from homelab docs"));
  assert.ok(svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"));
});

test("renderCard output is identical for identical input", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  assert.equal(renderCard(s, "dark"), renderCard(s, "dark"));
  assert.notEqual(renderCard(s, "dark"), renderCard(s, "light"));
  assert.equal(escapeXml(`"'`), "&quot;&apos;");
});

const reading = (checkedAt, mean, extra = {}) => ({ checkedAt, mean, lowest: mean, total: 3, stale: 0, ...extra });

test("recordDay keeps one reading per UTC day, the latest run winning", () => {
  let h = recordDay([], reading("2026-01-02 06:45:00.000", 0.99));
  h = recordDay(h, reading("2026-01-02 18:45:00.000", 0.999));
  h = recordDay(h, reading("2026-01-01 18:45:00.000", 1));
  assert.deepEqual(h.map((d) => [d.date, d.mean]), [["2026-01-01", 1], ["2026-01-02", 0.999]]);
  assert.equal(h[1].checked, 3);
  assert.equal(dayOf("2026-01-02 23:59:59.999"), "2026-01-02");
});

test("recordDay keeps only the newest KEEP_DAYS days", () => {
  let h = [];
  for (let i = 0; i < KEEP_DAYS + 5; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    h = recordDay(h, reading(`${d} 12:00:00.000`, 1));
  }
  assert.equal(h.length, KEEP_DAYS);
  assert.equal(h[0].date, new Date(Date.UTC(2026, 0, 6)).toISOString().slice(0, 10));
});

test("historyWindow shows unmeasured days as gaps and averages measured ones only", () => {
  const h = [
    { date: "2026-01-28", mean: 0.99 },
    { date: "2026-01-30", mean: 1 },
    { date: "2025-12-01", mean: 0.5 },
  ];
  const w = historyWindow(h, "2026-01-30", 3);
  assert.deepEqual(w.days, [
    { date: "2026-01-28", mean: 0.99 },
    { date: "2026-01-29", mean: null },
    { date: "2026-01-30", mean: 1 },
  ]);
  assert.equal(w.measured, 2);
  assert.equal(w.mean, (0.99 + 1) / 2);
  assert.equal(historyLabel(w), "99.50% over 2 measured days");
  const full = historyWindow([{ date: "2026-01-30", mean: 0.9996 }], "2026-01-30", 1);
  assert.equal(historyLabel(full), "99.96% over 1 day");
  assert.equal(historyLabel(historyWindow([], "2026-01-30", 2)), "no days measured yet");
});

test("parseHistory refuses a damaged file instead of skewing the record", () => {
  assert.deepEqual(parseHistory("[]"), []);
  throwsClean(() => parseHistory("{oops"), SourceFormatError);
  throwsClean(() => parseHistory('{"date":"2026-01-01"}'), SourceFormatError);
  throwsClean(() => parseHistory('[{"date":"2026-01-01","mean":1.5}]'), SourceFormatError);
  throwsClean(() => parseHistory('[{"date":"Jan 1","mean":1}]'), SourceFormatError);
});

test("an incident is a day under 99%, and a reading that only carries yesterday's outage keeps yesterday's date", () => {
  const h = [
    { date: "2026-01-01", mean: 0.95 },
    { date: "2026-01-02", mean: 1 },
    { date: "2026-01-05", mean: 0.98 },
    { date: "2026-01-06", mean: 0.985 },
  ];
  assert.equal(lastIncident(h, "2026-01-06"), "2026-01-05");
  assert.equal(lastIncident(h.slice(0, 3), "2026-01-05"), "2026-01-05");
  assert.equal(lastIncident(h, "2026-01-09"), "2026-01-06");
  assert.equal(lastIncident([{ date: "2026-01-01", mean: 0.99 }], "2026-01-02"), null);
  assert.deepEqual(incidentCounter(h, "2026-01-09"), { days: 3, since: "2026-01-06", open: false, downMinutes: 22 });
  assert.deepEqual(incidentCounter(h, "2026-01-06"), { days: 1, since: "2026-01-05", open: false, downMinutes: 29 });
  const clean = [{ date: "2026-01-01", mean: 1 }, { date: "2026-01-04", mean: 0.999 }];
  assert.deepEqual(incidentCounter(clean, "2026-01-04"), { days: 4, since: null, open: true });
  assert.deepEqual(incidentStat({ days: 1, open: false }), ["1", "day since uptime", "dipped below 99%"]);
  assert.deepEqual(incidentStat({ days: 0, open: false }), ["0", "days since uptime", "dipped below 99%"]);
  assert.deepEqual(incidentStat({ days: 4, open: true }), ["4+", "days with uptime", "of 99% or more"]);
});

test("renderCard adds the incident counter as a fourth figure only when given one", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  const svg = renderCard(s, "dark", null, { days: 12, since: "2026-01-01", open: false });
  assert.ok(svg.includes('class="num">12</text>'));
  assert.ok(svg.includes(">days since uptime<") && svg.includes(">dipped below 99%<"));
  assert.match(svg, /aria-label="[^"]*, 12 days since uptime dipped below 99%">/);
  assert.ok(!renderCard(s, "dark").includes("dipped below"));
});

test("the last dip's downtime comes from its worst-hit service and reads in plain words", () => {
  assert.equal(downtimeMinutes({ mean: 0.9236, lowest: 0.8751 }), 180);
  assert.equal(downtimeMinutes({ mean: 0.985 }), 22);
  assert.equal(downtimeMinutes(undefined), null);
  assert.equal(formatDuration(180), "3 hours");
  assert.equal(formatDuration(75), "1.5 hours");
  assert.equal(formatDuration(60), "1 hour");
  assert.equal(formatDuration(14), "14 minutes");
  assert.equal(formatDuration(1), "1 minute");
  assert.equal(
    dipLine({ days: 2, since: "2026-11-26", open: false, downMinutes: 180 }),
    "Last dip on Nov 26: the worst-hit service was down about 3 hours",
  );
  assert.equal(dipLine({ days: 90, since: null, open: true }), null);
});

test("renderCard adds the last dip under the 30-day row, and grows only then", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  const w = historyWindow(recordDay([], s), dayOf(s.checkedAt));
  const dipped = renderCard(s, "dark", w, { days: 2, since: "2026-11-26", open: false, downMinutes: 180 });
  assert.ok(dipped.includes('height="284"'));
  assert.ok(dipped.includes(">Last dip on Nov 26: the worst-hit service was down about 3 hours<"));
  assert.match(dipped, /aria-label="[^"]*, last dip on Nov 26: the worst-hit service was down about 3 hours">/);
  const clean = renderCard(s, "dark", w, { days: 40, since: null, open: true });
  assert.ok(clean.includes('height="256"') && !clean.includes("Last dip"));
});

const OUTAGE_FILE = {
  generated_at: "2026-01-09T12:00:00Z",
  page: "batcave",
  outages: [
    { start: "2026-01-08T22:30:00Z", end: null, monitors_down: 2, monitors_total: 9 },
    { start: "2026-01-06T09:15:40Z", end: "2026-01-06T11:45:10Z", monitors_down: 6, monitors_total: 9 },
    { start: "2026-01-06T04:00:00Z", end: "2026-01-06T04:20:00Z", monitors_down: 9, monitors_total: 9 },
    { start: "2026-01-03T23:10:00Z", end: "2026-01-04T00:40:00Z", monitors_down: 1, monitors_total: 9 },
  ],
};
const FILE_NOW = new Date("2026-01-09T12:30:00Z");

test("parseOutages reads each window, keeping a null end as still down", () => {
  const o = parseOutages(OUTAGE_FILE, FILE_NOW);
  assert.equal(o.generatedAt, Date.parse("2026-01-09T12:00:00Z"));
  assert.equal(o.windows.length, 4);
  assert.deepEqual(o.windows[1], {
    start: Date.parse("2026-01-06T09:15:40Z"),
    end: Date.parse("2026-01-06T11:45:10Z"),
    down: 6,
    total: 9,
  });
  assert.equal(o.windows[0].end, null);
});

test("parseOutages refuses another page, a stale file, bad times and impossible counts", () => {
  const withOutage = (patch) => ({ ...OUTAGE_FILE, outages: [{ ...OUTAGE_FILE.outages[1], ...patch }] });
  const later = new Date(Date.parse(OUTAGE_FILE.generated_at) + OUTAGES_STALE_AFTER_MS + 1000);
  assert.throws(() => parseOutages({ ...OUTAGE_FILE, page: "other" }, FILE_NOW), SourceFormatError);
  assert.throws(() => parseOutages(OUTAGE_FILE, later), StaleSourceError);
  assert.throws(() => parseOutages({ ...OUTAGE_FILE, outages: {} }, FILE_NOW), SourceFormatError);
  assert.throws(() => parseOutages(withOutage({ start: "2026-01-06 09:15:40" }), FILE_NOW), SourceFormatError);
  assert.throws(() => parseOutages(withOutage({ end: undefined }), FILE_NOW), SourceFormatError);
  assert.throws(() => parseOutages(withOutage({ monitors_down: 0 }), FILE_NOW), ImplausibleValueError);
  assert.throws(() => parseOutages(withOutage({ monitors_down: 10 }), FILE_NOW), ImplausibleValueError);
  assert.throws(() => parseOutages(withOutage({ end: "2026-01-06T09:00:00Z" }), FILE_NOW), ImplausibleValueError);
  assert.ok(new StaleSourceError("x") instanceof CardError);
});

test("dipOutage takes the longest outage overlapping the dip's UTC day", () => {
  const o = parseOutages(OUTAGE_FILE, FILE_NOW);
  assert.deepEqual(dipOutage(o, "2026-01-06"), {
    start: Date.parse("2026-01-06T09:15:40Z"),
    end: Date.parse("2026-01-06T11:45:10Z"),
    down: 6,
    total: 9,
    minutes: 150,
    count: 2,
  });
  // One outage across midnight belongs to both days.
  assert.equal(dipOutage(o, "2026-01-03").minutes, 90);
  assert.equal(dipOutage(o, "2026-01-04").count, 1);
  // An ongoing outage is measured up to when the file was written.
  assert.equal(dipOutage(o, "2026-01-08").end, null);
  assert.equal(dipOutage(o, "2026-01-09").minutes, 810);
  assert.equal(dipOutage(o, "2026-01-05"), null);
  assert.equal(dipOutage(null, "2026-01-06"), null);
});

test("dipLine gives the outage's own times, dating both ends when it crosses midnight", () => {
  const o = parseOutages(OUTAGE_FILE, FILE_NOW);
  const line = (day) => dipLine({ days: 1, since: day, open: false, downMinutes: 999, outage: dipOutage(o, day) });
  assert.equal(line("2026-01-06"), "Last dip on Jan 6: 6 of 9 services down 09:15 to 11:45 UTC (2.5 hours, longest of 2 outages)");
  assert.equal(line("2026-01-04"), "Last dip on Jan 4: 1 of 9 services down Jan 3 23:10 to Jan 4 00:40 UTC (1.5 hours)");
  assert.equal(line("2026-01-08"), "Last dip on Jan 8: 2 of 9 services down since 22:30 UTC");
  assert.equal(line("2026-01-09"), "Last dip on Jan 9: 2 of 9 services down since Jan 8 22:30 UTC");
  // Nothing in the file for that day: the estimate from the readings stays.
  assert.equal(
    dipLine({ days: 1, since: "2026-01-05", open: false, downMinutes: 180 }),
    "Last dip on Jan 5: the worst-hit service was down about 3 hours",
  );
});

test("a dip line too long for the card wraps with its parenthesis whole, and the card grows", () => {
  const long = "Last dip on Dec 22: 13 of 13 services down Dec 21 23:59 to Dec 22 00:10 UTC (11 minutes, longest of 3 outages)";
  assert.deepEqual(wrapLine(long), [
    "Last dip on Dec 22: 13 of 13 services down Dec 21 23:59 to Dec 22 00:10 UTC",
    "(11 minutes, longest of 3 outages)",
  ]);
  assert.ok(wrapLine(long).every((l) => l.length <= DIP_LINE_CHARS));
  const short = "Last dip on Jan 6: the worst-hit service was down about 3 hours";
  assert.deepEqual(wrapLine(short), [short]);
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  const w = historyWindow(recordDay([], s), dayOf(s.checkedAt));
  const outage = {
    start: Date.parse("2025-12-21T23:59:00Z"),
    end: Date.parse("2025-12-22T00:10:00Z"),
    down: 13,
    total: 13,
    minutes: 11,
    count: 3,
  };
  const card = renderCard(s, "dark", w, { days: 2, since: "2025-12-22", open: false, downMinutes: 11, outage });
  assert.ok(card.includes('height="300"'));
  assert.ok(card.includes('<tspan x="30" dy="16">(11 minutes, longest of 3 outages)</tspan></text>'));
});

test("renderCard draws the 30-day row only when given a window", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE), NOW), 7);
  const w = historyWindow(recordDay([], s), dayOf(s.checkedAt));
  const withRow = renderCard(s, "dark", w);
  assert.ok(withRow.includes('height="256"'));
  assert.ok(withRow.includes("LAST 30 DAYS"));
  assert.equal((withRow.match(/<title>\d{4}-\d{2}-\d{2}: /g) || []).length, 30);
  assert.ok(withRow.includes("over 1 measured day<"));
  assert.ok(!renderCard(s, "dark").includes("LAST 30 DAYS"));
});
