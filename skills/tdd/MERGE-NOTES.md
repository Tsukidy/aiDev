# tdd merge notes

Ticket 03 of spec #11 (decision D2 in `docs/combined-fleet-workflow.md`): `tdd` is a merge, not a pick. This file is the line-by-line accounting of both parents — where every idea landed, and every conscious drop or transformation. Nothing from either parent is contradicted or silently dropped.

The parents:

- **Fork tdd** — the pre-merge `skills/tdd/` (`SKILL.md`, `mocking.md`, `tests.md`, `agents/openai.yaml`), Matt Pocock's fork. Feature-building doctrine: good test = public interface, seams pre-agreed with the user, anti-patterns, red → green loop rules, refactoring belongs to review.
- **Upstream tdd** — `/tmp/pstack-research/pstack/plugins/pstack/skills/tdd/SKILL.md` (read-only reference; deliberately not copied by ticket 02). Bug-fix regression workflow: failing-before evidence, smallest fix, impractical-test escape hatch, guardrails, evidence-reporting.

Result: one `skills/tdd/` — the fork's skeleton and doctrine as the base, the upstream bug-fix workflow folded in as a first-class section. Files touched: `SKILL.md` (rewritten), `tests.md` (one paragraph added), `agents/openai.yaml` (short description widened). `mocking.md` unchanged (accounted below).

## Section map — merged SKILL.md

