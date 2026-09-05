import { $, esc } from './state.js';
import { switchTab } from './nav.js';

/* ===== HELP & TRAINING =====
   The handbook in docs/ is the long reference: printable, complete, the thing
   you read once on a quiet afternoon. This is the other half — what someone
   reaches for at 8pm with a customer waiting.

   So it is built for that: short topics, a search that finds a topic by any
   word in it, and for the handful of things people actually get stuck on, a
   little animation that shows the taps rather than describing them. Nothing
   here is a video: a mamak's wifi does not need to carry one, and a fifteen
   second clip is slower than three captioned frames anyway.

   Every topic below describes what this build of the POS actually does. If a
   screen changes, its topic changes with it. */

/* ---------- mini walkthroughs ----------
   A step is a caption plus a tiny mock of the screen. `hit` is which cell the
   finger is about to tap, and the cursor is moved there after layout rather
   than at hand-written coordinates — so the animation stays right when the
   text wraps differently on a phone. */
const WALKTHROUGHS = {
  takeOrder: {
    title: 'Taking an order',
    steps: [
      {
        caption: 'Tap Tables, then the table the customer is sitting at.',
        cells: [
          { t: 'T1', cls: 'tile free' }, { t: 'T2', cls: 'tile free' },
          { t: 'T3', cls: 'tile free' }, { t: 'T4', cls: 'tile free' },
        ],
        hit: 2,
      },
      {
        caption: 'Tap a category, then tap the dish. One tap adds it.',
        cells: [
          { t: 'Nasi', cls: 'chip' }, { t: 'Mee', cls: 'chip on' }, { t: 'Roti', cls: 'chip' },
          { t: 'Mee Goreng', cls: 'item' }, { t: 'Maggi Goreng', cls: 'item' },
        ],
        hit: 3,
      },
      {
        caption: 'The dish lands on the bill. Tap + for another, 📝 for a note.',
        cells: [
          { t: '1× Mee Goreng · RM 8.50', cls: 'line' },
          { t: '−', cls: 'mini' }, { t: '+', cls: 'mini' }, { t: '📝', cls: 'mini' },
        ],
        hit: 2,
      },
      {
        caption: 'Tap the big orange button. It says how many items it will send.',
        cells: [
          { t: '2× Mee Goreng · RM 17.00', cls: 'line' },
          { t: '🍳 Send 2 new items', cls: 'cta' },
        ],
        hit: 1,
      },
    ],
  },

  addMore: {
    title: 'Adding more food later',
    steps: [
      {
        caption: 'Table 1 ordered at 8:01pm. Round 1 is served by 8:15pm.',
        cells: [
          { t: 'ALREADY SENT', cls: 'label' },
          { t: 'Round 1 · 🍽 Served', cls: 'line quiet' },
          { t: '1× Mee Goreng', cls: 'line quiet' },
        ],
        hit: -1,
      },
      {
        caption: 'They want a roti. Open the same table again — do not start a new one.',
        cells: [
          { t: 'T1 · Ready to pay', cls: 'tile busy' }, { t: 'T2', cls: 'tile free' },
          { t: 'T3', cls: 'tile free' }, { t: 'T4', cls: 'tile free' },
        ],
        hit: 0,
      },
      {
        caption: 'Tap Roti Canai. It appears under NEW — not sent yet.',
        cells: [
          { t: 'Round 1 · 🍽 Served', cls: 'line quiet' },
          { t: 'NEW — NOT SENT YET', cls: 'label warm' },
          { t: '1× Roti Canai', cls: 'line' },
        ],
        hit: 2,
      },
      {
        caption: 'Send it. The kitchen gets a chit for the roti only, marked ADD-ON · ROUND 2.',
        cells: [{ t: '🍳 Send 1 new item', cls: 'cta' }],
        hit: 0,
      },
      {
        caption: 'One bill, two rounds. Round 1 stays served. The customer pays once.',
        cells: [
          { t: 'Round 1 · 🍽 Served', cls: 'line quiet' },
          { t: 'Round 2 · 🔔 New order', cls: 'line' },
          { t: 'Total RM 10.50', cls: 'total' },
        ],
        hit: -1,
      },
    ],
  },

  kitchen: {
    title: 'Working the kitchen screen',
    steps: [
      {
        caption: 'Tickets arrive in 🔔 New, oldest at the top.',
        cells: [
          { t: '🔔 New', cls: 'label' },
          { t: 'T1 · 1× Mee Goreng', cls: 'line' },
          { t: '🍳 Start cooking', cls: 'cta' },
        ],
        hit: 2,
      },
      {
        caption: 'It moves to 🍳 Cooking. Only the next step is ever shown.',
        cells: [
          { t: '🍳 Cooking', cls: 'label' },
          { t: 'T1 · 1× Mee Goreng', cls: 'line' },
          { t: '✅ Ready', cls: 'cta ok' },
        ],
        hit: 2,
      },
      {
        caption: 'Tap Ready when it leaves the wok. The waiter sees it on the floor.',
        cells: [
          { t: '✅ Ready', cls: 'label' },
          { t: 'T1 · 1× Mee Goreng', cls: 'line' },
          { t: '🍽 Served', cls: 'cta dark' },
        ],
        hit: 2,
      },
      {
        caption: 'Tapped the wrong one? ↶ Undo sits under the ticket for a few seconds.',
        cells: [{ t: '↶ Undo', cls: 'mini wide' }],
        hit: 0,
      },
    ],
  },

  payment: {
    title: 'Taking payment',
    steps: [
      {
        caption: 'Open the table, then tap Take Payment at the bottom of the bill.',
        cells: [
          { t: 'Total RM 21.00', cls: 'total' },
          { t: '💵 Take Payment', cls: 'cta ok' },
        ],
        hit: 1,
      },
      {
        caption: 'For cash, type what the customer handed you. The change is worked out for you.',
        cells: [
          { t: 'Cash received: 50.00', cls: 'line' },
          { t: 'Change: RM 29.00', cls: 'line quiet' },
          { t: '💵 Cash', cls: 'cta' },
        ],
        hit: 2,
      },
      {
        caption: 'Card and DuitNow are the two buttons below it. The receipt prints itself.',
        cells: [
          { t: '💳 Card', cls: 'cta info' },
          { t: '📱 DuitNow / eWallet', cls: 'cta dark' },
        ],
        hit: 0,
      },
      {
        caption: 'Sharing? Split evenly, or by seat if you set seat numbers on the lines.',
        cells: [
          { t: 'Split evenly', cls: 'mini wide' }, { t: 'Split by seat', cls: 'mini wide' },
        ],
        hit: 0,
      },
    ],
  },

  soldOut: {
    title: 'Marking something sold out',
    steps: [
      {
        caption: 'Admin → Menu. Find the dish — the search box is quicker than scrolling.',
        cells: [{ t: '🔍 teh tarik', cls: 'line' }],
        hit: 0,
      },
      {
        caption: 'Tap the green ✅ Available button on its row.',
        cells: [
          { t: 'Teh Tarik · RM 2.80', cls: 'line' },
          { t: '✅ Available', cls: 'cta ok' },
        ],
        hit: 1,
      },
      {
        caption: 'It turns red. The dish disappears from the till and the QR menu at once.',
        cells: [{ t: '🚫 Sold out today', cls: 'cta danger' }],
        hit: -1,
      },
      {
        caption: 'It comes back by itself at midnight. Nobody has to remember.',
        cells: [{ t: '✅ Available', cls: 'cta ok' }],
        hit: -1,
      },
    ],
  },

  voice: {
    title: 'How Speak to Order works',
    steps: [
      {
        caption: 'The customer scans the table QR and taps the microphone.',
        cells: [{ t: '🎙 Speak to Order', cls: 'cta' }],
        hit: 0,
      },
      {
        caption: 'They talk normally: “Roti canai dua, teh tarik satu kurang manis.”',
        cells: [{ t: 'Listening…', cls: 'label' }, { t: '▁▃▅▇▅▃▁', cls: 'line quiet' }],
        hit: -1,
      },
      {
        caption: 'The POS shows what it understood, with its own prices — never the computer’s guess at a price.',
        cells: [
          { t: '2× Roti Canai · RM 4.00', cls: 'line' },
          { t: '1× Teh Tarik · RM 2.80', cls: 'line' },
          { t: 'Total RM 6.80', cls: 'total' },
        ],
        hit: -1,
      },
      {
        caption: 'They can change anything, then tap Confirm. Only then does the kitchen see it.',
        cells: [{ t: 'Confirm order', cls: 'cta' }],
        hit: 0,
      },
      {
        caption: 'It arrives as an ordinary QR round on your kitchen screen, marked QR.',
        cells: [{ t: 'T4 · QR · 🔔 New', cls: 'line' }],
        hit: -1,
      },
    ],
  },
};

