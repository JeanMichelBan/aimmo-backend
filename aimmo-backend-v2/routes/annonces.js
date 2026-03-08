const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── GET /api/annonces?dept=31&type=maison&scoreMin=7 ──────
router.get('/', async (req, res) => {
  try {
    const { dept, type, scoreMin, source, limit = 100, offset = 0 } = req.query;
    let query = supabase
      .from('annonces')
      .select('*')
      .order('score_ia', { ascending: false })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (dept) query = query.ilike('cp', dept + '%');
    if (type) query = query.eq('type', type);
    if (scoreMin) query = query.gte('score_ia', parseFloat(scoreMin));
    if (source) query = query.eq('source', source);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({
      success: true,
      annonces: data || [],
      total: count,
      offset: parseInt(offset),
      limit: parseInt(limit)
    });
  } catch (e) {
    console.error('[/api/annonces GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/annonces/:id/check ──────────────────────────
router.get('/:id/check', async (req, res) => {
  try {
    const { data: annonce } = await supabase
      .from('annonces')
      .select('id, url_source')
      .eq('id', req.params.id)
      .single();

    if (!annonce) return res.json({ exists: false, reason: 'not_in_db' });
    if (!annonce.url_source || annonce.url_source === '#') return res.json({ exists: true, reason: 'no_url' });

    const token = process.env.APIFY_API_KEY;
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/apify~url-status-checker/runs?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [{ url: annonce.url_source }],
          proxyConfiguration: { useApifyProxy: true }
        }),
        timeout: 10000
      }
    );

    if (!startRes.ok) return res.json({ exists: true, reason: 'check_failed' });
    const startData = await startRes.json();
    const runId = startData?.data?.id;
    if (!runId) return res.json({ exists: true, reason: 'no_run' });

    // Poll max 30 secondes
    let status = 'RUNNING', datasetId = null;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
      const sd = await s.json();
      status = sd?.data?.status;
      datasetId = sd?.data?.defaultDatasetId;
      if (status === 'SUCCEEDED' || status === 'FAILED') break;
    }

    if (status !== 'SUCCEEDED') return res.json({ exists: true, reason: 'timeout' });

    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=1`);
    const items = await itemsRes.json();
    const httpStatus = items?.[0]?.statusCode;

    if (httpStatus === 404 || httpStatus === 410) {
      await supabase.from('annonces').delete().eq('id', req.params.id);
      console.log(`[CHECK] Annonce ${req.params.id} supprimée (HTTP ${httpStatus})`);
      return res.json({ exists: false, reason: 'http_' + httpStatus });
    }

    return res.json({ exists: true, statusCode: httpStatus });

  } catch (e) {
    console.error('[check]', e.message);
    res.json({ exists: true, reason: 'error' });
  }
});

// ─── GET /api/annonces/:id ─────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('annonces')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Annonce non trouvée' });
    res.json({ success: true, annonce: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
