# Accounting and e-invoice: plan

Status: **plan only — nothing built yet.** Starts after PR #20 is merged and
running in the shop. Written 1 Oct 2026.

## 1. What the owner gets

- **Accounting:** every sale, refund, cash movement and expense the POS already
  records also goes into proper books (double entry). From those books the
  POS shows profit and loss, a cash book, the SST figures for the SST-02 return,
  and an export the accountant can load.
- **e-Invoice:** the POS can give a customer a valid LHDN e-invoice when they
  ask for one, and can produce the monthly consolidated e-invoice for every
  other sale. It connects to LHDN's MyInvois only if the shop has to, or wants to.

## 2. The rules this plan is built on (check with the shop's tax agent)

| Rule | What it means for this shop |
|---|---|
| Since **1 Sep 2026** (e-Invoice Guideline v4.8, dated 30 Aug 2026), a business with annual turnover **under RM3 million** that meets the guideline's conditions (§1.6.10) is **exempt** from e-invoicing, and may stop issuing them without applying. The exemption does not apply if a shareholder company, holding company or related company turns over RM3m or more. | **A single mamak shop under RM3m a year is most likely exempt.** RM3m a year is about RM8,200 a day. So the e-invoice work is *optional* unless turnover is above that, or the shop belongs to a bigger group. |
| Shops above the threshold: B2C sales can go on **one consolidated e-invoice a month**, submitted within **7 days after the month ends**. Restaurants are allowed to consolidate. | One monthly document instead of one per bill. |
| A customer who **asks** for their own e-invoice must get one, and that sale then stays out of the consolidated one. | A "request e-invoice" path from the receipt. |
| Any **single sale over RM10,000** needs its own e-invoice. It can't go on the consolidated one. | Rare at a mamak (large catering orders). |
| A receipt for a validated e-invoice carries LHDN's QR code / validation link. | The receipt layout needs a QR slot. |
| A validated e-invoice can be **cancelled within 72 hours**. After that, a correction is a credit note or refund note. | Refunds map to refund notes, later discounts to credit notes. |
| Suppliers above the threshold send the shop e-invoices for its purchases. They are the evidence for the expense. | Expenses should keep the supplier's e-invoice reference. |
| Businesses must keep their records for **7 years**. | The books must never be wiped. See 6.2: *Clear sales data*. |
| **SST:** service tax on F&B is 6%, and a restaurant only registers once its taxable turnover passes RM1.5m a year. | **Check now** (see 6.1): the POS adds SST at 6% by default (`tax_rate_bp = 600`). |

## 3. Questions for the owner before any building starts

1. **Annual turnover**, roughly, and does the shop belong to a company that
   owns other businesses? (This decides whether e-invoicing is required.)
2. **Is the shop registered for SST?** If it isn't, it must not charge SST, and
   the till's 6% has to go to 0.
3. **Who keeps the books now**, and in which software (SQL Account, AutoCount,
   Xero, QuickBooks, Excel)? That decides the export format.
4. **Has any customer asked for an e-invoice** (companies buying meals or catering)?
5. **Bank:** which bank, and do card and DuitNow payouts arrive daily, with fees
   taken off?
6. **TIN, SSM/BRN number and MSIC code** (56101, restaurants, is usual). These are
   only needed if e-invoicing goes ahead.

## 4. Phases

Each phase is its own PR, reviewed by R the usual way (a request in
`review-notes/requests/`, race scripts run 40 times, Malaysia time and UTC).

### Phase A — the books (needed whatever happens with e-invoicing)

