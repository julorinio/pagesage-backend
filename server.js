/**
 * PageSage – SaaS Backend
 * ─────────────────────────────────────────────────────────────
 * Routes:
 *   POST /api/register          – create a free account, returns licenseKey
 *   GET  /api/status            – check tier + usage for a licenseKey
 *   POST /api/summarize         – proxy summarise (checks quota)
 *   POST /api/explain           – proxy explain   (checks quota)
 *   POST /api/image             – proxy DALL·E 3  (Pro/Team only)
 *   POST /api/checkout          – create Stripe Checkout session
 *   POST /api/portal            – create Stripe Customer Portal session
 *   POST /api/webhook           – Stripe webhook (subscription events)
 *
 * Storage: lightweight in-memory store (swap for Supabase in production).
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const Stripe      = require('stripe');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

/* ── CORS ──────────────────────────────────────────────────── */
app.use(cors({
  origin: ['chrome-extension://*', process.env.FRONTEND_URL || '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-license-key']
}));

/* ── Raw body for Stripe webhook ───────────────────────────── */
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

/* ── Rate limiting ─────────────────────────────────────────── */
const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });
app.use('/api/', limiter);

/* ══════════════════════════════════════════════════════════════
   IN-MEMORY STORE  (replace with Supabase in production)
   ══════════════════════════════════════════════════════════════ */
const users = new Map();
// Schema per user:
// {
//   licenseKey: string,
//   email: string,
//   tier: 'free' | 'pro' | 'team',
//   stripeCustomerId: string | null,
//   stripeSubscriptionId: string | null,
//   usage: { summaries: number, explains: number, images: number },
//   resetAt: Date   (first day of current month)
// }

const LIMITS = {
  free: { summaries: 5,         explains: 10,        images: 0          },
  pro:  { summaries: Infinity,  explains: Infinity,  images: Infinity   },
  team: { summaries: Infinity,  explains: Infinity,  images: Infinity   }
};

function getOrResetUsage(user) {
  const now = new Date();
  if (!user.resetAt || now >= new Date(user.resetAt.getFullYear(), user.resetAt.getMonth() + 1, 1)) {
    user.usage  = { summaries: 0, explains: 0, images: 0 };
    user.resetAt = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return user.usage;
}

function findUser(licenseKey) {
  return users.get(licenseKey) || null;
}

/* ══════════════════════════════════════════════════════════════
   ROUTES
   ══════════════════════════════════════════════════════════════ */

/* ── POST /api/register ────────────────────────────────────── */
app.post('/api/register', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  // Check if email already registered
  for (const u of users.values()) {
    if (u.email === email) {
      return res.json({ licenseKey: u.licenseKey, tier: u.tier, message: 'Already registered.' });
    }
  }

  const licenseKey = `PS-${uuidv4().toUpperCase().replace(/-/g, '').slice(0, 20)}`;
  const user = {
    licenseKey,
    email,
    tier: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    usage: { summaries: 0, explains: 0, images: 0 },
    resetAt: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  };
  users.set(licenseKey, user);

  console.log(`[register] New user: ${email} → ${licenseKey}`);
  res.json({ licenseKey, tier: 'free', message: 'Account created. Welcome to PageSage!' });
});

