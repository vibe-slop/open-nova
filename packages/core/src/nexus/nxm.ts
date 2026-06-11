/**
 * Parser for `nxm://` deep links — the protocol Nexus Mods registers so a
 * "Mod Manager Download" button on the website can hand a (short-lived,
 * non-Premium) download authorization to a desktop app.
 *
 * Canonical form:
 *
 *   nxm://{game_domain}/mods/{mod_id}/files/{file_id}?key={key}&expires={expires}&user_id={user_id}
 *
 * Note that under the WHATWG URL model the `{game_domain}` segment is the URL
 * *host*, not a path segment, so we read it from `url.hostname`. The query
 * params are optional (a Premium user can build the download link without
 * them), so `key` / `expires` / `userId` may be absent.
 */
import { domainToGameId } from './types.js';
import type { GameId } from '../game/gameinfo.js';

/** Parsed components of an `nxm://` URL. */
export interface ParsedNxm {
  domain: string;
  modId: number;
  fileId: number;
  key?: string;
  expires?: number;
  userId?: number;
}

/**
 * Parse an `nxm://` deep link into its components.
 *
 * @throws {Error} if the scheme is not `nxm:`, the host (domain) is empty, or
 *   the path is not `/mods/<int>/files/<int>`.
 */
export function parseNxmUrl(url: string): ParsedNxm {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Malformed nxm URL: ${url}`);
  }

  if (parsed.protocol !== 'nxm:') {
    throw new Error(`Not an nxm:// URL (got protocol "${parsed.protocol}"): ${url}`);
  }

  const domain = parsed.hostname;
  if (!domain) throw new Error(`nxm URL missing game domain: ${url}`);

  // Path segments, dropping the leading empty string from the leading slash.
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 4 || segments[0] !== 'mods' || segments[2] !== 'files') {
    throw new Error(`nxm URL path must be /mods/<id>/files/<id>: ${url}`);
  }

  const modId = parseIntStrict(segments[1], 'mod_id', url);
  const fileId = parseIntStrict(segments[3], 'file_id', url);

  const out: ParsedNxm = { domain, modId, fileId };

  const key = parsed.searchParams.get('key');
  if (key !== null) out.key = key;

  const expires = parsed.searchParams.get('expires');
  if (expires !== null) out.expires = parseIntStrict(expires, 'expires', url);

  const userId = parsed.searchParams.get('user_id');
  if (userId !== null) out.userId = parseIntStrict(userId, 'user_id', url);

  return out;
}

function parseIntStrict(value: string, field: string, url: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`nxm URL ${field} must be an integer (got "${value}"): ${url}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Map the Nexus domain slug from an nxm URL back to the trilogy's human
 * {@link GameId}, or `undefined` if the domain is not one of the three FF13
 * games.
 */
export function gameIdForNxm(domain: string): GameId | undefined {
  return domainToGameId[domain];
}
