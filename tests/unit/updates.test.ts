import { describe, expect, it } from 'vitest';
import { compareSemver, isSemver, parseLatestYml } from '../../src/shared/updates';

// Formato real que genera electron-builder (NSIS)
const SHA = 'k6QmZWfGNlXOBkC0FJpfeWSVYIeXqgKkMn1oqW5QB8u2C7xKH5Y3Wk1b2NtRzE6qQyM6dQ7XG3rH5o2ePjmT7w==';
const YML = `version: 1.0.1
files:
  - url: Callisto-Setup-1.0.1.exe
    sha512: ${SHA}
    size: 98765432
path: Callisto-Setup-1.0.1.exe
sha512: ${SHA}
releaseDate: '2026-12-01T10:00:00.000Z'
`;

describe('actualizaciones', () => {
  it('versiones', () => {
    expect(isSemver('1.0.0')).toBe(true);
    expect(isSemver('v1.0.0')).toBe(false);
    expect(isSemver('1.0')).toBe(false);
    expect(compareSemver('1.0.10', '1.0.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.10.0', '1.0.0')).toBe(-1);
  });

  it('lee el latest.yml de electron-builder', () => {
    expect(parseLatestYml(YML)).toEqual({ version: '1.0.1', path: 'Callisto-Setup-1.0.1.exe', sha512: SHA });
  });

  it('rechaza un latest.yml raro (otro archivo, rutas, sin hash)', () => {
    expect(parseLatestYml(YML.replace(/path: .*/, 'path: ..\\\\otro.exe'))).toBeNull();
    expect(parseLatestYml(YML.replace(/path: .*/, 'path: Callisto-Setup-1.0.1.exe.bat'))).toBeNull();
    expect(parseLatestYml(YML.replace(/^sha512: .*$/m, 'sha512: corto'))).toBeNull();
    expect(parseLatestYml(YML.replace('version: 1.0.1', 'version: latest'))).toBeNull();
    expect(parseLatestYml('no es yml')).toBeNull();
  });
});
