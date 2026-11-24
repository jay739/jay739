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

## B-2: Four claims have nothing public behind them

- **Status:** open
- **Size:** XS
- **Touches:** `README.md`
  - Featured Projects, Histopathologic Cancer Detection: "0.94 AUC". There is no
    public repo or notebook for this project.
  - About: "LLM fine-tuning". No public repo contains fine-tuning code
    (PodcastAI, the likeliest one, does not).
  - Batcave table: "Hybrid-cloud latency −60%" and "Multi-DB layer 177 GB".
    These are hand-typed, unlike the generated counts beside them.
- **Why:** every other figure on the page traces to a repo or to the generated
  homelab docs. A reviewer who checks one of these and finds nothing will
  discount the rest.
- **Done when:** each of the four links to its evidence (a notebook, a repo, the
  blog post that measured it) or is removed.

## B-4: The stats parser reads Markdown instead of a contract

- **Status:** open
- **Size:** M
- **Touches:** `.github/scripts/update-homelab-stats.mjs` (`parseInventory`,
  `parseIngress`, `parseRemoteHosts`) and, in the private
  `homelab-docker-services` repo, `tools/gen_docs.py`.
- **Why:** three of the four sources are generated Markdown, so rewording a
  summary line in the generator fails the stats run until the parser follows.
  It fails safely, leaving the README unchanged, but the numbers stay stale
  until someone acts on GitHub's failed-run email.
- **Fix:** have the generator also write a totals-only `docs/reference/stats.json`,
  and read that.
- **Done when:** the script reads only `topology.json` and the new stats file,
  and the three Markdown parsers and their tests are gone.
- **Risk:** the generator change has to be made where that repo is checked out,
  on batcave, and the drift check commits whatever the generator writes, so
  test the new file there before relying on it here.
