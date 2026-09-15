// Inbound visitor classification tests. The load-bearing assertions are
// the ones a brand-only or major-only reading gets wrong: Safari 17.4 and
// 17.5 come out distinct, the iOS wrappers (CriOS, FxiOS, EdgiOS) report
// WebKit at the device version while keeping their brand, Chromium forks
// resolve to their own brand ahead of the Chrome token, client hints win
// over the User-Agent when present and separate Brave from Chrome, and no
// string in the result is ever a slice of the request. The rest pins the
// input bound and the all-null shape for absent, empty, and garbage input.

import { describe, expect, test } from 'bun:test';
import { deriveUserAgent, MAX_HEADER_LENGTH, type UserAgentFields } from '../src/worker/telemetry/user-agent';

function derive(init: Record<string, string>): UserAgentFields {
  return deriveUserAgent(new Headers(init));
}

const ALL_NULL: UserAgentFields = {
  engine: null,
  engineVersion: null,
  brand: null,
  brandMajorMinor: null,
  osFamily: null,
};

const ENGINES = new Set(['Blink', 'Gecko', 'WebKit']);
const BRANDS = new Set(['Chrome', 'Safari', 'Firefox', 'Edge', 'Brave', 'Opera', 'Samsung Internet', 'Chromium']);
const OS_FAMILIES = new Set(['Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS']);
const MAJOR_MINOR = /^\d+\.\d+$/;

function expectClosed(fields: UserAgentFields): void {
  expect(fields.engine === null || ENGINES.has(fields.engine)).toBe(true);
  expect(fields.brand === null || BRANDS.has(fields.brand)).toBe(true);
  expect(fields.osFamily === null || OS_FAMILIES.has(fields.osFamily)).toBe(true);
  expect(fields.engineVersion === null || MAJOR_MINOR.test(fields.engineVersion)).toBe(true);
  expect(fields.brandMajorMinor === null || MAJOR_MINOR.test(fields.brandMajorMinor)).toBe(true);
}

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  safariMac17_4:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  safariMac17_5:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariMac17_4_1:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
  chromeIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15',
  edgeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/123.2420.65 Mobile/15E148 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0',
  operaAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 OPR/81.0.4196.78115',
  edgeAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36 EdgA/123.0.2420.65',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  chromeChromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
} as const;

const HINTS = {
  chrome: '"Google Chrome";v="123", "Chromium";v="123", "Not-A.Brand";v="24"',
  edge124: '"Microsoft Edge";v="124", "Chromium";v="124", "Not-A.Brand";v="24"',
  brave: '"Brave";v="123", "Chromium";v="123", "Not(A:Brand";v="24"',
  opera: '"Opera";v="108", "Chromium";v="122", "Not(A:Brand";v="24"',
  samsung: '"Samsung Internet";v="24", "Chromium";v="117", "Not;A=Brand";v="99"',
  chromiumOnly: '"Chromium";v="123", "Not-A.Brand";v="24"',
  greaseFirst: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  unknownBrand: '"Evil Browser";v="99", "Not-A.Brand";v="24"',
} as const;

describe('deriveUserAgent desktop brands', () => {
  test('Chrome resolves to Blink at the Chrome version', () => {
    expect(derive({ 'user-agent': UA.chromeWindows })).toEqual({
      engine: 'Blink',
      engineVersion: '123.0',
      brand: 'Chrome',
      brandMajorMinor: '123.0',
      osFamily: 'Windows',
    });
  });

  test('Safari resolves to WebKit at the Version token', () => {
    expect(derive({ 'user-agent': UA.safariMac17_4 })).toEqual({
      engine: 'WebKit',
      engineVersion: '17.4',
      brand: 'Safari',
      brandMajorMinor: '17.4',
      osFamily: 'macOS',
    });
  });

  test('Firefox resolves to Gecko at the Firefox version', () => {
    expect(derive({ 'user-agent': UA.firefoxWindows })).toEqual({
      engine: 'Gecko',
      engineVersion: '124.0',
      brand: 'Firefox',
      brandMajorMinor: '124.0',
      osFamily: 'Windows',
    });
  });

  test('Edge resolves to Blink at the Edg version', () => {
    expect(derive({ 'user-agent': UA.edgeWindows })).toEqual({
      engine: 'Blink',
      engineVersion: '123.0',
      brand: 'Edge',
      brandMajorMinor: '123.0',
      osFamily: 'Windows',
    });
  });
});

