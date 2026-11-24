# Backlog

Work on this profile repo that is understood well enough to start. Ordered by
impact if left undone, not by effort. Each item names the files it touches and
ends with a "Done when" line. Items that need outside discussion go to GitHub
Issues instead. Drop an item once it is done.

## B-5: The live status links open a badge, not a status page

- **Status:** open
- **Size:** S
- **Touches:** Uptime Kuma on the VPS (`status.jay739.dev`), then `README.md`:
  the About paragraph's "live status" link, "Live Batcave status" in the
  Batcave section's Proof links, and optionally the header badge's `href`.
- **Why:** there is no public status page. `status.jay739.dev` sends visitors
  to Kuma's admin dashboard (its entry page), so both links point at the
  shields-rendered badge as a stopgap. It shows one line of status and nothing
  about individual services.
- **Fix:** publish a Kuma status page for Batcave (for example
  `/status/batcave`), choosing deliberately which monitors are public, since
  monitor names describe the stack. Then point both links at it.
- **Done when:** both links open a readable public status page, and nothing in
  this README leads to the Kuma admin dashboard.
