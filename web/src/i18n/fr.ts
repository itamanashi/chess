import type { EloTargetKey } from '../types/chess';
import type { StabilityDriverKind, StabilityVerdict } from '../services/evalStability';
import type { ConfidenceLevel, EloTier } from '../services/repertoireScore';
import type { Weakness } from '../utils/repertoire';

/**
 * Dictionnaire français de l'interface — POINT DE PASSAGE UNIQUE du texte UI.
 *
 * Convention linguistique du projet :
 *   - identifiants (fonctions/types/variables) en ANGLAIS ;
 *   - modèle de données persisté inchangé (`coup`, `parties`, `victoires_*`…) :
 *     il est mappé 1:1 sur l'API Lichess, le backend Python et les JSON
 *     stockés — le renommer casserait tout sans bénéfice ;
 *   - le cœur algorithmique (`services/`, `utils/`, `storage/`, `hooks/`)
 *     ne contient AUCUN littéral français : il manipule des CODES
 *     (`'high'`, `'watch'`, `'check-suffered'`…) et formate via ce module ;
 *   - tout le français UI vit ici (ou, transitoirement, dans le JSX des
 *     composants — voir `docs` en bas de fichier pour la migration).
 *
 * Ajouter une langue = créer `en.ts` avec les mêmes exports et brancher le
 * choix dans `i18n/index.ts`. Aucun module métier à toucher.
 */

/** Locale de formatage des nombres. */
export const LOCALE = 'fr-FR';

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString(LOCALE);
}

// ---------------------------------------------------------------------------
// Niveaux de confiance (repertoireScore) — codes 'high' | 'medium' | 'low'.
// ---------------------------------------------------------------------------

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: 'Élevée',
  medium: 'Moyenne',
  low: 'Faible',
};

const CONFIDENCE_TITLES: Record<ConfidenceLevel, string> = {
  high: 'Recommandation forte : moteur + large échantillon concordants',
  medium: 'Recommandation raisonnable : signal correct mais partiel',
  low: 'Données insuffisantes : décision fragile, à confirmer',
};

export function confidenceTitle(level: ConfidenceLevel): string {
  return CONFIDENCE_TITLES[level];
}

// ---------------------------------------------------------------------------
// Verdicts de stabilité (evalStability) — codes 'stable' | 'watch' | ....
// ---------------------------------------------------------------------------

export const STABILITY_LABELS: Record<StabilityVerdict, string> = {
  stable: 'Stable',
  watch: 'À surveiller',
  unstable: 'Instable',
  reversal: 'Renversement',
};

/** Texte affiché quand aucune trajectoire moteur n'est disponible. */
export const NO_STABILITY_DATA = 'sans données';

export interface StabilitySummaryInput {
  verdict: StabilityVerdict;
  /** Ex. "+0.50 → −0.45" (format numérique du core). */
  range: string;
  minDepth: number;
  maxDepth: number;
  swingCp: number;
  /**
   * Cause structurée du core (jamais de texte) : le dictionnaire formule.
   * - 'mate' : finale décisive ; 'opp-mate' : mat adverse détecté ;
   * - 'swing' | 'drift' : cause du statut "watch", avec `driverCp`.
   */
  driverKind?: StabilityDriverKind;
  driverCp?: number;
}

