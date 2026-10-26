import { describe, expect, it } from 'vitest';
import { defangLinks, stripBidiControls } from './display-text';

// Links that Gmail, Outlook, Apple Mail or a GFM viewer may detect.
export const AUTOLINKABLE =
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|mailto:|[^\s[]@|\b[a-z0-9-]+\.(?:com|io|org|net|example|md)\b/i;

describe('defangLinks', () => {
  it.each([
    [
      'https://evil.example/verify-account',
      'https[:]//evil[.]example/verify-account',
    ],
    ['HTTP://Evil.Example:8080/x', 'HTTP[:]//Evil[.]Example:8080/x'],
    ['ftp://files.test/a', 'ftp[:]//files[.]test/a'],
    ['www.evil.example', 'www[.]evil[.]example'],
    ['see evil.com now', 'see evil[.]com now'],
    ['support@corp.example', 'support[@]corp[.]example'],
    ['mailto:support@corp.example', 'mailto[:]support[@]corp[.]example'],
    ['@admin', '[@]admin'],
    ['login.xn--p1ai', 'login[.]xn--p1ai'],
    ['file.md', 'file[.]md'],
    ['invoice.zip', 'invoice[.]zip'],
    ['Node.js', 'Node[.]js'],
    ['evil.tool.com', 'evil[.]tool[.]com'],
    ['weather.read', 'weather[.]read'],
    ['192.0.2.1/verify-account', '192[.]0[.]2[.]1/verify-account'],
    ['10.0.0.1:8080/x', '10[.]0[.]0[.]1:8080/x'],
    ['visit 203.0.113.9.', 'visit 203[.]0[.]113[.]9[.]'],
    ['http://[2001:db8::1]/login', 'http[:]//[2001:db8::1]/login'],
  ])('defangs %s', (input, expected) => {
    expect(defangLinks(input)).toBe(expected);
    expect(defangLinks(input)).not.toMatch(AUTOLINKABLE);
  });

  it.each([
    'customer_lookup',
    '$/properties/status',
    '$/properties/currency~1x',
    '2026-01-01T00:00:00.000Z',
    'v1.2.3',
    '1.2.3',
    '1.2.3.4.5',
    // Bare bracketed IPv6 is not a GFM or mail-client autolink shape; with a scheme it is defanged above.
    '[2001:db8::1]',
    '2026-09-25T10:39:57.123Z',
    'mcp-endpoint|mcp.tool',
    '{"kind":"openapi.operation"}',
    'a2a.skill webmcp.page-html',
    'e.g. an ordinary sentence: with a colon.',
    'Tool removed<script>: tool “customer_lookup',
  ])('leaves %s unchanged', (input) => {
    expect(defangLinks(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = defangLinks(
      'https://a.example x@b.io www.c.com d.io mailto:e@f.org',
    );
    expect(defangLinks(once)).toBe(once);
  });

  it('stays linear on adversarial input', () => {
    const started = performance.now();
    defangLinks('a.'.repeat(50_000) + '1');
    defangLinks(('a-'.repeat(30) + 'a.').repeat(1_500));
    defangLinks('@'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('stripBidiControls', () => {
  it('removes every embedding, override, isolate and mark character', () => {
    const controls = [
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u200e',
      '\u200f',
      '\u061c',
    ];
    for (const control of controls)
      expect(stripBidiControls(`delete${control}_user`)).toBe('delete_user');
    expect(stripBidiControls('\u202eresu_eteled\u202c')).toBe('resu_eteled');
  });

  it('is the identity for any text without bidi controls', () => {
    // Deterministic pseudo-random strings over the BMP and astral planes.
    let seed = 20260925;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const bidi = new Set([
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
      0x200e, 0x200f, 0x061c,
    ]);
    for (let sample = 0; sample < 2_000; sample += 1) {
      const points = Array.from({ length: 1 + (next() % 40) }, () => {
        const range = next() % 4;
        const point =
          range === 0
            ? next() % 0x80
            : range === 1
              ? 0x2000 + (next() % 0x80)
              : range === 2
                ? next() % 0xd800
                : 0x10000 + (next() % 0x10000);
        return bidi.has(point) ? 0x41 : point;
      });
      const text = String.fromCodePoint(...points);
      expect(stripBidiControls(text)).toBe(text);
    }
  });

  it('keeps ordinary text, right-to-left scripts and emoji joiners', () => {
    for (const text of [
      'create_order',
      'שלום עולם',
      'مرحبا',
      '👩\u200d💻',
      'a\u200bb',
    ])
      expect(stripBidiControls(text)).toBe(text);
  });
});
