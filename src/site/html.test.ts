import { describe, expect, it } from 'vitest';
import { escapeHtml, externalLink, href, layout, normalizeBase, safeUrl } from './html.js';

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes ampersands before everything else', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralizes a script tag and an attribute break-out', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escapeHtml('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    );
  });

  it('leaves ordinary text and unicode alone', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('server-everything 1.0 · café ok')).toBe('server-everything 1.0 · café ok');
  });
});

describe('normalizeBase', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['  ', '/'],
    ['/does-it-install', '/does-it-install/'],
    ['/does-it-install/', '/does-it-install/'],
    ['does-it-install', '/does-it-install/'],
    ['https://example.test/dii', 'https://example.test/dii/'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeBase(input)).toBe(expected);
  });
});

describe('href', () => {
  it('prefixes the base and collapses the joining slash', () => {
    expect(href('/does-it-install/', 's/a.html')).toBe('/does-it-install/s/a.html');
    expect(href('/does-it-install', '/s/a.html')).toBe('/does-it-install/s/a.html');
    expect(href('/', '')).toBe('/');
  });

  it('escapes the result', () => {
    expect(href('/', 's/a"b.html')).toBe('/s/a&quot;b.html');
  });
});

describe('safeUrl', () => {
  it('accepts http and https only', () => {
    expect(safeUrl('https://example.test/x')).toBe('https://example.test/x');
    expect(safeUrl('http://example.test')).toBe('http://example.test');
    expect(safeUrl(' https://example.test ')).toBe('https://example.test');
  });

  it('rejects script and unknown schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,<script>')).toBeUndefined();
    expect(safeUrl('/relative')).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});

describe('externalLink', () => {
  it('links an http(s) url with escaped text', () => {
    expect(externalLink('https://example.test/a?b=1&c=2', 'Repo')).toBe(
      '<a href="https://example.test/a?b=1&amp;c=2" rel="noopener nofollow">Repo</a>',
    );
  });

  it('degrades to plain text for an unsafe url', () => {
    expect(externalLink('javascript:alert(1)', '<Repo>')).toBe('&lt;Repo&gt;');
  });
});

describe('layout', () => {
  const page = layout('Ada & <Bob>', '<p>body</p>', '/does-it-install', 'Desc & <check>');

  it('produces a complete HTML5 document with an escaped title', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>Ada &amp; &lt;Bob&gt;</title>');
    expect(page).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(page).toContain('<p>body</p>');
  });

  it('points navigation at the base path', () => {
    expect(page).toContain('href="/does-it-install/"');
    expect(page).toContain('href="/does-it-install/methodology.html"');
  });

  // One amber tone serves both needs_auth and needs_config: same colour, same
  // meaning, "alive and asking for something we cannot supply".
  it('defines an amber tone distinct from pass, fail and untested', () => {
    expect(page).toContain('--auth:#bf8700');
    expect(page).toContain('.dot.auth{background:var(--auth)}');
    expect(page).toContain('.sq.auth{background:var(--auth)}');
    expect(page).toContain('.count.auth b{color:var(--auth)}');
    expect(page).toContain('.verdict.auth{color:var(--auth);border-color:#d4a72c;background:#fff8c5}');
    expect(page).toContain('pre.err.auth{border-left-color:var(--auth)}');
  });

  it('keeps every status tone on its own colour', () => {
    const tones = ['--pass:#2da44e', '--fail:#cf222e', '--auth:#bf8700', '--none:#8c959f'];
    expect(new Set(tones.map((token) => token.split(':')[1])).size).toBe(tones.length);
    for (const token of tones) expect(page).toContain(token);
  });

  it('stays self-contained: inline css, no scripts, no external assets', () => {
    expect(page).toContain('<style>');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<link');
    expect(page).not.toContain('src=');
    expect(page).not.toContain('@import');
  });
});
