// Inbound visitor classification: request headers to browser brand, engine,
// major.minor versions, and OS family, every field nullable and every
// returned string drawn from this module's own closed tables or built from
// parsed digits. Input text never reaches the result, so a caller cannot
// persist a User-Agent by accident. The engine is recorded beside the brand
// because the iOS wrappers (CriOS, FxiOS, EdgiOS) render with the device's
// WebKit while carrying Blink or Gecko brand tokens, and the version keeps
// its minor because Safari 17.4 and 17.5 differ on real support boundaries.
//
// This module reads what visitors send. The outbound probe User-Agents the
// web audit sends live in src/shared/user-agents.ts; the two are unrelated
// tables and neither consults the other.

export type Engine = 'Blink' | 'Gecko' | 'WebKit';

export type Brand = 'Chrome' | 'Safari' | 'Firefox' | 'Edge' | 'Brave' | 'Opera' | 'Samsung Internet' | 'Chromium';

export type OsFamily = 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Linux' | 'ChromeOS';

export interface UserAgentFields {
  readonly engine: Engine | null;
  readonly engineVersion: string | null;
  readonly brand: Brand | null;
  readonly brandMajorMinor: string | null;
  readonly osFamily: OsFamily | null;
}

type BrowserFields = Omit<UserAgentFields, 'osFamily'>;

/** Every header this module reads is cut to this length before any parsing. */
export const MAX_HEADER_LENGTH = 512;

const NO_BROWSER: BrowserFields = { engine: null, engineVersion: null, brand: null, brandMajorMinor: null };

// Brands as they appear in Sec-CH-UA. Anything else, GREASE included, is
// skipped: the header is attacker-settable free text, so unknown entries
// are never carried through. Chromium is the fallback brand when no branded
// entry is present; its entry also supplies the Blink engine version.
const HINT_BRANDS: ReadonlyMap<string, Brand> = new Map([
  ['Google Chrome', 'Chrome'],
  ['Microsoft Edge', 'Edge'],
  ['Brave', 'Brave'],
  ['Opera', 'Opera'],
  ['Opera GX', 'Opera'],
  ['Samsung Internet', 'Samsung Internet'],
  ['Chromium', 'Chromium'],
]);

const HINT_PLATFORMS: ReadonlyMap<string, OsFamily> = new Map([
  ['Windows', 'Windows'],
  ['macOS', 'macOS'],
  ['iOS', 'iOS'],
  ['Android', 'Android'],
  ['Linux', 'Linux'],
  ['Chrome OS', 'ChromeOS'],
  ['Chromium OS', 'ChromeOS'],
]);

const HINT_ENTRY = /"([^"]{1,64})"\s*;\s*v\s*=\s*"([^"]{0,32})"/g;
const HINT_PLATFORM = /^\s*"([^"]{1,32})"\s*$/;
const HINT_VERSION = /^(\d{1,6})(?:\.(\d{1,6}))?/;

const IOS_VERSION = /CPU (?:iPhone )?OS (\d{1,6})(?:_(\d{1,6}))?/;
const CHROME = /Chrome\/(\d{1,6})(?:\.(\d{1,6}))?/;
const FIREFOX = /Firefox\/(\d{1,6})(?:\.(\d{1,6}))?/;
const GECKO_RV = /\brv:(\d{1,6})(?:\.(\d{1,6}))?/;
const SAFARI_VERSION = /Version\/(\d{1,6})(?:\.(\d{1,6}))?/;
const SAFARI_TOKEN = /Safari\//;

