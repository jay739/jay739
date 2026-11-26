// Run with: node --test .github/scripts/update-releases.test.mjs
//
// Every fixture is invented.

import { test } from "node:test";
import assert from "node:assert/strict";

import { totalDownloads, cleanDescription, renderList, fmtDate } from "./update-releases.mjs";

const repo = (name, assets, extra = {}) => ({
  name,
  description: "A tool.",
  latestRelease: { tagName: "v1.0.0", url: `https://example.test/${name}`, publishedAt: "2026-03-04T10:00:00Z" },
  releases: { nodes: [{ releaseAssets: { nodes: assets } }] },
  ...extra,
});

test("totalDownloads skips checksum files and each file's first automated fetch", () => {
  const r = {
    releases: {
      nodes: [
        { releaseAssets: { nodes: [{ name: "App-1.0.dmg", downloadCount: 40 }, { name: "SHA256SUMS.txt", downloadCount: 9 }] } },
        { releaseAssets: { nodes: [{ name: "App-0.9-Setup.exe", downloadCount: 25 }, { name: "checksums.txt", downloadCount: 3 }] } },
      ],
    },
  };
  assert.equal(totalDownloads(r), 63);
  assert.equal(totalDownloads({}), 0);
});

test("totalDownloads gives zero for a release nobody installed yet", () => {
  const formats = ["app.deb", "app.rpm", "app.AppImage", "app.dmg", "app-setup.exe", "app.tar.gz"];
  const fresh = { releases: { nodes: [{ releaseAssets: { nodes: formats.map((name) => ({ name, downloadCount: 1 })) } }] } };
  assert.equal(totalDownloads(fresh), 0);
});

test("renderList shows downloads only at or above the threshold", () => {
  const busy = repo("busy", [{ name: "busy.dmg", downloadCount: 1234 }]);
  const quiet = repo("quiet", [{ name: "quiet.whl", downloadCount: 3 }]);
  const lines = renderList([busy, quiet], 50).split("\n");
  assert.equal(
    lines[0],
    "- [**busy** v1.0.0](https://example.test/busy) · A tool. · **1,233 downloads** <sub><i>Mar 4, 2026</i></sub>",
  );
  assert.ok(!lines[1].includes("downloads"));
});

test("renderList keeps the empty and no-description cases", () => {
  assert.equal(renderList([]), "_No releases yet._");
  const bare = repo("bare", [], { description: null });
  assert.equal(renderList([bare]), "- [**bare** v1.0.0](https://example.test/bare) <sub><i>Mar 4, 2026</i></sub>");
});

test("cleanDescription swaps em and en dashes for commas", () => {
  const em = String.fromCharCode(0x2014);
  const en = String.fromCharCode(0x2013);
  assert.equal(cleanDescription(`Fast ${em} small`), "Fast, small");
  assert.equal(cleanDescription(`A ${en} B`), "A, B");
  assert.equal(fmtDate("2026-11-21T08:00:00Z"), "Nov 21, 2026");
});