/* ---------- the topics ---------- */
const ALL = ['admin', 'staff', 'kitchen'];

const TOPICS = [
  {
    id: 'quick-start', icon: '🚀', title: 'Quick start', time: '2 min', roles: ALL,
    blurb: 'The whole job, start to finish.',
    body: [
      { h: 'Every shift', steps: [
        'Log in with your name and PIN.',
        'Tap 🕐 Shift → Open Shift, and type the cash already in the drawer.',
        'Work the floor from 🍽 Tables.',
        'At the end: 🕐 Shift → Close Shift, count the drawer, confirm.',
      ] },
      { h: 'The main flow', steps: [
        'Table → dish → 🍳 Send to Kitchen.',
        'Kitchen cooks it and taps ✅ Ready.',
        'You serve it and tap 🍽 Served.',
        'Customer leaves → 💵 Take Payment.',
      ] },
      { p: 'That is the whole POS. Everything else on this page is a detail of one of those four steps.' },
    ],
  },
  {
    id: 'take-order', icon: '🍽', title: 'Taking an order', time: '1 min', roles: ['admin', 'staff'],
    blurb: 'Table → food → kitchen.', walkthrough: 'takeOrder',
    body: [
      { steps: [
        'Tap 🍽 Tables, then the customer’s table.',
        'Tap a category chip along the top, or type in the search box.',
        'Tap a dish — one tap adds it, no dialog.',
        'Tap 🍳 Send N new items when the order is complete.',
      ] },
      { h: 'On a line you have not sent yet', list: [
        '− and + change how many.',
        '📝 adds a note: kurang pedas, tak nak ais. Common ones are one tap.',
        'Seat sets a seat number, which is only needed if they will split by seat.',
        '✕ removes the line.',
      ] },
      { tip: 'Some dishes ask a question first — Kuah? Extra lauk? — because the kitchen cannot start without the answer. Tap the answers, then Add.' },
    ],
  },
  {
    id: 'add-more', icon: '➕', title: 'Adding more items later', time: '1 min', roles: ['admin', 'staff'],
    blurb: 'One bill, many rounds. The thing worth reading twice.', walkthrough: 'addMore',
    body: [
      { p: 'A table has one bill but can send food to the kitchen many times. Each send is a round.' },
      { steps: [
        'Open the same table again. Never start a second one.',
        'Tap the extra dishes. They appear under NEW — not sent yet.',
        'Tap 🍳 Send N new items.',
      ] },
      { h: 'What happens', list: [
        'It is still one bill — the customer pays once, at the end, for everything.',
        'The new round starts at New order. It is not served.',
        'The earlier round stays exactly as it was.',
        'The kitchen chit shows only the new food, marked ADD-ON · ROUND 2, with your name.',
      ] },
      { tip: 'Order timeline at the bottom of the bill shows every round, who sent it and when.' },
    ],
  },
  {
    id: 'kitchen', icon: '🍳', title: 'The kitchen screen', time: '1 min', roles: ALL,
    blurb: 'New → Cooking → Ready → Served.', walkthrough: 'kitchen',
    body: [
      { h: 'The four columns', list: [
        '🔔 New — just arrived, nobody has started it.',
        '🍳 Cooking — someone is making it.',
        '✅ Ready — done, waiting to be carried out.',
        '🍽 Served — on the table.',
      ] },
      { p: 'Each ticket shows only its next action, so there is nothing to get wrong. The minutes on the ticket go amber after 5 and red after 10.' },
      { h: 'Other things on a ticket', list: [
        'ADD-ON · ROUND 2 — extra food for a table that has already been served once.',
        'QR — the customer ordered it themselves from their phone.',
        'A red flash and a struck-through line — a waiter voided that item. Stop making it.',
        '↶ Undo — appears for a few seconds after you advance a ticket by mistake.',
      ] },
      { tip: 'If drinks have their own screen, use the station chips at the top to switch between Kitchen and Drinks.' },
    ],
  },
  {
    id: 'payment', icon: '💵', title: 'Taking payment', time: '1 min', roles: ['admin', 'staff'],
    blurb: 'Cash, card, DuitNow, split.', walkthrough: 'payment',
    body: [
      { steps: [
        'Open the table and tap 💵 Take Payment.',
        'For cash, type what they handed you — the change is worked out and shown.',
        'Tap 💵 Cash, 💳 Card or 📱 DuitNow / eWallet.',
      ] },
      { h: 'Splitting', list: [
        'Split evenly — say how many people, pay each share in turn.',
        'Split by seat — works if the lines were given seat numbers when ordered.',
        'Pay a specific amount — for a customer paying part of the bill now.',
      ] },
      { tip: 'A shift has to be open before a payment is accepted. If Take Payment refuses, check 🕐 Shift first.' },
    ],
  },
  {
    id: 'void', icon: '❌', title: 'Taking something off the bill', time: '30 sec', roles: ['admin', 'staff'],
    blurb: 'Void a line the kitchen already has.',
    body: [
      { steps: [
        'Open the table.',
        'Find the line under ✅ Already sent and tap ❌ Void.',
        'Type why. This is recorded against your name.',
      ] },
      { p: 'The kitchen screen flashes the ticket red and strikes the line through, so nobody keeps cooking it. The bill drops by that amount immediately.' },
      { tip: 'A line that has not been sent yet does not need voiding — just tap ✕ to remove it.' },
    ],
  },
  {
    id: 'sold-out', icon: '🚫', title: 'Sold out', time: '30 sec', roles: ['admin'],
    blurb: 'When the kitchen runs out mid-service.', walkthrough: 'soldOut',
    body: [
      { steps: [
        'Tap ⚙ Admin → 🍜 Menu.',
        'Search for the dish.',
        'Tap the green ✅ Available button on its row.',
      ] },
      { p: 'It disappears from the till and the customer QR menu straight away, and comes back by itself at midnight.' },
      { tip: 'To take something off the menu for longer than today, open the item with ✏️ Edit and turn On the menu off instead. That one stays off until you turn it back on.' },
    ],
  },
  {
    id: 'takeaway', icon: '🥡', title: 'Takeaway', time: '30 sec', roles: ['admin', 'staff'],
    blurb: 'An order with no table.',
    body: [
      { steps: [
        'On 🍽 Tables, tap ➕ New Takeaway.',
        'Add the food and send it as usual.',
        'It appears in the Takeaway section with its own number, like Takeaway #128.',
      ] },
      { p: 'Any number of takeaway orders can be open at once, and they never block a table.' },
    ],
  },
  {
    id: 'move-table', icon: '↔', title: 'Moving a table', time: '30 sec', roles: ['admin', 'staff'],
    blurb: 'The customer moved. The food keeps cooking.',
    body: [
      { steps: [
        'Open the table they are on now — the one they started at.',
        'Tap ↔ Move at the top.',
        'Pick the free table they moved to.',
      ] },
      { p: 'The whole bill moves. Nothing is re-entered, the kitchen keeps cooking, and the ticket updates to the new table.' },
    ],
  },
  {
    id: 'shift', icon: '🕐', title: 'Opening and closing the shift', time: '1 min', roles: ['admin', 'staff'],
    blurb: 'The drawer, and the Z report.',
    body: [
      { h: 'Opening', steps: [
        'Tap 🕐 Shift.',
        'Type the cash already in the drawer as the float.',
        'Tap Open Shift.',
      ] },
      { h: 'During service', p: 'Record cash going in or out of the drawer that is not a sale — a supplier paid in cash, change fetched from the bank — with Pay in / Pay out and a reason.' },
      { h: 'Closing', steps: [
        'Tap 🕐 Shift → Close Shift.',
        'Count the drawer and type each denomination.',
        'If the counted total does not match, write a note saying why.',
        'Tap Confirm Close. The Z report is produced and can be printed or exported.',
      ] },
    ],
  },
  {
    id: 'qr', icon: '📱', title: 'Customers ordering by QR', time: '1 min', roles: ['admin', 'staff'],
    blurb: 'The sticker on the table.',
    body: [
      { p: 'A customer scans the QR on their table, sees the live menu, and sends the order straight to the kitchen. It lands on the same bill you would have used, marked QR.' },
      { h: 'Setting it up', steps: [
        '⚙ Admin → 🍽 Tables & QR.',
        'Check the address under the QR codes is one a phone can actually reach — not localhost.',
        'Print a table’s QR with the Print button on its card.',
      ] },
      { h: 'Holding orders for a staff member', list: [
        'QR handling → Require staff approval.',
        'Pending orders appear at the top of 🍳 Kitchen with a count on the tab.',
        'Accept sends it to the kitchen. Reject voids the lines and tells the customer.',
      ] },
      { tip: 'To stop QR ordering entirely — a rush, a broken kitchen printer — turn Accept QR orders off. Customers then see a short message asking them to order with staff.' },
    ],
  },
  {
    id: 'voice', icon: '🎙', title: 'Speak to Order', time: '1 min', roles: ALL,
    blurb: 'The customer talks; the till still decides.', walkthrough: 'voice',
    body: [
      { p: 'Where the restaurant has switched it on, the QR page leads with a microphone. The customer says their order the way they would say it to you — English, Bahasa Malaysia, or both at once.' },
      { h: 'What the customer sees', steps: [
        'They tap 🎙 Speak to Order and talk.',
        'The POS shows what it understood, with prices from this menu.',
        'They can change quantities, remove a line, or say a correction: “make the teh tarik two”.',
        'Nothing reaches the kitchen until they tap Confirm order.',
      ] },
      { h: 'What you need to know', list: [
        'It arrives as an ordinary QR round. Same kitchen screen, same bill, same rounds.',
        'The prices are always this restaurant’s prices. The computer is never allowed to invent one.',
        'A sold-out dish is refused and the customer is told, the same as if they had tapped it.',
        'If a dish needs an answer (Kuah?), the customer is asked before they can confirm.',
      ] },
      { tip: 'If a customer says it did not hear them, ask them to try again holding the phone closer — or just take the order yourself. It is an extra way to order, never the only one.' },
    ],
  },
  {
    id: 'menu-admin', icon: '🍜', title: 'Adding and editing the menu', time: '2 min', roles: ['admin'],
    blurb: 'Dishes, prices, categories.',
    body: [
      { h: 'A new dish', steps: [
        '⚙ Admin → 🍜 Menu → ➕ Add item.',
        'Name, category, price, and which station makes it (Kitchen or Drinks).',
        'Tick any food options it should ask about.',
        'Save. It is on the till and the QR menu immediately.',
      ] },
      { h: 'Changing a price', p: 'Edit the item and save. Bills already open keep the price they were rung up at — changing a price never rewrites a bill somebody is about to pay.' },
      { tip: 'Deleting a dish that appears on old bills is refused, because those bills would stop adding up. Turn On the menu off instead.' },
    ],
  },
  {
    id: 'options', icon: '🧂', title: 'Food options', time: '1 min', roles: ['admin'],
    blurb: 'The questions the till asks — Kuah? Extra lauk?',
    body: [
      { p: 'A group is a question, and its options are the answers. Extra Lauk asks “anything extra?”, and Chicken +RM3.00, Mutton +RM4.00, Egg +RM1.50 are what the customer can say.' },
      { h: 'Making one', steps: [
        '⚙ Admin → 🍜 Menu → ➕ Add option group.',
        'Name it, choose One only or Several, and set the minimum and maximum.',
        'Add the options and what each one adds to the price.',
        'Attach it to dishes by editing each dish and ticking the group.',
      ] },
      { tip: 'Minimum 1 means the till will not let the order through without an answer. Use it where the kitchen genuinely cannot start — kuah on a nasi kandar — and leave it at 0 everywhere else.' },
    ],
  },
  {
    id: 'staff', icon: '👤', title: 'Staff and PINs', time: '1 min', roles: ['admin'],
    blurb: 'Adding people, resetting a forgotten PIN.',
    body: [
      { h: 'A new person', steps: [
        '⚙ Admin → 👤 Staff.',
        'Name, role, and a temporary PIN typed twice.',
        'They choose their own PIN the first time they log in.',
      ] },
      { h: 'The three roles', list: [
        'Staff — the floor: tables, orders, kitchen, payments.',
        'Kitchen — the kitchen screen only.',
        'Admin — everything, including the menu, staff and the takings.',
      ] },
      { tip: 'A person who has left is deactivated, not deleted: their name is still on the bills they rang up.' },
    ],
  },
  {
    id: 'printing', icon: '🖨', title: 'Printers', time: '1 min', roles: ['admin'],
    blurb: 'Chits, receipts, and retrying a failed print.',
    body: [
      { h: 'Adding a printer', steps: [
        '⚙ Admin → 🖨 Printers.',
        'Name, its address on the network, port (usually 9100), and its role.',
        'Kitchen prints food chits, Drinks / bar prints drink chits, Receipt prints customer receipts.',
      ] },
      { h: 'A print that failed', steps: [
        'Go to Print jobs on the same page.',
        'Find the failed job and tap Retry.',
      ] },
      { p: 'A retry reprints exactly the same ticket and changes nothing on the bill. It is always safe.' },
    ],
  },
  {
    id: 'sales', icon: '💰', title: 'The Sales screen', time: '30 sec', roles: ['admin', 'staff'],
    blurb: 'How today is going.',
    body: [
      { h: 'The numbers along the top', list: [
        'Today sales — settled takings so far, against all of yesterday.',
        'Orders and Average order — how many bills and how big.',
        'Open tables and Ready to pay — the floor right now. Ready to pay means go and collect.',
        'Late in kitchen — tickets over ten minutes old.',
      ] },
      { p: 'Below that: sales by hour with the busiest hour marked, what sold most, how people paid, and what the kitchen is doing.' },
    ],
  },
  {
    id: 'trouble', icon: '🛟', title: 'When something goes wrong', time: '2 min', roles: ALL,
    blurb: 'Internet, printer, QR.',
    body: [
      { h: 'The internet is down', list: [
        'Keep taking orders. They queue on the tablet and a red bar says how many are waiting.',
        'When the connection comes back they send themselves, in order.',
        'Payments and voids will not work offline, on purpose — a mis-recorded payment is money nobody can reconstruct.',
      ] },
      { h: 'The kitchen printer is not printing', list: [
        'The order is safe: the kitchen screen has it whether or not anything printed.',
        '⚙ Admin → ⚙ System says whether the printer is reachable.',
        '⚙ Admin → 🖨 Printers → Print jobs → Retry on the failed job.',
        'Check power, paper and the network cable before blaming the POS.',
      ] },
      { h: 'A customer says the QR does not work', list: [
        '⚙ Admin → 🍽 Tables & QR shows a warning if the printed address cannot be reached from a phone.',
        'Check Accept QR orders is on.',
        'Ask them to try mobile data instead of the restaurant wifi.',
        'Meanwhile, just take the order yourself.',
      ] },
      { h: 'Two of the same order', list: [
        'Open the table and look at Order timeline — it shows every round and who sent it.',
        'Void the duplicate lines with a reason. The kitchen is told at once.',
      ] },
    ],
  },
];

