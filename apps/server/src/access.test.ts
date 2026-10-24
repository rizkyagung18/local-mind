import { describe, expect, it } from 'vitest';
import { allowedApiSource, allowedHost, validToken } from './access.js';

describe('local access boundary', () => {
  it.each(['evil.example', '127.0.0.1.evil.example:3210', 'localhost:3210', '127.0.0.1:5173', '0.0.0.0:3210'])('rejects noncanonical production Host %s', host => {
    expect(allowedHost(host, false)).toBe(false);
  });
  it.each(['null', 'https://evil.example', 'http://127.0.0.1:5173'])('rejects foreign or null Origin %s', origin => {
    expect(allowedApiSource({ host: '127.0.0.1:3210', origin }, false)).toBe(false);
  });
  it('rejects same-site requests from other local origins', () => {
    expect(allowedApiSource({ host: '127.0.0.1:3210', fetchSite: 'same-site' }, false)).toBe(false);
    expect(allowedApiSource({ host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210', fetchSite: 'same-origin' }, false)).toBe(true);
  });
  it('does not accept token prefixes, arrays, or missing tokens', () => {
    for (const candidate of [undefined, ['secret'], 'secre', 'secret-long']) expect(validToken(candidate, 'secret')).toBe(false);
    expect(validToken('secret', 'secret')).toBe(true);
  });
});
