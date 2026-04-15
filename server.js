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
  free:      { summaries: 10,        explains: 30,        images: 3          },
  anonymous: { summaries: 10,        explains: 30,        images: 3          },
  pro:       { summaries: Infinity,  explains: Infinity,  images: Infinity   },
  team:      { summaries: Infinity,  explains: Infinity,  images: Infinity   }
};

/* Anonymous user store (by IP, no registration needed) */
const anonUsage = new Map(); // ip → { summaries, explains, images, resetAt }

function getAnonUsage(ip) {
  const now = new Date();
  let u = anonUsage.get(ip);
  if (!u || now >= new Date(u.resetAt.getFullYear(), u.resetAt.getMonth() + 1, 1)) {
    u = { summaries: 0, explains: 0, images: 0, resetAt: new Date(now.getFullYear(), now.getMonth(), 1) };
    anonUsage.set(ip, u);
  }
  return u;
}

function getOrResetUsage(user) {
  const now = new Date();
  if (!user.resetAt || now >= new Date(user.resetAt.getFullYear(), user.resetAt.getMonth() + 1, 1)) {
    user.usage  = { summaries: 0, explains: 0, images: 0 };
    user.resetAt = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return user.usage;
}

function findUser(licenseKey) {
  if (!licenseKey || licenseKey === 'anonymous') return null;
  return users.get(licenseKey) || null;
}

function resolveUser(req) {
  const key  = req.headers['x-license-key'] || req.body?.licenseKey || '';
  const user = findUser(key);
  if (user) return { user, tier: user.tier, usage: getOrResetUsage(user), isAnon: false };
  // Anonymous free user — track by IP
  const ip   = req.ip || req.connection?.remoteAddress || 'unknown';
  const usage = getAnonUsage(ip);
  return { user: null, tier: 'anonymous', usage, isAnon: true };
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
  const { user, tier, usage, isAnon } = resolveUser(req);
  const limits = LIMITS[tier] || LIMITS.free;

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
  const { user, tier, usage, isAnon } = resolveUser(req);
  const limits = LIMITS[tier] || LIMITS.free;

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
  const { user, tier, usage } = resolveUser(req);
  const limits = LIMITS[tier] || LIMITS.free;

  if (usage.images >= limits.images) {
    return res.status(402).json({
      error: tier === 'free' || tier === 'anonymous'
        ? 'Free image limit reached. Upgrade to Pro for unlimited illustrations.'
        : 'Image limit reached.',
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

/* ── POST /api/mindmap ─────────────────────────────────────── */
app.post('/api/mindmap', async (req, res) => {
  const { user, tier, usage } = resolveUser(req);
  const limits = LIMITS[tier] || LIMITS.free;

  if (usage.images >= limits.images) {
    return res.status(402).json({
      error: 'Visual generation limit reached. Upgrade to Pro for unlimited mind maps.',
      upgradeUrl: `${process.env.FRONTEND_URL || 'https://pagesage.app'}/upgrade`
    });
  }

  const { prompt, context } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required.' });

  try {
    const nodes = await aiMindmap(prompt, context || '');
    usage.images++; // counts against same visual quota
    res.json({ nodes });
  } catch (err) {
    console.error('[mindmap]', err.message);
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

/* ── POST /api/translate ──────────────────────────────────── */
app.post('/api/translate', async (req, res) => {
  // Translation is available to all users (free + anonymous)

  const { texts, targetLang } = req.body;
  if (!Array.isArray(texts) || !targetLang) {
    return res.status(400).json({ error: 'texts (array) and targetLang are required.' });
  }

  const SUPPORTED = ['en','de','es','fr','it','el','ru','ja','zh','ko','th'];
  if (!SUPPORTED.includes(targetLang)) {
    return res.status(400).json({ error: `Unsupported language: ${targetLang}` });
  }

  try {
    const translations = await aiTranslate(texts, targetLang);
    res.json({ translations, targetLang });
  } catch (err) {
    console.error('[translate]', err.message);
    res.status(500).json({ error: err.message });
  }
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
    {
      role: 'system',
      content: `Extract 5–9 key points from the text. Return a JSON array of objects with this exact schema:
[{"text": "...", "importance": "high|mid|low"}]
Rules:
- 2–3 points should be "high" (core thesis, most critical facts)
- 2–4 points should be "mid" (supporting details)
- 1–2 points may be "low" (background/context)
- Wrap the most important terms in **double asterisks**
- Return ONLY the JSON array, no markdown fences.`
    },
    { role: 'user', content: `Title: "${title}"\n\n${text.slice(0, 12000)}` }
  ], 'gpt-4o-mini', 1000);

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const points  = JSON.parse(cleaned);
    if (Array.isArray(points)) return points;
  } catch {}
  // Fallback: plain strings
  return raw.split('\n').map(l => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(l => l.length > 5)
    .map(t => ({ text: t, importance: 'mid' }));
}

async function aiMindmap(prompt, context) {
  const raw = await callOpenAI([
    {
      role: 'system',
      content: 'Generate 6–10 concise mind-map nodes (2–4 words each) related to the key point. Return ONLY a JSON array of strings. No markdown.'
    },
    { role: 'user', content: `Key point: "${prompt}"\nContext: ${context.slice(0, 2000)}` }
  ], 'gpt-4o-mini', 300);

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const nodes   = JSON.parse(cleaned);
    if (Array.isArray(nodes)) return nodes;
  } catch {}
  return raw.split('\n').map(l => l.replace(/^[-*\d.)\s"]+/, '').replace(/["]+$/, '').trim()).filter(l => l.length > 1).slice(0, 10);
}

async function aiExplain(point, context) {
  return callOpenAI([
    { role: 'system', content: 'Write a clear, engaging 3–5 paragraph explanation of the key point using the provided context. Plain prose only.' },
    { role: 'user',   content: `Key point: "${point}"\n\nContext:\n${context.slice(0, 6000)}` }
  ], 'gpt-4o-mini', 700);
}

async function aiTranslate(texts, targetLang) {
  const LANG_NAMES = {
    en: 'English', de: 'German', es: 'Spanish', fr: 'French',
    it: 'Italian', el: 'Greek', ru: 'Russian', ja: 'Japanese',
    zh: 'Chinese (Simplified)', ko: 'Korean', th: 'Thai'
  };
  const langName = LANG_NAMES[targetLang] || targetLang;
  const input    = JSON.stringify(texts);

  const raw = await callOpenAI([
    {
      role: 'system',
      content: `You are a professional translator. Translate each string in the JSON array to ${langName}. Return ONLY a valid JSON array of translated strings in the same order. No markdown, no extra text.`
    },
    { role: 'user', content: input }
  ], 'gpt-4o-mini', 1500);

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const result  = JSON.parse(cleaned);
    if (Array.isArray(result) && result.length === texts.length) return result;
  } catch {}

  // Fallback: return originals if parse fails
  return texts;
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
