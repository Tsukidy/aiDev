---
name: create-skill
description: Create or edit agent skills that are scoped, terse, and self-contained, with optional references, scripts, and assets. Use when the user wants a new skill built, an existing one restructured or de-bloated, or asks how skills should be written.
---

# Create Skill

A skill is an onboarding guide for one job: the procedural knowledge a general model lacks. Write the guide, not documentation about it.

Deliverable: a self-contained folder, `SKILL.md` plus optional `references/` (detail), `scripts/` (deterministic code), `assets/` (files used in output), packaged as a `.skill` zip.

## Process

### 1. Understand the job

Get concrete usage before writing: two or three real invocations ("remove the red-eye from this image") and the trigger phrases a user would say. No examples yet → ask. Skip only when the job is already clear.

### 2. Plan the contents

For each repeating piece of work, decide where it lives: the same code rewritten every time → `scripts/`; the same schema or domain detail consulted → `references/`; the same boilerplate emitted into output → `assets/`. Procedure stays in SKILL.md.

### 3. Scaffold

`scripts/init_skill.py <name> --path <dir>` creates the folder and template. Delete every example file the skill doesn't use.

### 4. Write

Follow [references/style-guide.md](references/style-guide.md). Hard budgets:

- Description: what it does + "Use when ..." triggers, one sentence.
- Body: under ~800 words; a strict-format skill to ~1,200. A good repo's median is ~500.
- Structure: framing names the model → the deliverable → numbered Process → fences and tables → reference links → a rare Why section.
- Voice: imperative, one idea per sentence, contractions fine, no hedging, no filler openers.
- Each rule stated once, where it executes. Non-goals in one `## Out of scope` section.
- No em dashes anywhere; rewrite with a comma, colon, period, parentheses, or a conjunction, never a blind substitution.

### 5. Package and validate

`scripts/package_skill.py <folder> [out-dir]` validates frontmatter, structure, and references, then zips. Fix and rerun until it passes.

### 6. Iterate

After real use, fold each fix into the rule that exists, or delete that rule and write the principle it was patching. Never stack a new patch on an old one.

## Checklist

1. One sentence: what it does + triggers?
2. Under budget, or the detail moved to a reference?
3. The model named in the first two sentences?
4. Every rule once, where it executes?
5. Numbered steps for sequence, task-shaped headings otherwise?
6. Fences for formats, tables for choices, arrows for fixes?
7. No em dashes, no hedging, no placeholder sections?
8. Non-goals in one place?
9. Links one level deep, each saying when to read it?
