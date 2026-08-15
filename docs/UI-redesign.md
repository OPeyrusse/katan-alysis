# Refonte UI — mockups et plan

Refonte de la UI en trois espaces : un **écran d'accueil** (ouverture de
fichier + récents, à la VS Code), une **vue d'ensemble** du recording (à la
Java Mission Control), puis les **vues spécialisées** partageant un système de
sélections nommées (threads + période).

## 1. Parcours utilisateur

```
Accueil ──ouvre un .jfr──▶ Vue d'ensemble ──navigation──▶ Vues spécialisées
  ▲                            │                              │
  └────────fermer le fichier───┴──────────────────────────────┘
```

- Les sélections nommées vivent **le temps d'une session de fichier** :
  elles sont perdues à la fermeture du fichier (pas de persistance disque).
- La liste des fichiers récents, elle, **est persistée** entre les
  lancements de l'application.

## 2. Mockups

### 2.1 Écran d'accueil (aucun fichier chargé)

Inspiré de l'écran "Welcome" de VS Code : actions de démarrage à gauche,
fichiers récents à droite, zone de glisser-déposer sur toute la fenêtre.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ katan-alysis                                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│        ⣿⣿   katan-alysis                                                     │
│             Analyseur de recordings JFR                                      │
│                                                                              │
│   Démarrer                            Récents                                │
│   ────────────────────────────        ─────────────────────────────────────  │
│                                                                              │
│    ▶ Ouvrir un fichier…  Ctrl+O        payment-service-2026-08-14.jfr        │
│                                        ~/perf/prod        512 Mo · hier      │
│    ▶ Ouvrir un récent    Ctrl+R                                              │
│                                        startup-profile.jfr                   │
│                                        ~/tmp               48 Mo · il y a 3 j │
│   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                                              │
│                                        gc-pressure-repro.jfr                 │
│   │   Glissez un fichier .jfr  │       ~/Downloads         1,2 Go · 12 août  │
│       n'importe où dans la                                                   │
│   │   fenêtre pour l'ouvrir    │       fixture.jfr                           │
│                                        ~/dev/katan-alysis/fixtures           │
│   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                            2 Mo · 5 août     │
│                                                                              │
│                                        Tout effacer                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Comportement :

- Un clic sur un récent l'ouvre directement ; une croix au survol le retire
  de la liste ; un récent introuvable sur disque est grisé avec un message.
- La liste (chemin, taille, date de dernière ouverture) est persistée dans le
  répertoire de config de l'app, bornée aux ~10 dernières entrées.
- Pendant le chargement d'un gros fichier : barre de progression à la place
  de la zone de drop, l'accueil reste affiché.

### 2.2 Vue d'ensemble (fichier chargé)