const FAQS = [
  {
    q: 'The customer wants more food after the first lot was already served. What do I do?',
    a: 'Open the same table again and add the new food. Tap Send. It goes to the kitchen as a new round, the earlier food stays served, and it is all still one bill.',
    topic: 'add-more',
  },
  {
    q: 'The kitchen says they never got an order.',
    a: 'Open the table and check Order timeline. If the round is there, the kitchen screen has it — the printer may have failed, which Admin → Printers → Print jobs will show and can retry. If the round is not there, it was never sent: the items are still sitting under NEW on the bill.',
    topic: 'printing',
  },
  {
    q: 'Something is finished for today. How do I stop people ordering it?',
    a: 'Admin → Menu, find the dish, tap the green Available button. It goes from the till and the QR menu at once, and comes back by itself at midnight.',
    topic: 'sold-out',
  },
  {
    q: 'I rang up the wrong thing and the kitchen already has it.',
    a: 'Open the table, find the line under Already sent, tap Void and say why. The kitchen ticket flashes red and strikes it through so nobody keeps cooking.',
    topic: 'void',
  },
  {
    q: 'The customer moved to another table.',
    a: 'Open the table they started at, tap Move at the top, and pick the free table. The whole bill moves and the kitchen keeps cooking.',
    topic: 'move-table',
  },
  {
    q: 'The tablet says offline. Do I stop taking orders?',
    a: 'No. Keep going — orders queue and send themselves when the connection returns. Only payments and voids have to wait.',
    topic: 'trouble',
  },
  {
    q: 'Can the voice ordering send food to the kitchen by itself?',
    a: 'No. It shows the customer what it understood and waits. Nothing reaches the kitchen until the customer taps Confirm order, and the prices are always this restaurant’s prices.',
    topic: 'voice',
  },
  {
    q: 'Take Payment is refusing.',
    a: 'A shift has to be open before the POS will accept money. Tap Shift and open one.',
    topic: 'shift',
  },
  {
    q: 'Someone forgot their PIN.',
    a: 'An admin resets it in Admin → Staff. The new PIN is temporary — that person picks their own the next time they log in.',
    topic: 'staff',
  },
];

