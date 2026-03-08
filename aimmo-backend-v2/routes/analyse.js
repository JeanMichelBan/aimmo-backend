const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPT = `Tu es le moteur d'analyse immobilier d'AIMMO, outil d'aide à la décision pour investisseurs immobiliers français.
RÈGLES ABSOLUES :
- Analyses basées uniquement sur les données fournies et les prix DVF réels du marché français
- Jamais de décision d'investissement ferme — tu es un outil d'aide à la réflexion
- Si une donnée est absente, indique "Données insuffisantes" pour cet indicateur
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant/après ni backticks markdown

STRUCTURE JSON OBLIGATOIRE :
{
  "score": 7.4,
  "verdict": "Opportunité intéressante",
  "verdict_class": "good",
  "resume": "2 phrases max résumant le potentiel du bien",
  "tags": [{"label": "Sous-évalué", "type": "green"}],
  "indicateurs": [
    {
      "id": "prix_m2",
      "label": "Prix au m²",
      "icon": "💶",
      "valeur": "1 450 €/m²",
      "statut": "good",
      "statut_label": "Sous-évalué",
      "barre": 35,
      "barre_couleur": "green",
      "commentaire": "Commentaire court et précis"
    }
  ],
  "dvf": [
    {"date": "Jan 2024", "type": "Maison 110m²", "prix": "195 000 €", "m2": "1 773 €", "ecart": "-18%", "sens": "down"}
  ],
  "conseils": [
    {"type": "positive", "icon": "✅", "texte": "Conseil actionnable"}
  ],
  "donnees_insuffisantes": []
}

RÈGLES DE SCORING :
- statut valeurs : "good", "warn", "bad", "neutral", "na"
- verdict_class : "great" (≥8.5), "good" (7-8.4), "avg" (5-6.9), "bad" (<5)
- barre : 0-100 représentant la position dans l'échelle de risque/opportunité

12 INDICATEURS OBLIGATOIRES dans cet ordre :
prix_m2, positionnement, nego_score, etat_score, dpe_impact, tension_marche, budget_total, rendement_loc, plus_value, statut_legal, aide_potentielle, score_global

CONTEXTE MARCHÉ FRANÇAIS :
- Prix médian national maison : ~2 200€/m², appartement : ~3 500€/m²
- DPE G : interdit à la location depuis jan 2025, DPE F : interdit 2028
- MaPrimeRénov couvre 50-70% des travaux selon revenus
- Frais de notaire : ~7.5% ancien, ~3% neuf
- Rendement locatif brut correct en province : 6-9%`;

// ─── POST /api/analyse ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { bien, userId } = req.body;

    if (!bien || !bien.ville || !bien.surface || !bien.prix) {
      return res.status(400).json({ error: 'Données manquantes : ville, surface, prix obligatoires' });
    }

    // Vérification quota utilisateur
    if (userId) {
      const { data: user } = await supabase
        .from('users')
        .select('plan, nb_analyses_mois')
        .eq('id', userId)
        .single();

      if (user) {
        const limites = { free: 3, pro: 999, expert: 9999 };
        const limite = limites[user.plan] || 3;
        if (user.nb_analyses_mois >= limite) {
          return res.status(403).json({
            error: 'Quota atteint',
            message: `Plan ${user.plan} : ${limite} analyses/mois. Passez à Pro pour continuer.`,
            upgrade: true
          });
        }
      }
    }

    const prompt = buildPrompt(bien);

    // Appel Anthropic
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Anthropic Error]', err);
      return res.status(502).json({ error: 'Erreur API Anthropic', detail: err });
    }

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Sauvegarder en base si userId
    if (userId) {
      await supabase.from('analyses').insert({
        user_id: userId,
        bien_data: bien,
        analyse_data: analysis,
        score: analysis.score,
        ville: bien.ville,
        cp: bien.cp,
        created_at: new Date().toISOString()
      });

      // Incrémenter le compteur
      await supabase.rpc('increment_analyses', { user_id: userId });
    }

    res.json({ success: true, analysis });

  } catch (e) {
    console.error('[/api/analyse]', e.message);
    res.status(500).json({ error: 'Erreur analyse', detail: e.message });
  }
});

function buildPrompt(d) {
  return `Analyse ce bien immobilier français :

TYPE : ${d.type || 'Non précisé'}
LOCALISATION : ${d.ville} (${d.cp})${d.adresse ? ' — ' + d.adresse : ''}
SURFACE : ${d.surface}m²${d.terrain ? ' + terrain ' + d.terrain + 'm²' : ''}
PIÈCES : ${d.pieces || 'Non précisé'} | ANNÉE : ${d.annee || 'Non précisée'}
PRIX DEMANDÉ : ${d.prix.toLocaleString('fr-FR')} € (${Math.round(d.prix / d.surface).toLocaleString('fr-FR')} €/m²)
TRAVAUX ESTIMÉS : ${(d.travaux || 0).toLocaleString('fr-FR')} €
BUDGET TOTAL : ${(d.prix + (d.travaux || 0)).toLocaleString('fr-FR')} €
CHARGES ANNUELLES : ${(d.charges || 0).toLocaleString('fr-FR')} €
ÉTAT GÉNÉRAL : ${d.etat || 'Non précisé'}
DPE : ${d.dpe || 'Non renseigné'} | CHAUFFAGE : ${d.chauffage || 'Non précisé'}
CONTEXTE VENDEUR : ${d.contexte || 'Particulier'}
MARGE NÉGOCIATION ESTIMÉE : ${d.nego || 5}%
SIGNAUX DÉTECTÉS : ${d.signaux?.join(', ') || 'Aucun'}
DONNÉES DVF RÉELLES : ${d.dvfData ? JSON.stringify(d.dvfData) : 'Non disponibles pour cette commune'}
NOTES : ${d.commentaires || 'Aucune'}`;
}

module.exports = router;
