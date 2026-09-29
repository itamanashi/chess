/**
 * Noms d'ouvertures en français : les API (Lichess, PGN Chess.com) ne
 * fournissent que de l'anglais. Dictionnaire « tête » + « suite » appliqué
 * UNIQUEMENT à l'affichage (les données et regroupements gardent l'anglais).
 *
 * - Correspondance exacte → traduction directe.
 * - « Tête : suite » / « Tête, suite » (Lichess) → chaque partie traduite.
 * - « Tête suite » (slugs ECOUrl Chess.com déballés, ex. « Sicilian Defense
 *   Open Sicilian ») → plus long préfixe connu + suite.
 * - Inconnu → nom anglais d'origine (jamais de charabia).
 */

const HEAD_FR: Record<string, string> = {
  // 1.e4 / 1.d4 : premiers coups.
  "King's Pawn": 'Début du pion roi',
  "King's Pawn Game": 'Partie du pion roi',
  "King's Knight Opening": 'Début du cavalier roi',
  "Queen's Pawn": 'Début du pion dame',
  "Queen's Pawn Game": 'Partie du pion dame',
  // Sicilienne / Française / Caro.
  'Sicilian Defense': 'Défense sicilienne',
  'French Defense': 'Défense française',
  'Caro-Kann Defense': 'Défense Caro-Kann',
  // Parties ouvertes classiques.
  'Italian Game': 'Partie italienne',
  'Ruy Lopez': 'Partie espagnole',
  'Scotch Game': 'Partie écossaise',
  'Vienna Game': 'Partie viennoise',
  'Four Knights Game': 'Partie des quatre cavaliers',
  'Three Knights Opening': 'Début des trois cavaliers',
  'Two Knights Defense': 'Défense des deux cavaliers',
  'Philidor Defense': 'Défense Philidor',
  "Petrov's Defense": 'Défense russe',
  'Hungarian Defense': 'Défense hongroise',
  "Bishop's Opening": 'Début du fou',
  'Center Game': 'Partie du centre',
  'Ponziani Opening': 'Ouverture Ponziani',
  'Portuguese Opening': 'Ouverture portugaise',
  "Alapin's Opening": 'Ouverture Alapine',
  // Autres défenses contre 1.e4.
  'Scandinavian Defense': 'Défense scandinave',
  'Alekhine Defense': 'Défense Alekhine',
  'Pirc Defense': 'Défense Pirc',
  'Modern Defense': 'Défense moderne',
  'Nimzowitsch Defense': 'Défense Nimzowitsch',
  "Owen's Defense": 'Défense Owen',
  'St. George Defense': 'Défense Saint-Georges',
  'Borg Defense': 'Défense Borg',
  'Barnes Defense': 'Défense Barnes',
  'Goldsmith Defense': 'Défense Goldsmith',
  'Lemming Defense': 'Défense Lemming',
  'Norwegian Defense': 'Défense norvégienne',
  'Fred Defense': 'Défense Fred',
  // Gambits sur 1.e4.
  "King's Gambit": 'Gambit du roi',
  'Vienna Gambit': 'Gambit viennois',
  'Danish Gambit': 'Gambit danois',
  'Evans Gambit': 'Gambit Evans',
  'Latvian Gambit': 'Gambit letton',
  'Elephant Gambit': 'Gambit éléphant',
  'Englund Gambit': 'Gambit Englund',
  'Halloween Gambit': 'Gambit Halloween',
  'Stafford Gambit': 'Gambit Stafford',
  'Cochrane Gambit': 'Gambit Cochrane',
  'Urusov Gambit': 'Gambit Urusov',
  'Calabrese Countergambit': 'Contre-gambit calabrais',
  'Lewis Countergambit': 'Contre-gambit Lewis',
  'Falkbeer Countergambit': 'Contre-gambit Falkbeer',
  // Gambit dame et défenses fermées.
  "Queen's Gambit": 'Gambit dame',
  'Slav Defense': 'Défense slave',
  'Semi-Slav Defense': 'Défense semi-slave',
  'Nimzo-Indian Defense': 'Défense nimzo-indienne',
  "Queen's Indian Defense": 'Défense ouest-indienne',
  "King's Indian Defense": 'Défense est-indienne',
  'Grünfeld Defense': 'Défense Grünfeld',
  'Modern Benoni': 'Benoni moderne',
  'Benoni Defense': 'Défense Benoni',
  'Benko Gambit': 'Gambit Benko',
  'Budapest Gambit': 'Gambit Budapest',
  'Dutch Defense': 'Défense hollandaise',
  'Chigorin Defense': 'Défense Tchigorine',
  'Baltic Defense': 'Défense balte',
  'Marshall Defense': 'Défense Marshall',
  'Albin Countergambit': 'Contre-gambit Albin',
  'Keres Defense': 'Défense Kérès',
  'Polish Defense': 'Défense polonaise',
  'Horwitz Defense': 'Défense Horwitz',
  'Wade Defense': 'Défense Wade',
  'Rat Defense': 'Défense Rat',
  // Systèmes blancs.
  'Catalan Opening': 'Ouverture catalane',
  'London System': 'Système de Londres',
  'Colle System': 'Système Colle',
  'Torre Attack': 'Attaque Torre',
  'Trompowsky Attack': 'Attaque Trompowsky',
  'Veresov Opening': 'Début Veresov',
  // Ouvertures de flanc.
  'English Opening': 'Ouverture anglaise',
  'Réti Opening': 'Début Réti',
  "King's Indian Attack": 'Attaque est-indienne',
  'Bird Opening': 'Ouverture Bird',
  "Larsen's Opening": 'Ouverture Larsen',
  'Sokolsky Opening': 'Ouverture polonaise',
  'Polish Opening': 'Ouverture polonaise',
  'Grob Opening': 'Ouverture Grob',
  "Anderssen's Opening": 'Ouverture Anderssen',
  'Ware Opening': 'Ouverture Ware',
  'Saragossa Opening': 'Ouverture Saragosse',
  'Mieses Opening': 'Ouverture Mieses',
  "Van't Kruijs Opening": 'Ouverture Van\u2019t Kruijs',
  'Van Geet Opening': 'Ouverture Van Geet',
  'Zukertort Opening': 'Ouverture Zukertort',
  'Clemenz Opening': 'Ouverture Clemenz',
  'Desprez Opening': 'Ouverture Desprez',
  'Amar Opening': 'Ouverture Amar',
  'Durkin Opening': 'Ouverture Durkin',
  'Barnes Opening': 'Ouverture Barnes',
  "Benko's Opening": 'Ouverture Benko',
  "King's Fianchetto Opening": 'Début du fianchetto du roi',
  'Dunst Opening': 'Ouverture Dunst',
};