**A1. Ledger tables** (migration 023):
- `ledger_accounts`: a chart of accounts seeded for a mamak (Cash in drawer,
  Card clearing, e-wallet clearing, Bank, Sales — food, Sales — drinks, Service
  charge, SST payable, Rounding, Discounts given, Refunds, one expense account per
  expense category, Card fees, Owner's drawings, Opening balance).
- `ledger_entries` and `ledger_lines`, in integer cents like everything else. A
  constraint trigger makes every entry balance (debits = credits) at commit.
- `ledger_periods`: one row per month, open or locked.
- **Posted entries are never edited or deleted.** A correction is a reversing
  entry plus a new one. This is the same rule as "closed bills stay closed",
  enforced by a trigger, as migration 015 does for orders.

**A2. Posting from what the POS already records:**

| Event | Entry |
|---|---|
| A day's sales (one entry per KL calendar day, built from the Z report's own money CTE, so the books and the Z report cannot disagree) | Dr cash / card clearing / e-wallet clearing; Cr sales by category; Cr service charge; Cr SST payable; ± rounding; discounts shown gross |
| Refund | The reverse, on the day the refund was given |
| Cash pay-in / pay-out | Cash against owner's drawings or petty expenses |
| Expense (manual, photo, voice, regular) | Dr its category's account; Cr cash / bank / card by its method |
| Voided expense | Reversing entry |
| Card or DuitNow payout reaching the bank | Dr bank, Dr card fees; Cr card clearing (entered by the owner, or later from a bank CSV) |

- **Daily, not per bill:** one entry a day per source keeps the books readable and
  matches how the owner thinks (the Z report). Each posting has an idempotency key
  (`sales:2026-10-01`), so posting twice does nothing.
- **When it posts:** a sweep posts every finished day automatically. A late
  change to a posted day (a refund at 00:05 of a bill from yesterday is today's
  refund, so that is fine; an expense dated last week is not) posts as an
  adjustment on the day it was entered, or is refused (409) if the month is locked.
- **Locks:** posting takes the bill lock (`src/lib/billlock.js`), so it can't race
  a payment or refund at midnight.

**A3. Screens** (new 📒 Accounts tab, admin only, `feature_accounting` module, off by default):
- Profit and loss for a month or year: sales, less refunds and discounts, less
  expenses by category, giving profit, with the same months last year.
- Cash book: what came into and went out of the drawer, day by day, matching
  each shift's cash-up.
- Card and e-wallet clearing: what is still owed by the bank, with "Record payout".
- SST: taxable sales and SST charged for each two-month SST period, laid out
  like the SST-02 return.
- Month close: "Lock September". After that, nothing can change September's figures.
- Export: a journal CSV (date, account, debit, credit, memo) plus one ready
  template for the accountant's software (question 3).

**A4. Tests and review:**
- Unit: every entry balances; for each day, the books equal the Z report (the
  1,463-bill ZDAY data R already uses); posting twice changes nothing; a locked
  month refuses changes.
- R's checks: posting racing a payment or refund at midnight (KL time and
  UTC), month lock racing an expense save, and Clear sales data against the books.

### Phase B — e-invoice ready (built only if question 1 or 4 says so; no connection to LHDN yet)

**B1. Shop details** in Admin → Shop: TIN, SSM/BRN, MSIC code and description,
SST number (already present), and the address in LHDN's fields.

**B2. Documents** (`einvoice_documents`): type (invoice, credit note, refund note,
consolidated), status (draft, submitted, valid, invalid, cancelled), our number
(one unbroken sequence per type), LHDN UUID and long ID once validated, the
payload sent, the errors returned, and links to orders, refunds and the month.

