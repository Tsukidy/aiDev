# NOTICE for this skills tree

This tree combines skills from several sources under different licenses. No single license covers the whole tree. In particular, [`LICENSE`](LICENSE) is the pstack-claude MIT license and covers only the pstack-claude parts listed in the first row. Each license file named below is in this tree.

The curation gate (`verify-curation.mjs` in the repository's scripts directory) fails when a skill directory is neither adopted in [`pstack-provenance.json`](pstack-provenance.json) nor named in this file.

## Sources

| Included work | Upstream | Copyright | License |
| --- | --- | --- | --- |
| Every path adopted in [`pstack-provenance.json`](pstack-provenance.json): 59 skill directories (`understand` is upstream's `teach`), the agent definitions `thermo-nuclear-review-subagent`, `thermo-nuclear-code-quality-review-subagent`, `comment-sicko` and `poteto-agent`, and the license and notice files they ship with | [michael-denyer/pstack-claude @ 94f5ce9](https://github.com/michael-denyer/pstack-claude/tree/94f5ce95abe8a9dec976967d79941f631cf477cd), itself a port of cursor/plugins (pstack, cursor-team-kit, thermos) | (c) 2026 Lauren Tan, (c) 2026 Cursor, (c) 2026 Michael Denyer. [`NOTICE-skills.md`](NOTICE-skills.md) gives the split per part | MIT: [`LICENSE`](LICENSE), [`LICENSE-cursor-team-kit`](LICENSE-cursor-team-kit), [`LICENSE-thermos`](LICENSE-thermos) |
| `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `git-guardrails-claude-code`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `improve-codebase-architecture`, `loop-me`, `migrate-to-shoehorn`, `pr`, `prototype`, `research`, `retro`, `scaffold-exercises`, `setup-matt-pocock-skills`, `setup-pre-commit`, `setup-ts-deep-modules`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `wizard`, `writing-beats`, `writing-for-agents`, `writing-fragments`, `writing-shape` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336), forked on 2026-09-25 and compared at 49dd158 | (c) 2026 Matt Pocock | MIT: [`LICENSE-mattpocock-skills`](LICENSE-mattpocock-skills) |
| `resolving-merge-conflicts` | [mattpocock/skills @ 153fc1b](https://github.com/mattpocock/skills/tree/153fc1b93de6584562765cdce299324e1ff9e661/skills/engineering/resolving-merge-conflicts), removed upstream in daa01d8 | (c) 2026 Matt Pocock | MIT: [`LICENSE-mattpocock-skills`](LICENSE-mattpocock-skills) |
| `find-skills` | [vercel-labs/skills @ a80e4c9](https://github.com/vercel-labs/skills/tree/a80e4c9d12d607631249d4d7d059f835d4b2f13a/skills/find-skills) | (c) 2026 Vercel, Inc. | MIT: [`LICENSE-vercel-skills`](LICENSE-vercel-skills) |
| `web-design-guidelines` | [vercel-labs/agent-skills @ 063bee9](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines) | Vercel (the skill's `author`). The upstream repository has no license file or copyright line | MIT, as declared in the upstream README |
| `frontend-design` | [anthropics/skills @ dbd4588](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design) | Anthropic | Apache-2.0: [`frontend-design/LICENSE.txt`](frontend-design/LICENSE.txt) |
| `question-guidelines` | None. Written for this repository | This repository's authors | No license file |

## Local changes

Files this repository changed after copying them are listed by source:

- pstack-claude: each changed file is in the `modified` list of [`pstack-provenance.json`](pstack-provenance.json), with its reason.
- mattpocock/skills: the fork uses `CONTEXT.md` where upstream uses `GLOSSARY.md`, reworks `implement` and `code-review` for this workflow, and makes smaller local fixes. Git history records each change. `pr` adapts Dex Horthy's `show-me` skill (humanlayer/skills, MIT), and its frontmatter carries that credit, as upstream's does.
- `find-skills`, `web-design-guidelines`, `frontend-design` and `resolving-merge-conflicts` are unchanged from the upstream commits above.
