---
description: "Write or update CHANGELOG.md following Keep a Changelog format. Use when releasing a new version or backfilling the changelog from git history."
argument-hint: "Version number to document (e.g. 0.0.61), or 'backfill' to generate from full git history"
agent: "agent"
tools: ["#tool:run_in_terminal", "#tool:read_file", "#tool:replace_string_in_file", "#tool:create_file"]
---

Update (or create) `CHANGELOG.md` for this Signal K plugin following [Keep a Changelog](https://keepachangelog.com/) conventions.

## Rules

1. Format every release as:
   ```
   ## [x.y.z] - YYYY-MM-DD
   ### Added
   ### Changed
   ### Fixed
   ### Removed
   ```
   Only include sections that have entries. Keep entries in plain English — one line per change.

2. Place `## [Unreleased]` at the top if there are commits on `main` since the last tag.

3. Newest version first. Do not reorder existing entries.

4. At the bottom of the file maintain a reference block:
   ```
   [Unreleased]: https://github.com/htool/signalk-polar-performance-plugin/compare/vX.Y.Z...HEAD
   [x.y.z]: https://github.com/htool/signalk-polar-performance-plugin/compare/vA.B.C...vX.Y.Z
   ```

## Steps

1. Read `package.json` to get the current version.
2. Run `git log --oneline --decorate` to see tags and commits.
3. If `CHANGELOG.md` exists, read it so you can prepend without losing history.
4. For each version (or just the requested one if an argument was given):
   - Run `git log --oneline <prev-tag>..<tag>` (or `<last-tag>..HEAD` for Unreleased).
   - Categorise each commit into Added / Changed / Fixed / Removed based on its message.
   - **Write every entry from the perspective of a plugin end-user** (a sailor or boat owner using Signal K). Describe what changed in terms of visible behaviour or functionality — not implementation details, refactoring, or internal architecture. For example: prefer "Polar target speed is now shown for all points of sail" over "Refactored interpolation logic in PolarTable.js".
   - Ignore merge commits and automated dependency bumps unless they produce a user-visible change.
5. Write the result: if `CHANGELOG.md` exists, prepend the new section(s); otherwise create the file.
6. Confirm the final content is valid Markdown and the reference links resolve correctly.
