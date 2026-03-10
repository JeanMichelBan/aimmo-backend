const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APIFY_TOKEN = process.env.APIFY_API_KEY;

// ─── POST /api/scan ────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { dept, sources = ['leboncoin', 'pap'], userId } = req.body;

    res.json({ success: true, message: 'Scan démarré en arrière-plan', jobId: Date.now() });

    lancerScanAvecDept(dept, sources, userId).catch(console.error);

  } catch (e) {
    console.error('[/api/scan]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Scan automatique (cron) ──────────────────────────────
async function lancerScanAuto() {
  console.log('[SCAN AUTO] Démarrage...');
  await lancerScanAvecDept(null, ['leboncoin', 'pap'], null);
}

async function lancerScanAvecDept(dept, sources, userId) {
  const annonces = [];
  const statsParSource = {};

  if (!APIFY_TOKEN) {
    console.error('[SCAN] APIFY_API_KEY manquante — aucun scraping possible');
    return [];
  }

  // LeBonCoin via Apify
  if (sources.includes('leboncoin')) {
    console.log('[SCAN] Scraping LeBonCoin...');
    const items = await scraperApifyAsync({
      actorId: 'fatihtahta~leboncoin-fr-scraper',
      input: {
        startUrls: [buildLeBonCoinUrl(dept)],
        maxItems: 50
      },
      source: 'LeBonCoin',
      badge: 'badge-cl',
      mapper: mapLeBonCoin
    });
    annonces.push(...items);
    statsParSource['leboncoin'] = items.length;
    console.log('[LeBonCoin] ' + items.length + ' annonces');
  }

  // PAP.fr via Apify
  if (sources.includes('pap')) {
    console.log('[SCAN] Scraping PAP.fr...');
    const items = await scraperApifyAsync({
      actorId: 'azzouzana~pap-fr-mass-products-scraper-by-search-url',
      input: {
        startUrl: dept
          ? `https://www.pap.fr/annonce/vente-appartement-maison-terrain?geo_departement=${dept}`
          : 'https://www.pap.fr/annonce/vente-appartement-maison',
        maxItemsToScrape: 50
      },
      source: 'PAP.fr',
      badge: 'badge-cl',
      mapper: mapPAP
    });
    annonces.push(...items);
    statsParSource['pap'] = items.length;
    console.log('[PAP.fr] ' + items.length + ' annonces');
  }

  // Bien'ici — désactivé (bloqué 403 proxy)

  // Agorastore
  if (sources.includes('agorastore')) {
    console.log('[SCAN] Scraping Agorastore...');
    const items = await scraperAgorastore(dept);
    annonces.push(...items);
    statsParSource['agorastore'] = items.length;
    console.log('[Agorastore] ' + items.length + ' annonces');
  }

  console.log('[SCAN] Total : ' + annonces.length + ' annonces récupérées');

  // Scorer
  const annotees = annonces.map(a => ({
    ...a,
    score_ia: calculerScoreMetier(a),
    indicateurs: calculerIndicateurs(a)
  }));

  let nbNouvelles = 0;

  // Upsert Supabase
  if (annotees.length > 0) {
    const { data: upserted, error } = await supabase
      .from('annonces')
      .upsert(annotees, { onConflict: 'url_source' });

    if (error) console.error('[Supabase upsert]', error.message);
    else {
      nbNouvelles = annotees.length;
      console.log('[SCAN] ' + annotees.length + ' annonces sauvegardées');
    }
  }

  // ─── Sauvegarder historique scan ──────────────────────
  for (const source of Object.keys(statsParSource)) {
    await supabase.from('scans').insert({
      user_id: userId || null,
      source: source,
      nb_annonces: statsParSource[source],
      nb_nouvelles: statsParSource[source],
      nb_alertes: 0,
      statut: 'ok',
      created_at: new Date().toISOString()
    });
  }

  await verifierAlertes(annotees.filter(a => a.score_ia >= 8));

  return annotees;
}

// ─── Runner Apify générique (asynchrone + poll) ───────────
async function scraperApifyAsync({ actorId, input, source, badge, mapper }) {
  try {
    const startRes = await fetch(
      'https://api.apify.com/v2/acts/' + actorId + '/runs?token=' + APIFY_TOKEN,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }
    );

    if (!startRes.ok) {
      const err = await startRes.text();
      console.error('[Apify:' + source + '] Start failed:', err.slice(0, 200));
      return [];
    }

    const runData = await startRes.json();
    const runId = runData && runData.data && runData.data.id;
    if (!runId) {
      console.error('[Apify:' + source + '] Pas de runId');
      return [];
    }

    console.log('[Apify:' + source + '] Run démarré: ' + runId);

    const MAX_WAIT = 180000;
    const POLL_INTERVAL = 8000;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      await sleep(POLL_INTERVAL);

      const statusRes = await fetch(
        'https://api.apify.com/v2/actor-runs/' + runId + '?token=' + APIFY_TOKEN
      );
      const statusData = await statusRes.json();
      const status = statusData && statusData.data && statusData.data.status;

      console.log('[Apify:' + source + '] Status: ' + status);

      if (status === 'SUCCEEDED') {
        const datasetId = statusData.data.defaultDatasetId;
        const itemsRes = await fetch(
          'https://api.apify.com/v2/datasets/' + datasetId + '/items?token=' + APIFY_TOKEN + '&format=json&limit=100'
        );
        const items = await itemsRes.json();
        return (Array.isArray(items) ? items : []).map(item => mapper(item)).filter(Boolean);
      }

      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
        console.error('[Apify:' + source + '] Run terminé avec status: ' + status);
        return [];
      }
    }

    console.warn('[Apify:' + source + '] Timeout (3 min) dépassé');
    return [];

  } catch (e) {
    console.error('[Apify:' + source + ']', e.message);
    return [];
  }
}

