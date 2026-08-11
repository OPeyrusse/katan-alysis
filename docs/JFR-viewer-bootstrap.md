# JFR Viewer maison — Brief de démarrage

Document de bootstrap pour lancer le travail dans Claude Code. Résume la
motivation, les décisions d'architecture et l'ordre d'implémentation.

## Motivation

Les outils existants (profiler IntelliJ, Java Mission Control, speedscope,
async-profiler) rendent bien la flamegraph, mais aucun ne combine sous une même
UI **toutes** les vues voulues, et surtout aucun n'offre la vue « impact
cross-méthode » telle qu'on la veut :

- Quand une méthode intermédiaire est le bottleneck mais que les call-stacks qui
  y mènent varient, son coût est **dilué sur plusieurs colonnes** de la
  flamegraph. Une flamegraph inversée ne résout pas ça (la méthode appelle
  plusieurs sous-méthodes tout en restant le coordinateur coûteux).
- On veut pouvoir **sélectionner une méthode** et voir son impact agrégé,
  indépendamment du chemin d'appel : callers fusionnés + callees fusionnés,
  regroupés par méthode et non par position dans la stack.

Ce qui existe déjà et qu'on réimplémente plutôt que d'inventer :
- **Flamegraph** : partout.
- **Heatmap subseconde** = **FlameScope** (Gregg / Spier, Netflix). async-profiler
  le fait déjà via `jfrconv -o heatmap` (préserve les timestamps par sample,
  cross-linké à une flamegraph).
- **Top methods** (flat profile) : Method List d'IntelliJ, table de JMC.
- **Call-in / call-out fusionnés** : « Focus On Call » / Back Traces d'IntelliJ,
  Graph View de JMC. C'est LA vue à valeur ajoutée qu'on veut soigner.

## Décision technique

**Parsing en Rust, UI web, packagé en Tauri. Pas de JVM, pas de sidecar.**

Raisonnement :
- Le format JFR n'a pas de spec officielle (détail d'implémentation d'OpenJDK,
  auto-descriptif : header + métadonnées + constant pool par chunk, encodage
  varint). Écrire un parseur from scratch est un vrai projet → on ne le fait pas.
- La crate **`jfrs`** (Haruki Okada, Apache-2.0, ~2000 SLoC) parse déjà le JFR en
  Rust : itération chunks → events, filtrage `jdk.ExecutionSample`, accès aux
  champs (thread échantillonné, stack trace, timestamp). API bas niveau +
  couche serde.
- Précédent qui valide la stack : **`jfrv`** (même auteur) est un viewer web qui
  parse le JFR 100 % dans le navigateur via `jfrs` compilé en **wasm**, bâti
  autour de recordings **async-profiler** justement parce que les viewers
  existants ne faisaient pas la vue voulue. C'est exactement notre situation.

Alternatives écartées :
- **`jfrconv` en sidecar** : robuste mais on dépend soit du HTML fini (opaque,
  non ré-exploitable), soit du format `collapsed` (agrégé → **timestamps perdus**,
  donc heatmap impossible). Traîne une JVM. Bon pour un simple afficheur, pas
  pour un outil custom.
- **Clojure/cljfx ou backend JVM** : cohérent avec le parsing de référence
  (`RecordingFile`/`JfrReader`), mais empile une runtime JVM alors que `jfrs`
  rend l'accès aux samples bruts possible directement en Rust.
- **Fork de speedscope** : TS propre mais modèle orienté agrégation/flamegraph,
  peu réutilisable pour un heatmap 2D subseconde ; on hériterait de sa surface
  de maintenance pour greffer une vue qui partage peu avec l'existant.

## Formats de sortie jfrconv (référence, pour mémoire)

| Format | Nature | Temps préservé | Usage |
|---|---|---|---|
| `html` | vue finie | n/a | flamegraph autonome |
| `heatmap` | vue finie | **oui** (encodé dans le HTML) | FlameScope autonome |
| `collapsed` | données brutes | **non** (agrégé) | folded stacks, trivial à parser |
| `pprof` | données brutes | partiel | écosystème pprof |
| `otlp` | données brutes | — | OpenTelemetry |

