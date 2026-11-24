# Backlog

Work on this profile repo that is understood well enough to start. Ordered by
impact if left undone, not by effort. Each item names the files it touches and
ends with a "Done when" line. Items that need outside discussion go to GitHub
Issues instead. Drop an item once it is done.

## B-1: The header badge still hardcodes 56 containers

- **Status:** open
- **Size:** S
- **Touches:** `jay739/portfolio-site`, not this repo:
  `src/app/api/badges/batcave/route.ts` (`STATIC_CONTAINER_COUNT`, which falls
  back to 56). The same 56 is typed into `src/components/sections/AboutSection.tsx`
  and `src/data/projects.ts`.
- **Why:** the badge at the top of the profile reads "56 containers · up" right
  above a table whose numbers are generated, so the page contradicts itself.
  Only the "up" half of the badge is measured (a Netdata probe).
- **Fix:** have the route read `batcave_containers` from
  `https://raw.githubusercontent.com/jay739/jay739/main/profile/homelab-stats.json`,
  cached, keeping the environment variable as the fallback.
- **Done when:** the badge and the README table show the same container count,
  and a change to `profile/homelab-stats.json` reaches the badge within its
  cache window.

## B-4: The stats parser reads Markdown instead of a contract

- **Status:** blocked on the generator half
- **Size:** M
- **Touches:** in the private `homelab-docker-services` repo,
  `tools/gen_docs.py` (`build()`) and `tools/test_gen_docs.py`. This repo's
  half, the script that reads only `docs/reference/stats.json`, is the
  `feat/stats-contract` draft PR.
- **Why:** the merged script parses generated Markdown, so rewording a summary
  line in the generator fails the stats run until the parser follows. It fails
  safely, leaving the README unchanged, but the numbers stay stale until
  someone acts on GitHub's failed-run email.
- **Fix:** the generator also writes `docs/reference/stats.json`, a JSON object
  holding every key in `STAT_KEYS` (see the script) as a whole number, with no
  timestamps so the drift check only commits it when a count moves. It must be
  computed the way the Markdown pages count: `https_sites` is enabled proxy
  hosts whose upstream is not dangling, wildcards excluded, on batcave and
  every remote host.
- **Done when:** the drift check has committed `stats.json` with the same
  values `profile/homelab-stats.json` shows, the draft PR's dry run passes
  against it, and the PR is merged.
- **Risk:** the generator change has to be made in batcave's checkout, because
  the drift check there commits and pushes but never pulls. A generator change
  pushed from any other clone would leave batcave behind, and every later
  drift push would fail.
