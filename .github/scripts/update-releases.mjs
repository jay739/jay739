import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const README_PATH = process.env.README_PATH || "README.md";
const LIMIT = Number(process.env.RELEASES_LIMIT || 6);
// Below this, a download count reads as a weakness, so it is left out.
export const DOWNLOADS_MIN = Number(process.env.DOWNLOADS_MIN || 50);

const START = "<!-- RELEASES:START -->";
const END = "<!-- RELEASES:END -->";

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

// latestRelease is GitHub's "Latest" release: never a draft or a prerelease.
async function fetchLatestReleases() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        repositories(first: 100, privacy: PUBLIC, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes {
            name
            description
            latestRelease {
              tagName
              url
              publishedAt
            }
          }
        }
      }
    }
  `;
  const res = await graphql(query, { login: USERNAME });
  return res.data.user.repositories.nodes
    .filter((repo) => repo.latestRelease)
    .sort((a, b) => b.latestRelease.publishedAt.localeCompare(a.latestRelease.publishedAt))
    .slice(0, LIMIT);
}

// Every release of one repository, 100 per page, through the REST endpoint.
// It returns each release with all of its assets and their download counts,
// so totals cover every version however many releases or files there are.
// (GraphQL was tried first and fails with RESOURCE_LIMITS_EXCEEDED once a page
// holds roughly 800 release assets.)
async function fetchReleaseAssets(name) {
  const nodes = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${USERNAME}/${name}/releases?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API error ${res.status} listing releases of ${name}`);
    const releases = await res.json();
    for (const r of releases) {
      nodes.push({
        tagName: r.tag_name,
        releaseAssets: { nodes: (r.assets || []).map((a) => ({ name: a.name, downloadCount: a.download_count })) },
      });
    }
    if (releases.length < 100) break;
  }
  return { nodes };
}

// GitHub counts fetches, not people. Within hours of upload every release file
// is fetched once by something automated (a crawler or mirror), so a release in
// twelve formats starts at twelve "downloads" before anyone installs it. That
// first fetch of each file is not counted, which can only undercount. Checksum
// files are skipped too: they are fetched to verify an installer.
export function totalDownloads(repo) {
  return (repo.releases?.nodes || [])
    .flatMap((release) => release.releaseAssets?.nodes || [])
    .filter((asset) => !/sha256|checksum/i.test(asset.name))
    .reduce((sum, asset) => sum + Math.max(0, (asset.downloadCount || 0) - 1), 0);
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Repo descriptions are free text; keep the README free of em and en dashes
// (U+2014, U+2013). allow-dash: the pattern has to name them to remove them.
export function cleanDescription(text) {
  return (text || "").replace(/\s*[—–]\s*/g, ", ").trim();
}

export function renderList(repos, minDownloads = DOWNLOADS_MIN) {
  if (repos.length === 0) return "_No releases yet._";
  return repos
    .map((repo) => {
      const { tagName, url, publishedAt } = repo.latestRelease;
      const desc = cleanDescription(repo.description);
      const summary = desc ? ` · ${desc}` : "";
      const total = totalDownloads(repo);
      const downloads = total >= minDownloads ? ` · **${total.toLocaleString("en-US")} downloads**` : "";
      return `- [**${repo.name}** ${tagName}](${url})${summary}${downloads} <sub><i>${fmtDate(publishedAt)}</i></sub>`;
    })
    .join("\n");
}

async function main() {
  if (!USERNAME || !TOKEN) {
    throw new Error("GITHUB_REPOSITORY_OWNER and GITHUB_TOKEN must be set");
  }

  const readme = await readFile(README_PATH, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${README_PATH} has no ${START} ... ${END} block. Add both markers where the release list should go.`
    );
  }

  const repos = await fetchLatestReleases();
  for (const repo of repos) repo.releases = await fetchReleaseAssets(repo.name);
  const updated = `${readme.slice(0, start + START.length)}\n${renderList(repos)}\n${readme.slice(end)}`;

  if (updated === readme) {
    console.log("Release list unchanged");
    return;
  }
  await writeFile(README_PATH, updated, "utf8");
  console.log(`Wrote ${repos.length} releases to ${README_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
