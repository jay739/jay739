// Writes one "This week" line into README.md between the THIS-WEEK markers:
// how many of my pull requests were merged in public repositories over the
// last 7 days, and where. It reads only public data through the GitHub search
// API, so the job needs nothing beyond the workflow's own token.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOGIN = process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const README_PATH = process.env.README_PATH || "README.md";

export const START = "<!-- THIS-WEEK:START -->";
export const END = "<!-- THIS-WEEK:END -->";
export const WINDOW_DAYS = 7;
const NAMED_REPOS = 3;

export class ThisWeekError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The GitHub API could not be reached or answered with an error. */
export class ApiError extends ThisWeekError {}

/** README.md has no THIS-WEEK block, or a broken one. */
export class MarkerError extends ThisWeekError {}

// The window starts exactly WINDOW_DAYS before `now`, to the second. A bare
// date would be read as midnight UTC and stretch the window to almost 8 days.
// `now` is passed in so tests do not depend on the real clock.
export function sinceDate(now) {
  const d = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().split(".")[0] + "Z";
}

export function searchQuery(login, since) {
  return `is:pr is:merged is:public author:${login} merged:>=${since}`;
}

// Pull requests per repository, most first, ties by name. A repository I own
// is shown by its short name; anyone else's keeps its owner.
export function summarize(nodes, login) {
  const counts = new Map();
  for (const pr of nodes) {
    const repo = pr?.repository;
    if (!repo?.nameWithOwner) continue;
    const label = repo.owner?.login === login ? repo.nameWithOwner.split("/")[1] : repo.nameWithOwner;
    const entry = counts.get(repo.nameWithOwner) || { label, url: `https://github.com/${repo.nameWithOwner}`, count: 0 };
    entry.count += 1;
    counts.set(repo.nameWithOwner, entry);
  }
  const repos = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { total: repos.reduce((s, r) => s + r.count, 0), repos };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function joinNames(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function renderLine({ total, repos }) {
  if (total === 0) return `**This week:** a quiet one, no pull requests merged in the last ${WINDOW_DAYS} days.`;
  const named = repos.slice(0, NAMED_REPOS).map((r) => `[${r.label}](${r.url}) (${r.count})`);
  if (repos.length === 1) {
    return `**This week:** ${plural(total, "pull request", "pull requests")} merged, all in ${named[0]}.`;
  }
  const lead = repos.length > NAMED_REPOS ? "most in" : "in";
  return `**This week:** ${plural(total, "pull request", "pull requests")} merged across ${plural(repos.length, "repository", "repositories")}, ${lead} ${joinNames(named)}.`;
}

export function replaceBlock(readme, line) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new MarkerError(`README has no ${START} ... ${END} block. Add both markers where the line should go.`);
  }
  // The line goes on its own line: a line that starts with an HTML comment is
  // passed through as raw HTML, so Markdown on it would never render.
  return `${readme.slice(0, start + START.length)}\n${line}\n${readme.slice(end)}`;
}

async function graphql(query, variables) {
  let res;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ApiError(`could not reach the GitHub API (${err.name})`);
  }
  if (!res.ok) throw new ApiError(`GitHub API answered HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new ApiError(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data;
}

async function fetchMergedPullRequests(login, since) {
  const query = `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { repository { nameWithOwner owner { login } } } }
      }
    }
  `;
  const nodes = [];
  let after = null;
  do {
    const data = await graphql(query, { q: searchQuery(login, since), after });
    nodes.push(...data.search.nodes);
    after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

async function main() {
  if (!LOGIN || !TOKEN) throw new ThisWeekError("GITHUB_REPOSITORY_OWNER and GITHUB_TOKEN must be set");
  const now = process.env.THIS_WEEK_NOW ? new Date(process.env.THIS_WEEK_NOW) : new Date();
  const since = sinceDate(now);
  const summary = summarize(await fetchMergedPullRequests(LOGIN, since), LOGIN);
  const readme = await readFile(README_PATH, "utf8");
  const updated = replaceBlock(readme, renderLine(summary));
  if (updated !== readme) await writeFile(README_PATH, updated, "utf8");
  console.log(`This week since ${since}: ${summary.total} merged across ${summary.repos.length} repositories`);
  console.log(updated === readme ? "README unchanged" : "README updated");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof ThisWeekError ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
}
