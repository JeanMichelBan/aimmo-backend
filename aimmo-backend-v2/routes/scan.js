const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.post('/', async (req, res) => {
  try {
    const { dept, sources = ['pap', 'leboncoin'], userId } = req.body;
    res.json({ success: true, message: 'Scan démarré en arrière-plan', jobId: Date.now() });
    lancerScanAvecDept(dept, sources).catch(console.error);
  } catch (e) {
    console.error('[/api/scan]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function lancerScanAuto() {
  console.log('[SCAN AUTO] Démarrage...');
  await lancerScanAvecDept(null, ['pap', 'agorastore', 'leboncoin']);
}

async function lancerScanAvecDept(dept, sources) {
  const annonces = [];

  if (sources.includes('pap')) {
    const r = await scraperPAP(dept);
    console.log('[SCAN] PAP:', r.length, 'annonces');
    annonces.push(...r);
  }

  if (sources.includes('agorastore')) {
    const r = await scraperAgorastore(dept);
    console.log('[SCAN] Agorastore:', r.length, 'annonces');
    annonces.push(...r);
  }

  if (process.env.APIFY_API_KEY && sources.includes('leboncoin')) {
    const r = await scraperViaApify('leboncoin', dept);
    console.log('[SCAN] Apify LBC:', r.length, 'annonces');
    annonces.push(...r);
  }

  console.log('[SCAN] Total:', annonces.length, 'annonces');
  if (annonces.length === 0) return [];

  const annotees = annonces.map(a => ({
    ...a,
    score_ia: calculerScoreMetier(a),
    indicateurs: calculerIndicateurs(a)
  }));

  const { error } = await supabase
    .from('annonces')
    .upsert(annotees, { onConflict: 'url_source' });

  if (error) console.error('[Supabase upsert]', error.message);
  else console.log('[SCAN]', annotees.length, 'annonces sauvegardées');

  await verifierAlertes(annotees.filter(a => a.score_ia >= 8));
  return annotees;
}

async function scraperPAP(dept) {
  try {
    const rssUrl = dept
      ? 'https://www.pap.fr/rss/vente-immobilier-' + dept
      : 'https://www.pap.fr/rss/vente-immobilier';

    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIMMO/3.0)' },
      timeout: 15000
    });
    if (!res.ok) { console.error('[PAP] HTTP', res.status); return []; }
    const xml = await res.text();
    return parseRSSPAP(xml);
  } catch (e) {
    console.error('[scraperPAP]', e.message);
    return [];
  }
}

function parseRSSPAP(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titre = extractXML(item, 'title');
    const desc = extractXML(item, 'description');
    const lien = extractXML(item, 'link');
    const pubDate = extractXML(item, 'pubDate');
    if (!titre || !lien) continue;
    const surfaceMatch = (titre + desc).match(/(\d+)\s*m²/i);
    const prixMatch = (titre + desc).match(/(\d[\d\s]{2,})\s*€/);
    const cpMatch = (titre + desc).match(/\b(\d{5})\b/);
    const villeMatch = titre.match(/(?:à|-)?\s*([A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s[A-ZÀ-Ÿ][a-zà-ÿ]+)*)\s*(?:\(|\d{5})/);
    items.push({
      titre: nettoyer(titre),
      description: nettoyer(desc).slice(0, 500),
      url_source: lien,
      source: 'PAP.fr',
      badge: 'badge-cl',
      surface: surfaceMatch ? parseInt(surfaceMatch[1]) : null,
      prix: prixMatch ? parseInt(prixMatch[1].replace(/\s/g, '')) : null,
      cp: cpMatch ? cpMatch[1] : null,
      ville: villeMatch ? villeMatch[1] : null,
      type: detecterType(titre + desc),
      kws: detecterMotsCles(titre + desc),
      date_annonce: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      is_new: true,
      created_at: new Date().toISOString()
    });
  }
  return items.slice(0, 30);
}