/* ── GET /api/status ───────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user) return res.status(401).json({ error: 'Invalid license key.' });

  const usage  = getOrResetUsage(user);
  const limits = LIMITS[user.tier];

  res.json({
    tier: user.tier,
    email: user.email,
    usage,
    limits: {
      summaries: limits.summaries === Infinity ? null : limits.summaries,
      explains:  limits.explains  === Infinity ? null : limits.explains,
      images:    limits.images    === Infinity ? null : limits.images
    },
    resetAt: user.resetAt
  });
});

/* ── POST /api/summarize ───────────────────────────────────── */
app.post('/api/summarize', async (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user) return res.status(401).json({ error: 'Invalid license key.' });

  const usage  = getOrResetUsage(user);
  const limits = LIMITS[user.tier];

  if (usage.summaries >= limits.summaries) {
    return res.status(402).json({
      error: 'Monthly summary limit reached.',
      upgradeUrl: `${process.env.FRONTEND_URL || 'https://pagesage.app'}/upgrade`,
      limit: limits.summaries,
      used: usage.summaries
    });
  }

  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required.' });

  try {
    const points = await aiSummarize(text, title);
    usage.summaries++;
    res.json({ points, usage: { summaries: usage.summaries, limit: limits.summaries === Infinity ? null : limits.summaries } });
  } catch (err) {
    console.error('[summarize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/explain ─────────────────────────────────────── */
app.post('/api/explain', async (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user) return res.status(401).json({ error: 'Invalid license key.' });

  const usage  = getOrResetUsage(user);
  const limits = LIMITS[user.tier];

  if (usage.explains >= limits.explains) {
    return res.status(402).json({
      error: 'Monthly explanation limit reached.',
      upgradeUrl: `${process.env.FRONTEND_URL || 'https://pagesage.app'}/upgrade`
    });
  }

  const { point, context } = req.body;
  if (!point) return res.status(400).json({ error: 'point is required.' });

  try {
    const explanation = await aiExplain(point, context || '');
    usage.explains++;
    res.json({ explanation });
  } catch (err) {
    console.error('[explain]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/image ───────────────────────────────────────── */
app.post('/api/image', async (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user) return res.status(401).json({ error: 'Invalid license key.' });

  const usage  = getOrResetUsage(user);
  const limits = LIMITS[user.tier];

  if (limits.images === 0) {
    return res.status(402).json({
      error: 'Image generation is a Pro feature.',
      upgradeUrl: `${process.env.FRONTEND_URL || 'https://pagesage.app'}/upgrade`
    });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required.' });

  try {
    const imageData = await aiGenerateImage(prompt);
    usage.images++;
    res.json({ imageData });
  } catch (err) {
    console.error('[image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/checkout ────────────────────────────────────── */
app.post('/api/checkout', async (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user) return res.status(401).json({ error: 'Invalid license key.' });

  const { plan } = req.body; // 'pro_monthly' | 'pro_yearly' | 'team_monthly'
  const priceMap = {
    pro_monthly:  process.env.STRIPE_PRICE_PRO_MONTHLY,
    pro_yearly:   process.env.STRIPE_PRICE_PRO_YEARLY,
    team_monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    // Create or reuse Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { licenseKey: key }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'https://pagesage.app'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL || 'https://pagesage.app'}/upgrade`,
      metadata: { licenseKey: key }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/portal ──────────────────────────────────────── */
app.post('/api/portal', async (req, res) => {
  const key  = req.headers['x-license-key'];
  const user = findUser(key);
  if (!user || !user.stripeCustomerId) {
    return res.status(400).json({ error: 'No billing account found.' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL || 'https://pagesage.app'}`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/webhook ─────────────────────────────────────── */
app.post('/api/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('[webhook] Signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const licKey  = session.metadata?.licenseKey;
      const user    = findUser(licKey);
      if (user) {
        user.stripeSubscriptionId = session.subscription;
        // Tier determined by next event (customer.subscription.updated)
        console.log(`[webhook] Checkout complete for ${licKey}`);
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub      = event.data.object;
      const custId   = sub.customer;
      const priceId  = sub.items.data[0]?.price?.id;
      const isActive = sub.status === 'active' || sub.status === 'trialing';

      for (const user of users.values()) {
        if (user.stripeCustomerId === custId) {
          if (isActive) {
            if (priceId === process.env.STRIPE_PRICE_TEAM_MONTHLY) user.tier = 'team';
            else user.tier = 'pro';
          } else {
            user.tier = 'free';
          }
          user.stripeSubscriptionId = sub.id;
          console.log(`[webhook] Tier updated → ${user.tier} for ${user.email}`);
          break;
        }
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub    = event.data.object;
      const custId = sub.customer;
      for (const user of users.values()) {
        if (user.stripeCustomerId === custId) {
          user.tier = 'free';
          user.stripeSubscriptionId = null;
          console.log(`[webhook] Subscription cancelled → free for ${user.email}`);
          break;
        }
      }
      break;
    }
  }

  res.json({ received: true });
});

/* ── Health check ──────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ status: 'ok', users: users.size }));

/* ══════════════════════════════════════════════════════════════
   AI HELPERS
   ══════════════════════════════════════════════════════════════ */

async function callOpenAI(messages, model = 'gpt-4o-mini', maxTokens = 800) {
  const { default: fetch } = await import('node-fetch');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI error ${resp.status}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

async function aiSummarize(text, title = '') {
  const raw = await callOpenAI([
    { role: 'system', content: 'Extract 5–9 key points as a JSON array of strings. Return ONLY the JSON array, no markdown.' },
    { role: 'user',   content: `Title: "${title}"\n\n${text.slice(0, 12000)}` }
  ], 'gpt-4o-mini', 800);

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const points  = JSON.parse(cleaned);
    if (Array.isArray(points)) return points;
  } catch {}
  return raw.split('\n').map(l => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(l => l.length > 5);
}

async function aiExplain(point, context) {
  return callOpenAI([
    { role: 'system', content: 'Write a clear, engaging 3–5 paragraph explanation of the key point using the provided context. Plain prose only.' },
    { role: 'user',   content: `Key point: "${point}"\n\nContext:\n${context.slice(0, 6000)}` }
  ], 'gpt-4o-mini', 700);
}

async function aiGenerateImage(prompt) {
  const { default: fetch } = await import('node-fetch');
  const enhanced = `A classical, detailed editorial illustration representing: ${prompt}. Style: rich oil-painting aesthetic, warm golden tones, encyclopaedic illustration.`;
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'dall-e-3', prompt: enhanced, n: 1, size: '1024x1024', response_format: 'b64_json' })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `DALL·E error ${resp.status}`);
  }
  const data = await resp.json();
  return `data:image/png;base64,${data.data[0].b64_json}`;
}

/* ── Start ─────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PageSage backend running on port ${PORT}`));
