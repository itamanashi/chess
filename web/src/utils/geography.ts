/**
 * Géographie des adversaires : codes pays Chess.com (alpha-2, ex. « FR »),
 * noms français (Intl.DisplayNames, sans table embarquée), drapeaux
 * (flagcdn, les emojis-drapeaux ne rendent pas sous Windows) et bilans par
 * pays. Les pays adverses ne sont PAS dans les parties : voir
 * `services/opponentCountry.ts` (chargement à la demande + cache).
 */

/** Code « pays inconnu » (adversaire sans pays ou non résolu). */
export const UNKNOWN_COUNTRY = '';

/** Vignette drapeau (w80 : net en 40 px, srcSet w160 pour écrans denses). */
export function flagSrc(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return `https://flagcdn.com/w80/${code.toLowerCase()}.png`;
}

export function flagSrcSet(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const c = code.toLowerCase();
  return `https://flagcdn.com/w80/${c}.png 1x, https://flagcdn.com/w160/${c}.png 2x`;
}

let displayNames: Intl.DisplayNames | null = null;
let displayNamesFailed = false;

/** Nom français du pays (« France », « États-Unis »), repli = code. */
export function frenchCountryName(code: string): string {
  if (!code) return 'Pays inconnu';
  try {
    if (!displayNames && !displayNamesFailed) {
      displayNames = new Intl.DisplayNames(['fr'], { type: 'region' });
    }
    const name = displayNames?.of(code);
    if (typeof name === 'string' && name) return name;
  } catch {
    displayNamesFailed = true;
  }
  return code;
}

/**
 * world-atlas `countries-110m` identifie les géométries par code ISO
 * numérique (« 250 » = France, « -99 » = Kosovo/Chypre-Nord/Somaliland).
 * Table numérique → alpha-2 pour colorer la carte et afficher les noms.
 */
const NUMERIC_TO_ALPHA2: Record<string, string> = {
  '004': 'AF', '008': 'AL', '012': 'DZ', '016': 'AS', '020': 'AD', '024': 'AO',
  '660': 'AI', '028': 'AG', '032': 'AR', '051': 'AM', '533': 'AW', '036': 'AU',
  '040': 'AT', '031': 'AZ', '044': 'BS', '048': 'BH', '050': 'BD', '052': 'BB',
  '112': 'BY', '056': 'BE', '084': 'BZ', '204': 'BJ', '060': 'BM', '064': 'BT',
  '068': 'BO', '070': 'BA', '072': 'BW', '076': 'BR', '096': 'BN', '100': 'BG',
  '854': 'BF', '108': 'BI', '116': 'KH', '120': 'CM', '124': 'CA', '140': 'CF',
  '148': 'TD', '152': 'CL', '156': 'CN', '170': 'CO', '174': 'KM', '178': 'CG',
  '180': 'CD', '184': 'CK', '188': 'CR', '384': 'CI', '191': 'HR', '192': 'CU',
  '531': 'CW', '196': 'CY', '203': 'CZ', '208': 'DK', '262': 'DJ', '212': 'DM',
  '214': 'DO', '218': 'EC', '818': 'EG', '222': 'SV', '226': 'GQ', '232': 'ER',
  '233': 'EE', '231': 'ET', '238': 'FK', '234': 'FO', '242': 'FJ', '246': 'FI',
  '250': 'FR', '254': 'GF', '258': 'PF', '260': 'TF', '266': 'GA', '270': 'GM',
  '268': 'GE', '276': 'DE', '288': 'GH', '292': 'GI', '300': 'GR', '304': 'GL',
  '308': 'GD', '312': 'GP', '316': 'GU', '320': 'GT', '324': 'GN', '328': 'GY',
  '332': 'HT', '340': 'HN', '344': 'HK', '348': 'HU', '352': 'IS', '356': 'IN',
  '360': 'ID', '364': 'IR', '368': 'IQ', '372': 'IE', '376': 'IL', '380': 'IT',
  '388': 'JM', '392': 'JP', '400': 'JO', '398': 'KZ', '404': 'KE', '408': 'KP',
  '410': 'KR', '414': 'KW', '417': 'KG', '418': 'LA', '428': 'LV', '422': 'LB',
  '426': 'LS', '430': 'LR', '434': 'LY', '438': 'LI', '440': 'LT', '442': 'LU',
  '446': 'MO', '807': 'MK', '450': 'MG', '454': 'MW', '458': 'MY', '462': 'MV',
  '466': 'ML', '470': 'MT', '478': 'MR', '480': 'MU', '175': 'YT', '484': 'MX',
  '583': 'FM', '498': 'MD', '492': 'MC', '496': 'MN', '499': 'ME', '500': 'MS',
  '504': 'MA', '508': 'MZ', '104': 'MM', '516': 'NA', '520': 'NR', '524': 'NP',
  '528': 'NL', '540': 'NC', '554': 'NZ', '558': 'NI', '562': 'NE', '566': 'NG',
  '578': 'NO', '512': 'OM', '586': 'PK', '585': 'PW', '591': 'PA', '598': 'PG',
  '600': 'PY', '604': 'PE', '608': 'PH', '612': 'PN', '616': 'PL', '620': 'PT',
  '630': 'PR', '634': 'QA', '642': 'RO', '643': 'RU', '646': 'RW', '652': 'BL',
  '654': 'SH', '659': 'KN', '662': 'LC', '663': 'MF', '534': 'SX', '666': 'PM',
  '670': 'VC', '882': 'WS', '674': 'SM', '678': 'ST', '682': 'SA', '686': 'SN',
  '688': 'RS', '694': 'SL', '090': 'SB', '706': 'SO', '710': 'ZA', '728': 'SS',
  '724': 'ES', '144': 'LK', '729': 'SD', '740': 'SR', '748': 'SZ', '752': 'SE',
  '756': 'CH', '760': 'SY', '158': 'TW', '762': 'TJ', '834': 'TZ', '764': 'TH',
  '626': 'TL', '768': 'TG', '772': 'TK', '776': 'TO', '780': 'TT', '788': 'TN',
  '792': 'TR', '795': 'TM', '798': 'TV', '800': 'UG', '804': 'UA', '784': 'AE',
  '826': 'GB', '840': 'US', '858': 'UY', '860': 'UZ', '548': 'VU', '336': 'VA',
  '862': 'VE', '704': 'VN', '092': 'VG', '850': 'VI', '876': 'WF', '732': 'EH',
  '887': 'YE', '894': 'ZM', '716': 'ZW', '831': 'GG', '832': 'JE', '833': 'IM',
  '580': 'MP', '275': 'PS',
};

