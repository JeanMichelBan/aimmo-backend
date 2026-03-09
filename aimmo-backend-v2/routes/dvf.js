const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Cache Supabase (remplace cache mémoire) ───────────────
async function getCache(key) {
  try {
    const { data } = await supabase
      .from('dvf_cache')
      .select('data, expires_at')
      .eq('cache_key', key)
      .single();
    if (!data) return null;
    if (new Date(data.expires_at) < new Date()) return null; // expiré
    return data.data;
  } catch {
    return null;
  }
}

async function setCache(key, data) {
  try {
    await supabase.from('dvf_cache').upsert({
      cache_key: key,
      data,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }, { onConflict: 'cache_key' });
  } catch (e) {
    console.error('[dvf_cache] setCache error:', e.message);
  }
}

// ─── GET /api/dvf?commune=31555&type=maison&surface=120 ────
router.get('/', async (req, res) => {
  try {
    const { commune, cp, type, surface } = req.query;

    if (!commune && !cp) {
      return res.status(400).json({ error: 'Paramètre commune ou cp requis' });
    }

    const cacheKey = `${commune||cp}_${type||'all'}`;

    // Vérifier cache Supabase
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', ...cached });
    }

    // Résoudre code commune depuis CP si nécessaire
    let codeCommune = commune;
    if (!codeCommune && cp) {
      codeCommune = await getCommuneFromCP(cp);
    }

    if (!codeCommune) {
      return res.json({ success: true, transactions: [], mediane_m2: null, message: 'Commune non trouvée' });
    }

    // Appel API DVF officielle
    const dvfUrl = `https://app.dvf.etalab.gouv.fr/api/mutations/dvf/?code_commune=${codeCommune}&nb_resultats=20`;
    const dvfRes = await fetch(dvfUrl, {
      headers: { 'Accept': 'application/json' },
      timeout: 8000
    });

    if (!dvfRes.ok) {
      return await fallbackDVF(cp, type, surface, res);
    }

    const dvfData = await dvfRes.json();
    const processed = processDVFData(dvfData, type, surface);

    // Sauvegarder en cache Supabase
    await setCache(cacheKey, processed);

    res.json({ success: true, source: 'dvf_etalab', ...processed });

  } catch (e) {
    console.error('[/api/dvf]', e.message);
    res.json({ success: false, transactions: [], mediane_m2: null, error: e.message });
  }
});

// ─── GET /api/dvf/stats?cp=31000&type=maison ──────────────
router.get('/stats', async (req, res) => {
  try {
    const { cp, type } = req.query;
    if (!cp) return res.status(400).json({ error: 'CP requis' });

    const cacheKey = `stats_${cp}_${type||'all'}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json({ success: true, source: 'cache', cp, ...cached });

    const url = `https://api.priximmobilier.fr/v1/transactions?code_postal=${cp}&type_local=${mapType(type)}&limit=50`;
    const response = await fetch(url).catch(() => null);

    if (!response || !response.ok) {
      return res.json(getDefaultStats(cp));
    }

    const data = await response.json();
    const stats = computeStats(data.results || []);
    await setCache(cacheKey, stats);
    res.json({ success: true, cp, ...stats });

  } catch (e) {
    res.json(getDefaultStats(req.query.cp));
  }
});

// ─── Helpers ──────────────────────────────────────────────

async function getCommuneFromCP(cp) {
  try {
    const url = `https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=code,nom&format=json&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    return data?.[0]?.code || null;
  } catch {
    return null;
  }
}

function processDVFData(raw, type, surface) {
  const mutations = raw.results || raw.mutations || raw || [];
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return { transactions: [], mediane_m2: null, nb_transactions: 0 };
  }

  const transactions = mutations
    .filter(m => {
      if (!m.valeur_fonciere || !m.surface_reelle_bati) return false;
      const surfaceNum = parseFloat(m.surface_reelle_bati);
      if (surfaceNum < 10 || surfaceNum > 2000) return false;
      if (type && m.type_local && !m.type_local.toLowerCase().includes(mapType(type).toLowerCase())) return false;
      return true;
    })
    .slice(0, 8)
    .map(m => {
      const surf = parseFloat(m.surface_reelle_bati);
      const prix = parseFloat(m.valeur_fonciere);
      const pm2 = Math.round(prix / surf);
      const date = m.date_mutation ? new Date(m.date_mutation) : new Date();
      return {
        date: date.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }),
        type: `${m.type_local || 'Bien'} ${Math.round(surf)}m²`,
        prix: prix.toLocaleString('fr-FR') + ' €',
        m2: pm2.toLocaleString('fr-FR') + ' €/m²',
        pm2_num: pm2,
        surface: surf
      };
    });

  const pm2s = transactions.map(t => t.pm2_num).filter(Boolean).sort((a, b) => a - b);
  const mediane_m2 = pm2s.length > 0 ? pm2s[Math.floor(pm2s.length / 2)] : null;

  const withEcart = transactions.map(t => {
    if (!mediane_m2 || !t.pm2_num) return { ...t, ecart: '—', sens: 'neutral' };
    const ecartPct = Math.round(((t.pm2_num - mediane_m2) / mediane_m2) * 100);
    return {
      ...t,
      ecart: (ecartPct >= 0 ? '+' : '') + ecartPct + '%',
      sens: ecartPct >= 0 ? 'up' : 'down'
    };
  });

  return {
    transactions: withEcart,
    mediane_m2,
    nb_transactions: transactions.length,
    prix_min: pm2s[0] || null,
    prix_max: pm2s[pm2s.length - 1] || null
  };
}

async function fallbackDVF(cp, type, surface, res) {
  // Fallback : données régionales par défaut
  const stats = getDefaultStats(cp);
  res.json({ success: true, transactions: [], ...stats, source: 'fallback' });
}

function computeStats(results) {
  if (!results.length) return { mediane_m2: null, nb_transactions: 0 };
  const pm2s = results
    .filter(r => r.prix_m2)
    .map(r => r.prix_m2)
    .sort((a, b) => a - b);
  return {
    mediane_m2: pm2s[Math.floor(pm2s.length / 2)] || null,
    nb_transactions: results.length,
    prix_min: pm2s[0],
    prix_max: pm2s[pm2s.length - 1]
  };
}

function mapType(type) {
  if (!type) return '';
  const t = type.toLowerCase();
  if (t.includes('maison')) return 'Maison';
  if (t.includes('appart')) return 'Appartement';
  return '';
}

function getDefaultStats(cp) {
  const regionDefaults = {
    '75': 10500, '92': 7800, '93': 4200, '94': 5800, '95': 3600,
    '69': 4800, '13': 3900, '31': 3400, '33': 3800, '06': 5200,
    '59': 2100, '67': 3100, '44': 3600, '34': 3100, '38': 2900
  };
  const prefix = (cp || '').substring(0, 2);
  const mediane = regionDefaults[prefix] || 2200;
  return { success: true, mediane_m2: mediane, nb_transactions: 0, source: 'default', cp };
}

module.exports = router;
