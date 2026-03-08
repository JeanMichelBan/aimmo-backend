require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// ─── Middlewares ───────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────
app.use('/api/analyse',   require('./routes/analyse'));
app.use('/api/dvf',       require('./routes/dvf'));
app.use('/api/annonces',  require('./routes/annonces'));
app.use('/api/scan',      require('./routes/scan'));
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/stripe',    require('./routes/stripe'));

// ─── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() });
});

// ─── 404 ──────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ─── Error handler ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erreur serveur', detail: err.message });
});

// ─── Cron scan automatique (toutes les heures) ─────────────
const cron = require('node-cron');
const { lancerScanAuto } = require('./routes/scan');
cron.schedule('0 * * * *', () => {
  console.log('[CRON] Scan automatique déclenché');
  lancerScanAuto().catch(console.error);
});

// ─── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ AIMMO Backend démarré sur port ${PORT}`);
  console.log(`📡 Anthropic : ${process.env.ANTHROPIC_API_KEY ? 'OK' : '⚠️ MANQUANT'}`);
  console.log(`🗄️  Supabase  : ${process.env.SUPABASE_URL ? 'OK' : '⚠️ MANQUANT'}`);
  console.log(`💳 Stripe    : ${process.env.STRIPE_SECRET_KEY ? 'OK' : '⚠️ MANQUANT'}`);
  console.log(`🕷️  Apify     : ${process.env.APIFY_API_KEY ? 'OK' : '⚠️ MANQUANT'}`);
});
