import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { matchesSite, normalizeSite, sanitizeSettings } from '../../src/shared/settings';
import { CHANGELOG } from '../../src/shared/changelog';
import { appMenuTemplate } from '../../src/main/context-menu';
import { isSemver } from '../../src/shared/updates';

describe('sitios que nunca se duermen', () => {
  it('normaliza lo que escribe el usuario', () => {
    expect(normalizeSite('music.youtube.com')).toBe('music.youtube.com');
    expect(normalizeSite('  https://Mail.Google.com/mail/u/0 ')).toBe('mail.google.com');
    expect(normalizeSite('www.ejemplo.com')).toBe('ejemplo.com');
    expect(normalizeSite('*.ejemplo.com')).toBe('ejemplo.com');
    expect(normalizeSite('ejemplo.com:8080/ruta')).toBe('ejemplo.com');
    expect(normalizeSite('no es un sitio')).toBeNull();
    expect(normalizeSite('')).toBeNull();
  });

  it('coincide con el sitio y sus subdominios, no con otros', () => {
    const sites = ['youtube.com', 'mail.google.com'];
    expect(matchesSite('https://music.youtube.com/watch', sites)).toBe(true);
    expect(matchesSite('https://www.youtube.com/', sites)).toBe(true);
    expect(matchesSite('https://mail.google.com/mail', sites)).toBe(true);
    expect(matchesSite('https://google.com/', sites)).toBe(false);
    expect(matchesSite('https://notyoutube.com/', sites)).toBe(false);
    expect(matchesSite('callisto://settings', sites)).toBe(false);
  });

  it('en la configuración: válidos, sin repetir', () => {
    expect(sanitizeSettings({ neverSleepSites: ['YouTube.com', 'youtube.com', 'basura !', 3] }).neverSleepSites).toEqual(['youtube.com']);
    expect(sanitizeSettings({}).neverSleepSites).toEqual([]);
  });
});

describe('actualizaciones (1.1.0)', () => {
  it('las novedades empiezan por la versión actual (no olvidarse de escribirlas)', () => {
    const version = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
    expect(CHANGELOG[0]!.version).toBe(version);
    for (const e of CHANGELOG) {
      expect(isSemver(e.version)).toBe(true);
      expect(e.items.length).toBeGreaterThan(0);
    }
  });

  it('con una versión lista, el menú ⋯ empieza con "Reiniciar para actualizar"', () => {
    const noop = () => {};
    const actions = { newTab: noop, newWindow: noop, newPrivateWindow: noop, history: noop, downloads: noop, passwords: noop, extensions: noop, zoom: noop, find: noop, settings: noop, closeWindow: noop, installUpdate: noop };
    const withUpdate = appMenuTemplate({ zoomPercent: 100, updateVersion: '1.2.0' }, actions) as MenuItemConstructorOptions[];
    expect(withUpdate[0]!.label).toBe('Reiniciar para actualizar a 1.2.0');
    const without = appMenuTemplate({ zoomPercent: 100 }, actions) as MenuItemConstructorOptions[];
    expect(without[0]!.label).toBe('Nueva pestaña');
  });
});