/** Identifiant world-atlas → alpha-2 (null = sans équivalent : « -99 », Antarctique…). */
export function alpha2OfNumericId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return NUMERIC_TO_ALPHA2[String(id)] ?? null;
}

export type CountryOutcome = 'win' | 'draw' | 'loss';

export interface CountryGameInput {
  /** Alpha-2 Chess.com ('' = inconnu). */
  country: string;
  outcome: CountryOutcome;
  /** Précision du compte lié (absente si partie non analysée). */
  accuracy?: number | null;
}

export interface CountryRow {
  code: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accSum: number;
  accN: number;
}

/** Agrège les parties par pays, triées par volume décroissant. */
export function computeCountryStats(items: CountryGameInput[]): CountryRow[] {
  const byCode = new Map<string, CountryRow>();
  const row = (code: string): CountryRow => {
    let r = byCode.get(code);
    if (!r) {
      r = { code, games: 0, wins: 0, draws: 0, losses: 0, accSum: 0, accN: 0 };
      byCode.set(code, r);
    }
    return r;
  };
  for (const item of items) {
    const r = row(item.country);
    r.games++;
    if (item.outcome === 'win') r.wins++;
    else if (item.outcome === 'draw') r.draws++;
    else r.losses++;
    if (typeof item.accuracy === 'number' && Number.isFinite(item.accuracy)) {
      r.accSum += item.accuracy;
      r.accN++;
    }
  }
  return [...byCode.values()].sort((a, b) => b.games - a.games || a.code.localeCompare(b.code));
}

/** Précision moyenne du pays (null si aucune partie notée). */
export function countryAccuracy(row: CountryRow): number | null {
  return row.accN > 0 ? row.accSum / row.accN : null;
}

/** Part de victoires du pays (0–100, NaN si aucune partie). */
export function countryWinRate(row: CountryRow): number {
  return row.games > 0 ? (row.wins / row.games) * 100 : NaN;
}
