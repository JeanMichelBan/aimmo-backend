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
