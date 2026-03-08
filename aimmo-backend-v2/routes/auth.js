const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true
    });

    if (error) return res.status(400).json({ error: error.message });

    // Créer profil utilisateur
    await supabase.from('users').insert({
      id: data.user.id,
      email,
      plan: 'free',
      nb_scans_mois: 0,
      nb_analyses_mois: 0,
      created_at: new Date().toISOString()
    });

    res.json({ success: true, user: { id: data.user.id, email } });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const { data: profile } = await supabase.from('users').select('*').eq('id', data.user.id).single();

    res.json({ success: true, token: data.session.access_token, user: { ...data.user, ...profile } });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token invalide' });

    const { data: profile } = await supabase.from('users').select('*').eq('id', user.id).single();
    res.json({ success: true, user: { ...user, ...profile } });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
