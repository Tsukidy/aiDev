---
name: implement
description: "Execute a crewmate brief or spec'd ticket, feature or bug fix: build features test-first at the brief's agreed seams, fix bugs through tdd, blast-radius before risky integration, show-me-your-work on unattended runs, fix-ci on red checks, then code-review and commit."
---

Implement the work described in the brief, ticket, or spec. This is the crewmate-facing execution doctrine: you arrive dispatched with a brief, and you execute it through the skills below.

## Take the ticket

Fetch the ticket or issue (per `docs/agents/issue-tracker.md`, when the repo has one) and read it whole before touching code. The brief's **agreed seams** and **acceptance criteria** are the contract: the seams fix where tests go, the criteria fix what done means. Reversible details are yours to decide; anything that would change the brief's shape goes back to the dispatcher rather than guessed at mid-change.

## Execute at the seams

- **Feature work**: write the failing test first at the seams agreed in the spec or brief, then only the code needed to pass it. One seam and one test per cycle. If the work needs a seam the brief did not agree, take it back to the dispatcher instead of testing there.
- **Bug fix**: use /tdd. The bug picks its narrowest executable check, which fails before the fix and passes after it.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Before building on a claim the brief makes about existing code ("X already handles Y", "make X public"), run /blast-radius — the assertion is a hypothesis until the caller census proves it, and the census can change the design.

On an unattended or multi-phase run, keep a decision trail with /show-me-your-work so a reviewer who wasn't there can retrace what you did and why.

If the PR's checks go red, /fix-ci: find the first actionable error and fix it focused, rather than re-rolling the suite blind.

## Review, then commit

Once done, use /code-review — two axes: Standards (thermos reviewers) and Spec (the diff against the originating issue). Link the report on the ticket or issue so the review gate can see it.

Commit your work to the current branch.
