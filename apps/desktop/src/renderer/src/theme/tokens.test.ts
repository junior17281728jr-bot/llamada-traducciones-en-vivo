import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Custom properties declared by the rule whose selector is exactly `selector`; rules inside @media count too. */
function declarations(selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const ruleSelector = rule[1]!.replace(/@media[^{]*$/, '').trim();
    if (ruleSelector !== selector) continue;
    for (const declaration of rule[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars.set(declaration[1]!, declaration[2]!.trim());
    }
  }
  return vars;
}

const base = declarations(':root');
const dark = new Map(base);
const light = new Map([...base, ...declarations(":root[data-theme='light']")]);
const lightFromSystem = new Map([...base, ...declarations(":root:not([data-theme='dark'])")]);

function luminance(hex: string): number {
  const [r, g, b] = hex
    .replace('#', '')
    .match(/../g)!
    .map((pair) => parseInt(pair, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['--color-bg', '--color-surface', '--color-surface-raised'];
const TEXT_TOKENS = [
  '--color-text',
  '--color-text-muted',
  '--color-passenger',
  '--color-operator',
  '--color-accent',
  '--color-ok',
  '--color-warn',
  '--color-danger',
  '--color-simulated',
];

describe.each([
  ['dark', dark],
  ['light', light],
] as const)('%s theme', (_name, theme) => {
  it.each(TEXT_TOKENS)('%s reaches AA (4.5:1) on every surface', (token) => {
    for (const surface of SURFACES) {
      expect(contrast(theme.get(token)!, theme.get(surface)!), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text on the accent colour reaches AA', () => {
    expect(contrast(theme.get('--color-on-accent')!, theme.get('--color-accent')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring is visible against every surface (3:1)', () => {
    for (const surface of SURFACES) {
      expect(contrast(theme.get('--color-focus')!, theme.get(surface)!)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps passenger and operator on different hues', () => {
    expect(theme.get('--color-passenger')).not.toBe(theme.get('--color-operator'));
  });
});

describe('theme plumbing', () => {
  it('dark is the default and the light values from the system preference match the forced light theme', () => {
    expect(base.get('--color-bg')).toBe('#0b1220');
    const forcedLight = declarations(":root[data-theme='light']");
    expect(forcedLight.size).toBeGreaterThan(10);
    expect(declarations(":root:not([data-theme='dark'])").size).toBe(forcedLight.size);
    for (const [name, value] of forcedLight) {
      expect(lightFromSystem.get(name), name).toBe(value);
    }
  });

  it('declares the tokens the other teams rely on', () => {
    for (const token of [
      '--color-passenger',
      '--color-passenger-soft',
      '--color-operator',
      '--color-operator-soft',
      '--color-simulated',
      '--space-4',
      '--radius-md',
      '--font-sans',
      '--lane-height',
      '--motion-base',
    ]) {
      expect(base.has(token), token).toBe(true);
    }
  });

  it('removes decorative motion under prefers-reduced-motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*--motion-base:\s*0ms/);
  });
});
