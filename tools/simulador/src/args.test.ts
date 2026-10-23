import { describe, expect, it } from 'vitest';
import { UsageError, flagBoolean, flagNumber, flagString, parseArgs, rejectUnknownFlags } from './args.js';

describe('parseArgs', () => {
  it('reads the command, --clave valor, --clave=valor and switches', () => {
    const parsed = parseArgs(['llamar', '--desde', '+447700900123', '--idioma=en', '--repetir', '--guion', 'x.json']);
    expect(parsed.command).toBe('llamar');
    expect(parsed.flags.get('desde')).toBe('+447700900123');
    expect(parsed.flags.get('idioma')).toBe('en');
    expect(parsed.flags.get('repetir')).toBe(true);
    expect(parsed.flags.get('guion')).toBe('x.json');
    expect(parsed.positionals).toEqual([]);
  });

  it('does not let a known switch swallow the command that follows it', () => {
    const parsed = parseArgs(['--sin-hora', 'escuchar', '--idioma', 'pt', '--colgar-al-terminar']);
    expect(parsed.command).toBe('escuchar');
    expect(parsed.flags.get('sin-hora')).toBe(true);
    expect(parsed.flags.get('colgar-al-terminar')).toBe(true);
  });

  it('treats -h as --ayuda and keeps extra positionals', () => {
    const parsed = parseArgs(['-h', 'colgar', 'extra']);
    expect(parsed.flags.get('ayuda')).toBe(true);
    expect(parsed.command).toBe('colgar');
    expect(parsed.positionals).toEqual(['extra']);
  });

  it('validates values in Spanish', () => {
    const { flags } = parseArgs(['x', '--espera', 'abc', '--vacio', '--numero', '+34600000000', '--repetir=no']);
    expect(() => flagNumber(flags, 'espera', { min: 1 })).toThrow(UsageError);
    expect(() => flagNumber(flags, 'espera', { min: 1 })).toThrow(/--espera debe ser un número/);
    expect(() => flagString(flags, 'vacio')).toThrow(/--vacio necesita un valor/);
    expect(flagString(flags, 'numero')).toBe('+34600000000');
    expect(flagString(flags, 'ausente')).toBeUndefined();
    expect(flagBoolean(flags, 'repetir')).toBe(false);
    expect(flagBoolean(flags, 'ausente')).toBe(false);
    expect(() => rejectUnknownFlags(flags, ['espera'], 'x')).toThrow(/Opción desconocida para «x»: --vacio, --numero, --repetir/);
  });

  it('accepts decimal comma and ranges', () => {
    const { flags } = parseArgs(['x', '--velocidad', '2,5', '--espera', '7']);
    expect(flagNumber(flags, 'velocidad', { min: 0.01 })).toBe(2.5);
    expect(flagNumber(flags, 'espera', { integer: true, min: 1, max: 10 })).toBe(7);
    expect(() => flagNumber(flags, 'espera', { integer: true, min: 1, max: 5 })).toThrow(/entre 1 y 5/);
  });
});