→ Aucun format brut standard ne redonne commodément `sample + timestamp`. Pour ça
il faut le parseur (`JfrReader` interne d'async-profiler, `RecordingFile` du JDK,
ou **`jfrs`** côté Rust). D'où le choix de `jfrs`.

## Architecture

Pipeline unique, filtres = paramètres d'agrégation (pas de post-traitement JS) :

```
jfrs → samples normalisés {ts, thread_id, stack: Vec<frame_id>} + dict de frames
     → (filtre threads + filtre période)
     → agrégation (Rust)
     → modèle prêt à dessiner (frames partagées par index, pas par chaîne)
     → front : rendu canvas + interaction (hover / zoom / brush)
```

Principes :
- **Rust fait toute l'agrégation** (arbre flamegraph, buckets 2D du heatmap,
  table top-methods, arbres callers/callees fusionnés). Le front reçoit un modèle
  déjà agrégé.
- **Rendu canvas, jamais un nœud = un élément DOM/SVG.** Retour clj-async-profiler :
  SVG → 20-30 s d'affichage et 10 Mo ; canvas → instantané et 300 Ko (~30x). Vaut
  pour la flamegraph ET le heatmap (milliers de cellules ; async-profiler vise
  24 h à 20 ms de granularité).
- **Modèle découplé du rendu** : un dictionnaire de frames partagées + des arbres
  qui référencent par index. Permet des transforms dynamiques côté navigateur
  (inverse, largeur min…) sans régénérer.
- **Couplage heatmap ↔ flamegraph** = un brush sur le heatmap réinjecte un filtre
  temps dans le pipeline, qui régénère la flamegraph. Rien de spécial, juste le
  même pipeline.

## Vues à construire

1. **Top methods** — flat profile, `HashMap<frame_id, {self, total}>`.
2. **Flamegraph** — arbre depuis les stacks, rendu rectangles sur canvas.
3. **FlameScope heatmap** — buckets 2D (x = seconde, y = offset dans la seconde,
   ~50 lignes de 20 ms), couleur = nb de samples ; brush → filtre temps.
4. **Call-in / call-out fusionnés** — pour une méthode sélectionnée, arbres
   callers et callees regroupés par méthode. **Vue à valeur ajoutée principale.**

Filtres transverses : **threads** (retenir les samples du/des thread(s)) et
**période** (borne sur `ts`). Ils profitent gratuitement à toutes les vues.

## Ordre d'implémentation

1. Pipeline `jfrs` → samples normalisés + dict de frames (socle commun).
2. Top-methods (valide le modèle, résultat visible vite).
3. Flamegraph canvas.
4. Filtres threads + temps injectés dans le pipeline.
5. Heatmap FlameScope + brush → filtre temps.
6. Call-in / call-out fusionnés (la vue inédite).

Chaque étape s'appuie sur le socle et donne un livrable visible.

## À valider AVANT de bâtir (spike d'une heure sur un JFR réel)

- [ ] `jfrs` expose bien les **timestamps par sample** de façon exploitable
      (pas seulement les stacks) — tout le heatmap et le filtre temps en dépendent.
- [ ] `jfrs` lit correctement les **JFR produits par async-profiler** (pas
      seulement ceux du JDK). `jfrv` étant bâti sur des recordings async-profiler,
      c'est rassurant, mais à confirmer sur nos fichiers.
- [ ] Perf de `jfrs` sur nos tailles de fichiers réelles (l'auteur note que la
      désérialisation serde est lente ; l'API bas niveau est plus rapide — prévoir
      de rester bas niveau si besoin).

## Références

- `jfrs` — https://github.com/ocadaruma/jfrs
- `jfrv` (précédent Rust+wasm) — https://github.com/ocadaruma/jfrv
- async-profiler Heatmap — https://github.com/async-profiler/async-profiler/blob/master/docs/Heatmap.md
- Format JFR (reverse-engineering, Gunnar Morling) — https://www.morling.dev/blog/jdk-flight-recorder-file-format/
- Rendu canvas vs SVG (clj-async-profiler) — https://clojure-goes-fast.com/blog/clj-async-profiler-100/
- FlameScope (Netflix) — concept du heatmap subseconde