/* ---------- rendering ---------- */

let query = '';
let openTopicId = null;

const visible = () => TOPICS.filter(t => t.roles.includes(API.user.role));

function haystack(topic) {
  const parts = [topic.title, topic.blurb];
  topic.body.forEach(b => {
    if (b.h) parts.push(b.h);
    if (b.p) parts.push(b.p);
    if (b.tip) parts.push(b.tip);
    (b.steps || []).forEach(s => parts.push(s));
    (b.list || []).forEach(s => parts.push(s));
  });
  return parts.join(' ').toLowerCase();
}

function matching() {
  if (!query) return visible();
  return visible().filter(t => haystack(t).includes(query));
}

function cardHtml(t) {
  return `<button class="help-card" data-action="help-topic" data-topic="${t.id}">
    <span class="hc-ico" aria-hidden="true">${t.icon}</span>
    <span class="hc-words">
      <span class="hc-title">${esc(t.title)}</span>
      <span class="hc-blurb">${esc(t.blurb)}</span>
    </span>
    <span class="hc-time">${esc(t.time)}</span>
  </button>`;
}

function blockHtml(b) {
  let html = b.h ? `<h4 class="help-h">${esc(b.h)}</h4>` : '';
  if (b.p) html += `<p class="help-p">${esc(b.p)}</p>`;
  if (b.steps) html += `<ol class="help-steps">${b.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
  if (b.list) html += `<ul class="help-list">${b.list.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
  if (b.tip) html += `<div class="help-tip"><span aria-hidden="true">💡</span><span>${esc(b.tip)}</span></div>`;
  return html;
}

function renderHome() {
  const found = matching();
  $('help-home').hidden = false;
  $('help-article').hidden = true;
  $('help-results').innerHTML = found.length
    ? found.map(cardHtml).join('')
    : `<div class="empty"><span class="big" aria-hidden="true">🔍</span>Nothing matches “${esc(query)}”. Try a shorter word.</div>`;
  $('help-faq-wrap').hidden = !!query;
  $('help-count').textContent = query
    ? `${found.length} topic${found.length === 1 ? '' : 's'}`
    : `${found.length} topics`;
}

function renderFaq() {
  $('help-faq').innerHTML = FAQS.map((f, i) => `<details class="faq">
    <summary>${esc(f.q)}</summary>
    <div class="faq-a">
      <p>${esc(f.a)}</p>
      <button class="btn small ghost" data-action="help-topic" data-topic="${f.topic}">Read the full topic →</button>
    </div>
  </details>`).join('');
}

export function openTopic(id) {
  const topic = TOPICS.find(t => t.id === id);
  if (!topic) return;
  openTopicId = id;
  $('help-home').hidden = true;
  $('help-article').hidden = false;
  $('help-article-title').innerHTML = `<span aria-hidden="true">${topic.icon}</span> ${esc(topic.title)}`;
  $('help-article-sub').textContent = topic.blurb;
  $('help-article-body').innerHTML = topic.body.map(blockHtml).join('');
  const wt = topic.walkthrough ? WALKTHROUGHS[topic.walkthrough] : null;
  $('help-wt').hidden = !wt;
  if (wt) mountWalkthrough(wt);
  window.scrollTo({ top: 0 });
}

function backToHome() {
  stopWalkthrough();
  openTopicId = null;
  renderHome();
  window.scrollTo({ top: 0 });
}

/* ---------- the walkthrough player ---------- */

let wt = null;
let wtStep = 0;
let wtTimer = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function mountWalkthrough(def) {
  stopWalkthrough();
  wt = def;
  wtStep = 0;
  $('wt-title').textContent = def.title;
  // Started before the first paint, so the control reads "Pause" from the
  // outset rather than claiming to be stopped for the first three seconds.
  // A person who has asked their device to stop animating gets the steps as a
  // list of frames instead of a film — same content, no motion.
  if (!reducedMotion()) wtTimer = setInterval(nextStep, 3200);
  renderStep();
}

function stopWalkthrough() {
  clearInterval(wtTimer);
  wtTimer = null;
}

function nextStep() {
  if (!wt) return;
  wtStep = (wtStep + 1) % wt.steps.length;
  renderStep();
}

function goStep(i) {
  if (!wt) return;
  stopWalkthrough();
  wtStep = Math.max(0, Math.min(wt.steps.length - 1, i));
  renderStep();
}

function renderStep() {
  if (!wt) return;
  const step = wt.steps[wtStep];
  const stage = $('wt-stage');
  stage.innerHTML = step.cells
    .map((c, i) => `<div class="wt-cell ${c.cls}${i === step.hit ? ' hit' : ''}">${esc(c.t)}</div>`).join('')
    + '<div class="wt-cursor" id="wt-cursor" aria-hidden="true"></div>';

  // The finger goes wherever the cell ended up, which is the only way this
  // stays right when the caption wraps to two lines on a phone.
  requestAnimationFrame(() => {
    const hit = stage.querySelector('.wt-cell.hit');
    const cursor = $('wt-cursor');
    if (!hit || !cursor) { if (cursor) cursor.style.opacity = '0'; return; }
    const s = stage.getBoundingClientRect();
    const h = hit.getBoundingClientRect();
    cursor.style.opacity = '1';
    cursor.style.transform =
      `translate(${(h.left - s.left + h.width / 2).toFixed(0)}px, ${(h.top - s.top + h.height * 0.62).toFixed(0)}px)`;
  });

  $('wt-caption').textContent = `${wtStep + 1}. ${step.caption}`;
  $('wt-dots').innerHTML = wt.steps
    .map((_, i) => `<button class="wt-dot ${i === wtStep ? 'on' : ''}" data-action="wt-go" data-i="${i}"
        aria-label="Step ${i + 1} of ${wt.steps.length}"></button>`).join('');
  $('wt-play').textContent = wtTimer ? '⏸ Pause' : '▶ Play';
}

function togglePlay() {
  if (wtTimer) { stopWalkthrough(); renderStep(); }
  else { wtTimer = setInterval(nextStep, 3200); renderStep(); }
}

/* ---------- entry points ---------- */

export function refreshHelp() {
  renderFaq();
  if (openTopicId) openTopic(openTopicId); else renderHome();
}

/* Contextual "? how this works" links elsewhere in the app land here. */
export function showHelpTopic(id) {
  switchTab('help');
  openTopic(id);
}

$('tab-help').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'help-topic') openTopic(el.dataset.topic);
  else if (a === 'help-back') backToHome();
  else if (a === 'wt-go') goStep(Number(el.dataset.i));
  else if (a === 'wt-play') togglePlay();
  else if (a === 'wt-next') goStep(wtStep + 1);
  else if (a === 'wt-prev') goStep(wtStep - 1);
});

$('help-search').addEventListener('input', e => {
  query = e.target.value.trim().toLowerCase();
  if (openTopicId) openTopicId = null;
  renderHome();
});

// Leaving Help must stop the animation; a timer running behind the kitchen
// screen is a battery drain nobody can see.
document.addEventListener('tab-changed', e => {
  if (e.detail !== 'help') stopWalkthrough();
});
