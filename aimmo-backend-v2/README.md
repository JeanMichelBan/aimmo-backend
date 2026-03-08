# AIMMO Backend — Guide de déploiement Railway

## Déploiement en 5 minutes

### 1. Préparer le repo GitHub
```bash
# Dans ce dossier :
git init
git add .
git commit -m "AIMMO Backend v3"
git remote add origin https://github.com/TON-COMPTE/aimmo-backend.git
git push -u origin main
```

### 2. Déployer sur Railway
1. Va sur railway.app → "New Project" → "Deploy from GitHub repo"
2. Sélectionne ton repo aimmo-backend
3. Railway détecte automatiquement Node.js

### 3. Ajouter les variables d'environnement
Dans Railway → ton projet → "Variables" → ajoute :

| Variable | Valeur |
|---|---|
| SUPABASE_URL | https://ymctlhwglzxqxdgvrbrt.supabase.co |
| SUPABASE_ANON_KEY | eyJhbGci... (voir .env.example) |
| SUPABASE_SERVICE_KEY | eyJhbGci... (voir .env.example) |
| ANTHROPIC_API_KEY | sk-ant-... (ta clé Anthropic) |
| STRIPE_SECRET_KEY | sk_live_... (ta clé Stripe) |
| STRIPE_PRICE_PRO | price_... (ID produit Pro 19€) |
| STRIPE_PRICE_EXPERT | price_... (ID produit Expert 49€) |
| APIFY_API_KEY | apify_api_... (ta clé Apify) |
| NODE_ENV | production |
| FRONTEND_URL | * |

### 4. Récupérer l'URL Railway
Après deploy → Settings → Domains → copier l'URL
Format : https://aimmo-backend-production-xxxx.up.railway.app

### 5. Mettre à jour le frontend
Dans aimmo-v3.html, ligne ~895 :
```js
const API_BASE = 'https://TON-URL.up.railway.app';
```
Remplacer par ton URL Railway.

### 6. Tester
```
GET https://ton-url.railway.app/health
→ {"status":"ok","version":"3.0.0"}
```

## Routes disponibles
- `GET  /health` — Vérification santé
- `POST /api/analyse` — Analyse IA d'un bien
- `GET  /api/dvf?cp=31000&type=maison` — Données DVF réelles
- `GET  /api/annonces` — Liste des annonces
- `POST /api/scan` — Déclencher un scan
- `POST /api/auth/register` — Créer un compte
- `POST /api/auth/login` — Se connecter
- `GET  /api/stripe/plans` — Plans disponibles
- `POST /api/stripe/checkout` — Créer session paiement