describe('deriveUserAgent major.minor boundary', () => {
  test('Safari 17.4 and 17.5 resolve to distinct values', () => {
    const a = derive({ 'user-agent': UA.safariMac17_4 });
    const b = derive({ 'user-agent': UA.safariMac17_5 });
    expect(a.brandMajorMinor).toBe('17.4');
    expect(b.brandMajorMinor).toBe('17.5');
    expect(a.engineVersion).toBe('17.4');
    expect(b.engineVersion).toBe('17.5');
    expect(a.brandMajorMinor).not.toBe(b.brandMajorMinor);
  });

  test('a patch component is dropped, never folded into the minor', () => {
    const fields = derive({ 'user-agent': UA.safariMac17_4_1 });
    expect(fields.brandMajorMinor).toBe('17.4');
    expect(fields.engineVersion).toBe('17.4');
  });
});

describe('deriveUserAgent iOS wrappers', () => {
  test('CriOS keeps the Chrome brand and reports WebKit at the iOS version', () => {
    expect(derive({ 'user-agent': UA.chromeIos })).toEqual({
      engine: 'WebKit',
      engineVersion: '17.4',
      brand: 'Chrome',
      brandMajorMinor: '123.0',
      osFamily: 'iOS',
    });
  });

  test('FxiOS keeps the Firefox brand and reports WebKit at the iOS version', () => {
    expect(derive({ 'user-agent': UA.firefoxIos })).toEqual({
      engine: 'WebKit',
      engineVersion: '17.4',
      brand: 'Firefox',
      brandMajorMinor: '124.0',
      osFamily: 'iOS',
    });
  });

  test('EdgiOS keeps the Edge brand and takes the iOS version over its fixed Version token', () => {
    const fields = derive({ 'user-agent': UA.edgeIos });
    expect(fields.brand).toBe('Edge');
    expect(fields.engine).toBe('WebKit');
    expect(fields.engineVersion).toBe('17.4');
    expect(fields.engineVersion).not.toBe('17.0');
    expect(fields.osFamily).toBe('iOS');
    // Edge for iOS omits the zero minor from its own token, so the second
    // component is what the token carries.
    expect(fields.brandMajorMinor).toBe('123.2420');
  });

  test('the iPad form of the iOS version token resolves the same way', () => {
    const fields = derive({ 'user-agent': UA.chromeIpad });
    expect(fields.engine).toBe('WebKit');
    expect(fields.engineVersion).toBe('17.4');
    expect(fields.brand).toBe('Chrome');
    expect(fields.osFamily).toBe('iOS');
  });

  test('Safari on iPhone resolves as Safari on iOS', () => {
    expect(derive({ 'user-agent': UA.safariIphone })).toEqual({
      engine: 'WebKit',
      engineVersion: '17.4',
      brand: 'Safari',
      brandMajorMinor: '17.4',
      osFamily: 'iOS',
    });
  });
});

describe('deriveUserAgent Chromium forks', () => {
  test('Samsung Internet resolves to its own brand with Blink at the Chrome token', () => {
    expect(derive({ 'user-agent': UA.samsungAndroid })).toEqual({
      engine: 'Blink',
      engineVersion: '117.0',
      brand: 'Samsung Internet',
      brandMajorMinor: '24.0',
      osFamily: 'Android',
    });
  });

  test('Opera resolves to its own brand with Blink at the Chrome token', () => {
    expect(derive({ 'user-agent': UA.operaWindows })).toEqual({
      engine: 'Blink',
      engineVersion: '122.0',
      brand: 'Opera',
      brandMajorMinor: '108.0',
      osFamily: 'Windows',
    });
    expect(derive({ 'user-agent': UA.operaAndroid })).toEqual({
      engine: 'Blink',
      engineVersion: '122.0',
      brand: 'Opera',
      brandMajorMinor: '81.0',
      osFamily: 'Android',
    });
  });

  test('Edge on Android resolves to Edge, not Chrome', () => {
    expect(derive({ 'user-agent': UA.edgeAndroid })).toEqual({
      engine: 'Blink',
      engineVersion: '123.0',
      brand: 'Edge',
      brandMajorMinor: '123.0',
      osFamily: 'Android',
    });
  });
});