Inspirée de l'onglet "Automated Analysis / Overview" de Java Mission
Control : bandeau d'infos clés extraites du JFR, puis quatre graphes
temporels alignés sur le même axe X (toute la durée du recording).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ payment-service-2026-08-14.jfr                                    [Fermer ✕] │
├────────────┬─────────────────────────────────────────────────────────────────┤
│            │  Infos clés                                                     │
│  NAVIGATION│  ┌──────────────────┬───────────────────┬──────────────────────┐│
│            │  │ JVM              │ GC                │ Système              ││
│ ▣ Vue      │  │ OpenJDK 21.0.4   │ G1 Young/Old      │ Linux 6.8 x86_64     ││
│   d'ensem. │  │ 64-bit Server VM │ Heap max 8 Go     │ 16 cœurs · 64 Go RAM ││
│ ▢ Top      │  │ -Xmx8g -Xms8g …  │ Régions 4 Mo      │ hôte: prod-pay-03    ││
│   methods  │  └──────────────────┴───────────────────┴──────────────────────┘│
│ ▢ Flame-   │                                                                 │
│   graph    │  CPU (%)                    ── process user ·· process system   │
│ ▢ Heatmap  │  100 ┤                                          ▄▄              │
│ ▢ Appels   │   50 ┤      ▄▄▂▂▄▄▆▆████▆▆▄▄▂▂        ▂▂▄▄▆▆████████▆▆▄▄        │
│   fusionnés│    0 ┼──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────   │
│ ▢ GC       │                                                                 │
│            │  Heap (Go)                  ── utilisé  ─ ─ committed  ··· max  │
│            │    8 ┤···························································│
│            │    4 ┤  ╱╲    ╱╲    ╱╲    ╱╲     ╱╲      ╱╲    ╱╲    ╱╲         │
│  Recording │    0 ┼─╱──╲──╱──╲──╱──╲──╱──╲───╱──╲────╱──╲──╱──╲──╱──╲──────  │
│  ─────────│                                                                 │
│  Durée     │  Off-heap (Mo)              ── direct buffers  ·· metaspace     │
│  5 min 12 s│  512 ┤        ▂▂▂▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   │
│  Samples   │    0 ┼──────────────────────────────────────────────────────    │
│  1 204 511 │                                                                 │
│  Threads   │  Pauses GC (ms)             │ = une pause (hauteur = durée)     │
│  87        │  120 ┤                              │                           │
│            │   60 ┤   │    │    │   ││   │  │    │    │   │    │      │      │
│            │    0 ┼───┴────┴────┴───┴┴───┴──┴────┴────┴───┴────┴──────┴───   │
│            │      0:00      1:00      2:00      3:00      4:00      5:00     │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

Comportement :

- Les quatre graphes partagent l'axe temporel ; un survol affiche un curseur
  vertical synchronisé avec les valeurs des quatre séries.
- Un brush (glisser horizontal) sur n'importe quel graphe propose « Analyser
  cette période » → ouvre une vue spécialisée avec la période pré-remplie
  dans la sélection courante.
- Le panneau « Infos clés » vient des événements de métadonnées du JFR
  (version JVM, flags, algo GC, taille heap, OS, CPU, hostname). Les champs
  absents du recording sont affichés « n/d ».

### 2.3 Vue spécialisée (exemple : Top methods)

Chaque vue spécialisée partage le même gabarit : la barre de sélection en
haut (sélections nommées + résumé de la sélection active), le contenu de la
vue au centre, et deux panneaux repliables — threads à gauche, mini-timeline
de brush en bas.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ payment-service-2026-08-14.jfr                                    [Fermer ✕] │
├────────────┬─────────────────────────────────────────────────────────────────┤
│            │ Sélection: [ 0:45–2:10 · 8 threads      ▼] [Enregistrer] [Aucune]│
│  NAVIGATION├─────────────────────────────────────────────────────────────────┤
│            │ THREADS (8/87)  [filtrer…] │  Top methods         392 104 samples│
│ ▢ Vue      │ ───────────────────────────│  ──────────────────────────────────│
│   d'ensem. │ ☑ pool-1-worker-1     12 % │  Méthode              Self    Total │
│ ▣ Top      │ ☑ pool-1-worker-2     11 % │  ─────────────────────────────────  │
│   methods  │ ☑ pool-1-worker-3     10 % │  Order.computeTotals  18,2 %  24,1 %│
│ ▢ Flame-   │ ☑ pool-1-worker-4      9 % │  Json.serialize       11,7 %  31,0 %│
│   graph    │ ☐ http-nio-exec-1      8 % │  Cache.lookup          9,3 %   9,8 %│
│ ▢ Heatmap  │ ☑ http-nio-exec-2      7 % │  Crypto.sign           7,1 %   7,1 %│
│ ▢ Appels   │ ☑ kafka-consumer-0     5 % │  Db.executeQuery       5,0 %  22,4 %│
│   fusionnés│ ☑ kafka-consumer-1     4 % │  GzipStream.write      4,2 %   4,4 %│
│ ▢ GC       │ ☑ GC Thread#0          3 % │  …                                  │
│            │ ☐ VM Periodic Task     1 % │                                     │
│            │ ☐ …77 autres               │                                     │
│            │ [Tout] [Rien] [Inverser]   │                                     │
│            ├─────────────────────────────────────────────────────────────────┤
│            │ PÉRIODE   0:45 ──────────────▶ 2:10     (sur 5:12)      [Reset]  │
│            │ ▁▂▄▆█▆▄▂▁▁▂▄██████████████▆▄▂▁▁▁▂▄▆█▆▄▂▁▁▁▁▂▄▆▆▄▂▁▁▁▂▄▆█▆▄▂▁▁   │
│            │          ◀━━━━━━━━━━━━━━━━━━━▶                                   │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