**B3. Customer asks for one:**
- Every receipt (printed and the card's QR page) gets a short link, "Need an
  e-invoice? Scan here".
- The customer enters TIN or IC, name, address, email and phone on their phone,
  within the same month. Staff can also enter it at the till.
- The request is checked: the bill is paid, it isn't already on a document, and
  it falls in the current month. A draft document is then made, and the bill is
  marked so it is left out of that month's consolidated document.

**B4. Monthly consolidated document:**
- On the 1st, the POS drafts last month's document. Its lines are the paid bills
  (or ranges of receipt numbers), with bills that got their own e-invoice left
  out, and any sale over RM10,000 flagged.
- Due by the 7th. The Accounts tab shows "September's consolidated e-invoice:
  due in 6 days".

**B5. Refunds and corrections:**
- A refund of a bill that has its own e-invoice makes a refund note.
- On a consolidated month, it goes into the next consolidated document as the
  guideline describes. The tax agent should confirm which form applies.

**B6. Supplier side:** Expenses gains "Supplier e-invoice no. / UUID" (scan the
QR on the supplier's invoice). The P&L can then show which expenses have
e-invoice evidence.

**B7. Output without an API:** an export in the MyInvois Portal's batch-upload
format, so the owner (or the agent) uploads it by hand. No certificate is needed
and no keys are kept in the POS. **For a small shop this may be all it ever needs.**

### Phase C — direct MyInvois connection (only if B7's manual upload is too much work)

- LHDN's preproduction (sandbox) first, then production.
- Log in as the taxpayer with client ID and secret from the MyInvois portal. The
  credentials go in `.env` only: the repository is public.
- Documents in UBL 2.1 JSON, signed with a digital certificate from an
  MCMC-licensed certificate authority. That is a yearly cost for the shop.
- Submission goes through an outbox, like the offline order queue. The till
  never waits on LHDN: the receipt prints at once and its QR fills in when LHDN
  validates the document. Status is polled and retried, and a document LHDN
  rejects shows on the Accounts tab with LHDN's reason.
- Cancel within 72 hours from the screen. After 72 hours, only a credit or refund
  note is possible.
- Signing, submission and polling get unit tests against a local stand-in for
  MyInvois, the same way the Gemini stand-in works.

## 5. Order of work

1. Finish PR #20: R re-check 3 on the fixes just made, merge, update the shop,
   and walk the tills with the new RUNBOOK steps.
2. Get answers to the questions in §3. **A wrong SST setting (question 2) is a problem today, not later.**
3. Phase A (A1–A4) as one PR, possibly split into A1–A2 then A3.
4. Phase B, only if needed: B1–B4 and B7 first, B5–B6 after.
5. Phase C, only if needed.

## 6. Risks and decisions

### 6.1 SST at 6% by default
Migration 002 seeded `tax_rate_bp = 600`, and the receipt prints "SST". If the
shop isn't SST-registered, it is charging customers a tax it may not collect.
Confirm with the owner, and set the rate to 0 in Admin if the shop isn't registered.

### 6.2 Clear sales data versus the books
Clear sales data moves bills into archive schemas so the figures start from
RM0. The books must not be cleared: there is a 7-year record-keeping duty,
and an e-invoice already sent to LHDN can't be unsent. Proposal: Clear sales
data leaves the ledger and the e-invoice documents as they are, and is refused
for a month that is locked or has a submitted document. That is a change in
behaviour, so R needs to review it.

### 6.3 Other risks
- **Rules keep moving.** The threshold has changed three times since 2025. Keep
  the threshold and the dates as settings and text, not code, and re-check them
  against hasil.gov.my before Phase B starts.
- **Public repository.** No TIN, certificate, client secret or customer tax
  details go in the repository, the tests, or R's reports.
- **Customer personal data** (IC numbers, addresses) arrives with the first
  e-invoice request. Store only what LHDN needs, show it to admins only, and
  never print it on the till's receipt.

## Sources

- [Malaysia raises e-Invoice exemption threshold to MYR 3 million (VATupdate, 8 Sep 2026)](https://www.vatupdate.com/2026/09/08/malaysia-raises-e-invoice-exemption-threshold-to-myr-3-million/)
- [E-Invoice Exemption Below RM3 Million (L & Co)](https://landco.my/social/e-invoice-exemption-threshold-expanded-to-rm3-million/)
- [LHDN e-Invoice general FAQs (hasil.gov.my)](https://www.hasil.gov.my/wp-content/uploads/lhdnm-e-invoice-general-faqs.pdf)
- [IRBM e-Invoice specific guideline (hasil.gov.my)](https://www.hasil.gov.my/wp-content/uploads/irbm-e-invoice-specific-guideline.pdf)
- [e-Invoice implementation dates and relaxation period (ClearTax)](https://www.cleartax.com/my/en/different-phases-implementation-timelines-einvoicing-malaysia)
- [Consolidated e-invoice rules, 2026](https://invoicedataextraction.com/blog/malaysia-consolidated-e-invoice-rules)
