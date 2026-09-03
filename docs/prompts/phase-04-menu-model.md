# Phase 04 — Menu and modifier model

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~35k tokens.**

## Why

Audit #20–21. Modifiers are global and unattached: the client hardcodes "if
`item.kandar` is true, show the one radio group and the one checkbox group". You
cannot give satay a sauce choice without editing JavaScript. And the server
enforces nothing — the API accepts three "kuah" options on one item, or an
"Extra Lauk" on a Teh Tarik.

## Files

Read: `src/services/orders.js` (`buildOrderItems`), `src/routes/admin.js`,
`src/routes/public.js`, `public/js/pos.js`, `public/customer/customer.js`.
Create: `migrations/004_menu.sql`, `test/unit/modifiers.test.js`.

## Do

**1. `migrations/004_menu.sql`:**

```sql
CREATE TABLE IF NOT EXISTS item_modifier_groups (
  item_id  INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  group_id INT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

ALTER TABLE modifier_groups
  ADD COLUMN IF NOT EXISTS min_select INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_select INT NOT NULL DEFAULT 1;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS sold_out_until DATE;

-- preserve today's behaviour: every kandar item gets both existing groups
INSERT INTO item_modifier_groups (item_id, group_id)
SELECT i.id, g.id FROM items i CROSS JOIN modifier_groups g WHERE i.kandar
ON CONFLICT DO NOTHING;

UPDATE modifier_groups SET min_select=1, max_select=1 WHERE mode='radio';
UPDATE modifier_groups SET min_select=0, max_select=99 WHERE mode='checkbox';
```

The backfill matters: after this migration the app must behave **exactly** as it
does today until an admin changes something.

**2. Enforce the rules server-side** in `buildOrderItems`. For each line, for each
group attached to that item: count selected options in that group and reject
outside `[min_select, max_select]`; reject any option whose group is not attached
to that item; reject unavailable options (already done). Error messages name the
group: `"Kuah: choose exactly 1"`. These are `status: 400` errors.

Do not trust the client. This is the whole point of the phase.

**3. `GET /api/menu`** returns each item's attached group ids, and groups carry
`min_select`/`max_select`. Both the staff modal and the customer modal render from
that data instead of the hardcoded radio/checkbox assumption, and disable the
confirm button until every group's minimum is satisfied. The `kandar` flag stops
driving behaviour and becomes display-only.

**4. Sold-out with a daily reset.** Toggling an item sold out sets
`sold_out_until = current_date` (Asia/Kuala_Lumpur). `available` in the menu query
becomes `available AND (sold_out_until IS NULL OR sold_out_until < current_date)`,
so yesterday's 86 list clears itself at midnight rather than staying off the menu
for a week. Admin UI shows "Sold out today" and a "Sold out indefinitely" option
(which sets `available = false`).

**5. Admin CRUD** for attaching groups to items, editing `min_select`/`max_select`,
creating groups, and reordering categories/items via the existing unused `sort`
columns (`PATCH /api/admin/items/:id` accepting `sort`, drag or up/down buttons).

## Tests — `test/unit/modifiers.test.js`

- Radio group, 0 selected → 400; 1 → 200; 2 → 400.
- Checkbox group `max_select=3`, 4 selected → 400.
- Option from a group not attached to the item → 400.
- Item sold out today → 400; the same item tomorrow (advance `sold_out_until`) → 200.
- Post-migration parity: a kandar item still accepts exactly today's payload shape.

## Verify

```bash
npm test
```

Then by hand: attach the "Kuah" group to a non-kandar item in Admin, confirm it now
prompts for kuah in both the staff and customer flows, and that ordering it without
a choice is rejected by the API even when the request is sent directly with `curl`.