Comportement :

- Le panneau threads liste les threads triés par activité (part des samples),
  avec filtre textuel et actions Tout / Rien / Inverser.
- La mini-timeline du bas montre la densité globale de samples et porte les
  poignées de brush ; elle est identique dans toutes les vues.
- Threads et période forment **la sélection courante** ; changer l'un ou
  l'autre re-déclenche le pipeline Rust (comportement actuel conservé).
- La navigation entre vues **conserve la sélection courante** telle quelle.

### 2.4 Sélections nommées

Le menu déroulant de la barre de sélection :

```
   Sélection: [ 0:45–2:10 · 8 threads ▼ ]  [Enregistrer]  [Aucune]
              ┌──────────────────────────────────────────┐
              │ ● 0:45–2:10 · 8 threads        (courante) │
              │ ○ Aucune sélection (tout le recording)    │
              │ ──────────────────────────────────────── │
              │ ○ pic de charge             1:10–1:35 · 4 │
              │ ○ 0:00–0:30 · 87 threads                  │
              │ ○ 0:00–0:30 · 87 threads (2)          ✎ ✕ │
              └──────────────────────────────────────────┘
```

Règles :

- **Enregistrer** fige la sélection courante sous un nom. Nom par défaut :
  `<période> · <n> threads` (ex. `0:45–2:10 · 8 threads`) ; si le nom existe
  déjà, suffixe ` (2)`, ` (3)`, … Le nom est éditable (✎) à tout moment,
  avec la même règle anti-conflit.
- Choisir une entrée du menu **réapplique** la sélection dans la vue
  courante ; **Aucune** revient à « pas de filtre » (tout le recording,
  tous les threads) sans toucher aux sélections enregistrées.
- Modifier threads ou période après avoir appliqué une entrée nommée
  détache la sélection courante (elle redevient anonyme) — l'entrée
  enregistrée n'est jamais modifiée silencieusement.
- Durée de vie : mémoire uniquement, liée au fichier ouvert. Fermer le
  fichier (ou en ouvrir un autre) vide la liste.

## 3. Ce que ça implique côté données (Rust)

L'existant ne lit que `jdk.ExecutionSample`. La vue d'ensemble et le bandeau
d'infos demandent d'ingérer de nouveaux événements JFR :

| Bloc UI | Événements JFR |
|---|---|
| CPU | `jdk.CPULoad` (user/system/machine) |
| Heap | `jdk.GCHeapSummary` (used/committed), `jdk.GCConfiguration` (max) |
| Off-heap | `jdk.MetaspaceSummary`, `jdk.DirectBufferStatistics` (JDK 17+), à défaut `jdk.NativeMemoryUsage` si NMT actif |
| Pauses GC | `jdk.GarbageCollection` (durée, cause) ou `jdk.GCPhasePause` |
| Infos JVM | `jdk.JVMInformation` (version, flags), `jdk.InitialSystemProperty` |
| Infos GC | `jdk.GCConfiguration`, `jdk.GCHeapConfiguration` |
| Infos OS | `jdk.OSInformation`, `jdk.CPUInformation`, `jdk.PhysicalMemory` |

