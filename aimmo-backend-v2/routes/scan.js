const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── POST /api/scan ────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { dept, sources = ['pap', 'leboncoin'], userId } = req.body;

    // Répondre immédiatement, scan en arrière-plan
    res.json({ success: true, message: 'Scan démarré en arrière-plan', jobId: Date.now() });

    // Lancer le scan async
    lancerScanAvecDept(dept, sources).catch(console.error);

  } catch (e) {
    console.error('[/api/scan]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Scan automatique (appelé par le cron) ────────────────
async function lancerScanAuto() {
  console.log('[SCAN AUTO] Démarrage...');
  await lancerScanAvecDept(null, ['pap', 'agorastore']);
}

async function lancerScanAvecDept(dept, sources) {
  const annonces = [];

  // 1. Scraper PAP.fr via RSS (gratuit, légal)
  if (sources.includes('pap')) {
    const papAnnonces = await scraperPAP(dept);
    annonces.push(...papAnnonces);
  }

  // 2. Scraper Agorastore via API publique (ventes aux enchères)
  if (sources.includes('agorastore')) {
    const agoraAnnonces = await scraperAgorastore(dept);
    annonces.push(...agoraAnnonces);
  }

  // 3. Apify pour LeBonCoin et SeLoger (si clé dispo)
  if (process.env.APIFY_API_KEY && sources.includes('leboncoin')) {
    const apifyAnnonces = await scraperViaApify('leboncoin', dept);
    annonces.push(...apifyAnnonces);
  }

  console.log(`[SCAN] ${annonces.length} annonces récupérées`);

  // 4. Scorer chaque annonce avec les règles métier (pas IA — quota préservé)
  const annotees = annonces.map(a => ({
    ...a,
    score_ia: calculerScoreMetier(a),
    indicateurs: calculerIndicateurs(a)
  }));

  // 5. Sauvegarder en base (upsert sur l'URL pour éviter les doublons)
  if (annotees.length > 0) {
    const { error } = await supabase
      .from('annonces')
      .upsert(annotees, { onConflict: 'url_source' });

    if (error) console.error('[Supabase upsert]', error.message);
    else console.log(`[SCAN] ${annotees.length} annonces sauvegardées`);
  }

  // 6. Déclencher alertes pour les scores élevés
  await verifierAlertes(annotees.filter(a => a.score_ia >= 8));

  return annotees;
}

// ─── Scraper PAP via RSS ───────────────────────────────────
async function scraperPAP(dept) {
  try {
    const deptParam = dept ? `&departement=${dept}` : '';
    const urls = [
      `https://www.pap.fr/annonce/ventes-maisons-${dept||'france'}-g439-${dept||''}?typeTransaction=1&typeAnnonce=1`,
      `https://www.pap.fr/rss/vente-immobilier${dept ? '-' + dept : ''}`
    ];

    // Essayer le flux RSS PAP
    const rssUrl = `https://www.pap.fr/rss/vente-immobilier`;
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'AIMMO/3.0 (contact@aimmo.fr)' },
      timeout: 10000
    });

    if (!res.ok) return [];

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

    // Parser les données depuis le titre/description
    const surfaceMatch = (titre + desc).match(/(\d+)\s*m²/i);
    const prixMatch = (titre + desc).match(/(\d[\d\s]*)\s*€/);
    const cpMatch = (titre + desc).match(/\b(\d{5})\b/);
    const villeMatch = titre.match(/(?:à|-)?\s*([A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s[A-ZÀ-Ÿ][a-zà-ÿ]+)*)\s*(?:\(|\d{5})/);

    items.push({
      titre: nettoyer(titre),
      description: nettoyer(desc),
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

// ─── Scraper Agorastore (API publique) ────────────────────
async function scraperAgorastore(dept) {
  try {
    const url = `https://www.agorastore.fr/api/v1/lots?categorie=immobilier&limit=20${dept ? '&departement=' + dept : ''}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIMMO/3.0' },
      timeout: 8000
    });

    if (!res.ok) return [];
    const data = await res.json();
    const lots = data.lots || data.results || data || [];

    return lots.slice(0, 10).map(lot => ({
      titre: lot.titre || lot.title || 'Bien aux enchères',
      description: lot.description || '',
      url_source: `https://www.agorastore.fr/lot/${lot.id || lot.reference}`,
      source: 'Agorastore',
      badge: 'badge-jd',
      surface: lot.surface ? parseInt(lot.surface) : null,
      prix: lot.mise_a_prix || lot.startingPrice || null,
      cp: lot.code_postal || null,
      ville: lot.ville || lot.city || null,
      type: detecterType(lot.titre || ''),
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

// ─── Apify (LeBonCoin) ────────────────────────────────────
async function scraperViaApify(source, dept) {
  try {
    if (source !== 'leboncoin') return [];

    // URL de recherche Leboncoin immobilier
    const searchUrl = dept
      ? `https://www.leboncoin.fr/recherche?category=9&locations=${dept}`
      : `https://www.leboncoin.fr/recherche?category=9`;

    const body = {
      startUrls: [searchUrl],
      limit: 20,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL']
      }
    };

    // Lancer le run et attendre le résultat (sync)
    const runUrl = `https://api.apify.com/v2/acts/fatihtahta~leboncoin-fr-scraper/run-sync-get-dataset-items?token=${process.env.APIFY_API_KEY}&timeout=120`;

    const res = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 130000
    });

    if (!res.ok) {
      console.error('[Apify] Erreur HTTP:', res.status, await res.text());
      return [];
    }

    const items = await res.json();

    return (Array.isArray(items) ? items : []).slice(0, 20).map(item => ({
      titre: item.title || 'Annonce LeBonCoin',
      description: item.description || '',
      url_source: item.url || '',
      source: 'LeBonCoin',
      badge: 'badge-cl',
      surface: item.property?.surface_m2 || null,
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
    console.error(`[scraperViaApify:${source}]`, e.message);
    return [];
  }
}

// ─── Scoring métier (règles déterministes) ─────────────────
function calculerScoreMetier(annonce) {
  let score = 5.0; // Base

  // 1. Score prix/m² (si données DVF disponibles — sinon on skip)
  if (annonce.prix && annonce.surface && annonce.surface > 0) {
    const pm2 = annonce.prix / annonce.surface;
    if (pm2 < 800) score += 2.5;        // Très sous-évalué
    else if (pm2 < 1200) score += 1.5;  // Sous-évalué
    else if (pm2 < 2000) score += 0.5;  // Normal
    else if (pm2 > 4000) score -= 1.0;  // Sur-évalué
  }

  // 2. Score mots-clés urgence/opportunité
  const motsCles = annonce.kws || [];
  const mots_haute_valeur = ['succession', 'abandon', 'sans maître', 'judiciaire', 'enchères'];
  const mots_urgence = ['urgent', 'vente rapide', 'à saisir', 'prix négociable'];

  const nbHV = motsCles.filter(k => mots_haute_valeur.some(m => k.includes(m))).length;
  const nbUrgence = motsCles.filter(k => mots_urgence.some(m => k.includes(m))).length;

  score += Math.min(nbHV * 1.2, 2.4);
  score += Math.min(nbUrgence * 0.5, 1.0);

  // 3. Score DPE (impact positif si rénovable avec aides)
  if (annonce.dpe === 'G' || annonce.dpe === 'F') {
    if (annonce.prix && annonce.prix < 150000) score += 0.8; // Passoire bon marché = opportunité
    else score -= 0.5;
  } else if (annonce.dpe === 'A' || annonce.dpe === 'B') {
    score += 0.5;
  }

  // 4. Nouveauté
  if (annonce.is_new) score += 0.3;

  // 5. Source (sources exclusives = plus rare)
  if (['Agorastore', 'Succession vacante', 'Bien sans maître'].includes(annonce.source)) {
    score += 0.8;
  }

  // Plafonner entre 1 et 10
  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

function calculerIndicateurs(annonce) {
  const pm2 = annonce.prix && annonce.surface ? Math.round(annonce.prix / annonce.surface) : null;
  const isUrgent = (annonce.kws || []).some(k => ['urgent', 'succession', 'abandon'].includes(k));

  return {
    pm2,
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

    if (!alertes?.length) return;

    for (const alerte of alertes) {
      const criteres = alerte.criteres || {};
      const matches = annoncesHauteScore.filter(a => {
        if (criteres.dept && a.cp && !a.cp.startsWith(criteres.dept)) return false;
        if (criteres.scoreMin && a.score_ia < criteres.scoreMin) return false;
        if (criteres.prixMax && a.prix && a.prix > criteres.prixMax) return false;
        return true;
      });

      if (matches.length > 0) {
        console.log(`[ALERTE] ${matches.length} match(es) pour user ${alerte.user_id}`);
        // TODO: envoyer email via Resend/SendGrid
      }
    }
  } catch (e) {
    console.error('[verifierAlertes]', e.message);
  }
}

// ─── Utils ────────────────────────────────────────────────
function extractXML(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
  return match ? match[1].trim() : '';
}

function nettoyer(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").trim();
}

function detecterType(texte) {
  const t = texte.toLowerCase();
  if (t.includes('château') || t.includes('manoir')) return 'Château';
  if (t.includes('ferme') || t.includes('corps de ferme')) return 'Ferme';
  if (t.includes('maison') || t.includes('villa') || t.includes('pavillon')) return 'Maison';
  if (t.includes('appartement') || t.includes('appart') || t.includes('studio') || t.includes('f2') || t.includes('t2')) return 'Appartement';
  if (t.includes('terrain') || t.includes('parcelle')) return 'Terrain';
  return 'Bien';
}

function detecterMotsCles(texte) {
  const t = texte.toLowerCase();
  const mots = [];
  const dict = {
    'succession': ['succession', 'héritiers', 'héritage', 'notaire', 'succession'],
    'urgent': ['urgent', 'vente rapide', 'à saisir', 'rapidement'],
    'abandon': ['abandon', 'sans maître', 'délaissé', 'vacant', 'inoccupé'],
    'travaux': ['travaux', 'à rénover', 'rénovation', 'dégradé', 'état moyen'],
    'notaire': ['notaire', 'étude notariale', 'maître'],
    'enchères': ['enchères', 'mise à prix', 'adjudication'],
    'dégradé': ['dégradé', 'mauvais état', 'ruine', 'délabré']
  };
  for (const [label, patterns] of Object.entries(dict)) {
    if (patterns.some(p => t.includes(p))) mots.push(label);
  }
  return mots;
}

module.exports = router;
module.exports.lancerScanAuto = lancerScanAuto;
