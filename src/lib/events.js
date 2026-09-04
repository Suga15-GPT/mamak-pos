// In-process event hub for real-time updates (phase 06). One restaurant runs one
// server process, so a plain EventEmitter + ring buffer is enough — no Redis, no
// Postgres LISTEN/NOTIFY.
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

const RING_SIZE = 200;
const ring = [];
let seq = 0;

// payload carries ids only (order_id, table_id) — never the full order. Clients
// refetch what they need; this keeps the stream tiny and avoids leaking data to a
// role that shouldn't see it.
function publish(type, payload) {
  seq += 1;
  const event = { seq, type, ...payload };
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit('event', event);
  return event;
}

function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}

// How many screens are currently attached to the stream. Admin -> System
// reports this as a real number rather than a green light nobody checked.
function subscriberCount() { return bus.listenerCount('event'); }

// Replay everything after sinceSeq, for a reconnect that shouldn't miss an order.
function recent(sinceSeq) {
  if (!sinceSeq) return [];
  return ring.filter(e => e.seq > sinceSeq);
}

module.exports = { publish, subscribe, recent, subscriberCount };
