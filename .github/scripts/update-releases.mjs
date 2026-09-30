import { readFile, writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const README_PATH = process.env.README_PATH || "README.md";
const LIMIT = Number(process.env.RELEASES_LIMIT || 6);

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

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Repo descriptions are free text; keep the README free of em/en dashes.
function cleanDescription(text) {
  return (text || "").replace(/\s*[—–]\s*/g, ", ").trim();
}

function renderList(repos) {
  if (repos.length === 0) return "_No releases yet._";
  return repos
    .map((repo) => {
      const { tagName, url, publishedAt } = repo.latestRelease;
      const desc = cleanDescription(repo.description);
      const summary = desc ? ` · ${desc}` : "";
      return `- [**${repo.name}** ${tagName}](${url})${summary} <sub><i>${fmtDate(publishedAt)}</i></sub>`;
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
  const updated = `${readme.slice(0, start + START.length)}\n${renderList(repos)}\n${readme.slice(end)}`;

  if (updated === readme) {
    console.log("Release list unchanged");
    return;
  }
  await writeFile(README_PATH, updated, "utf8");
  console.log(`Wrote ${repos.length} releases to ${README_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
