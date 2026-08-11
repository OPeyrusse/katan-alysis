# Plan d'action — katan-alysis (JFR Viewer maison)

Plan de mise en œuvre du brief `docs/JFR-viewer-bootstrap` : parseur JFR en Rust
(`jfrs`), agrégations côté Rust, UI SolidJS rendue sur canvas, le tout packagé
en Tauri. Ce document découpe le projet en composants testables indépendamment,
définit la pipeline CircleCI, et tranche la question du SSR.

## 1. Décision préalable : SolidJS et SSR dans Tauri

**Recommandation : SolidJS en rendu client (CSR) via Vite, pas de SSR.**

Pourquoi le SSR n'apporte rien ici :

- Une application Tauri n'embarque **pas de serveur Node** : le frontend est un
  jeu de fichiers statiques servis à la webview via un protocole custom
  (`tauri://`). Le SSR « vrai » (SolidStart en mode server) exigerait un sidecar
  Node ou un runtime JS côté Rust — exactement le genre de dépendance lourde que
  le brief écarte (« pas de JVM, pas de sidecar »).
- Les bénéfices du SSR (SEO, time-to-first-byte sur réseau) n'existent pas en
  desktop : les assets sont locaux, le « réseau » est instantané.
- Toutes les données viennent des commandes Tauri (IPC vers Rust) **après**
  chargement d'un fichier JFR : il n'y a rien à pré-rendre côté serveur.

Si on veut malgré tout un HTML initial non vide (shell de l'app affiché avant
l'hydratation JS), **SolidStart en mode SSG/pre-rendering** (`ssr: false` ou
`server.prerender`) produit des fichiers statiques compatibles Tauri. C'est une
option activable plus tard sans changer l'architecture ; on démarre en
SolidJS + Vite simple, qui reste le chemin le mieux supporté par
`create-tauri-app`.

## 2. Découpage en composants testables

Workspace Cargo + workspace pnpm, chaque composant testable isolément :

```
katan-alysis/
├── Cargo.toml                  # workspace Rust
├── crates/
│   ├── jfr-model/              # C1 — types partagés (aucune dépendance)
│   ├── jfr-ingest/             # C2 — jfrs → samples normalisés + dict de frames
│   └── jfr-aggregate/          # C3 — filtres + agrégations (4 vues)
├── app/
│   ├── src-tauri/              # C4 — commandes Tauri (couche fine)
│   └── ui/                     # C5 — SolidJS + Vite, rendu canvas
├── fixtures/                   # petits JFR d'exemple (JDK + async-profiler)
├── docs/
└── .circleci/config.yml
```

### C1 — `jfr-model` : le contrat de données

Types purs, sérialisables (serde) : `FrameId`, `Frame`, `Sample {ts, thread_id,
stack: Vec<FrameId>}`, `Profile {frames, samples, threads, time_range}`, et les
modèles de sortie prêts à dessiner (`FlameNode`, `HeatmapGrid`, `MethodStats`,
`MergedCallTree`). Le principe du brief — frames partagées par index, jamais par
chaîne — vit ici.

- **Tests** : round-trip serde, invariants (ids denses, stacks non vides).
- **Livrable** : le contrat que C2, C3, C4 et C5 consomment. À figer en premier.

### C2 — `jfr-ingest` : parsing → modèle normalisé

Seule brique qui dépend de `jfrs`. Itère chunks → events, filtre
`jdk.ExecutionSample`, interne les frames dans le dictionnaire, produit un
`Profile`. Reste sur l'API bas niveau de `jfrs` (la couche serde est lente,
dixit l'auteur).

- **Tests** : sur les fixtures réelles (JFR produit par le JDK **et** par
  async-profiler) — nombre de samples, présence des timestamps, threads
  résolus, stabilité du dictionnaire de frames. C'est ici que le spike du brief
  se transforme en tests de non-régression permanents.
- **Testable sans** : Tauri, UI, agrégations.

### C3 — `jfr-aggregate` : filtres + les 4 vues

Fonctions pures `(&Profile, &Filters) -> modèle de vue`. `Filters = {threads,
time_range}` appliqué **avant** agrégation (pipeline unique du brief). Un module
par vue :

1. `top_methods` — flat profile `HashMap<FrameId, {self, total}>`.
2. `flame` — arbre flamegraph depuis les stacks.
3. `heatmap` — buckets 2D (x = seconde, y = tranche de 20 ms, ~50 lignes).
4. `merged_calls` — callers/callees fusionnés par méthode pour un `FrameId`
   sélectionné (la vue à valeur ajoutée).