const TAIL_FR: Record<string, string> = {
  // Variantes courantes (partagées entre ouvertures).
  'Classical Variation': 'variante classique',
  'Modern Variation': 'variante moderne',
  'Advance Variation': 'variante avancée',
  'Exchange Variation': 'variante d\u2019échange',
  'Main Line': 'ligne principale',
  // Sicilienne.
  'Najdorf Variation': 'variante Naïdorf',
  'Dragon Variation': 'variante du Dragon',
  'Sveshnikov Variation': 'variante Sveshnikov',
  'Kan Variation': 'variante Kan',
  'Taimanov Variation': 'variante Taïmanov',
  'Accelerated Dragon': 'Dragon accéléré',
  'Hyper-Accelerated Dragon': 'Dragon hyper-accéléré',
  'Alapin Variation': 'variante Alapin',
  'Smith-Morra Gambit': 'gambit Smith-Morra',
  'Closed Sicilian': 'Sicilienne fermée',
  'Open Sicilian': 'Sicilienne ouverte',
  'Grand Prix Attack': 'attaque Grand Prix',
  'Moscow Variation': 'variante Moscou',
  'Rossolimo Variation': 'variante Rossolimo',
  "O'Kelly Variation": 'variante O\u2019Kelly',
  'Paulsen Variation': 'variante Paulsen',
  'Prins Variation': 'variante Prins',
  'Kalashnikov Variation': 'variante Kalashnikov',
  'Four Knights Variation': 'variante des quatre cavaliers',
  'Wing Gambit': 'gambit de l\u2019aile',
  // Française.
  'Winawer Variation': 'variante Winawer',
  'Tarrasch Variation': 'variante Tarrasch',
  'Rubinstein Variation': 'variante Rubinstein',
  'Burn Variation': 'variante Burn',
  'MacCutcheon Variation': 'variante MacCutcheon',
  'Steinitz Variation': 'variante Steinitz',
  'Chigorin Variation': 'variante Tchigorine',
  // Espagnole.
  'Berlin Defense': 'défense de Berlin',
  'Morphy Defense': 'défense Morphy',
  'Closed Variation': 'variante fermée',
  "Bird's Defense": 'défense Bird',
  'Classical Defense': 'défense classique',
  'Schliemann Defense': 'défense Schliemann',
  'Open Berlin': 'Berlin ouvert',
  'Rio de Janeiro Variation': 'variante Rio de Janeiro',
  'Zaitsev Variation': 'variante Zaïtsev',
  'Breyer Variation': 'variante Breyer',
  'Smyslov Variation': 'variante Smyslov',
  // Italienne.
  'Giuoco Piano': 'Giuoco Piano',
  'Giuoco Pianissimo': 'Giuoco Pianissimo',
  'Fried Liver Attack': 'attaque du foie frit',
  'Traxler Counterattack': 'contre-attaque Traxler',
  'Polerio Variation': 'variante Polerio',
  'Deutz Variation': 'variante Deutz',
  'Jerome Gambit': 'gambit Jerome',
  // Russe, écossaise, viennoise, Philidor.
  'Classical Attack': 'attaque classique',
  'Modern Attack': 'attaque moderne',
  'Italian Variation': 'variante italienne',
  'Scotch Gambit': 'gambit écossais',
  'Göring Gambit': 'gambit Göring',
  'Lolli Variation': 'variante Lolli',
  'Blumenfeld Attack': 'attaque Blumenfeld',
  'Falkbeer Variation': 'variante Falkbeer',
  'Max Lange Variation': 'variante Max Lange',
  'Mieses Variation': 'variante Mieses',
  'Frankenstein-Dracula Variation': 'variante Frankenstein-Dracula',
  'Hanham Variation': 'variante Hanham',
  'Antoshin Variation': 'variante Antochine',
  'Nimzowitsch Variation': 'variante Nimzowitsch',
  'Lion Variation': 'variante du Lion',
  // Gambit dame.
  'Accepted': 'accepté',
  'Declined': 'refusé',
  'Orthodox Defense': 'défense orthodoxe',
  'Tarrasch Defense': 'défense Tarrasch',
  'Ragozin Defense': 'défense Ragozin',
  'Tartakower Variation': 'variante Tartakower',
  'Vienna Variation': 'variante viennoise',
  'Janowski Variation': 'variante Janowski',
  'Showalter Variation': 'variante Showalter',
  'Austrian Variation': 'variante autrichienne',
  'Hennig-Schara Gambit': 'gambit Hennig-Schara',
  'Winawer Countergambit': 'contre-gambit Winawer',
  'Petrosian Variation': 'variante Petrossian',
  // Slave.
  'Czech Variation': 'variante tchèque',
  'Geller Gambit': 'gambit Geller',
  // Grünfeld.
  'Russian System': 'système russe',
  'Hungarian Variation': 'variante hongroise',
  'Seville Variation': 'variante Séville',
  'Smyslov Defense': 'défense Smyslov',
  'Capablanca Variation': 'variante Capablanca',
  'Modern Exchange Variation': 'variante d\u2019échange moderne',
  'Spassky Variation': 'variante Spassky',
  // Est-indienne.
  'Sämisch Variation': 'variante Sämisch',
  'Fianchetto Variation': 'variante fianchetto',
  'Four Pawns Attack': 'attaque des quatre pions',
  'Makogonov Variation': 'variante Makogonov',
  'Averbakh System': 'système Averbakh',
  'Double Fianchetto': 'double fianchetto',
  'Pomar System': 'système Pomar',
  'Gligoric Variation': 'variante Gligoric',
  // Nimzo / Ouest-indienne.
  'Leningrad Variation': 'variante Leningrad',
  'Hübner Variation': 'variante Hübner',
  'Romanishin Variation': 'variante Romanichine',
  'Fischer Variation': 'variante Fischer',
  // Benoni / Benko / Budapest.
  'Snake Variation': 'variante du Serpent',
  // Caro-Kann.
  'Panov-Botvinnik Attack': 'attaque Panov-Botvinnik',
  'Bronstein-Larsen Variation': 'variante Bronstein-Larsen',
  'Gurgenidze Variation': 'variante Gurgenidze',
  'Fantasy Variation': 'variante Fantaisie',
  'Karpov Variation': 'variante Karpov',
  'Edwards Variation': 'variante Edwards',
  'Labahn Variation': 'variante Labahn',
  // Gambit du roi.
  'Kieseritzky Gambit': 'gambit Kieseritzky',
  'Allgaier Gambit': 'gambit Allgaier',
  'Muzio Gambit': 'gambit Muzio',
  'Salvio Gambit': 'gambit Salvio',
  'Cunningham Defense': 'défense Cunningham',
  'Abbazia Defense': 'défense Abbazia',
  'Fischer Defense': 'défense Fischer',
  'Becker Defense': 'défense Becker',
  'Quaade Gambit': 'gambit Quaade',
  'Rosentreter Gambit': 'gambit Rosentreter',
  'MacLeod Defense': 'défense MacLeod',
  'Schallopp Defense': 'défense Schallopp',
  'Hanstein Gambit': 'gambit Hanstein',
  'Philidor Variation': 'variante Philidor',
  // Hollandaise.
  'Stonewall Variation': 'variante Stonewall',
  'Staunton Gambit': 'gambit Staunton',
  'Hort Variation': 'variante Hort',
  // Anglaise / Réti / Est-indienne (attaque).
  "King's English Variation": 'variante anglaise du roi',
  'Mikenas-Carls Variation': 'variante Mikenas-Carls',
  'Hedgehog System': 'système Hérisson',
  'Reversed Sicilian': 'Sicilienne inversée',
  'Four Knights System': 'système des quatre cavaliers',
  'Two Knights System': 'système des deux cavaliers',
  'Réti Accepted': 'Réti accepté',
  'Reversed Blumenfeld': 'Blumenfeld inversé',
  'French Variation': 'variante française',
  'Sicilian Variation': 'variante sicilienne',
  'Symmetrical Variation': 'variante symétrique',
  'Yugoslav Variation': 'variante yougoslave',
  'Keres Variation': 'variante Kérès',
  // Colle / Catalane.
  'Anti-Colle': 'Anti-Colle',
  'Open Catalan': 'Catalane ouverte',
  'Closed Catalan': 'Catalane fermée',
  'Open Defense': 'défense ouverte',
  // Grob / Bird / Larsen / Polonaise.
  'Fritz Gambit': 'gambit Fritz',
  'Grob Gambit': 'gambit Grob',
  'Spike Attack': 'attaque Spike',
  'Romford Countergambit': 'contre-gambit Romford',
  "From's Gambit": 'gambit From',
  'Dutch Variation': 'variante hollandaise',
  'Siebrecht Variation': 'variante Siebrecht',
  'Williams Variation': 'variante Williams',
  'Spanish Variation': 'variante espagnole',
  'Sturm Gambit': 'gambit Sturm',
  'Indian Variation': 'variante indienne',
  'English Variation': 'variante anglaise',
  'Bugayev Attack': 'attaque Bugayev',
  'Myers Variation': 'variante Myers',
  'Birmingham Gambit': 'gambit Birmingham',
  'Tübingen Gambit': 'gambit Tübingen',
  'German Variation': 'variante allemande',
  // Ponziani / Centre / Début du fou.
  'Jaenisch Counterattack': 'contre-attaque Jaenisch',
  'Leonhardt Variation': 'variante Leonhardt',
  'Cordel Variation': 'variante Cordel',
  'Small Center': 'petit centre',
  'Boi Variation': 'variante Boi',
  'Lewis Gambit': 'gambit Lewis',
  'Philidor Counterattack': 'contre-attaque Philidor',
  // Scandinave / Alekhine / Pirc / Moderne.
  'Mies-Kotrč Variation': 'variante Mies-Kotrč',
  'Richter Variation': 'variante Richter',
  'Panov Variation': 'variante Panov',
  'Collijn Variation': 'variante Collijn',
  'Portuguese Gambit': 'gambit portugais',
  'Welling Variation': 'variante Welling',
  "O'Sullivan Gambit": 'gambit O\u2019Sullivan',
  'Krejcik Variation': 'variante Krejcik',
  'Maróczy Variation': 'variante Maroczy',
  'Austrian Attack': 'attaque autrichienne',
  '150 Attack': 'attaque 150',
  'Suttles Variation': 'variante Suttles',
  'Kholmov Variation': 'variante Kholmov',
  'Chinese Variation': 'variante chinoise',
  "Geller's System": 'système Geller',
  'Mongredien Variation': 'variante Mongredien',
  'Pterodactyl Variation': 'variante Ptérodactyle',
  'Hippopotamus Variation': 'variante Hippopotame',
  // Owen / Saint-Georges / Divers.
  'Smith Variation': 'variante Smith',
  'Gutman Variation': 'variante Gutman',
  'Matthews Variation': 'variante Matthews',
  'Watson Gambit': 'gambit Watson',
  'St. George Gambit': 'gambit Saint-Georges',
  'Kennedy Variation': 'variante Kennedy',
  'Declined Variation': 'variante refusée',
  'Franco-Nimzowitsch Variation': 'variante franco-Nimzowitsch',
  'Stockholm Variation': 'variante Stockholm',
  'Paris Gambit': 'gambit Paris',
  'Gent Gambit': 'gambit de Gand',
  'Hammerschlag Variation': 'variante Hammerschlag',
  'Betbeder Variation': 'variante Betbeder',
  'Larson Variation': 'variante Larson',
  'McDonnell Variation': 'variante McDonnell',
  'Kingside Fianchetto': 'fianchetto du roi',
  'Queenside Fianchetto': 'fianchetto de la dame',
  'Arctic Variation': 'variante arctique',
  'Black Mustang': 'Mustang noir',
  'Lisbon Gambit': 'gambit Lisbonne',
  'Lemberger Gambit': 'gambit Lemberger',
  'Ross Gambit': 'gambit Ross',
  'Wade Variation': 'variante Wade',
  'Nimzo-Larsen Variation': 'variante Nimzo-Larsen',
  'Pirc Invitation': 'invitation Pirc',
  'Slav Invitation': 'invitation slave',
  'Sicilian Invitation': 'invitation sicilienne',
  'Reversed Rat': 'Rat inversé',
  'New York Variation': 'variante New York',
  'Crab Variation': 'variante du Crabe',
  'Cologne Variation': 'variante Cologne',
  'Reversed Benoni': 'Benoni inversé',
  'Slav Formation': 'formation slave',
  'Old Indian Formation': 'formation vieille-indienne',
  'Pirc Formation': 'formation Pirc',
  'Réti Opening': 'début Réti',
  // Parties ouvertes/fermées (slugs ECOUrl).
  'Open Game': 'partie ouverte',
  'Closed Game': 'partie fermée',
  'Semi-Open Game': 'partie semi-ouverte',
  'Indian Game': 'partie indienne',
  'Open Ruy Lopez': 'Espagnole ouverte',
  'Closed Ruy Lopez': 'Espagnole fermée',
  'Open Spanish': 'Espagnole ouverte',
  'Closed Spanish': 'Espagnole fermée',
};