export function stabilitySummary(input: StabilitySummaryInput): string {
  const { verdict, range, minDepth, maxDepth, swingCp, driverKind, driverCp } = input;
  const head = `${range} (prof. ${minDepth}–${maxDepth})`;
  switch (verdict) {
    case 'stable':
      return driverKind === 'mate'
        ? `${head} : finale décisive (mat) — stable.`
        : `${head} : converge — confiance élevée.`;
    case 'reversal':
      return driverKind === 'opp-mate'
        ? `${head} : mat adverse détecté — coup à écarter sauf analyse humaine.`
        : `${head} : renversement +/− — coup tactiquement suspect.`;
    case 'unstable':
      return `${head} : amplitude ${Math.round(swingCp)} cp — instable, à vérifier en profondeur.`;
    case 'watch': {
      const driver =
        driverKind === 'swing'
          ? `amplitude ${Math.round(driverCp ?? swingCp)} cp`
          : driverKind === 'drift'
            ? `dérive ${Math.round(driverCp ?? 0)} cp`
            : 'éval instable';
      return `${head} : bouge encore (${driver}) — à surveiller.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Faiblesses de position (weaknessOfPosition) — codes, jamais de labels.
// ---------------------------------------------------------------------------

export function weaknessLabel(w: Pick<Weakness, 'code' | 'materialDeficit'>): string | null {
  switch (w.code) {
    case 'none':
      return null;
    case 'checkmate-suffered':
      return 'Échec et mat subi — trou critique du répertoire';
    case 'stalemate':
      return 'Pat';
    case 'draw':
      return 'Nulle';
    case 'check-suffered':
      return 'Échec subi';
    case 'material-deficit':
      return `${w.materialDeficit ?? '?'} matériel`;
  }
}

/**
 * Pastille courte de dangerosité (liste des réponses adverses).
 * Remplace les comparaisons sur labels (`=== 'Échec subi'`,
 * `.replace(' matériel', '')`) par une logique sur CODES.
 */
export function dangerShortLabel(
  score: number,
  code: Weakness['code'],
  materialDeficit?: number,
): string | null {
  if (score < 0.3) return null;
  if (score >= 1) return 'MAT';
  if (code === 'check-suffered') return 'ÉCHEC';
  if (code === 'material-deficit') return `${materialDeficit ?? '?'}`;
  return '⚠';
}

// ---------------------------------------------------------------------------
// Paliers de pondération (repertoireScore).
// ---------------------------------------------------------------------------

export const TIER_LABELS: Record<EloTier, string> = {
  low: 'Débutant / Club',
  mid: 'Intermédiaire',
  high: 'Avancé / Maîtres',
};

// ---------------------------------------------------------------------------
// Cibles Elo (config technique dans types/chess.ts, libellés ici).
// ---------------------------------------------------------------------------

const ELO_TARGET_META: Record<EloTargetKey, { label: string; description: string }> = {
  all_700: {
    label: '> 700 Elo (Lichess)',
    description: 'Toutes les parties compétitives ordinaires sur Lichess',
  },
  beginner: {
    label: '400 - 1000 Elo (Débutants)',
    description: "Parties d'initiation et débutants sur Lichess",
  },
  beginner_club: {
    label: '400 - 1600 Elo (Débutant à Intermédiaire)',
    description: 'Large bande débutant à intermédiaire sur Lichess',
  },
  club_low: {
    label: '1000 - 1400 Elo (Club Débutant)',
    description: 'Joueurs occasionnels et début de club',
  },
  club_mid: {
    label: '1400 - 1800 Elo (Intermédiaire)',
    description: 'Le niveau moyen des joueurs réguliers',
  },
  club_high: {
    label: '1800 - 2200 Elo (Avancé)',
    description: 'Joueurs de compétition confirmés',
  },
  masters: {
    label: 'Grands Maîtres (FIDE Masters)',
    description: 'Parties officielles des Grands Maîtres en tournoi',
  },
};

export function eloTargetLabel(key: EloTargetKey): string {
  return ELO_TARGET_META[key]?.label ?? key;
}

export function eloTargetDescription(key: EloTargetKey): string {
  return ELO_TARGET_META[key]?.description ?? '';
}

// ---------------------------------------------------------------------------
// Justifications et avertissements (repertoireScore — gabarits à paramètres).
// ---------------------------------------------------------------------------

export function tierNote(tier: EloTier): string {
  if (tier === 'low') return 'À ce niveau, les résultats pratiques pèsent lourd.';
  if (tier === 'high') return 'À ce niveau, la précision théorique prime.';
  return 'Équilibre théorie / pratique pour ce niveau.';
}

export function justificationEngineOnly(scoreFormatted: string, depth: number): string {
  return `Choix moteur pur (${scoreFormatted}, prof. ${depth}) : aucune partie à ce niveau pour le valider.`;
}

export function justificationPreferred(args: {
  san: string;
  scoreFormatted: string;
  statBit: string;
  loss: string | null;
}): string {
  return (
    `Préféré à ${args.san} (${args.scoreFormatted} moteur) : ` +
    `meilleur rendement réel (${args.statBit})` +
    (args.loss !== null ? ` malgré −${args.loss} au moteur.` : '.')
  );
}

export function justificationUnanimous(scoreFormatted: string, depth: number, statBit: string): string {
  return (
    `Choix unanime : meilleur au moteur (${scoreFormatted}, prof. ${depth}) ` +
    `et résultats pratiques solides (${statBit}).`
  );
}

export function justificationDefault(scoreFormatted: string, depth: number, winPct: string, games: string): string {
  return (
    `Éval ${scoreFormatted}${depth > 0 ? ` (prof. ${depth})` : ''}, ` +
    `${winPct} % de victoires sur ${games} parties.`
  );
}

export function statBit(games: number, winPct: string, drawPct: string): string {
  return `${formatInt(games)} parties : ${winPct} % vict., ${drawPct} % nulles`;
}

export const WARNING_ENGINE_ONLY_CHOICE = 'Jamais joué à ce niveau : choix purement moteur.';

export function warningLowSample(games: number): string {
  return `Échantillon faible (${formatInt(games)} parties) : résultat à confirmer.`;
}

export function warningShallowDepth(depth: number): string {
  return `Profondeur moteur limitée (${depth}).`;
}

export const WARNING_NO_ENGINE_COVERAGE = "Non couvert par l'analyse moteur locale.";

/**
 * Opponent-error edge line (audit A5): statistical over/under-performance
 * of the observed replies vs engine theory, in percentage points.
 */
export function edgeDeltaLine(deltaPp: number): string {
  const sign = deltaPp > 0 ? '+' : deltaPp < 0 ? '−' : '';
  return `${sign}${Math.abs(deltaPp).toFixed(1)} pts (réponses adv.)`;
}

// ---------------------------------------------------------------------------
// Feedback utilisateur global (toasts App + bibliothèque).
// ---------------------------------------------------------------------------

export function toastImportSuccess(label: string): string {
  return `Import réussi : ${label} ajouté(s) à votre bibliothèque.`;
}

export function toastBatchAdded(count: number): string {
  return `${count} variante(s) adverse(s) majeure(s) intégrée(s) au répertoire avec leur taux d'apparition.`;
}

export function toastImportPartial(warning: string): string {
  return `Import partiel : ${warning}`;
}

export function toastImportError(detail: string): string {
  return `Import JSON impossible : ${detail}`;
}

export function toastCopyOk(what: 'FEN' | 'PGN'): string {
  return `${what} copié dans le presse-papiers.`;
}

export const TOAST_COPY_UNAVAILABLE = 'Copie impossible dans ce navigateur.';

export const TOAST_PGN_EMPTY = 'Aucun coup à copier : jouez un coup ou ouvrez une variante d\u2019abord.';

export function toastLibraryUpgraded(issue: string, version: number): string {
  return `Bibliothèque mise à niveau (schéma v${version}) : ${issue}`;
}

export const TOAST_LIBRARY_CORRUPT =
  'Bibliothèque locale illisible : une copie de secours a été conservée, les répertoires par défaut sont chargés.';

export const TOAST_STORAGE_UNAVAILABLE =
  'Stockage local indisponible : vos modifications ne seront pas conservées.';

export const TOAST_LIBRARY_SAVE_FAILED =
  'Impossible de sauvegarder la bibliothèque. Vérifiez l’espace de stockage disponible.';
export const TOAST_LIBRARY_DURABLE_LOAD_FAILED =
  'La copie durable du répertoire n’a pas pu être relue. La copie locale est conservée.';

// ---------------------------------------------------------------------------
// Persistance (storage/) — erreurs techniques formulées pour l'utilisateur.
// ---------------------------------------------------------------------------

export const STORAGE_QUOTA_ERROR = 'Stockage local indisponible ou plein.';

export function quotaSaveError(what: 'création' | 'import'): string {
  return `${STORAGE_QUOTA_ERROR} (${what} non sauvegardé).`;
}

export function prefInvalidValue(raw: string): string {
  return `Valeur illisible « ${raw.slice(0, 20)} », défaut appliqué.`;
}

export const STORE_INIT_SAVE_FAILED = 'Écriture initiale impossible (quota ou stockage indisponible).';

export const STORE_CORRUPT_BACKUP = 'Données illisibles : une copie de secours a été conservée.';

export function storePrunedBranches(count: number): string {
  return `${count} branche(s) invalide(s) élaguée(s).`;
}

export function storeEntryUnreadable(displayIndex: number): string {
  return `Entrée #${displayIndex} illisible — ignorée.`;
}

export function storeEntryRejected(displayIndex: number, reason: string): string {
  return `Entrée #${displayIndex} : ${reason} — ignorée.`;
}

export function storeEntryIssue(title: string, detail: string): string {
  return `Entrée « ${title} » : ${detail}`;
}

export const IMPORT_DEFAULT_TITLE = 'Répertoire importé';

export function storeMigratedTitle(displayIndex: number): string {
  return `Répertoire migré ${displayIndex}`;
}

export function importNotJson(filename: string): string {
  return `Fichier JSON invalide : « ${filename} » n'est pas du JSON.`;
}

export const IMPORT_EMPTY = 'Fichier vide : aucun répertoire à importer.';

export function importUnrecognizedEntry(index: number): string {
  return `entrée #${index} : forme non reconnue (racine { fen, children } ou item avec clé « root » attendue)`;
}

export function importFailed(details: string): string {
  return `Import impossible : ${details}`;
}

export function importPrunedBranches(count: number, index: number): string {
  return `${count} branche(s) invalide(s) élaguée(s) dans l'entrée #${index}.`;
}

export function importEntryPrefix(index: number, detail: string): string {
  return `Entrée #${index} : ${detail}`;
}

export const STORE_ROOT_INVALID = 'Racine invalide : objet { fen, children } attendu.';
export const STORE_ROOT_BAD_FEN = 'Racine invalide : FEN de départ illisible.';
export const STORE_CHILDREN_NOT_ARRAY = '« children » doit être un tableau.';

export function importTruncated(max: number): string {
  return `Import tronqué : limite de ${max} positions atteinte.`;
}

export const TREE_TOO_DEEP = 'profondeur excessive — branche élaguée.';

export function treeTooManyChildren(count: number, max: number): string {
  return `${count} variantes, seules les ${max} premières sont gardées.`;
}

export const NODE_NOT_OBJECT = 'coup invalide (objet attendu) — branche élaguée.';
export const NODE_BAD_SAN = 'SAN manquant ou invalide — branche élaguée.';

export function nodeBadUci(uci: string): string {
  return `uci invalide « ${uci.slice(0, 12)} » — branche élaguée.`;
}

export const NODE_BAD_FEN = 'FEN invalide — branche élaguée.';
export const NODE_CHILDREN_NOT_ARRAY = '« children » doit être un tableau — branche élaguée.';

// ---------------------------------------------------------------------------
// API Lichess / moteur local — erreurs remontées à l'interface.
// ---------------------------------------------------------------------------

export function lichessNetworkError(detail: string): string {
  return `Erreur réseau vers Lichess : ${detail}`;
}

export const LICHESS_AUTH_REQUIRED =
  "Token Lichess requis ou invalide (401). Depuis 2026, Lichess exige un token gratuit sans aucun scope créé sur https://lichess.org/account/oauth/token.";

export const LICHESS_RATE_LIMITED =
  'Limite de requêtes Lichess atteinte (429). Patientez quelques secondes.';

export const LICHESS_BAD_JSON = 'Réponse Lichess illisible (JSON invalide).';

export function lichessTimeout(timeoutMs: number): string {
  return `Délai dépassé vers Lichess (${Math.round(timeoutMs / 1000)} s).`;
}

// ---------------------------------------------------------------------------
// API Chess.com (données publiques, sans authentification).
// ---------------------------------------------------------------------------

export function chesscomUnknownUser(username: string): string {
  return `Compte Chess.com « ${username} » introuvable (vérifiez le pseudo).`;
}

export function chesscomNetworkError(detail: string): string {
  return `Erreur réseau vers Chess.com : ${detail}`;
}

export const CHESSCOM_RATE_LIMITED =
  'Limite de requêtes Chess.com atteinte (429). Patientez quelques secondes puis relancez.';

export const CHESSCOM_BAD_RESPONSE = 'Réponse Chess.com illisible ou inattendue.';

export function chesscomTimeout(timeoutMs: number): string {
  return `Délai dépassé vers Chess.com (${Math.round(timeoutMs / 1000)} s).`;
}

export const CLOUD_NOT_ANALYZED = 'Position absente du cloud Lichess.';

export const CLOUD_TIMEOUT = "Délai dépassé pour l'évaluation cloud.";

export function cloudServerError(status: number): string {
  return `Erreur HTTP ${status} de l'API cloud Lichess.`;
}

export const CLOUD_BAD_REQUEST = 'Requête cloud invalide (HTTP 400).';

/** Timeout interne propagé tel quel vers « Moteur indisponible : … ». */
export const ENGINE_WAIT_TIMEOUT = 'Délai dépassé';

/**
 * Analyse supplantée par une demande plus récente ou prioritaire (audit A9).
 * Jamais affichée telle quelle : les appelants la traitent comme un arrêt
 * propre (résultats partiels conservés, pas d'erreur visible).
 */
export const ENGINE_SUPERSEDED = 'Analyse supplantée par une demande plus récente.';

/** Worker Stockfish non démarrable (fichiers absents, Worker bloqué…). */
export const ENGINE_WASM_UNAVAILABLE =
  'fichiers Stockfish introuvables ou Web Worker bloqué';

/** Analyse demandée alors que le moteur n'est pas prêt. */
export const ENGINE_NOT_READY = 'Moteur local pas encore prêt.';

/** FEN refusé avant tout envoi au moteur. */
export const ENGINE_INVALID_FEN = 'Position FEN invalide pour le moteur.';

export function storeBackupCreated(backupKey: string): string {
  return `Payload illisible sauvegardé sous ${backupKey}.`;
}

// ---------------------------------------------------------------------------
// Analyse de robustesse — labels de progression affichés pendant le run.
// ---------------------------------------------------------------------------

export function robustnessProgressReplies(san: string): string {
  return `${san} : réponses adverses…`;
}

export function robustnessProgressOurs(candidateSan: string, replySan: string): string {
  return `${candidateSan} … ${replySan} : nos réponses…`;
}

export function robustnessProgressEngine(candidateSan: string, replySan: string): string {
  return `${candidateSan} … ${replySan} : moteur…`;
}

export type RobustnessSkipReason =
  | 'illegal-move'
  | 'candidate-stats-unavailable'
  | 'no-adversary-data'
  | 'no-analyzable-reply'
  | 'cancelled';

export function robustnessSkipReasonLabel(reason: RobustnessSkipReason): string {
  switch (reason) {
    case 'illegal-move':
      return 'coup illégal';
    case 'candidate-stats-unavailable':
      return 'stats adverses indisponibles';
    case 'no-adversary-data':
      return 'aucune réponse adverse';
    case 'no-analyzable-reply':
      return 'aucune réponse analysable';
    case 'cancelled':
      return 'analyse interrompue';
  }
}

export function robustnessCoverageLine(analyzed: number, requested: number, replies: number): string {
  return `${analyzed}/${requested} coups analysés · ${replies} réponse(s) · couverture fréquentielle dans les cartes`;
}

// ---------------------------------------------------------------------------
// Potentiel de piège (trapPotential) : théorie vs pratique à horizon.
// ---------------------------------------------------------------------------

export type TrapVerdictLabel = 'Solide' | 'Piège rentable' | 'Pratique' | 'Dangereux' | 'Inconnu';

export function trapVerdictLabel(verdict: 'solid' | 'trap' | 'practical' | 'dangerous' | 'unknown'): TrapVerdictLabel {
  switch (verdict) {
    case 'solid':
      return 'Solide';
    case 'trap':
      return 'Piège rentable';
    case 'practical':
      return 'Pratique';
    case 'dangerous':
      return 'Dangereux';
    case 'unknown':
      return 'Inconnu';
  }
}

export function trapButtonLabel(horizonPlies: number): string {
  return `Analyser le potentiel de piège (horizon ${Math.round(horizonPlies / 2)} coups)`;
}

export function trapTooltip(horizonPlies: number): string {
  return `Théorie vs pratique (stats Lichess) à horizon ${horizonPlies} plis`;
}

export const TRAP_PROGRESS_REPLIES = 'Réponses Lichess…';
export const TRAP_PROGRESS_DEFENSE = 'Défense parfaite…';

export function trapProgressReply(san: string): string {
  return `Réponse ${san}…`;
}

export function trapProgressHorizon(san: string): string {
  return `Horizon ${san}…`;
}

export const TRAP_NOTE_NO_DATA = 'Pas assez de données Lichess pour juger ce coup.';
export const TRAP_NOTE_ENGINE_EMPTY = "Le moteur ne propose rien sur cette position.";
export const TRAP_NOTE_ILLEGAL = 'Coup illégal depuis cette position.';

export function trapNotePartialFloor(count: number): string {
  return `${count} réponse(s) sans éval à l'horizon (floor safety appliqué).`;
}

export const TRAP_DISABLED_NO_ENGINE = 'Moteur local indisponible — potentiel de piège non analysable.';
export const TRAP_DISABLED_BUSY = "Moteur occupé par l'analyse en cours — réessayez dans un instant.";
export const TRAP_DEFENSE_NOT_PLAYED = 'non jouée';

export function robustnessPartialError(skippedDetail: string): string {
  return `Données insuffisantes pour juger la robustesse ici (${skippedDetail}).`;
}