- **Tests** : sur des `Profile` synthétiques construits à la main — pas besoin
  de fichiers JFR. Chaque propriété est vérifiable exactement : `self ≤ total`,
  somme des buckets = nb de samples filtrés, symétrie callers/callees, effet
  des filtres. C'est le composant le plus facile à tester et le cœur métier.
- **Testable sans** : `jfrs`, Tauri, UI.

### C4 — `app/src-tauri` : la couche IPC

Commandes Tauri fines, sans logique : `open_recording(path) -> ProfileSummary`,
`get_top_methods(filters)`, `get_flamegraph(filters)`, `get_heatmap(filters)`,
`get_merged_calls(frame_id, filters)`. Garde le `Profile` chargé en state
(`tauri::State<Mutex<...>>`) ; chaque commande = filtre + agrégation + modèle
sérialisé.

- **Tests** : unitaires sur les handlers (les commandes Tauri sont des fonctions
  Rust appelables directement) ; les cas d'erreur (fichier absent, JFR corrompu,
  commande avant chargement) sont couverts ici.
- **Testable sans** : UI (et sans lancer de webview).

### C5 — `app/ui` : SolidJS + rendu canvas

Découpage interne pour rester testable malgré le canvas :

- **`api/`** — wrappers typés des `invoke()` Tauri, mockables.
- **`state/`** — store Solid : profil courant, filtres, vue active, sélection.
  Le couplage heatmap → flamegraph (brush = nouveau filtre temps = re-fetch)
  vit ici, pas dans les composants.
- **`render/`** — renderers canvas **purs** : `(modèle, viewport) -> liste de
  rectangles/cellules à dessiner`, puis un `draw(ctx, primitives)` trivial.
  La géométrie (layout flamegraph, hit-testing du hover, zone de brush) est
  ainsi testée sans navigateur.
- **`components/`** — composants Solid minces : un `<canvas>` + handlers
  souris qui délèguent à `render/` et `state/`.

- **Tests** : Vitest. Géométrie et hit-testing en tests purs ; stores et
  composants avec `@solidjs/testing-library` + API mockée
  (`@tauri-apps/api` remplacé par un mock — pattern standard).