// ─── Mappers par source ───────────────────────────────────

function mapLeBonCoin(item) {
  try {
    const attrs = item.attributes || {};
    const surface = attrs.square ? parseInt(attrs.square) : null;
    const prix = (item.price && item.price[0]) || item.price || null;
    const cp = (item.location && item.location.zipcode) || null;
    const ville = (item.location && item.location.city) || null;
    const titre = item.subject || item.title || 'Annonce LeBonCoin';
    const desc = item.body || item.description || '';

    return {
      titre: nettoyer(titre),
      description: nettoyer(desc).slice(0, 500),
      url_source: item.url || ('https://www.leboncoin.fr/ventes_immobilieres/' + item.list_id),
      source: 'LeBonCoin',
      badge: 'badge-cl',
      surface: surface,
      prix: prix ? parseInt(String(prix).replace(/\D/g, '')) : null,
      cp: cp,
      ville: ville,
      type: detecterType(titre + ' ' + desc),
      kws: detecterMotsCles(titre + ' ' + desc),
      dpe: (attrs.energy_rate && attrs.energy_rate.value) || null,
      photos: (item.images && item.images.urls_large && item.images.urls_large.slice(0, 3)) || [],
      date_annonce: item.first_publication_date || new Date().toISOString(),
      is_new: true,
      created_at: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

function mapPAP(item) {
  try {
    const titre = item.title || item.titre || item.libelle || 'Annonce PAP.fr';
    const desc = item.description || item.texte || '';
    const prix = item.price || item.prix || item.prix_vente || null;
    const surface = item.surface || item.area || item.surface_habitable || null;
    const cp = item.zipCode || item.postalCode || item.codePostal || item.code_postal || null;
    const ville = item.city || item.ville || item.commune || null;

    return {
      titre: nettoyer(titre),
      description: nettoyer(desc).slice(0, 500),
      url_source: item.url || item.link || item.href || '',
      source: 'PAP.fr',
      badge: 'badge-cl',
      surface: surface ? parseInt(surface) : null,
      prix: prix ? parseInt(String(prix).replace(/\D/g, '')) : null,
      cp: cp ? String(cp) : null,
      ville: ville,
      type: detecterType(titre + ' ' + desc),
      kws: detecterMotsCles(titre + ' ' + desc),
      dpe: item.dpe || item.energyClass || item.classe_energie || null,
      photos: (item.photos && item.photos.slice(0, 3)) ||
              (item.images && item.images.slice(0, 3)) ||
              (item.photo ? [item.photo] : []),
      date_annonce: item.publicationDate || item.date_parution || item.date || new Date().toISOString(),
      is_new: true,
      created_at: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

// ─── Builders d'URL ───────────────────────────────────────
function buildLeBonCoinUrl(dept) {
  const base = 'https://www.leboncoin.fr/recherche?category=9&real_estate_type=1,2,3,4,5';
  return dept ? (base + '&locations=department-' + dept) : base;
}

// ─── Agorastore ───────────────────────────────────────────
async function scraperAgorastore(dept) {
  try {
    const url = 'https://www.agorastore.fr/api/v1/lots?categorie=immobilier&limit=20' + (dept ? ('&departement=' + dept) : '');
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIMMO/3.0' },
      timeout: 8000
    });
    if (!res.ok) return [];
    const data = await res.json();
    const lots = data.lots || data.results || data || [];
    return lots.slice(0, 10).map(function(lot) {
      return {
        titre: lot.titre || lot.title || 'Bien aux encheres',
        description: lot.description || '',
        url_source: 'https://www.agorastore.fr/lot/' + (lot.id || lot.reference),
        source: 'Agorastore',
        badge: 'badge-jd',
        surface: lot.surface ? parseInt(lot.surface) : null,
        prix: lot.mise_a_prix || lot.startingPrice || null,
        cp: lot.code_postal || null,
        ville: lot.ville || lot.city || null,
        type: detecterType(lot.titre || ''),
        kws: ['encheres', 'judiciaire'],
        date_annonce: new Date().toISOString(),
        is_new: true,
        created_at: new Date().toISOString()
      };
    });
  } catch (e) {
    console.error('[scraperAgorastore]', e.message);
    return [];
  }
}

// ─── Scoring métier ────────────────────────────────────────
function calculerScoreMetier(annonce) {
  let score = 5.0;

  if (annonce.prix && annonce.surface && annonce.surface > 0) {
    const pm2 = annonce.prix / annonce.surface;
    if (pm2 < 800) score += 2.5;
    else if (pm2 < 1200) score += 1.5;
    else if (pm2 < 2000) score += 0.5;
    else if (pm2 > 4000) score -= 1.0;
  }

  const motsCles = annonce.kws || [];
  const mots_haute_valeur = ['succession', 'abandon', 'sans maitre', 'judiciaire', 'encheres'];
  const mots_urgence = ['urgent', 'vente rapide', 'a saisir', 'prix negociable'];
  score += Math.min(motsCles.filter(k => mots_haute_valeur.some(m => k.includes(m))).length * 1.2, 2.4);
  score += Math.min(motsCles.filter(k => mots_urgence.some(m => k.includes(m))).length * 0.5, 1.0);

  if (annonce.dpe === 'G' || annonce.dpe === 'F') {
    if (annonce.prix && annonce.prix < 150000) score += 0.8;
    else score -= 0.5;
  } else if (annonce.dpe === 'A' || annonce.dpe === 'B') {
    score += 0.5;
  }

  if (annonce.is_new) score += 0.3;
  if (annonce.source === 'Agorastore') score += 0.8;

  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

function calculerIndicateurs(annonce) {
  const pm2 = annonce.prix && annonce.surface ? Math.round(annonce.prix / annonce.surface) : null;
  const isUrgent = (annonce.kws || []).some(k => ['urgent', 'succession', 'abandon'].includes(k));
  return {
    pm2: pm2,
    is_urgent: isUrgent,
    has_dpe_issue: annonce.dpe === 'F' || annonce.dpe === 'G',
    aide_estimee: annonce.dpe === 'G' ? '30 000 - 50 000 €' : annonce.dpe === 'F' ? '15 000 - 30 000 €' : '0 €',
    rendement_estime: pm2 && pm2 < 1500 ? '7-9%' : pm2 && pm2 < 2500 ? '4-6%' : '2-4%',
    score_negociation: isUrgent ? '15-20%' : '5-10%'
  };
}

// ─── Alertes ──────────────────────────────────────────────
async function verifierAlertes(annoncesHauteScore) {
  if (!annoncesHauteScore.length) return;
  try {
    const { data: alertes } = await supabase
      .from('alertes')
      .select('*, users(email)')
      .eq('active', true);
    if (!alertes || !alertes.length) return;
    for (const alerte of alertes) {
      const criteres = alerte.criteres || {};
      const matches = annoncesHauteScore.filter(a => {
        if (criteres.dept && a.cp && !a.cp.startsWith(criteres.dept)) return false;
        if (criteres.scoreMin && a.score_ia < criteres.scoreMin) return false;
        if (criteres.prixMax && a.prix && a.prix > criteres.prixMax) return false;
        return true;
      });
      if (matches.length > 0) {
        console.log('[ALERTE] ' + matches.length + ' match(es) pour user ' + alerte.user_id);
      }
    }
  } catch (e) {
    console.error('[verifierAlertes]', e.message);
  }
}

// ─── Utils ────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function nettoyer(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .trim();
}

function detecterType(texte) {
  const t = (texte || '').toLowerCase();
  if (t.includes('chateau') || t.includes('manoir') || t.includes('castle')) return 'Chateau';
  if (t.includes('ferme') || t.includes('corps de ferme') || t.includes('grange')) return 'Ferme';
  if (t.includes('maison') || t.includes('villa') || t.includes('pavillon') || t.includes('house')) return 'Maison';
  if (t.includes('appartement') || t.includes('appart') || t.includes('studio') || t.includes('flat')) return 'Appartement';
  if (t.includes('terrain') || t.includes('parcelle') || t.includes('land')) return 'Terrain';
  return 'Bien';
}

function detecterMotsCles(texte) {
  const t = (texte || '').toLowerCase();
  const mots = [];
  const dict = {
    'succession': ['succession', 'heritiers', 'heritage'],
    'urgent': ['urgent', 'vente rapide', 'a saisir', 'rapidement'],
    'abandon': ['abandon', 'sans maitre', 'delaisse', 'vacant', 'inoccupe'],
    'travaux': ['travaux', 'a renover', 'renovation', 'degrade', 'etat moyen'],
    'notaire': ['notaire', 'etude notariale'],
    'encheres': ['encheres', 'mise a prix', 'adjudication'],
    'degrade': ['degrade', 'mauvais etat', 'ruine', 'delabre']
  };
  for (const label in dict) {
    const patterns = dict[label];
    if (patterns.some(p => t.includes(p))) mots.push(label);
  }
  return mots;
}

module.exports = router;
module.exports.lancerScanAuto = lancerScanAuto;
