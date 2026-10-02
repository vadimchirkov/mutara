# Mutara

Mutara is the reusable library in `src/`; Alchemy is one consumer under
`examples/alchemy/`. Read `README.md` for installation and project structure.

For integration work, read `skills/mutara/SKILL.md` and only the references needed
for the task. Its runnable adapter is also the source of the minimal demo.

Public exports live in `src/index.ts`. Consumers must import `mutara`, not internal
files. Keep credentials, private recipe data and journals out of the distributable.

Use `pnpm typecheck`, `pnpm test`, `pnpm demo`. Packaging/API changes also need
`pnpm test:package`, which installs the archive in a clean temporary consumer.
Alchemy benchmarks need the existing local recipe file; do not fetch or publish it.

Implementation hashes distinguish source TS from built JS. Preserve old journals
and reports; create new experiment IDs/databases after behavior-changing edits.
Do not rewrite history to make replay pass or describe smoke tests as measured gains.

## Writing rules (always on)

When you write prose (docs, comments, messages, README, site copy):

- No em dashes. Use commas, colons, or hyphens.
- Vary sentence length. Follow a long sentence with a short one. Fragments are fine.
- Cut AI vocabulary: delve, leverage, utilize, robust, comprehensive, streamline, furthermore, moreover, "it's worth noting", "in today's landscape".
- No rule-of-three by reflex, no tidy summary closing every paragraph, no "In conclusion".
- State facts, not their significance. Delete "represents / underscores / highlights".
- Prefer active voice and a named actor over agentless passive.
- One defensible stance over both-sides mush. Concrete numbers, names, examples over abstractions.
- Never rewrite inside quotes or code blocks.

For sites: one idea per section, inverted pyramid, headings + short paragraphs, 16px+ body, 4.5:1 contrast, 24px+ targets, keyboard accessible, alt by purpose. Semantic HTML (`header/main/article`), JSON-LD where it matters.

On demand: `humanize` (rewrite), `ai-check` (forensic score), `writing-guidelines` (docs audit), `web-design-guidelines` (UI audit), `accessibility` (WCAG 2.2 audit), `userinterface-wiki` (152 UI rules), `humanizer` (55 patterns, `--score`).

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
