/* One lock for every operation that can change which cards share a bill,
   settle a bill, or change a bill's total: combine, un-combine, dissolve,
   group pay, single-card pay, adding a round, void, discount/comp, refund,
   QR approve/reject, move, cancel and leave-on-close.

   Each takes this transaction-scoped advisory lock FIRST, before any row
   lock, and only then locks order rows (ascending id). Two such operations
   can therefore never hold row locks in conflicting orders — deadlock is
   impossible by construction, instead of depending on every code path
   discovering and ordering its rows correctly (PR #16 re-check, #5). They are
   rare and quick at restaurant scale, so serialising them costs nothing.

   Switching a feature module takes it too (services/features.js save): the
   switch refuses to strand a combined bill or a round awaiting approval, and
   the operations above read the flags they depend on under this lock, so a
   switch lands wholly before or wholly after each of them.

   Released automatically at COMMIT or ROLLBACK. */

const BILL_LOCK_KEY = 7243016;

async function lockBills(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [BILL_LOCK_KEY]);
}

module.exports = { lockBills, BILL_LOCK_KEY };