describe('deriveUserAgent token precedence', () => {
  test('Chrome carries Safari and AppleWebKit tokens and still resolves to Chrome on Blink', () => {
    const fields = derive({ 'user-agent': UA.chromeWindows });
    expect(fields.brand).toBe('Chrome');
    expect(fields.engine).toBe('Blink');
  });

  test('Edge carries a Chrome token and still resolves to Edge', () => {
    const fields = derive({ 'user-agent': UA.edgeWindows });
    expect(fields.brand).toBe('Edge');
  });

  test('Firefox on Android resolves to Gecko on Android', () => {
    expect(derive({ 'user-agent': UA.firefoxAndroid })).toEqual({
      engine: 'Gecko',
      engineVersion: '124.0',
      brand: 'Firefox',
      brandMajorMinor: '124.0',
      osFamily: 'Android',
    });
  });

  test('Android and ChromeOS win over the Linux and X11 tokens they carry', () => {
    expect(derive({ 'user-agent': UA.chromeAndroid }).osFamily).toBe('Android');
    expect(derive({ 'user-agent': UA.chromeChromeOs }).osFamily).toBe('ChromeOS');
    expect(derive({ 'user-agent': UA.firefoxLinux }).osFamily).toBe('Linux');
    expect(derive({ 'user-agent': UA.chromeLinux }).osFamily).toBe('Linux');
  });
});

describe('deriveUserAgent client hints', () => {
  test('hints win over a User-Agent that disagrees', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.edge124, 'user-agent': UA.edgeWindows });
    expect(fields.brand).toBe('Edge');
    expect(fields.brandMajorMinor).toBe('124.0');
    expect(fields.engine).toBe('Blink');
    expect(fields.engineVersion).toBe('124.0');
  });

  test('Brave is distinguished when hints are present and folds into Chrome when they are not', () => {
    const withHints = derive({ 'sec-ch-ua': HINTS.brave, 'user-agent': UA.chromeWindows });
    expect(withHints.brand).toBe('Brave');
    expect(withHints.brandMajorMinor).toBe('123.0');
    expect(withHints.engine).toBe('Blink');
    const withoutHints = derive({ 'user-agent': UA.chromeWindows });
    expect(withoutHints.brand).toBe('Chrome');
  });

  test('Chrome hints resolve to Chrome on Blink at the Chromium version', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.chrome, 'sec-ch-ua-platform': '"Windows"' });
    expect(fields).toEqual({
      engine: 'Blink',
      engineVersion: '123.0',
      brand: 'Chrome',
      brandMajorMinor: '123.0',
      osFamily: 'Windows',
    });
  });

  test('a Chromium-only hint list resolves to the Chromium fallback brand', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.chromiumOnly });
    expect(fields.brand).toBe('Chromium');
    expect(fields.brandMajorMinor).toBe('123.0');
    expect(fields.engine).toBe('Blink');
    expect(fields.engineVersion).toBe('123.0');
  });

  test('GREASE entries are skipped wherever they appear in the list', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.greaseFirst });
    expect(fields.brand).toBe('Chrome');
    expect(fields.brandMajorMinor).toBe('120.0');
    expect(fields.engineVersion).toBe('120.0');
  });

  test('Opera and Samsung hints keep their own brand version and take the Chromium entry as engine version', () => {
    const opera = derive({ 'sec-ch-ua': HINTS.opera });
    expect(opera.brand).toBe('Opera');
    expect(opera.brandMajorMinor).toBe('108.0');
    expect(opera.engineVersion).toBe('122.0');
    const samsung = derive({ 'sec-ch-ua': HINTS.samsung });
    expect(samsung.brand).toBe('Samsung Internet');
    expect(samsung.brandMajorMinor).toBe('24.0');
    expect(samsung.engineVersion).toBe('117.0');
  });

  test('the platform hint maps through the closed table and wins over the User-Agent', () => {
    expect(derive({ 'sec-ch-ua-platform': '"Windows"' }).osFamily).toBe('Windows');
    expect(derive({ 'sec-ch-ua-platform': '"macOS"' }).osFamily).toBe('macOS');
    expect(derive({ 'sec-ch-ua-platform': '"Android"' }).osFamily).toBe('Android');
    expect(derive({ 'sec-ch-ua-platform': '"Chrome OS"' }).osFamily).toBe('ChromeOS');
    expect(derive({ 'sec-ch-ua-platform': '"Linux"' }).osFamily).toBe('Linux');
    expect(derive({ 'sec-ch-ua-platform': '"Windows"', 'user-agent': UA.safariMac17_4 }).osFamily).toBe('Windows');
  });

  test('an unrecognized platform hint falls to the User-Agent, and to null without one', () => {
    expect(derive({ 'sec-ch-ua-platform': '"Evil OS"', 'user-agent': UA.chromeWindows }).osFamily).toBe('Windows');
    const alone = derive({ 'sec-ch-ua-platform': '"Evil OS"' });
    expect(alone.osFamily).toBeNull();
    expect(JSON.stringify(alone)).not.toContain('Evil');
  });

  test('an unrecognized brand token yields null brand and engine, never the token text', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.unknownBrand });
    expect(fields.brand).toBeNull();
    expect(fields.engine).toBeNull();
    expect(fields.brandMajorMinor).toBeNull();
    expect(fields.engineVersion).toBeNull();
    expect(JSON.stringify(fields)).not.toContain('Evil');
    expectClosed(fields);
  });

  test('when hints resolve nothing the User-Agent table runs', () => {
    const fields = derive({ 'sec-ch-ua': HINTS.unknownBrand, 'user-agent': UA.firefoxWindows });
    expect(fields.brand).toBe('Firefox');
    expect(fields.engine).toBe('Gecko');
  });
});

