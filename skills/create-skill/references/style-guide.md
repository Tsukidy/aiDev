# Style Guide

Sizing, structure, and verbiage rules for writing skills, distilled from a full review of `mattpocock/skills` (38 SKILL.md files plus repo conventions). Read when writing or editing any skill, and when deciding what moves out of SKILL.md into this kind of reference.

## Sizing (measured across that repo's 38 skills)

- Body: median ~500 words, max ~2,029. Target under ~800 for most skills; a strict-format skill may go to ~1,200.
- Description: median ~17 words, one sentence doing two jobs: what it does + "Use when ..." triggers.
- A skill that needs two sentences can be two sentences. Never pad.

Frontmatter: only `name` and `description` by default; add keys only when they carry meaning (`disable-model-invocation: true` for user-invoked-only skills). This runtime discovers skills by description alone, so trade brevity for triggers where they conflict; compression is good, cutting triggers is not.

## Body structure and flow

1. `# Title`, then 1-3 sentences of framing that name the core model or loop in bold terms ("TDD is the red → green loop"). No "This skill will help you...".
2. The deliverable or output contract, stated up front.
3. How: `## Process` or `## Steps` with numbered steps when work is sequential; task-shaped headings (`## Out of scope`, `## Notes`) when it is not. Headings describe the job, never a template for its own sake.
4. Fixed formats and examples in fenced blocks; tables when the reader picks between options.
5. Reference links for detail, one level deep, each saying what it holds and when to read it.
6. A short `## Why ...` only for a non-obvious design decision; skip otherwise.

## Voice

- Imperative throughout; direct address to the agent's actions.
- One idea per sentence. A sentence that needs a semicolon chain is two sentences.
- Define vocabulary in bold on first use: a **seam** is the public boundary you test at.
- No hedging ("generally", "might be a good idea"), no marketing, no "This skill is designed to".
- Prefer `don't` and `never` plainly over stacked qualifiers.

## Verbiage

- Bold-subject fragments carry whole rules: `**Something's broken** → **/diag**.` No "If the user is experiencing...".
- Rule as a bold fragment, reason as the one sentence after it: `**The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.`
- Contractions freely (`don't`, `can't`, `it's`): spoken-terse, not formal-terse.
- One breath per rule. If a rule needs "and also", it is two rules.
- Trust the model. No explaining why obvious things are true; state the constraint and move.

## Formatting devices

- Arrows for fix patterns: `**Duplicated Code**: same logic shape in more than one hunk → extract the shared shape`.
- Quoted briefs for exact text the agent must reuse (sub-agent prompts, user-facing lines).
- Labeled anti-pattern bullets with the tell: `- **Tautological**: the assertion recomputes the expected value the way the code does. The tell: ...`
- Checklists as `- [ ]` items inside a step when the step is literally a procedure.

## House rules

- No em dashes anywhere in prose; rewrite with a comma, colon, period, parentheses, or a conjunction, never a blind character substitution.
- Each rule stated once, where it executes. If a rule seems to need repeating, the structure is wrong.
- Non-goals in one `## Out of scope` section, not scattered "don't" clauses.

## References and packaging

- SKILL.md carries procedure; references carry detail (examples, schemas, big tables).
- A reference file opens with one line saying what it holds and when to read it.
- Over ~100 lines: a short Contents list. Under: skip it.
- No README, CHANGELOG, or per-skill docs beyond SKILL.md and its references, scripts, and assets.

## Anti-patterns

- Repeated enforcement of one rule across sections.
- A "rules wall" of disconnected bullets when the rules could live inside the steps that use them.
- Placeholder sections, TOCs on short files, template headings nothing fills.
- Explaining the skill's own history or creation process inside the skill.
