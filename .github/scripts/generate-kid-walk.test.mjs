// Run with: node --test .github/scripts/generate-kid-walk.test.mjs
//
// Every fixture is invented.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEVELS, STRIDE, THEMES, WALK_START, WALK_END, GRID_X, PITCH, CELL,
  SourceFormatError, WalkError, formatDate, kidEnd, monthLabels, parseCalendar, renderWalk, revealPercent,
} from "./generate-kid-walk.mjs";

// A calendar of `weeks` weeks starting on Sunday 2025-11-23, the last week cut to
// `lastDays` days, with each day's level picked by `levelOf(dayIndex)`.
function calendar({ weeks = 53, lastDays = 6, total = 42, levelOf = () => 0 } = {}) {
  const start = Date.UTC(2025, 10, 23);
  let n = 0;
  return {
    data: { user: { contributionsCollection: { contributionCalendar: {
      totalContributions: total,
      weeks: Array.from({ length: weeks }, (_, w) => ({
        contributionDays: Array.from({ length: w === weeks - 1 ? lastDays : 7 }, (_, weekday) => {
          const date = new Date(start + n * 86400000).toISOString().slice(0, 10);
          return { date, weekday, contributionLevel: LEVELS[levelOf(n++)] };
        }),
      })),
    } } } },
  };
}

test("parseCalendar keeps each day's date, weekday and level", () => {
  const cal = parseCalendar(calendar({ levelOf: (i) => i % 5 }));
  assert.equal(cal.total, 42);
  assert.equal(cal.weeks.length, 53);
  assert.equal(cal.weeks.at(-1).length, 6);
  assert.deepEqual(cal.weeks[0][3], { date: "2025-11-26", weekday: 3, level: 3 });
});

test("parseCalendar rejects anything that is not a whole contribution calendar", () => {
  const broken = [
    [{ errors: [{ message: "Could not resolve to a User" }] }, /Could not resolve/],
    [calendar({ weeks: 12 }), /12 weeks/],
    [calendar({ total: -1 }), /totalContributions/],
  ];
  const badLevel = calendar();
  badLevel.data.user.contributionsCollection.contributionCalendar.weeks[2].contributionDays[1].contributionLevel = "LOTS";
  broken.push([badLevel, /level LOTS/]);
  for (const [json, why] of broken) {
    assert.throws(() => parseCalendar(json), (e) => e instanceof SourceFormatError && e instanceof WalkError && why.test(e.message));
  }
});

test("each week lights up as the kid reaches it, first to last, inside the walk", () => {
  const p = Array.from({ length: 53 }, (_, i) => revealPercent(GRID_X + i * PITCH + CELL / 2, 53));
  assert.ok(p.every((v, i) => i === 0 || v > p[i - 1]));
  assert.ok(p[0] > WALK_START && p[0] < WALK_START + 3, `first week at ${p[0]}%`);
  assert.equal(p.at(-1), WALK_END);
  assert.equal(kidEnd(53), GRID_X + 52 * PITCH + CELL / 2);
});

test("month labels go under the week each month starts, never crowded together", () => {
  const labels = monthLabels(parseCalendar(calendar()).weeks);
  assert.equal(labels[0].text, "Dec");
  assert.equal(labels.at(-1).text, "Nov");
  assert.ok(labels.every((l, i) => i === 0 || l.week - labels[i - 1].week >= 3));
});

test("the walk keeps every knee bending forward", () => {
  for (const side of ["l", "r"]) {
    assert.ok(Object.values(STRIDE[`sm-shin-${side}`]).every((deg) => deg >= 0), `shin ${side}`);
  }
});

test("renderWalk draws every day once, lights only active days, and holds still for reduced motion", () => {
  const cal = parseCalendar(calendar({ total: 1234, levelOf: (i) => (i % 9 === 0 ? 4 : 0) }));
  const svg = renderWalk(cal, "dark");
  const days = cal.weeks.flat();
  const active = days.filter((d) => d.level > 0).length;
  assert.equal((svg.match(/<rect x="\d+" y="\d+" width="10" height="10" rx="2"\/>/g) || []).length, days.length);
  assert.equal((svg.match(new RegExp(`fill="${THEMES.dark.levels[3]}"/>`, "g")) || []).length, active + 1); // + the legend swatch
  assert.match(svg, /aria-label="My last year on GitHub: 1,234 contributions between Nov 23, 2025 and Nov 2[0-9], 2026\./);
  assert.match(svg, /@media \(prefers-reduced-motion: reduce\) \{ \* \{ animation: none !important; \} \}/);
  assert.match(svg, /\.walker \{ opacity: 0;/);
  assert.match(svg, /\.greeter \{ opacity: 1;/);
});

test("light and dark use the same four ambers, in opposite order", () => {
  assert.deepEqual([...THEMES.light.levels].reverse(), THEMES.dark.levels);
  assert.match(renderWalk(parseCalendar(calendar()), "light"), new RegExp(`fill="${THEMES.light.empty}"`));
});

test("formatDate writes a short month name", () => {
  assert.equal(formatDate("2026-03-07"), "Mar 7, 2026");
});
