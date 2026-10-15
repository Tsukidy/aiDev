---
name: it-support-call-notes
description: Turn IT support / technical service call transcripts (phone, chat, remote-session log, or email thread) into structured "call overview" notes for an IT technical support ticketing system, covering symptoms, troubleshooting, resolution, and open items. Also updates previously written notes from follow-up additions, asking targeted questions when material information is missing and reissuing the complete notes after any change. Use when summarizing a support call, writing call notes, making a call overview, documenting a service call, or adding to existing call notes.
---

# IT Support Call Notes

Turn a service call transcript into the permanent call record for an IT support ticket. Write for the ticket's future reader: the next tech, billing, the customer record.

The ticket records the system and the agreement, never the session. Each line concerns the system (state, evidence, ruling-outs, changes), the agreement (plan, logistics, charges, promises), or the customer (questions, tasks). Session detail is out, whatever the topic: reconnect counts, reboots, attempt tallies, menus, key presses. Admission test: would a future ticket reader act differently, or understand the machine better, because of this line? If not, it does not go in. A session detail enters only as evidence of the reported issue (the session dropped because the PC crashed) or as an obstacle that stopped the work.

Deliverable: raw Markdown in one fenced markdown code block. Raw: every `**` marker, `- ` bullet, and blank line copies out intact, one click into the ticketing system.

## Process

### 1. Scope the input

Read the transcript the user provided, end to end: participants, channel, dates, attachments.

That transcript, the user's answers, and the existing notes when editing are the only input. If it looks incomplete, ask; never hunt:

- Read nothing else: filesystem, documents, email, chat histories, note stores such as an Obsidian vault. A file that looks relevant is still out of scope. This scopes the call, not this skill's [reference file](references/field-guide.md).
- No shell tools (grep, sed, awk) on the transcript or notes.
- No writes, and no offers to write, unless asked.

### 2. Extract

Sort the facts into five buckets: symptoms (customer's terms, frequency, evidence), troubleshooting findings (diagnostics, ruling-outs, evidence behind the conclusion, interim fixes, system-related answers given on the call), resolution and logistics, open items (only what remains open), side requests.

### 3. Ask once, if needed

A gap earns a question only if it changes the record or blocks action: a return address when something ships, a promised callback date, a garbled amount or case number, an ambiguous outcome, a contradiction inside the transcript. One batched numbered list, max 4, each naming its field, ending with: reply "skip" and the gaps get `(not stated)`. Then write; never re-ask.

### 4. Write

Fill the format below exactly. Every statement traces to the transcript or the user's answers; mark missing facts `(not stated)`.

### 5. Check, then deliver

- One fenced markdown code block, never rendered chat markdown, every marker intact.
- Nothing relevant dropped. No answered question in Open items. Issue reported within budget. No line fails the admission test. No em dash.
- Commentary outside the block: clarifying questions and change notes only. No tips, offers, apologies, or sign-offs.

## Format

```markdown
**Return address:**

**Subject:** <main symptom / key detail, root cause if known, planned action>

**Issue reported (<Day MM/DD>):** <what the customer reported: all symptoms, severity/frequency, when it started, evidence such as photos or error text>


**Troubleshooting:**

- <tech actions and findings in chronological order; diagnostics, diagnosis, interim fixes>
- ...


**Resolution plan:** <the agreed fix: repair/replace/retest/escalate/callback>

- <logistics: warranty status and window, charges with amounts, shipping labels, packing guide, paperwork, data-handling notes, timing>


**Open items:**

- <pending task and who owes it, with any committed time>
- <question still awaiting an answer, phrased as a question>
- **Separate request:** <unrelated request with something still pending, and what was offered>
```

Blank lines are format: one between the three header fields, two before each section header, one between a header and its first bullet, none inside a bullet list, no trailing spaces. All six sections always appear.

## Writing rules

State each fact once, in the field it belongs to:

- **Dashes**: no em dashes, en dashes, or double hyphens → use a comma, semicolon, colon, parentheses, or two sentences. Compound hyphens (follow-up, 3-year) are fine; verbatim quotes keep their characters.
- **Subject**: comma-separated fragments, 5-12 words: symptom / key detail, root cause, planned action (`Desktop crashing / black screen, failing CPU, depot repair`).
- **Issue reported**: one to three sentences at the example's density. One clause per symptom, with frequency and start point; evidence in parentheses ((she sent a photo)). History and setup narration → compress to a clause or drop. Date as `Day MM/DD` or `(date not stated)`.
- **Voice**: third person, past tense, the customer's name and pronouns as found in the transcript. Error messages, counts, prices, models, serials, case numbers stay verbatim.
- **Language**: the notes and all commentary match the conversation's language; never switch languages mid-response.
- **Troubleshooting**: findings, not narration. Each bullet is evidence (what a check showed), a system change, or a ruling-out; name the remote tool once at most. Negative results stay ("memory and storage tested fine").
- **Conclusion**: no "Diagnosis:" bullet → state it once in the Resolution plan's opening line; the Subject fragment summarizes it. Certainty vocabulary: "based on current findings", "the current theory is", "consistent with", "most likely cause", "root cause" (confirmed), "not yet confirmed". Never "the tech's best explanation".
- **Resolution plan**: the action on the first line (repair, replace, retest, escalate, callback, next diagnostic step); logistics as bullets: warranty window, charges with amounts, labels, packing, paperwork and RMA, data handling, timing.
- **Answered questions**: no section. A system-related answer becomes a Troubleshooting finding; the rest drops by the admission test.
- **Open items**: only what is still open: tasks with owners and committed times, promises, unanswered questions phrased as questions. Answered questions and completed side requests never appear.
- **Separate request**: tag side topics wherever they land → Open items if pending, Troubleshooting if completed on the call. No placeholders ("none raised").
- **Empty sections**: Return address stays blank; every other empty section gets one `- None` bullet. Never a bare header.

## Follow-up edits

When the user adds or corrects after delivery ("add ... to troubleshooting", "the return address is ..."):

- Route each addition: actions and findings → chronological spot in Troubleshooting; logistics → Resolution plan; tasks and unanswered questions → Open items; a question now answered → out of Open items, its substance into Troubleshooting if about the system; addresses, names, dates → their own fields.
- The user's correction overrides the transcript. Untouched content stays verbatim.
- Reissue the complete notes in the same fenced block: never a diff or excerpt. Later rounds stack on the latest copy.

## Reference

Read [references/field-guide.md](references/field-guide.md) for field examples, edge cases, what to ask about, and the calibration example (structure, tone, density; never reuse its wording).
