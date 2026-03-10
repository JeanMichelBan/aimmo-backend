const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── GET /api/annonces?dept=31&type=maison&scoreMin=7&page=1&limit=20 ──────
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { dept, type, scoreMin, source, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('annonces')
      .select('*', { count: 'exact' })
      .order('score_ia', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (dept)     query = query.ilike('cp', dept + '%');
    if (type)     query = query.eq('type', type);
    if (scoreMin) query = query.gte('score_ia', parseFloat(scoreMin));
    if (source)   query = query.eq('source', source);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      annonces: data || [],
      total: count || 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((count || 0) / limitNum)
    });
  } catch (e) {
    console.error('[/api/annonces GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/annonces/:id/check ───────────────────────────
router.get('/:id/check', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('annonces')
      .select('id')
      .eq('id', req.params.id)
      .single();
    res.json({ exists: !error && !!data });
  } catch (e) {
    res.json({ exists: false });
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

// ─── DELETE /api/annonces/:id ──────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('annonces')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Annonce supprimée' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