Chaque série est facultative : un recording async-profiler n'aura souvent
que les samples → la vue d'ensemble affiche « données absentes de ce
recording » par graphe manquant, et le bandeau met « n/d ».

## 4. Plan de mise en œuvre

Jalons incrémentaux, chacun livrable et testé indépendamment, dans la
continuité de `docs/PLAN.md` (C1–C5).

### U1 — Coquille de navigation + écran d'accueil

- UI : router d'états (`accueil` / `fichier ouvert` + vue active), sidebar de
  navigation, gabarit commun des vues ; l'actuelle table top-methods devient
  la première vue spécialisée du gabarit.
- Tauri : dialogue natif d'ouverture (`tauri-plugin-dialog`), drag-and-drop
  de fichier (événement webview), commande `close_recording`.
- Récents : petit module Rust (liste JSON dans le répertoire de config de
  l'app, dédupliquée, bornée) + commandes `list_recent` / `remove_recent` ;
  `open_recording` alimente la liste.
- Tests : store de navigation (Vitest), module récents (unitaires Rust,
  répertoire temporaire), accueil rendu avec API mockée.

### U2 — Barre de sélection : threads + période dans toutes les vues

- UI : panneau threads (tri par activité, filtre, tout/rien/inverser) et
  mini-timeline avec brush, branchés sur le store `filters` existant ;
  résumé de sélection dans la barre du haut.
- Rust : agrégat `sample_density` (histogramme de samples par bucket de
  temps, tous threads) pour dessiner la mini-timeline ; part d'activité par
  thread dans `ProfileSummary` (ou commande dédiée).
- Tests : géométrie du brush en pur (render/), stores Vitest, agrégat Rust
  sur profils synthétiques.

### U3 — Sélections nommées

- UI uniquement (aucun changement Rust) : store `selections` — liste
  `{nom, threads, période}` en mémoire, vidée par `close_recording`.
  Nommage par défaut + suffixe anti-conflit, renommage, suppression,
  application, « Aucune », détachement en cas de modification.
- Tests : toutes les règles de nommage/conflit/détachement en Vitest pur —
  c'est le jalon le plus testable.

### U4 — Ingestion des métadonnées et séries temporelles

- `jfr-model` : types `RecordingInfo` (JVM/GC/OS) et `TimeSeries`
  (timestamps + valeurs, unité), tous champs optionnels.
- `jfr-ingest` : lecture des événements du §3, tolérante à leur absence.
- `jfr-aggregate` : ré-échantillonnage des séries en ~N points pour l'IPC
  (bucket = max/moyenne selon la série), extraction des pauses GC.
- `src-tauri` : `get_recording_info`, `get_timeseries(kind)`, `get_gc_pauses`.
- Tests : fixtures JFR enrichies (recording JDK avec `profile` settings) +
  profils synthétiques pour le ré-échantillonnage.

### U5 — Vue d'ensemble

- UI : bandeau infos clés, quatre graphes canvas alignés (renderers purs :
  ligne, aires, lollipops GC), curseur synchronisé, brush « Analyser cette
  période » → bascule vers une vue spécialisée avec la période appliquée.
- Tests : renderers purs (géométrie), composant avec API mockée.

### U6 — Finitions

- États vides/erreurs (recording sans telle série, fichier récent disparu),
  raccourcis clavier (Ctrl+O, Ctrl+R), progression d'ouverture des gros
  fichiers, styles/thème.

### Ordre et dépendances

```
U1 (coquille + accueil) ──▶ U2 (sélection) ──▶ U3 (sélections nommées)
                                   │
U4 (données Rust) ─────────────────┴──────────▶ U5 (vue d'ensemble) ──▶ U6
```

U4 est parallélisable avec U2/U3 (Rust pur vs UI pure). Les vues
spécialisées futures (flamegraph J4, heatmap J6, appels fusionnés J7 du plan
d'origine) s'insèrent dans le gabarit U2 sans travail supplémentaire de
sélection.