- **Testable sans** : Rust (l'API est mockée), et sans binaire Tauri.

### Matrice de dépendances

| Composant | Dépend de | Testé avec |
|---|---|---|
| C1 `jfr-model` | — | tests unitaires purs |
| C2 `jfr-ingest` | C1, `jfrs` | fixtures JFR réelles |
| C3 `jfr-aggregate` | C1 | profils synthétiques |
| C4 `src-tauri` | C1–C3, Tauri | handlers appelés en direct |
| C5 `ui` | contrat JSON de C1 | Vitest + API mockée |

## 3. Pipeline CircleCI

Objectif : à chaque commit sur `main` (et sur les branches, pour valider les
PR), tests de tout le workspace + build de la UI ; artefacts de build conservés.

### Jobs

1. **`rust-test`** (image `cimg/rust`) : `cargo fmt --check`, `cargo clippy
   --workspace -- -D warnings`, `cargo test --workspace`. Cache
   `~/.cargo` + `target/` clé sur `Cargo.lock`.
2. **`ui-test`** (image `cimg/node`) : `pnpm install --frozen-lockfile`,
   `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest). Cache pnpm store.
3. **`ui-build`** : `pnpm build` (Vite) → `store_artifacts` sur `app/ui/dist`.
4. **`tauri-build`** (optionnel dans un premier temps, `main` uniquement) :
   build Linux du binaire Tauri (`cimg/rust` + `libwebkit2gtk-4.1-dev`,
   `libgtk-3-dev`, etc.) → artefact AppImage/deb. Coûteux ; à activer quand C4
   existe.

### Workflow

```yaml
workflows:
  ci:
    jobs:
      - rust-test
      - ui-test
      - ui-build:
          requires: [ui-test]
      - tauri-build:
          requires: [rust-test, ui-build]
          filters:
            branches:
              only: main
```

`rust-test` et `ui-test`/`ui-build` tournent en parallèle (aucune dépendance
entre les deux moitiés). La config complète est en annexe ; elle sera commitée
dès le jalon 0 pour que la CI accompagne chaque étape.

## 4. Jalons

Chaque jalon suit l'ordre du brief, s'appuie sur le socle et produit un
livrable visible + testé en CI.

- **J0 — Squelette + CI** : workspace Cargo (C1 vide mais compilant), app
  Tauri + SolidJS scaffoldée (`create-tauri-app`), `.circleci/config.yml`
  actif avec les jobs 1–3. *Livrable : CI verte sur un hello-world.*
- **J1 — Spike `jfrs` (les 3 cases du brief)** : sur un JFR réel — timestamps
  par sample exploitables ? fichiers async-profiler lus ? perf de l'API bas
  niveau acceptable ? Résultat consigné dans `docs/`, fixtures ajoutées au
  dépôt. **Point de décision : go/no-go sur `jfrs`** avant d'investir dans C2.
- **J2 — Socle données** : C1 + C2 complets, tests fixtures en CI.
- **J3 — Top methods bout en bout** : `top_methods` (C3) + commande (C4) +
  table UI (C5). Valide toute la chaîne Rust → IPC → Solid sur la vue la plus
  simple.
- **J4 — Flamegraph canvas** : layout + rendu + hover/zoom.
- **J5 — Filtres threads + période** : injectés dans le pipeline, toutes les
  vues en profitent ; sélecteur de threads dans la UI.
- **J6 — Heatmap + brush** : grille FlameScope, brush → filtre temps →
  régénération de la flamegraph (même pipeline, rien de spécial).
- **J7 — Call-in/call-out fusionnés** : la vue inédite ; sélection d'une
  méthode depuis top-methods ou flamegraph.
- **J8 — Packaging** : job `tauri-build` activé sur `main`, artefacts binaires.

## 5. Risques et parades

| Risque | Parade |
|---|---|
| `jfrs` ne lit pas nos JFR async-profiler ou perd les timestamps | J1 est bloquant avant tout investissement dans C2 ; plan B = contribuer un fix à `jfrs` (2000 SLoC, Apache-2.0) ou parser le sous-ensemble ExecutionSample nous-mêmes |
| Désérialisation serde de `jfrs` trop lente | Rester sur l'API bas niveau (prévu dès C2) |
| Payload IPC Tauri trop gros sur de gros profils | Les modèles C1 sont déjà agrégés et indexés (pas de chaînes répétées) ; si besoin, passer les gros buffers en `tauri::ipc::Response` binaire |
| Rendu canvas complexe à tester | Séparation stricte géométrie pure / `draw()` (C5) — la géométrie est couverte par des tests unitaires |
| `tauri-build` lent en CI | Job limité à `main`, caches Cargo, activé seulement à partir de J8 |

## Annexe — `.circleci/config.yml` cible

```yaml
version: 2.1

orbs:
  node: circleci/node@7

jobs:
  rust-test:
    docker:
      - image: cimg/rust:1.88
    steps:
      - checkout
      - restore_cache:
          keys: [cargo-v1-{{ checksum "Cargo.lock" }}, cargo-v1-]
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
      - save_cache:
          key: cargo-v1-{{ checksum "Cargo.lock" }}
          paths: [~/.cargo/registry, ~/.cargo/git, target]

  ui-test:
    docker:
      - image: cimg/node:22.17
    steps:
      - checkout
      - node/install-pnpm
      - restore_cache:
          keys: [pnpm-v1-{{ checksum "pnpm-lock.yaml" }}, pnpm-v1-]
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C app/ui lint
      - run: pnpm -C app/ui typecheck
      - run: pnpm -C app/ui test
      - save_cache:
          key: pnpm-v1-{{ checksum "pnpm-lock.yaml" }}
          paths: [~/.local/share/pnpm/store]

  ui-build:
    docker:
      - image: cimg/node:22.17
    steps:
      - checkout
      - node/install-pnpm
      - restore_cache:
          keys: [pnpm-v1-{{ checksum "pnpm-lock.yaml" }}, pnpm-v1-]
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C app/ui build
      - store_artifacts:
          path: app/ui/dist
          destination: ui-dist

  tauri-build:
    docker:
      - image: cimg/rust:1.88-node
    resource_class: large
    steps:
      - checkout
      - run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
            libayatana-appindicator3-dev librsvg2-dev patchelf
      - node/install-pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C app/ui tauri build
      - store_artifacts:
          path: app/src-tauri/target/release/bundle
          destination: bundles

workflows:
  ci:
    jobs:
      - rust-test
      - ui-test
      - ui-build:
          requires: [ui-test]
      - tauri-build:
          requires: [rust-test, ui-build]
          filters:
            branches:
              only: main
```
