// Run with: node --test .github/scripts/generate-batcave-card.test.mjs
//
// Every fixture is invented, so nothing here describes the real status page.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STATUS,
  CardError,
  SourceFormatError,
  ImplausibleValueError,
  parseStatusPage,
  parseHeartbeats,
  summarize,
  formatUptime,
  formatCheckedAt,
  escapeXml,
  headline,
  renderCard,
} from "./generate-batcave-card.mjs";

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
  const groups = parseHeartbeats(shuffled, parseStatusPage(PAGE));
  assert.equal(groups[1].monitors[0].status, STATUS.UP);
  assert.equal(groups[1].monitors[0].checkedAt, "2026-01-02 03:02:00.000");
});

test("parseHeartbeats refuses missing beats and impossible uptimes", () => {
  const groups = parseStatusPage(PAGE);
  const noBeats = structuredClone(BEATS);
  noBeats.heartbeatList[3] = [];
  throwsClean(() => parseHeartbeats(noBeats, groups), ImplausibleValueError);
  const badUptime = structuredClone(BEATS);
  badUptime.uptimeList["2_24"] = 1.5;
  throwsClean(() => parseHeartbeats(badUptime, groups), ImplausibleValueError);
  throwsClean(() => parseHeartbeats({ heartbeatList: {} }, groups), SourceFormatError);
});

test("summarize counts states and finds the mean, lowest and newest check", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE)), 7);
  assert.equal(s.total, 3);
  assert.equal(s.up, 3);
  assert.equal(s.lowest, 0.995);
  assert.ok(Math.abs(s.mean - (1 + 0.995 + 0.99996) / 3) < 1e-12);
  assert.equal(s.checkedAt, "2026-01-02 03:02:00.000");
});

test("summarize refuses a missing container count", () => {
  const groups = parseHeartbeats(BEATS, parseStatusPage(PAGE));
  throwsClean(() => summarize(groups, undefined), ImplausibleValueError);
  throwsClean(() => summarize(groups, 0), ImplausibleValueError);
});

test("formatUptime never rounds up to a better number", () => {
  assert.equal(formatUptime(1), "100%");
  assert.equal(formatUptime(0.99996), "99.99%");
  assert.equal(formatUptime(0.9993), "99.93%");
  assert.equal(formatUptime(0.5), "50.00%");
});

test("formatCheckedAt reads Kuma's UTC time format", () => {
  assert.equal(formatCheckedAt("2026-11-26 02:46:39.876"), "Nov 26, 2026, 02:46 UTC");
  throwsClean(() => formatCheckedAt("yesterday"), ImplausibleValueError);
});

test("headline says what is wrong when not everything is up", () => {
  const base = { total: 13 };
  assert.equal(headline({ ...base, up: 13, down: 0 }), "All 13 services up");
  assert.equal(headline({ ...base, up: 11, down: 2 }), "2 of 13 down");
  assert.equal(headline({ ...base, up: 12, down: 0 }), "12 of 13 up, 1 pending");
});

test("renderCard escapes names and shows a down service", () => {
  const page = { publicGroupList: [{ name: "A&B", monitorList: [{ id: 1, name: "<x>" }] }] };
  const beats = { heartbeatList: { 1: [beat(0, "2026-01-02 03:00:00.000")] }, uptimeList: { "1_24": 0.9 } };
  const svg = renderCard(summarize(parseHeartbeats(beats, parseStatusPage(page)), 5), "light");
  assert.ok(svg.includes("A&amp;B"));
  assert.ok(svg.includes("&lt;x&gt;: down"));
  assert.ok(!svg.includes("<x>"));
  assert.ok(svg.includes("1 of 1 down"));
  assert.ok(svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"));
});

test("renderCard output is identical for identical input", () => {
  const s = summarize(parseHeartbeats(BEATS, parseStatusPage(PAGE)), 7);
  assert.equal(renderCard(s, "dark"), renderCard(s, "dark"));
  assert.notEqual(renderCard(s, "dark"), renderCard(s, "light"));
  assert.equal(escapeXml(`"'`), "&quot;&apos;");
});
