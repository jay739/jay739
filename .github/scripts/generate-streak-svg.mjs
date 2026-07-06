import { writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_PATH = process.env.OUT_PATH || "profile/streak-stats.svg";

const COLORS = {
  background: "#0F172A",
  border: "#334155",
  ring: "#F59E0B",
  fire: "#F59E0B",
  label: "#F59E0B",
  nums: "#f8fafc",
  dates: "#94a3b8",
};

async function fetchContributionYears() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionYears
        }
      }
    }
  `;
  const res = await graphql(query, { login: USERNAME });
  return res.data.user.contributionsCollection.contributionYears;
}

async function fetchYearCalendar(year) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const res = await graphql(query, { login: USERNAME, from, to });
  return res.data.user.contributionsCollection.contributionCalendar.weeks.flatMap(
    (w) => w.contributionDays
  );
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

function computeStreaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = days
    .filter((d) => d.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  let total = 0;
  let longest = 0;
  let longestRange = null;
  let running = 0;
  let runningStart = null;

  for (const day of sorted) {
    total += day.contributionCount;
    if (day.contributionCount > 0) {
      if (running === 0) runningStart = day.date;
      running += 1;
      if (running > longest) {
        longest = running;
        longestRange = [runningStart, day.date];
      }
    } else {
      running = 0;
      runningStart = null;
    }
  }

  let current = 0;
  let currentStart = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const day = sorted[i];
    if (day.contributionCount > 0) {
      current += 1;
      currentStart = day.date;
    } else if (day.date === today) {
      continue;
    } else {
      break;
    }
  }
  const currentRange = current > 0 ? [currentStart, sorted[sorted.length - 1].date] : null;

  return {
    total,
    longest,
    longestRange,
    current,
    currentRange,
    firstDate: sorted[0]?.date,
    lastDate: sorted[sorted.length - 1]?.date,
  };
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtRange(range) {
  if (!range) return "-";
  const [start, end] = range;
  return start === end ? fmtDate(start) : `${fmtDate(start)} - ${fmtDate(end)}`;
}

function renderSvg(stats) {
  const { total, current, longest, currentRange, longestRange, firstDate, lastDate } = stats;
  const c = COLORS;

  return `<svg width="600" height="200" viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg">
  <style>
    .bg { fill: ${c.background}; stroke: ${c.border}; stroke-width: 1; }
    .num { font: 700 28px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${c.nums}; text-anchor: middle; }
    .label { font: 600 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${c.label}; text-anchor: middle; text-transform: uppercase; letter-spacing: 1px; }
    .date { font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${c.dates}; text-anchor: middle; }
    .divider { stroke: ${c.border}; stroke-width: 1; }
  </style>

  <rect class="bg" x="0.5" y="0.5" width="599" height="199" rx="10" />

  <text class="label" x="100" y="40">Total Contributions</text>
  <text class="num" x="100" y="95">${total}</text>
  <text class="date" x="100" y="150">${fmtDate(firstDate)} - present</text>

  <line class="divider" x1="200" y1="30" x2="200" y2="170" />

  <circle cx="300" cy="95" r="38" fill="none" stroke="${c.ring}" stroke-width="4" opacity="0.5" />
  <text class="label" x="300" y="40">Current Streak</text>
  <text class="num" x="300" y="103" fill="${c.fire}">${current}</text>
  <text class="date" x="300" y="150">${fmtRange(currentRange)}</text>

  <line class="divider" x1="400" y1="30" x2="400" y2="170" />

  <text class="label" x="500" y="40">Longest Streak</text>
  <text class="num" x="500" y="95">${longest}</text>
  <text class="date" x="500" y="150">${fmtRange(longestRange)}</text>
</svg>`;
}

async function main() {
  if (!USERNAME || !TOKEN) {
    throw new Error("GITHUB_REPOSITORY_OWNER and GITHUB_TOKEN must be set");
  }

  const years = await fetchContributionYears();
  const calendars = await Promise.all(years.map((y) => fetchYearCalendar(y)));
  const days = calendars.flat();

  const stats = computeStreaks(days);
  const svg = renderSvg(stats);

  await writeFile(OUT_PATH, svg, "utf8");
  console.log(`Wrote ${OUT_PATH}`);
  console.log(stats);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
