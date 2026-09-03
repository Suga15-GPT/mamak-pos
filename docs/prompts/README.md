# How to run this rebuild

Twelve phases, run **in order**, each one a separate session with a fresh context.
Do not run two phases in one session — the second inherits the first's context and
the token cost roughly doubles for no benefit.

## What to do next

Start phase 00. Paste exactly this into a new Sonnet 5 session opened on this repo:

```
Read docs/prompts/_CONVENTIONS.md and docs/prompts/phase-00-safety-net.md,
then do that phase. Do not read any other file unless one of those two names it.
When you are done, run the Verify commands and paste the real output.
```

That is the entire kickoff. Every phase after it is the same line with the next
filename. Nothing else needs to be explained to the model — the phase file carries
the schema, the formulas, the acceptance tests and the scope limits.

## The phases

| Phase | File | Effort | Depends on |
|---|---|---|---|
| 00 | `phase-00-safety-net.md` — migrations, tests, CI | medium | — |
| 01 | `phase-01-module-split.md` — split the two big files | medium | 00 |
| 02 | `phase-02-money-and-tax.md` — **tax is currently never charged** | **high** | 01 |
| 03 | `phase-03-order-integrity.md` — attribution, voids, audit | **high** | 01 |
| 04 | `phase-04-menu-model.md` — item↔modifier links, 86 list | medium | 01 |
| 05 | `phase-05-payments.md` — split bills, multi-tender, discounts | **high** | 02, 03 |
| 06 | `phase-06-realtime.md` — SSE, kill the 3s poll | medium | 01 |
| 07 | `phase-07-offline.md` — outbox, idempotency | **high** | 03, 06 |
| 08 | `phase-08-printing.md` — chits and receipts | medium | 02, 05 |
| 09 | `phase-09-shifts-reports.md` — shifts, drawer, X/Z | medium | 03, 05 |
| 10 | `phase-10-ux.md` — POS ergonomics, kitchen display, BM/EN | medium | 01 |
| 11 | `phase-11-hardening.md` — cookies, CSP, Docker, backups | medium | all |

**Where to spend a bigger model, if the budget only covers three:** phases **02,
03 and 07**. Those are the ones where a confident wrong answer costs real money and
does not look wrong on screen. The rest is well-specified CRUD and layout.

## Shipping order, if you cannot do all twelve

The restaurant can open on 00 → 01 → 02 → 03 → 09. That gets correct bills,
accountability, and a shift that reconciles — the legal and financial minimum.
06, 07 and 08 are what make it pleasant to actually work on. 04, 05, 10, 11 are
what make it competitive.

## Running a phase well

- **One phase, one commit, one review.** If a phase's diff is unreviewable, it took
  on too much — say so in the report rather than continuing.
- **If a phase fails its Verify step twice, stop.** Report what is blocking rather
  than making a third attempt; two failed attempts usually means the prompt's
  assumption about the code is wrong and a human should look.
- **Update `docs/MAP.md` at the end of every phase.** It is the input that keeps
  the *next* phase cheap. A stale map sends the next session exploring, which is
  the single most expensive thing it can do.
- Phases 02, 03, 05, 07 and 09 touch money or order state. For those, the tests
  listed in the prompt are the deliverable as much as the code is.

## A note on scope creep

Every phase file has a "Do not" section. They are there because the most common
failure mode is a model that fixes something it noticed on the way past, turning a
reviewable 200-line diff into an 800-line one where the real change is invisible.
Anything noticed and not fixed goes in the closing report as a line item — that is
how it gets scheduled, and `docs/AUDIT.md` is where it should end up.