async function scraperAgorastore(dept) {
  try {
    const url = 'https://www.agorastore.fr/api/v1/lots?categorie=immobilier&limit=20' + (dept ? '&departement=' + dept : '');
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'AIMMO/3.0' }, timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    const lots = data.lots || data.results || (Array.isArray(data) ? data : []);
    return lots.slice(0, 10).map(lot => ({
      titre: lot.titre || lot.title || 'Bien aux enchères',
      description: lot.description || '',
      url_source: 'https://www.agorastore.fr/lot/' + (lot.id || lot.reference),
      source: 'Agorastore',
      badge: 'badge-jd',
      surface: lot.surface ? parseInt(lot.surface) : null,
      prix: lot.mise_a_prix || lot.startingPrice || null,
      cp: lot.code_postal || null,
      ville: lot.ville || lot.city || null,
      type: detecterType(lot.titre || lot.title || ''),
      kws: ['enchères', 'judiciaire'],
      date_annonce: new Date().toISOString(),
      is_new: true,
      created_at: new Date().toISOString()
    }));
  } catch (e) {
    console.error('[scraperAgorastore]', e.message);
    return [];
  }
}

async function scraperViaApify(source, dept) {
  try {
    const token = process.env.APIFY_API_KEY;
    const searchUrl = dept
      ? 'https://www.leboncoin.fr/recherche?category=9&locations=' + dept
      : 'https://www.leboncoin.fr/recherche?category=9';

    // 1. Lancer le run
    const startRes = await fetch(
      'https://api.apify.com/v2/acts/fatihtahta~leboncoin-fr-scraper/runs?token=' + token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [searchUrl],
          limit: 50,
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
        }),
        timeout: 15000
      }
    );

    if (!startRes.ok) {
      console.error('[Apify] Erreur démarrage:', startRes.status);
      return [];
    }

    const startData = await startRes.json();
    const runId = startData?.data?.id;
    if (!runId) { console.error('[Apify] Pas de runId'); return []; }
    console.log('[Apify] Run lancé:', runId);

    // 2. Attendre max 3 minutes
    let status = 'RUNNING';
    let datasetId = null;
    for (let i = 0; i < 18; i++) {
      await sleep(10000);
      const statusRes = await fetch('https://api.apify.com/v2/actor-runs/' + runId + '?token=' + token, { timeout: 10000 });
      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();
      status = statusData?.data?.status;
      datasetId = statusData?.data?.defaultDatasetId;
      console.log('[Apify] Status:', status, '(' + (i+1) + '/18)');
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') break;
    }

    if (status !== 'SUCCEEDED' || !datasetId) {
      console.error('[Apify] Echec, status final:', status);
      return [];
    }

    // 3. Récupérer les items
    const itemsRes = await fetch('https://api.apify.com/v2/datasets/' + datasetId + '/items?token=' + token + '&limit=50', { timeout: 15000 });
    if (!itemsRes.ok) return [];
    const items = await itemsRes.json();
    console.log('[Apify]', items.length, 'items récupérés');

    return (Array.isArray(items) ? items : []).map(item => ({
      titre: item.title || 'Annonce LeBonCoin',
      description: (item.description || '').slice(0, 500),
      url_source: item.url || '',
      source: 'LeBonCoin',
      badge: 'badge-cl',
      surface: item.property?.surface_m2 ? Math.round(item.property.surface_m2) : null,
      prix: item.pricing?.amount_eur || null,
      cp: item.location?.zipcode || null,
      ville: item.location?.city || null,
      type: detecterType(item.title || ''),
      kws: detecterMotsCles((item.title || '') + ' ' + (item.description || '')),
      photos: item.media?.images?.urls || [],
      dpe: item.property?.energy?.rating || null,
      date_annonce: item.listing?.first_publication_date || new Date().toISOString(),
      is_new: true,
      created_at: new Date().toISOString()
    }));

  } catch (e) {
    console.error('[scraperViaApify]', e.message);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calculerScoreMetier(annonce) {
  let score = 5.0;
  if (annonce.prix && annonce.surface && annonce.surface > 0) {
    const pm2 = annonce.prix / annonce.surface;
    if (pm2 < 800) score += 2.5;
    else if (pm2 < 1200) score += 1.5;
    else if (pm2 < 2000) score += 0.5;
    else if (pm2 > 4000) score -= 1.0;
  }
  const kws = annonce.kws || [];
  score += Math.min(kws.filter(k => ['succession','abandon','sans maître','judiciaire','enchères'].some(m => k.includes(m))).length * 1.2, 2.4);
  score += Math.min(kws.filter(k => ['urgent','vente rapide','à saisir'].some(m => k.includes(m))).length * 0.5, 1.0);
  if (annonce.dpe === 'G' || annonce.dpe === 'F') score += annonce.prix && annonce.prix < 150000 ? 0.8 : -0.5;
  else if (annonce.dpe === 'A' || annonce.dpe === 'B') score += 0.5;
  if (annonce.is_new) score += 0.3;
  if (['Agorastore','Succession vacante','Bien sans maître'].includes(annonce.source)) score += 0.8;
  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

function calculerIndicateurs(annonce) {
  const pm2 = annonce.prix && annonce.surface ? Math.round(annonce.prix / annonce.surface) : null;
  const isUrgent = (annonce.kws || []).some(k => ['urgent','succession','abandon'].includes(k));
  return {
    pm2, is_urgent: isUrgent,
    has_dpe_issue: annonce.dpe === 'F' || annonce.dpe === 'G',
    aide_estimee: annonce.dpe === 'G' ? '30 000 - 50 000 €' : annonce.dpe === 'F' ? '15 000 - 30 000 €' : '0 €',
    rendement_estime: pm2 && pm2 < 1500 ? '7-9%' : pm2 && pm2 < 2500 ? '4-6%' : '2-4%',
    score_negociation: isUrgent ? '15-20%' : '5-10%'
  };
}

async function verifierAlertes(annoncesHauteScore) {
  if (!annoncesHauteScore.length) return;
  try {
    const { data: alertes } = await supabase.from('alertes').select('*, users(email)').eq('active', true);
    if (!alertes?.length) return;
    for (const alerte of alertes) {
      const criteres = alerte.criteres || {};
      const matches = annoncesHauteScore.filter(a => {
        if (criteres.dept && a.cp && !a.cp.startsWith(criteres.dept)) return false;
        if (criteres.scoreMin && a.score_ia < criteres.scoreMin) return false;
        if (criteres.prixMax && a.prix && a.prix > criteres.prixMax) return false;
        return true;
      });
      if (matches.length > 0) console.log('[ALERTE]', matches.length, 'match(es) pour user', alerte.user_id);
    }
  } catch (e) { console.error('[verifierAlertes]', e.message); }
}

function extractXML(xml, tag) {
  const match = xml.match(new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/' + tag + '>', 's'));
  return match ? match[1].trim() : '';
}

function nettoyer(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").trim();
}

function detecterType(texte) {
  const t = texte.toLowerCase();
  if (t.includes('château') || t.includes('manoir')) return 'Château';
  if (t.includes('ferme')) return 'Ferme';
  if (t.includes('maison') || t.includes('villa') || t.includes('pavillon')) return 'Maison';
  if (t.includes('appartement') || t.includes('studio')) return 'Appartement';
  if (t.includes('terrain')) return 'Terrain';
  return 'Bien';
}

function detecterMotsCles(texte) {
  const t = texte.toLowerCase();
  const mots = [];
  const dict = {
    'succession': ['succession', 'héritiers', 'notaire'],
    'urgent': ['urgent', 'vente rapide', 'à saisir'],
    'abandon': ['abandon', 'sans maître', 'délaissé', 'vacant'],
    'travaux': ['travaux', 'à rénover', 'rénovation'],
    'notaire': ['notaire', 'étude notariale'],
    'enchères': ['enchères', 'mise à prix', 'adjudication'],
    'dégradé': ['dégradé', 'mauvais état', 'ruine']
  };
  for (const [label, patterns] of Object.entries(dict)) {
    if (patterns.some(p => t.includes(p))) mots.push(label);
  }
  return mots;
}

module.exports = router;
module.exports.lancerScanAuto = lancerScanAuto;
