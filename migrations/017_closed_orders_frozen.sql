-- A closed bill is frozen, not just closed.
--
-- Migration 015 stopped a paid, cancelled or refunded order from changing
-- status (except paid -> refunded). A move racing a payment could still
-- rewrite a paid bill's card_id/order_type after it closed — relabelling paid
-- bills and turning takeaways into dine-in on the dashboard. This extends the
-- same trigger so that once an order is closed, its location (card_id,
-- table_id, order_type) and its money columns cannot change either.
--
-- paid -> refunded still works: a refund changes only the status. Every money
-- write in the application (rounding on the settling payment, recompute on a
-- void or discount) happens while the order is open, before or in the same
-- statement-sequence that closes it. 017, not 016: 016 is reserved for the
-- setup-wizard branch.

CREATE OR REPLACE FUNCTION orders_closed_stays_closed() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('paid', 'cancelled', 'refunded') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
      RAISE EXCEPTION 'order % is % and cannot become %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.card_id IS DISTINCT FROM OLD.card_id
       OR NEW.table_id IS DISTINCT FROM OLD.table_id
       OR NEW.order_type IS DISTINCT FROM OLD.order_type THEN
      RAISE EXCEPTION 'order % is % and cannot be moved or change type', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
       OR NEW.service_charge_cents IS DISTINCT FROM OLD.service_charge_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
       OR NEW.rounding_cents IS DISTINCT FROM OLD.rounding_cents
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.tax_rate_bp IS DISTINCT FROM OLD.tax_rate_bp
       OR NEW.svc_rate_bp IS DISTINCT FROM OLD.svc_rate_bp THEN
      RAISE EXCEPTION 'order % is % and its bill cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Every column, not just status: fire on any UPDATE of a row.
DROP TRIGGER IF EXISTS orders_closed_stays_closed ON orders;
CREATE TRIGGER orders_closed_stays_closed
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_closed_stays_closed();
