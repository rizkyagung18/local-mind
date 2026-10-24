import { timingSafeEqual } from 'node:crypto';
import { APP_ORIGIN, DEV_ORIGIN } from '@localmind/contracts';

type Source = { host?: string | undefined; origin?: string; fetchSite?: string };

export function allowedHost(host: string | undefined, development: boolean): boolean {
  return host === '127.0.0.1:3210' || (development && host === '127.0.0.1:5173');
}

export function allowedApiSource(source: Source, development: boolean): boolean {
  if (!allowedHost(source.host, development)) return false;
  if (source.origin !== undefined && source.origin !== (development ? DEV_ORIGIN : APP_ORIGIN)) return false;
  return source.fetchSite === undefined || source.fetchSite === 'same-origin';
}

export function validToken(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string') return false;
  const supplied = Buffer.from(candidate);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}