// Plus long préfixe d'abord (ex. « King's Indian Defense » avant « King's… »).
const HEAD_KEYS = Object.keys(HEAD_FR).sort((a, b) => b.length - a.length);

/** Suite en français : dictionnaire des suites, sinon tête connue en minuscule. */
function tailAsFrench(tailRaw: string): string | null {
  const direct = TAIL_FR[tailRaw];
  if (direct) return direct;
  const asHead = HEAD_FR[tailRaw];
  if (asHead) return asHead.charAt(0).toLowerCase() + asHead.slice(1);
  return null;
}

/** Variante seule en français (null si inconnue : garder l'anglais). */
export function frenchOpeningVariant(variantRaw: string | null | undefined): string | null {
  if (!variantRaw) return null;
  return tailAsFrench(variantRaw.trim());
}

/**
 * Découpe « Tête : suite » / « Tête, suite » / « Tête suite » (mêmes règles
 * que `frenchOpeningName`, sans traduire). Sans suite → parent seul.
 */
export function splitOpeningName(name: string | null | undefined): { parent: string; variant: string | null } {
  const raw = (name ?? '').trim();
  if (!raw) return { parent: '', variant: null };
  const m = raw.match(/^(.+?)\s*[:,]\s*(.+)$/);
  if (m) return { parent: m[1].trim(), variant: m[2].trim() };
  for (const h of HEAD_KEYS) {
    if (raw.startsWith(`${h} `)) {
      return { parent: h, variant: raw.slice(h.length + 1).trim() };
    }
  }
  return { parent: raw, variant: null };
}