| Merged section | From fork | From upstream |
|---|---|---|
| Frontmatter `description` | feature trigger kept near-verbatim ("build a feature test-first", "red-green-refactor", "integration tests") | bug trigger ("obvious, cheap local test path — even when TDD wasn't asked for") + skip clause ("unclear, expensive, integration-heavy, or not requested") carried over; see resolution R4 |
| Intro paragraph | fork's intro ("TDD is the red → green loop. This skill is the reference…") expanded to name the two modes (feature work / bug fixes) | supplies the bug-mode half of the two-mode framing ("a focused regression test that fails before the fix and passes after it" is upstream's intro sentence) |
| CONTEXT.md paragraph (read `CONTEXT.md`, respect ADRs) | verbatim | — |
| What a good test is | fork paragraph verbatim, plus one added sentence extending the doctrine to regression tests ("encodes the intended behavior, not the way the buggy code currently behaves") | that added sentence restates upstream workflow step 3's clause ("encode intended behavior, not mirror the current implementation"), which also survives verbatim in step 3 |
| Seams: where tests go | fork paragraphs kept: seam definition, "test only at pre-agreed seams" (prefixed "Feature work:" per R2), the ask, the `codebase-design` pointer | one added paragraph, "Bug fixes: the bug chooses the seam" — the by-phase resolution R2; upstream's narrowest-check idea (its step 2) is cross-referenced |
| Anti-patterns | verbatim (implementation-coupled, tautological, horizontal slicing / vertical slices, tracer bullets) | — |
| Rules of the loop | all three fork rules kept: "Red before green", "One slice at a time", "Refactoring is not part of the loop" | "Red before green" gains one clause pointing at the bug-fix evidence step ("red comes with evidence — the failure is quoted and checked against the bug"); see resolution R1 |
| Fixing bugs: the regression workflow (opening paragraphs) | — | upstream intro verbatim ("make the broken behavior executable…") and the "Do not force a test when it would be impractical…" paragraph verbatim, plus one added sentence on where feature work settles practicality (resolution R3) |
| Workflow steps 1–6 | — | upstream steps 1–6 verbatim, including the full quote-the-failure-content rule in step 4 and "smallest production change… preserving nearby contracts" in step 5 |
| If a failing test is impractical | — | upstream section verbatim (title case lowered to sentence case to match the fork's heading style); both paragraphs intact, including "Prefer no new test over a bad test" and the full bad-test definition |
| Guardrails | — | all five upstream guardrails verbatim |
| Final response | — | all three upstream evidence-reporting bullets verbatim |

## Sibling files

### tests.md (one paragraph added)

The fork's "Bad Tests" section covered implementation-detail and tautological tests. Upstream's bad-test definition (from "If a Failing Test Is Impractical") names characteristics the fork's red-flag lists did not: mostly tests mocks, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, would be deleted immediately after proving its point, and the "prefer no new test" action. Those landed as a new **Bad-for-the-job tests** paragraph at the end of "Bad Tests" — tests that go through the public interface and still aren't worth keeping. The upstream list remains in full in `SKILL.md`'s escape-hatch section too; `tests.md` carries it where the fork's test-quality examples live so the two documents agree.

### mocking.md (unchanged)

Checked upstream for mocking-relevant content:

- "A bad test is one that mostly tests mocks" — already this file's doctrine ("Don't mock: your own classes/modules, internal collaborators, anything you control"), and now also named in the new `tests.md` paragraph. No edit needed.
- "brittle mocks" (upstream's impracticality list) — addressed by this file's "Designing for Mockability" section (dependency injection, SDK-style interfaces), which is the fork's standing answer to mock brittleness. No edit needed.

### agents/openai.yaml (kept, description widened)

Fork file kept as the base. `short_description` widened from "Test-driven red-green-refactor" to "Test-first features and bug regressions" so the display metadata covers both trigger spaces; `display_name` unchanged.

## Conflict resolutions (explicit, by phase)

- **R1 — what "failing test first" must prove.** Fork: the test is written first and only enough code is added to pass it. Upstream: the test is *run* before the fix, the failure is *quoted*, and only a failure that matches the bug (an exception, an empty result against a literal, the predicted mismatch — not an unrelated error) proves the test measures the bug. These compose rather than conflict: red-before-green stays the universal loop rule; the evidence discipline is scoped to the bug-fix workflow (step 4) and referenced from the loop rule rather than blended into it. Feature slices keep the fork's rule as written.
- **R2 — where the test goes.** Fork: seams are written down and confirmed with the user *before any test exists*. Upstream: pick "the narrowest executable check" on the affected path, no agreement step. Resolved by phase, stated in the Seams section: feature work keeps the pre-agreed-seams rule untouched; a bug fix reads "the bug chooses the seam" — the failure itself fixes where the test goes, the public-interface rule still holds, and the narrowest-check choice is upstream's step 2.
- **R3 — whether a test is written at all.** Fork: feature TDD always writes tests; that is the mode, and the seam agreement is where testing effort is budgeted. Upstream: "prefer no new test over a bad test", skip when impractical. Resolved by phase: the escape hatch is scoped to bug fixes, and a sentence in the workflow's opening makes the boundary explicit — in feature work, practicality is settled when the seams are agreed; the hatch is the bug-fix counterpart where no seam conversation happened. The "prefer no new test over a bad test" maxim itself is general doctrine and appears in both the workflow section and `tests.md`.
- **R4 — description scope.** The fork's description already said "build features or fix bugs test-first" (underspecified: it gated bugs only through the test-first phrase, with no cheap-test trigger and no skip clause); upstream's gated to bugs only ("Use only when…"). The merged description carries the fork's feature triggers near-verbatim, upstream's bug trigger (explicit cheap-test path, even unrequested) and upstream's skip clause, scoped explicitly to the bug-fix regression.
- **R5 — minimality.** Fork: "only enough code to pass it" (loop rule). Upstream: "the smallest production change that satisfies the intended behavior while preserving nearby contracts" (step 5). Both kept in their sections; they are the same minimality doctrine at different granularity, and upstream's adds the preserve-nearby-contracts clause the fork lacked.
- **R6 — title and framing.** Upstream's title "TDD Bug Fix" is dropped: the merged skill is not bug-only, and a bug-only title would contradict the fork's feature doctrine by omission. The workflow itself is retained in full under "Fixing bugs: the regression workflow".

## Consciously dropped

Nothing. Every paragraph of both parents appears in the merge, transformed only as recorded in the section map and resolutions above.

## Downstream tdd-framing audit

Grep of `skills/` for `tdd` mentions outside `skills/tdd/`, and what was done:

- `skills/poteto-help/SKILL.md` — map row was "Fix a bug test-first when a cheap local test exists" → bug-only framing. Updated to "Build a feature test-first, or fix a bug with a failing-first regression test". Link target unchanged.
- `skills/poteto-help/references/recipes.md` — "Bug with a cheap test: … /tdd it" — a bug-context recipe, not a claim that tdd is bug-only; consistent with the merged skill's bug trigger. Left as is.
- `skills/poteto-mode/playbooks/bug-fix.md` — points at the tdd skill for "the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear." Bug playbook, and its skip clause matches the merged escape hatch verbatim in spirit. Left as is.
- ask-matt's SKILL.md (as audited here, recoverable at 823d5ed; the skill itself was retired in ticket 05), `skills/implement/SKILL.md` — feature-side mentions ("build a concrete behaviour test-first", "at pre-agreed seams"); not bug-only framings and consistent with the merged doctrine. Left as is.
