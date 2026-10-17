// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const Stripe = require('stripe');
const stringify = require('csv-stringify').stringify;
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
let DOMAIN = process.env.DOMAIN || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
const SPORTS_PROVIDER = process.env.SPORTS_PROVIDER || 'none';
const SPORTS_API_KEY = process.env.SPORTS_API_KEY || '';

if (!STRIPE_SECRET_KEY) {
  console.warn('Warning: STRIPE_SECRET_KEY not set. Stripe calls will fail until set.');
}
const stripe = Stripe(STRIPE_SECRET_KEY);

const db = new sqlite3.Database('./pool.db');

// Helper: get squares
function getSquares(cb) {
  db.all('SELECT * FROM squares ORDER BY id', (err, rows) => {
    if (err) return cb(err);
    cb(null, rows);
  });
}

// API: fetch grid
app.get('/api/grid', (req, res) => {
  getSquares((err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// API: create checkout session (client posts selected square ids + name/email)
app.post('/api/create-checkout-session', async (req, res) => {
  const { squareIds, purchaserName, purchaserEmail } = req.body;
  if (!Array.isArray(squareIds) || squareIds.length === 0) {
    return res.status(400).json({ error: 'No squares selected' });
  }
  if (!purchaserEmail || !purchaserName) {
    return res.status(400).json({ error: 'Name and email required' });
  }

  const placeholders = squareIds.map(() => '?').join(',');
  db.all(`SELECT id, purchased FROM squares WHERE id IN (${placeholders})`, squareIds, async (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error on validation' });
    const already = rows.filter(r => r.purchased);
    if (already.length > 0) {
      return res.status(409).json({ error: 'One or more squares already purchased', taken: already.map(a => a.id) });
    }

    const unitPriceCents = 2000; // $20 -> cents
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `Chicago Bears Pool - ${squareIds.length} square(s)`,
                description: `Squares: ${squareIds.join(', ')}`
              },
              unit_amount: unitPriceCents
            },
            quantity: squareIds.length
          }
        ],
        metadata: {
          square_ids: squareIds.join(','),
          purchaser_name: purchaserName,
          purchaser_email: purchaserEmail
        },
        success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${DOMAIN}/`,
        customer_email: purchaserEmail
      });

      return res.json({ url: session.url });
    } catch (stripeErr) {
      console.error('Stripe error:', stripeErr);
      return res.status(500).json({ error: 'Stripe error' });
    }
  });
});

// One-click buy: create a Checkout session for a single square and redirect
app.get('/buy/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).send('Invalid square id');

  db.get('SELECT id, purchased FROM squares WHERE id = ?', [id], async (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Square not found');
    if (row.purchased) return res.status(409).send('Square already taken');

    const unitPriceCents = 2000; // $20
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `Chicago Bears Pool - Square ${id}`,
                description: `Square #${id}`
              },
              unit_amount: unitPriceCents
            },
            quantity: 1
          }
        ],
        metadata: {
          square_ids: String(id)
        },
        success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${DOMAIN}/`
      });

      return res.redirect(303, session.url);
    } catch (stripeErr) {
      console.error('Stripe error (buy/:id):', stripeErr);
      return res.status(500).send('Stripe error creating checkout session');
    }
  });
});

// Webhook to confirm payment and mark squares purchased.
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const squareIds = (metadata.square_ids || '').split(',').map(s => parseInt(s)).filter(Boolean);
    const purchaserName = metadata.purchaser_name || session.customer_details?.name || '';
    const purchaserEmail = metadata.purchaser_email || session.customer_details?.email || session.customer_email || '';

    if (squareIds.length === 0) {
      console.warn('No square ids found in metadata for session', session.id);
      return res.json({ received: true });
    }

    const now = new Date().toISOString();

    db.serialize(() => {
      const stmt = db.prepare(`UPDATE squares SET purchased=1, owner_name=?, owner_email=?, stripe_payment_intent=?, purchased_at=? WHERE id=? AND purchased=0`);
      for (const sq of squareIds) {
        stmt.run(purchaserName, purchaserEmail, session.payment_intent || session.id, now, sq, function(err) {
          if (err) console.error('Failed to mark square', sq, err);
          else if (this.changes === 0) {
            console.warn('Square already taken (race):', sq);
          }
        });
      }
      stmt.finalize(() => {
        console.log(`Marked squares paid: ${squareIds.join(',')} for session ${session.id}`);
      });
    });
  }

  res.json({ received: true });
});

// Admin: view sales (protected by a simple token)
app.get('/admin/sales', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  db.all('SELECT * FROM squares ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Admin: CSV export
app.get('/admin/export.csv', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).send('Unauthorized');
  }
  db.all('SELECT * FROM squares ORDER BY id', (err, rows) => {
    if (err) return res.status(500).send('DB error');
    const data = rows.map(r => [r.id, r.row, r.col, r.owner_name || '', r.owner_email || '', r.purchased ? '1' : '0', r.purchased_at || '']);
    res.setHeader('Content-disposition', 'attachment; filename=squares.csv');
    res.setHeader('Content-Type', 'text/csv');
    stringify([['id', 'row', 'col', 'owner_name', 'owner_email', 'purchased', 'purchased_at'], ...data], (err2, output) => {
      if (err2) return res.status(500).send('CSV error');
      res.send(output);
    });
  });
});

// --- Live scoring (SSE) ---
let clients = [];
let latestScore = { active: false, game: null };

app.get('/scores/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  // Send current state immediately
  res.write(`data: ${JSON.stringify(latestScore)}\n\n`);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

function sendScoreUpdate(obj) {
  latestScore = obj;
  clients.forEach(c => c.res.write(`data: ${JSON.stringify(obj)}\n\n`));
}

async function fetchLiveScore() {
  try {
    // Pluggable adapter: add providers here. For now we support a mock and TheSportsDB demo adapter.
    if (SPORTS_PROVIDER === 'thesportsdb' && SPORTS_API_KEY) {
      // Example: fetch recent events for NFL (league id 4391 or similar). This is a heuristic — please adjust per your provider's docs.
      const url = `https://www.thesportsdb.com/api/v1/json/${SPORTS_API_KEY}/eventslast.php?id=1348`;
      // NOTE: replace id with the Bears team id if known. This code is a placeholder to show integration points.
      const r = await fetch(url);
      const j = await r.json();
      // Parse j to determine if there's an active game
      // For demo, set active false unless provider gives a live event field.
      sendScoreUpdate({ active: false, game: null, raw: j });
      return;
    }

    // Default: mock/demo mode — no live game
    sendScoreUpdate({ active: false, game: null });
  } catch (err) {
    console.error('Error fetching live score:', err);
  }
}

// Poll every 30s
setInterval(fetchLiveScore, 30 * 1000);
// initial fetch
fetchLiveScore();

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  if (process.env.DOMAIN) DOMAIN = process.env.DOMAIN;
});