/**
 * Nom d'ouverture en français (affichage). Entrée vide → ''. Inconnu →
 * nom anglais d'origine, sans reformatage.
 */
export function frenchOpeningName(name: string | null | undefined): string {
  if (!name) return '';
  const raw = name.trim();
  if (!raw) return '';
  const full = HEAD_FR[raw];
  if (full) return full;
  // « Tête : suite » / « Tête, suite » (format Lichess).
  const m = raw.match(/^(.+?)\s*[:,]\s*(.+)$/);
  if (m) {
    const headRaw = m[1].trim();
    const tailRaw = m[2].trim();
    const headFr = HEAD_FR[headRaw];
    const tailFr = tailAsFrench(tailRaw);
    if (!headFr && !tailFr) return raw;
    const sep = raw.includes(':') ? ' : ' : ', ';
    return `${headFr ?? headRaw}${sep}${tailFr ?? tailRaw}`;
  }
  // « Tête suite » (slugs ECOUrl Chess.com déballés) : plus long préfixe connu.
  for (const h of HEAD_KEYS) {
    if (raw.startsWith(`${h} `)) {
      const tailRaw = raw.slice(h.length + 1).trim();
      const tailFr = tailAsFrench(tailRaw) ?? tailRaw;
      // Adjectif seul (« accepté ») : soudé ; suite nominale : après virgule.
      const glue = /^[a-zàâäéèêëîïôöùûüç]/.test(tailFr) ? ' ' : ', ';
      return `${HEAD_FR[h]}${glue}${tailFr}`;
    }
  }
  // Suite seule connue (« Accepted », « Declined »…).
  const tailOnly = TAIL_FR[raw];
  if (tailOnly) return tailOnly;
  return raw;
}
