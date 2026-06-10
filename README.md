# 🌿 Eco-Gather — POC espace virtuel type Gather

POC d'espace virtuel collaboratif (inspiré de Gather / WorkAdventure) pour Ecomaison :
carte 2D vue de dessus, avatars déplaçables au clavier, et — à terme — communication
audio / vidéo / partage d'écran déclenchée par **proximité** entre avatars.

Cible : ~5 personnes, usage interne, sans création de compte (juste un pseudo).

## État actuel

### Étape 1 ✅ — prototype spatial
- Carte 2D vue de dessus structurée en **zones** : open-space (bureaux, chaises,
  écrans), salle de **réunion** fermée (cloisons + porte), coin **café** (comptoir,
  machine, ☕ 🍩), zone **détente** (canapé, bibliothèque, 🎸, 🐈), étang à canards 🦆,
  table de ping-pong 🏓, et quelques clins d'œil (🚧 🛹).
- Avatar déplaçable au clavier : **flèches** et **ZQSD**, collisions murs + mobilier.
- **Détection de proximité avec retour visuel** : halo + changement de couleur +
  lien « en conversation » quand on entre dans la bulle d'un autre avatar.

### Personnalisation de l'avatar 🎨
À l'entrée, chacun choisit (avec aperçu en direct) :
- sa **couleur** (palette de 7) ;
- son **accessoire** : casquette 🧢, haut-de-forme 🎩 ou chapeau de fête 🥳 ;
- son **compagnon** : un petit chien 🐶 qui trottine derrière l'avatar.
La personnalisation est synchronisée : les autres voient ta couleur, ton chapeau
et ton chien. L'avatar garde sa bouille ronde avec ses petits yeux directionnels.

### Étape 2 ✅ — multijoueur positions
- Serveur **Node + Express + Socket.io** (`server/index.js`), état **en mémoire**
  (pas de base de données, réinitialisé au redémarrage).
- À l'arrivée : on saisit un pseudo, le serveur assigne un point d'apparition + une couleur.
- Synchronisation temps réel des positions (x, y, direction) entre tous les clients,
  avec **interpolation** des avatars distants pour un rendu fluide.
- Gestion propre des **connexions / déconnexions** (les avatars apparaissent/disparaissent).
- La proximité se déclenche aussi sur les **vrais participants** (mêmes hooks que l'Étape 1).
- Les bots restent affichés comme décor de démo (`SHOW_BOTS` dans `src/config.js`).

### Étape 3 ✅ — média par proximité (LiveKit)
- Token d'accès généré **côté serveur** (`GET /token`) avec `livekit-server-sdk` ;
  la clé secrète ne quitte jamais le serveur. Front et serveur partagent une room unique.
- **Connexion paresseuse (économie de minutes)** : on ne rejoint la room LiveKit
  que lorsqu'au moins une personne est **à portée**, et on la quitte (après un court
  délai de grâce) dès qu'on se retrouve seul. Seul dans son coin = **0 minute
  consommée**, et la caméra s'éteint physiquement. Le HUD indique l'état (`💤 en veille`
  / `🎥 actif`).
- Connexion LiveKit avec `autoSubscribe: false` : on publie son micro + sa caméra,
  mais on ne **souscrit** qu'aux participants **proches** (piloté par la proximité).
  Quand on s'éloigne → désabonnement automatique (bande passante préservée).
- Identité LiveKit = id Socket.io → la proximité « jeu » pilote directement le média.
- Vignettes vidéo des personnes proches + self-view, indicateur de personne qui parle.
- Barre de contrôles : 🎤 micro, 🎥 caméra, 🖥️ partage d'écran.
- **Choix de la source** : deux sélecteurs dans la barre permettent de changer de
  micro / caméra **à chaud** (sans se déconnecter) ; le choix est mémorisé pour
  les prochaines visites (`localStorage`). Les listes se mettent à jour quand on
  branche/débranche un périphérique.
- **Partage d'écran agrandissable** : cliquer sur la vignette du partage l'affiche
  en grand au centre (re-clic ou clic sur le fond pour réduire).
- **Dégradation propre** : sans clés LiveKit, l'app tourne en « positions seules ».

> ⚙️ **Activer le média** : renseigner `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
> `LIVEKIT_API_SECRET` dans `.env` (projet gratuit sur https://cloud.livekit.io).
> Voir `.env.example`.

## Lancer en local

```bash
npm install
npm run dev
```

`npm run dev` lance **en parallèle** le front (Vite, http://localhost:5173) et le serveur
de signaling (Socket.io, http://localhost:3001). Pour tester le multijoueur : ouvrir
http://localhost:5173 dans **deux onglets** (ou deux machines du réseau local) avec des
pseudos différents.

> Astuce : `npm run dev:web` et `npm run dev:server` permettent de lancer chaque process
> séparément.

## Commandes (en jeu)

| Action | Touches |
| --- | --- |
| Se déplacer | Flèches ou `Z` `Q` `S` `D` |
| Régler le rayon de proximité | `[` (réduire) / `]` (agrandir) |
| Afficher/masquer sa bulle | `P` |

## Architecture

- **Rendu carte/avatars** : Phaser 3 + Vite *(en place)*.
- **Temps réel positions** : Node.js + Express + Socket.io *(en place)*.
- **Média** : LiveKit Cloud — `livekit-client` (front) + `livekit-server-sdk` (tokens) *(en place)*.

## Déploiement (gratuit, HTTPS)

Le serveur sert **aussi le front compilé** : un seul service à déployer, le client se
connecte en same-origin (pas de CORS, pas d'URL séparée). Le `build` génère `dist/`,
que le serveur sert en production. HTTPS et WebSocket sont gérés par l'hébergeur.

**Sur Render (recommandé, tier gratuit, sans carte bancaire)** — voir `render.yaml` :
1. Pousser le repo sur GitHub.
2. Render → *New* → *Blueprint* → sélectionner le repo (il détecte `render.yaml`).
3. Renseigner les 3 variables `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   dans le dashboard (elles ne sont jamais commitées).
4. Déployer → l'app est en ligne en HTTPS (ex : `https://eco-gather.onrender.com`).

> Le tier gratuit Render met le service en veille après ~15 min d'inactivité
> (1er chargement ~50 s au réveil). Sans incidence pour une démo interne.

Build command : `npm install && npm run build` · Start command : `node server/index.js`
(Render fournit `PORT` automatiquement.)

## Variables d'environnement

```
# Serveur de signaling
PORT=3001                 # port du serveur Socket.io (3001 par défaut en dev)

# Client (build Vite) — uniquement en prod, quand front et serveur ont des origines différentes
VITE_SERVER_URL=          # ex : https://eco-gather.fly.dev (vide en dev = proxy Vite)

# Étape 3 — LiveKit (pas encore utilisées)
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_URL=
```

## Structure

```
server/
  index.js             signaling Socket.io (positions, join/leave) + tokens LiveKit
src/
  config.js            constantes de calibration (vitesse, proximité, couleurs, bots)
  net.js               connexion socket.io-client (same-origin en dev via proxy Vite)
  media.js             couche LiveKit (publication, souscription par proximité, vignettes)
  main.js              écran d'accueil (pseudo) + bootstrap Phaser
  scenes/GameScene.js  carte, avatar, collisions, bots, réseau, proximité, média
```
