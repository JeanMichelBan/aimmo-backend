const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié — token manquant' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token invalide ou expiré' });

    const { data: profile } = await supabase
      .from('users').select('*').eq('id', user.id).single();

    if (!profile) return res.status(401).json({ error: 'Profil utilisateur introuvable' });

    if (profile.plan !== 'free') {
      const now = new Date();
      if (profile.plan_updated_at) {
        const diffDays = (now - new Date(profile.plan_updated_at)) / (1000 * 60 * 60 * 24);
        if (diffDays > 35) {
          await supabase.from('users').update({ plan: 'free' }).eq('id', user.id);
          profile.plan = 'free';
        }
      }
    }

    req.user = { ...user, ...profile };
    next();
  } catch (e) {
    console.error('[middleware/auth]', e.message);
    res.status(500).json({ error: 'Erreur authentification' });
  }
}

const QUOTAS = {
  free:    { scans: 3,   analyses: 2   },
  starter: { scans: 10,  analyses: 10  },
  pro:     { scans: 30,  analyses: 30  },
  expert:  { scans: 999, analyses: 999 }
};

async function checkQuota(type) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'Non authentifié' });

      const plan = user.plan || 'free';
      const quota = QUOTAS[plan] || QUOTAS.free;
      const field = type === 'scan' ? 'nb_scans_mois' : 'nb_analyses_mois';
      const limit = type === 'scan' ? quota.scans : quota.analyses;
      const current = user[field] || 0;

      if (current >= limit) {
        return res.status(429).json({
          error: `Quota ${type}s atteint (${current}/${limit} ce mois)`,
          plan,
          upgrade_url: '/pricing'
        });
      }

      await supabase.from('users').update({ [field]: current + 1 }).eq('id', user.id);
      next();
    } catch (e) {
      console.error('[middleware/checkQuota]', e.message);
      next();
    }
  };
}

async function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return next();

    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) {
      const { data: profile } = await supabase
        .from('users').select('*').eq('id', user.id).single();
      req.user = { ...user, ...profile };
    }
  } catch {}
  next();
}

module.exports = { requireAuth, checkQuota, optionalAuth };
