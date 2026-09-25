-- Safety net: a closed bill stays closed.
--
-- 'paid', 'cancelled' and 'refunded' are terminal. The only legitimate exit
-- from one of them is paid -> refunded (every payment on a settled order
-- refunded, services/billing.js addRefund). Anything else — a kitchen tap that
-- read "ready" before a payment and wrote "served" after it (PR #16 re-check 2,
-- finding K) — is rejected here, whatever code path attempts it and whether or
-- not it holds the bill lock. The application already prevents it; this makes
-- the database refuse it too.

CREATE OR REPLACE FUNCTION orders_closed_stays_closed() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('paid', 'cancelled', 'refunded')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
    RAISE EXCEPTION 'order % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_closed_stays_closed ON orders;
CREATE TRIGGER orders_closed_stays_closed
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_closed_stays_closed();
