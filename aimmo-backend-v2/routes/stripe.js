const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/stripe/checkout — créer session de paiement
router.post('/checkout', async (req, res) => {
  try {
    const { plan, userId, email, successUrl, cancelUrl } = req.body;

    const priceId = plan === 'expert'
      ? process.env.STRIPE_PRICE_EXPERT
      : process.env.STRIPE_PRICE_PRO;

    if (!priceId) return res.status(400).json({ error: 'Plan invalide' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: cancelUrl,
      metadata: { userId, plan }
    });

    res.json({ success: true, url: session.url, sessionId: session.id });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stripe/webhook — Stripe envoie les events ici
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Webhook invalide: ${e.message}` });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;

      if (userId && plan) {
        await supabase.from('users').update({
          plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan_updated_at: new Date().toISOString()
        }).eq('id', userId);
        console.log(`[STRIPE] User ${userId} upgraded to ${plan}`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await supabase.from('users')
        .update({ plan: 'free' })
        .eq('stripe_subscription_id', sub.id);
      console.log(`[STRIPE] Subscription ${sub.id} cancelled → downgrade to free`);
      break;
    }

    case 'invoice.payment_failed': {
      console.log(`[STRIPE] Paiement échoué pour ${event.data.object.customer}`);
      break;
    }
  }

  res.json({ received: true });
});

// GET /api/stripe/plans — retourner les plans disponibles
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        id: 'free',
        nom: 'Gratuit',
        prix: 0,
        features: ['3 scans/mois', '3 analyses IA/mois', 'Accès radar basique'],
        cta: 'Commencer gratuitement'
      },
      {
        id: 'pro',
        nom: 'Pro',
        prix: 19,
        priceId: process.env.STRIPE_PRICE_PRO,
        features: ['Scans illimités', '30 analyses IA/mois', 'Alertes temps réel', 'DVF complet', 'Export PDF'],
        cta: 'Passer Pro',
        populaire: true
      },
      {
        id: 'expert',
        nom: 'Expert',
        prix: 49,
        priceId: process.env.STRIPE_PRICE_EXPERT,
        features: ['Tout Pro', 'Analyses IA illimitées', 'API access', 'Support prioritaire', 'Rapports personnalisés'],
        cta: 'Passer Expert'
      }
    ]
  });
});

module.exports = router;
