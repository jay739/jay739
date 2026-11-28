// Draws profile/kid-walk.svg and profile/kid-walk-light.svg: my last year of
// GitHub contributions as a grid, with the kid from my wall display walking along
// its top edge so each week lights up as he passes. At the far end he turns and
// waves, then the year fades and he sets off again.
//
// The figure is the wall display's own rig (overlay/stickman.js): same joints and
// viewBox, its profile face for the walk, and the front face with the family
// card's wave at the end. Motion is CSS
// only, because GitHub never runs scripts inside an image. Viewers who ask for
// reduced motion get the finished picture: every week lit and the kid at the end.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOGIN = process.env.GITHUB_REPOSITORY_OWNER || "jay739";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || "profile";
// A saved GraphQL response, for previews without a token.
const CALENDAR_JSON = process.env.CALENDAR_JSON;
const TIMEOUT_MS = 30_000;

/** Base class, so the CLI can tell expected failures from bugs. */
export class WalkError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
/** GitHub could not be asked for the calendar. */
export class SourceUnavailableError extends WalkError {}
/** GitHub answered with something that is not a contribution calendar. */
export class SourceFormatError extends WalkError {}

export const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];

export function parseCalendar(json) {
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal || !Array.isArray(cal.weeks)) {
    const why = json?.errors?.[0]?.message;
    throw new SourceFormatError(`GitHub returned no contribution calendar${why ? ` (${why})` : ""}`);
  }
  if (!Number.isInteger(cal.totalContributions) || cal.totalContributions < 0) {
    throw new SourceFormatError(`totalContributions is ${cal.totalContributions}, expected a whole number`);
  }
  if (cal.weeks.length < 52 || cal.weeks.length > 54) {
    throw new SourceFormatError(`the calendar has ${cal.weeks.length} weeks, expected 52 to 54`);
  }
  const weeks = cal.weeks.map((w, i) => {
    const days = w?.contributionDays;
    if (!Array.isArray(days) || days.length === 0 || days.length > 7) {
      throw new SourceFormatError(`week ${i} has ${days?.length} days, expected 1 to 7`);
    }
    return days.map((d) => {
      const level = LEVELS.indexOf(d?.contributionLevel);
      if (level < 0) throw new SourceFormatError(`day ${d?.date} has level ${d?.contributionLevel}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) throw new SourceFormatError(`a day has the date ${d.date}`);
      if (!Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6) {
        throw new SourceFormatError(`day ${d.date} has weekday ${d.weekday}`);
      }
      return { date: d.date, weekday: d.weekday, level };
    });
  });
  return { total: cal.totalContributions, weeks };
}

// Geometry. Cells follow GitHub's own grid: one column per week, Sunday on top.
export const W = 760;
export const H = 274;
export const CELL = 10;
export const PITCH = 13;
export const GRID_X = 37;
export const GRID_Y = 150;
export const KID_HEIGHT = 74;

// One loop, as percentages of CYCLE seconds: he walks from WALK_START to WALK_END,
// waves until HOLD_END, and the year has faded by FADE_END.
export const CYCLE = 16;
export const WALK_START = 3;
export const WALK_END = 78;
export const HOLD_END = 92;
export const FADE_END = 96;

export const kidStart = () => GRID_X - 14;
export const kidEnd = (weeks) => GRID_X + (weeks - 1) * PITCH + CELL / 2;

/** When, as a percentage of the loop, the kid reaches the middle of column x. */
export function revealPercent(x, weeks) {
  const start = kidStart();
  const end = kidEnd(weeks);
  return WALK_START + ((WALK_END - WALK_START) * (x - start)) / (end - start);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A label under each week that starts a new month, skipping ones that would crowd the last. */
export function monthLabels(weeks) {
  const labels = [];
  let prev = null;
  weeks.forEach((days, i) => {
    const month = Number(days[0].date.slice(5, 7)) - 1;
    if (month !== prev) {
      if (labels.length && i - labels.at(-1).week < 3) labels.pop();
      labels.push({ week: i, text: MONTHS[month] });
    }
    prev = month;
  });
  // The first week usually starts mid-month; drop its label if the next comes soon.
  if (labels.length > 1 && labels[1].week - labels[0].week < 3) labels.shift();
  return labels;
}

export function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export const THEMES = {
  // Contribution steps are one amber hue, validated as an ordinal ramp against each
  // card surface (monotone lightness, visible steps, the faintest step at 2:1 or
  // more). Light mode runs the same four colours the other way round.
  dark: {
    bg: "#0F172A", border: "#334155", title: "#F59E0B", text: "#cbd5e1", muted: "#94a3b8",
    empty: "#1e293b", levels: ["#92400e", "#b45309", "#d97706", "#f59e0b"],
    figure: "#f5deb3", feature: "#0b0b0b",
  },
  light: {
    bg: "#ffffff", border: "#e2e8f0", title: "#b45309", text: "#334155", muted: "#475569",
    empty: "#e2e8f0", levels: ["#f59e0b", "#d97706", "#b45309", "#92400e"],
    figure: "#1e293b", feature: "#f8fafc",
  },
};

// A plain walk cycle in the display's rig, one 0.8 s step. The display's own keyframe
// stride (stickman.css sm-stride) bent his knees backwards when drawn here in
// profile, in either direction, so this one is written for a walk to the right:
// a nearly straight leg strikes the ground in front, pushes off behind, then bends
// hard at the knee as it swings through. Knees only ever bend forward (shin angles
// are never negative), the right leg runs half a step behind the left, and each arm
// swings opposite its leg with the elbow bending as it comes forward.
const LEG = { 0: -28, 15: -18, 30: -2, 50: 26, 62: 12, 80: -14, 92: -28 };
const SHIN = { 0: 2, 15: 12, 30: 4, 50: 14, 62: 48, 80: 40, 92: 10 };
const halfStep = (frames) =>
  Object.fromEntries(Object.entries(frames).map(([at, deg]) => [String((Number(at) + 50) % 100), deg]));
export const STRIDE = {
  "sm-leg-l": LEG,
  "sm-shin-l": SHIN,
  "sm-leg-r": halfStep(LEG),
  "sm-shin-r": halfStep(SHIN),
  "sm-arm-l": { 0: 22, 25: 0, 50: -22, 75: 0 },
  "sm-arm-r": { 0: -22, 25: 0, 50: 22, 75: 0 },
  "sm-fore-l": { 0: -6, 50: -26 },
  "sm-fore-r": { 0: -26, 50: -6 },
};
const PIVOTS = {
  "sm-leg-l": "80px 124px", "sm-leg-r": "80px 124px",
  "sm-shin-l": "80px 150px", "sm-shin-r": "80px 150px",
  "sm-arm-l": "75px 93px", "sm-arm-r": "85px 93px",
  "sm-fore-l": "75px 111px", "sm-fore-r": "85px 111px",
};

function limb(cls, x, a, b, c, sub, cap) {
  return (
    `<g class="${cls}"><line x1="${x}" y1="${a}" x2="${x}" y2="${b}"/>` +
    `<g class="${sub}"><line x1="${x}" y1="${b}" x2="${x}" y2="${c}"/>` +
    `<circle cx="${x}" cy="${c}" r="4.2" fill="currentColor" stroke="none"/></g></g>`
  );
}
// Walking, both feet point the way he is going; standing, they splay like the card's.
function leg(side, walking) {
  const toe = walking ? 93 : side === "l" ? 67 : 93;
  return (
    `<g class="sm-leg-${side}"><line x1="80" y1="124" x2="80" y2="150"/>` +
    `<g class="sm-shin-${side}"><line x1="80" y1="150" x2="80" y2="174"/>` +
    `<line x1="80" y1="174" x2="${toe}" y2="174"/></g></g>`
  );
}

// The rig without the extras this picture never shows (props, hats, other mouths).
function rig(c, walking) {
  const face = walking
    ? // Profile face (stickman.js sm-face-profile): one eye, one brow, a nose bump.
      `<g stroke="${c.feature}" stroke-width="3.2" stroke-linecap="round" fill="none">` +
      `<path d="M84 37 Q90 31.5 96 34.5"/><path d="M103 48 L108 55 L102 57"/><path d="M90 64 Q96 66 99 63"/></g>` +
      `<ellipse cx="92" cy="49" rx="5" ry="6.4" fill="${c.feature}" stroke="none"/>`
    : `<g stroke="${c.feature}" stroke-width="3.2" stroke-linecap="round" fill="none">` +
      `<path d="M64 37 Q70 31.5 76 34.5"/><path d="M96 37 Q90 31.5 84 34.5"/></g>` +
      `<g fill="${c.feature}" stroke="none"><ellipse cx="70" cy="49" rx="5.2" ry="6.6"/><ellipse cx="90" cy="49" rx="5.2" ry="6.6"/></g>` +
      `<path d="M69 61 Q80 71 91 61" stroke="${c.feature}" stroke-width="4" stroke-linecap="round" fill="none"/>`;
  return (
    `<g class="sm-body" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">` +
    `<line x1="80" y1="82" x2="80" y2="124" stroke-width="7"/>` +
    `<line x1="75" y1="93" x2="85" y2="93"/>` +
    leg("l", walking) +
    leg("r", walking) +
    `<g class="sm-head"><circle cx="80" cy="52" r="28" fill="currentColor" stroke="none"/>${face}</g>` +
    limb("sm-arm-l", 75, 93, 111, 128, "sm-fore-l") +
    limb("sm-arm-r", 85, 93, 111, 128, "sm-fore-r") +
    `</g>`
  );
}

function strideCss() {
  return Object.entries(STRIDE)
    .map(([cls, frames]) => {
      const stops = Object.entries(frames)
        .map(([at, deg]) => `${at === "0" ? "0%, 100%" : `${at}%`} { transform: rotate(${deg}deg); }`)
        .join(" ");
      return (
        `@keyframes ${cls}-walk { ${stops} }\n` +
        `    .walker .${cls} { transform-origin: ${PIVOTS[cls]}; animation: ${cls}-walk 0.8s linear infinite; }`
      );
    })
    .join("\n    ");
}

const pct = (n) => `${Number(n.toFixed(2))}%`;

export function renderWalk(cal, theme = "dark") {
  const c = THEMES[theme];
  const n = cal.weeks.length;
  const days = cal.weeks.flat();
  const first = formatDate(days[0].date);
  const last = formatDate(days.at(-1).date);
  const total = cal.total.toLocaleString("en-US");
  const label =
    `My last year on GitHub: ${total} contributions between ${first} and ${last}. ` +
    `The kid from my wall display walks along the contribution grid, each week lights up as he passes, ` +
    `and at the end he turns and waves.`;

  const at = (i, weekday) => [GRID_X + i * PITCH, GRID_Y + weekday * PITCH];
  const base = cal.weeks
    .map((week, i) => week.map((d) => {
      const [x, y] = at(i, d.weekday);
      return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"/>`;
    }).join(""))
    .join("");

  const columns = [];
  const reveals = [];
  cal.weeks.forEach((week, i) => {
    const lit = week.filter((d) => d.level > 0);
    if (!lit.length) return;
    const p = revealPercent(GRID_X + i * PITCH + CELL / 2, n);
    reveals.push(
      `@keyframes r${i} { 0%, ${pct(p)} { opacity: 0; } ${pct(p + 0.6)}, ${HOLD_END}% { opacity: 1; } ${FADE_END}%, 100% { opacity: 0; } }\n` +
        `    .c${i} { animation-name: r${i}; }`,
    );
    columns.push(
      `<g class="col c${i}">` +
        lit.map((d) => {
          const [x, y] = at(i, d.weekday);
          return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${c.levels[d.level - 1]}"/>`;
        }).join("") +
        `</g>`,
    );
  });

  const months = monthLabels(cal.weeks)
    .map((m) => `<text x="${GRID_X + m.week * PITCH}" y="${GRID_Y + 7 * PITCH + 12}" class="small">${m.text}</text>`)
    .join("");

  // Top right, level with the count line, clear of the month labels under the grid.
  const legendX = W - 30 - (5 * PITCH + 52);
  const legendY = 51;
  const legend =
    `<text x="${legendX}" y="${legendY + 9}" class="small">Less</text>` +
    [c.empty, ...c.levels]
      .map((fill, i) => `<rect x="${legendX + 28 + i * PITCH}" y="${legendY}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`)
      .join("") +
    `<text x="${legendX + 28 + 5 * PITCH + 4}" y="${legendY + 9}" class="small">More</text>`;

  // The figure keeps the display's own viewBox, so every pivot is its pixel pivot.
  const kidW = (KID_HEIGHT * 228) / 220;
  const kidY = GRID_Y - 4 - KID_HEIGHT * (218 / 220);
  const distance = (kidEnd(n) - kidStart()).toFixed(1);
  const figure = (walking) =>
    `<svg class="fig" x="${(kidStart() - kidW / 2).toFixed(1)}" y="${kidY.toFixed(1)}" width="${kidW.toFixed(1)}" height="${KID_HEIGHT}" viewBox="-34 -44 228 220" overflow="visible" color="${c.figure}">${rig(c, walking)}</svg>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">
  <style>
    text { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .title { fill: ${c.title}; font-size: 15px; font-weight: 700; letter-spacing: 0.5px; }
    .body { fill: ${c.text}; font-size: 12.5px; }
    .small { fill: ${c.muted}; font-size: 10.5px; }
    .fig * { transform-box: view-box; }
    /* The finished picture is the default, which is what reduced motion shows. */
    .pos { transform: translateX(${distance}px); animation: pos ${CYCLE}s linear infinite; }
    .kid { animation: kid ${CYCLE}s linear infinite; }
    .walker { opacity: 0; animation: walker ${CYCLE}s linear infinite; }
    .greeter { opacity: 1; animation: greeter ${CYCLE}s linear infinite; }
    .col { animation-duration: ${CYCLE}s; animation-timing-function: linear; animation-iteration-count: infinite; }
    @keyframes pos { 0%, ${WALK_START}% { transform: translateX(0px); } ${WALK_END}%, 100% { transform: translateX(${distance}px); } }
    @keyframes kid { 0% { opacity: 0; } 2%, ${HOLD_END}% { opacity: 1; } ${FADE_END}%, 100% { opacity: 0; } }
    @keyframes walker { 0%, ${WALK_END}% { opacity: 1; } ${WALK_END + 0.1}%, 100% { opacity: 0; } }
    @keyframes greeter { 0%, ${WALK_END}% { opacity: 0; } ${WALK_END + 0.1}%, 100% { opacity: 1; } }
    /* Walking: the display's stride, a bob twice a step and a slight lean forward. */
    ${strideCss()}
    .walker .sm-body { transform-origin: 80px 124px; animation: bob 0.4s ease-in-out infinite; }
    @keyframes bob { 0%, 100% { transform: translateY(0) rotate(4deg); } 50% { transform: translateY(-6px) rotate(4deg); } }
    /* Standing at the end: the calm pose, and the family card's wave on the right arm. */
    .greeter .sm-arm-l { transform-origin: 75px 93px; transform: rotate(45deg); }
    .greeter .sm-arm-r { transform-origin: 85px 93px; transform: rotate(-45deg); animation: wave-arm ${CYCLE}s ease-in-out infinite; }
    .greeter .sm-fore-r { transform-origin: 85px 111px; animation: wave-fore ${CYCLE}s ease-in-out infinite; }
    .greeter .sm-leg-l { transform-origin: 80px 124px; transform: rotate(23deg); }
    .greeter .sm-leg-r { transform-origin: 80px 124px; transform: rotate(-23deg); }
    .greeter .sm-shin-l { transform-origin: 80px 150px; transform: rotate(-23deg); }
    .greeter .sm-shin-r { transform-origin: 80px 150px; transform: rotate(23deg); }
    @keyframes wave-arm { 0%, 79%, 91%, 100% { transform: rotate(-45deg); } 81%, 89% { transform: rotate(-125deg); } }
    @keyframes wave-fore { 0%, 81%, 89%, 100% { transform: rotate(0deg); } 83% { transform: rotate(-12deg); } 85% { transform: rotate(14deg); } 87% { transform: rotate(-12deg); } 88% { transform: rotate(10deg); } }
    ${reveals.join("\n    ")}
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.bg}" stroke="${c.border}" />
  <text x="30" y="38" class="title">MY LAST YEAR ON GITHUB</text>
  <text x="30" y="60" class="body">${total} contributions between ${first} and ${last}</text>
  <g fill="${c.empty}">${base}</g>
  ${columns.join("\n  ")}
  ${months}
  ${legend}
  <g class="kid"><g class="pos"><g class="walker">${figure(true)}</g><g class="greeter">${figure(false)}</g></g></g>
</svg>
`;
}

async function fetchCalendar() {
  if (CALENDAR_JSON) return JSON.parse(await readFile(CALENDAR_JSON, "utf8"));
  if (!TOKEN) throw new SourceUnavailableError("GITHUB_TOKEN is not set. Run inside the workflow, or set CALENDAR_JSON to a saved response.");
  const query = `query($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar {
    totalContributions weeks { contributionDays { date weekday contributionLevel } } } } } }`;
  let res;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { login: LOGIN } }),
    });
  } catch (err) {
    throw new SourceUnavailableError(`could not reach the GitHub GraphQL API (${err.name}). Re-run the workflow.`);
  }
  if (!res.ok) throw new SourceUnavailableError(`the GitHub GraphQL API answered HTTP ${res.status}. Check the token's permissions.`);
  return res.json();
}

async function main() {
  const cal = parseCalendar(await fetchCalendar());
  for (const [theme, file] of [["dark", "kid-walk.svg"], ["light", "kid-walk-light.svg"]]) {
    await writeFile(path.join(OUT_DIR, file), renderWalk(cal, theme), "utf8");
  }
  const days = cal.weeks.flat();
  console.log(`Kid walk: ${cal.total} contributions over ${cal.weeks.length} weeks, ${days[0].date} to ${days.at(-1).date}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof WalkError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
