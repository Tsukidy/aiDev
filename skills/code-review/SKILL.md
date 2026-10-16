---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (bugs, security, and code quality under the thermos reviewers' rubric) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code hold up under the thermos reviewers' rubric — bugs, breakage, security and devex risk from one reviewer; maintainability, structure and codebase health from the other?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside the parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. The standards axis is thermos

The Standards axis keeps no checklist of its own. It runs [thermos](../thermos/SKILL.md): two reviewer sub-agents whose rubrics together are the complete standards rubric.

- `thermo-nuclear-review` covers bugs, breaking changes, security, devex regressions, and feature-flag leaks.
- `thermo-nuclear-code-quality-review` covers maintainability, structure, file-size growth, spaghetti, and abstractions.

Both reviewer definitions are carried in this tree under `skills/thermos/agents/` and dispatch by bare name — `subagent_type: "thermo-nuclear-review-subagent"` and `subagent_type: "thermo-nuclear-code-quality-review-subagent"`. Each loads its own rubric skill at run time: nothing is pasted into the prompt, and nothing here duplicates the rubric.

### 4. Spawn the reviewers in parallel

**Gather first (this agent).** The thermos reviewers don't run git themselves — the parent collects, once, before spawning: the diff output `git diff <fixed-point>...HEAD` and the commit list `git log <fixed-point>..HEAD --oneline`, plus the full contents of the changed files (through an Explore sub-agent when the set is large).

**Standards axis — both thermos reviewers.** Launch them in the same message, in the background (`run_in_background: true`), each with a prompt of two labeled sections: `### Git / diff output` and `### Changed file contents`. Pass both reviewers the same gathered context, with the pinned fixed point as the diff base, and ask each for prioritized findings with file:line evidence, scoped to the added/modified code only — no pre-existing issues in untouched code:

- `subagent_type: "thermo-nuclear-review-subagent"` for the bug/security/devex pass.
- `subagent_type: "thermo-nuclear-code-quality-review-subagent"` for the code-quality pass.

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

In two stages.

**Within the Standards axis**, synthesize the two thermos reports into one: findings first, deduplicated across the reviewers — a finding both raise counts once and weighs more, not twice. Resolve disagreements with your own judgment and keep it brief; if the individual background summaries are already visible to the user, don't restate them wholesale.

**Across axes**, present the synthesized Standards report and the Spec report under `## Standards` and `## Spec` headings. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that clears every quality and security bar but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but is riddled with breakage and sprawl → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