// Checked ahead of every desktop branch: these carry a Blink or Gecko brand
// token but render with the device's WebKit, whose version is the iOS
// version because those User-Agents carry no trustworthy Version token.
const IOS_WRAPPERS: ReadonlyArray<readonly [RegExp, Brand]> = [
  [/CriOS\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Chrome'],
  [/FxiOS\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Firefox'],
  [/EdgiOS\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Edge'],
];

// Checked ahead of the Chrome branch: each of these also carries a Chrome
// token, which is the Blink version rather than the brand version.
const CHROMIUM_FORKS: ReadonlyArray<readonly [RegExp, Brand]> = [
  [/\bEdgA?\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Edge'],
  [/\bOPR\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Opera'],
  [/SamsungBrowser\/(\d{1,6})(?:\.(\d{1,6}))?/, 'Samsung Internet'],
];

// Ordered so the more specific token wins: iOS before macOS, Android and
// ChromeOS before the Linux and X11 tokens they carry. An iPad on current
// Safari presents as Macintosh and is reported as macOS.
const OS_TOKENS: ReadonlyArray<readonly [RegExp, OsFamily]> = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows NT/, 'Windows'],
  [/Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

function bounded(value: string | null): string {
  return value === null ? '' : value.slice(0, MAX_HEADER_LENGTH);
}

function majorMinor(major: string | undefined, minor: string | undefined): string | null {
  if (major === undefined || major === '') return null;
  const a = Number.parseInt(major, 10);
  const b = minor === undefined || minor === '' ? 0 : Number.parseInt(minor, 10);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  return `${a}.${b}`;
}

function versionOf(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  if (match === null) return null;
  const minor: string | undefined = match[2];
  return majorMinor(match[1], minor);
}

function browserFromHints(secChUa: string): BrowserFields | null {
  let brand: Brand | null = null;
  let brandMajorMinor: string | null = null;
  let chromiumSeen = false;
  let chromiumVersion: string | null = null;
  for (const entry of secChUa.matchAll(HINT_ENTRY)) {
    const known = HINT_BRANDS.get(entry[1]);
    if (known === undefined) continue;
    const version = versionOf(entry[2], HINT_VERSION);
    if (known === 'Chromium') {
      chromiumSeen = true;
      chromiumVersion = version;
    } else if (brand === null) {
      brand = known;
      brandMajorMinor = version;
    }
  }
  if (brand === null) {
    if (!chromiumSeen) return null;
    brand = 'Chromium';
    brandMajorMinor = chromiumVersion;
  }
  return { engine: 'Blink', engineVersion: chromiumVersion, brand, brandMajorMinor };
}

function browserFromUserAgent(ua: string): BrowserFields {
  const ios = versionOf(ua, IOS_VERSION);
  for (const [pattern, brand] of IOS_WRAPPERS) {
    const version = versionOf(ua, pattern);
    if (version !== null) return { engine: 'WebKit', engineVersion: ios, brand, brandMajorMinor: version };
  }
  const chromium = versionOf(ua, CHROME);
  for (const [pattern, brand] of CHROMIUM_FORKS) {
    const version = versionOf(ua, pattern);
    if (version !== null) {
      return { engine: 'Blink', engineVersion: chromium ?? version, brand, brandMajorMinor: version };
    }
  }
  const firefox = versionOf(ua, FIREFOX);
  if (firefox !== null) {
    const gecko = versionOf(ua, GECKO_RV) ?? firefox;
    return { engine: 'Gecko', engineVersion: gecko, brand: 'Firefox', brandMajorMinor: firefox };
  }
  if (chromium !== null) {
    return { engine: 'Blink', engineVersion: chromium, brand: 'Chrome', brandMajorMinor: chromium };
  }
  const safari = versionOf(ua, SAFARI_VERSION);
  if (safari !== null && SAFARI_TOKEN.test(ua)) {
    return { engine: 'WebKit', engineVersion: safari, brand: 'Safari', brandMajorMinor: safari };
  }
  return NO_BROWSER;
}

function osFromPlatformHint(platform: string): OsFamily | null {
  const match = HINT_PLATFORM.exec(platform);
  if (match === null) return null;
  return HINT_PLATFORMS.get(match[1]) ?? null;
}

function osFromUserAgent(ua: string): OsFamily | null {
  for (const [pattern, family] of OS_TOKENS) {
    if (pattern.test(ua)) return family;
  }
  return null;
}

/**
 * Classify the requesting browser from its headers. Client hints are read
 * first because Chromium sends them by default and they separate Brave from
 * Chrome, which the User-Agent cannot; the User-Agent token table runs only
 * when the hints resolve nothing, which is always the case for Safari and
 * Firefox. Never returns any part of the input.
 */
export function deriveUserAgent(headers: Headers): UserAgentFields {
  const hints = bounded(headers.get('sec-ch-ua'));
  const platform = bounded(headers.get('sec-ch-ua-platform'));
  const ua = bounded(headers.get('user-agent'));
  const browser = browserFromHints(hints) ?? browserFromUserAgent(ua);
  const osFamily = osFromPlatformHint(platform) ?? osFromUserAgent(ua);
  return { ...browser, osFamily };
}