describe('deriveUserAgent bounds and garbage', () => {
  test('absent headers yield all-null', () => {
    expect(deriveUserAgent(new Headers())).toEqual(ALL_NULL);
  });

  test('empty and garbage User-Agents yield all-null', () => {
    expect(derive({ 'user-agent': '' })).toEqual(ALL_NULL);
    expect(derive({ 'user-agent': 'asdfghjkl' })).toEqual(ALL_NULL);
    expect(derive({ 'user-agent': 'Mozilla/5.0' })).toEqual(ALL_NULL);
    expect(derive({ 'user-agent': 'curl/8.7.1' })).toEqual(ALL_NULL);
    expect(derive({ 'user-agent': 'Chrome/ Safari/ Version/ rv:' })).toEqual(ALL_NULL);
  });

  test('malformed hint headers yield all-null rather than throwing', () => {
    expect(derive({ 'sec-ch-ua': 'not a structured field' })).toEqual(ALL_NULL);
    expect(derive({ 'sec-ch-ua': '"Google Chrome"' })).toEqual(ALL_NULL);
    expect(derive({ 'sec-ch-ua': '"Google Chrome";v="abc"' }).brandMajorMinor).toBeNull();
    expect(derive({ 'sec-ch-ua-platform': 'Windows' })).toEqual(ALL_NULL);
  });

  test('an oversized User-Agent is cut at the cap before any token is read', () => {
    const inside = 'x'.repeat(MAX_HEADER_LENGTH - UA.chromeWindows.length) + UA.chromeWindows;
    expect(derive({ 'user-agent': inside }).brand).toBe('Chrome');
    const beyond = 'x'.repeat(MAX_HEADER_LENGTH) + UA.chromeWindows;
    expect(derive({ 'user-agent': beyond })).toEqual(ALL_NULL);
  });

  test('the cap covers Sec-CH-UA and Sec-CH-UA-Platform as well', () => {
    const grease = '"Not-A.Brand";v="24", ';
    const filler = grease.repeat(Math.ceil(MAX_HEADER_LENGTH / grease.length));
    expect(derive({ 'sec-ch-ua': filler + HINTS.chrome })).toEqual(ALL_NULL);
    expect(derive({ 'sec-ch-ua': grease + HINTS.chrome }).brand).toBe('Chrome');
    // Headers strips outer whitespace, so the filler sits between the value
    // and trailing junk: the junk breaks the anchored parse unless the cut
    // removes it first.
    const quoted = '"Windows"';
    const pastCap = `${quoted}${' '.repeat(MAX_HEADER_LENGTH - quoted.length)}junk`;
    expect(derive({ 'sec-ch-ua-platform': pastCap }).osFamily).toBe('Windows');
    const insideCap = `${quoted}${' '.repeat(8)}junk`;
    expect(derive({ 'sec-ch-ua-platform': insideCap }).osFamily).toBeNull();
  });

  test('every string in the result is a table member or a built major.minor, never input text', () => {
    for (const ua of Object.values(UA)) {
      expectClosed(derive({ 'user-agent': ua }));
    }
    for (const hints of Object.values(HINTS)) {
      expectClosed(derive({ 'sec-ch-ua': hints }));
    }
  });
});
