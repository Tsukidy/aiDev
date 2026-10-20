# Field Guide

Per-field detail with examples, edge cases, what to ask about, and the calibration example. The admission test in SKILL.md decides what enters: a line about the session rather than the system never does.

## Fields

Field examples and detail the SKILL.md rules don't carry; the rules themselves live there.

### Return address
Exactly as given; never reconstruct from partial data.

### Subject
No root cause found → symptoms + next step: `Laptop won't boot, no POST, bench diagnostics next`.

### Issue reported
Good: "The C drive failed; a vendor replacement was already installed and the PC sat at the Windows 11 setup screen. Separately, Windows hangs whenever the PC idles with nothing running; keeping something running holds it off." Bad: arrival dates, who built the installer, where things were left standing. Vagueness stays visible: screen "goes weird" with no further detail given.

### Troubleshooting
Finding shapes: ruling-out ("memory, storage and files look fine"), evidence ("one core is throwing errors"), interim fix with its purpose ("turned off CPU performance boost to cut down the crashes until she can ship it").

### Resolution plan
Conclusion once, where it explains the action: "replace the failing CPU". Logistics examples: warranty window ("out of the 3-year window"), exact charges ("$45 return shipping; inbound label optional for another $45"), shipping and packing ("packing guide PDF sent 10/12; she doesn't have the original box"), paperwork ("do not wipe" on the RMA form), test-before-return, timing.

### Open items
Task shapes: "issue the RMA number", "call her this afternoon to help set up TeamViewer". Unanswered question shape: "which CPU upgrade options and price ranges to send her".

## Edge cases

- **Multiple issues:** the dominant issue owns the note; minor extras become tagged bullets where they land; a co-dominant second issue gets its own `Issue reported` + `Troubleshooting` blocks.
- **No resolution:** the Resolution plan states the next step and what it depends on ("await crash dumps; callback Thursday after she reproduces the error").
- **Missing dates:** `(date not stated)`; never guess.
- **Chat or email thread:** same format; message timestamps are the chronological anchors.
- **Customer identity:** name and pronouns from the transcript; never assume gender.
- **Third parties:** attribute explicitly ("her husband confirmed the lights flicker").
- **Ticket/CRM:** raw Markdown pastes cleanly; if the target system needs other markup, ask before converting.
- **Conflicts:** record the conflict, don't invent a resolution ("customer says it crashes hourly; event log shows 3 this week").
- **Missing information:** ask the user; never search the filesystem or the vault, never shell-process the material.
- **Empty sections:** Return address blank; other empty sections one `- None` bullet; no bare headers, no apologies.

## Asking

Material gaps only: name or pronouns when unclear and referenced often; return address when a return is planned; dates for promised actions; exact amounts and case numbers when garbled; an ambiguous final outcome; contradictions only the user can resolve.

Not worth asking: anything the transcript answers; gaps with no consequence (a return address when nothing ships); more than 4 questions; anything already asked.

Format: one batched numbered list, each question naming its field, ending with `Reply "skip" and I'll mark these (not stated)`. After one round, write the notes.

## Calibration example

Match its structure, tone, and detail level only. Never reuse its wording; every note is written fresh from the transcript at hand. The layout must match exactly:

```markdown
**Return address:**

**Subject:** Desktop crashing / black screen, failing CPU, depot repair

**Issue reported (Sun 10/11):** The computer shut itself off several times and showed a black screen (she sent a photo).


**Troubleshooting:**

- Remoted in over TeamViewer. The session dropped a few times because the PC crashed and restarted, and it needs a password at login.
- The event log shows one CPU core throwing errors; Windows had been correcting them quietly, but they’ve gotten worse fast over the past few weeks and are now crashing the system.
- Memory, storage and files look fine.
- Interim fix: turned off CPU performance boost to cut down the crashes until she can ship it.


**Resolution plan:** Depot repair to replace the failing CPU, then test before return.

- Out of the 3-year window, so there’s a $45 return shipping charge. An inbound label is optional for another $45.
- Packing guide PDF sent 10/12. She doesn’t have the original box.
- If she can’t get in to back up her files, she’ll note “do not wipe” on the RMA form.


**Open items:**

- Issue the RMA number and paperwork, and confirm whether she wants our inbound label
- Answer her questions: is there one processor or several, is this a good time to upgrade the CPU, and what are the price ranges
- Help her back up her data if she can get to the desktop
- **Separate request:** she wants her original EZ PC looked at remotely to see if it can be brought back for a spare or for her mom. You offered to do it today if she gets it online with TeamViewer, or to call her this afternoon to help set it up.
```
