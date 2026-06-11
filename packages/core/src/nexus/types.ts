/**
 * Type definitions for the Nexus Mods public API (v1).
 *
 * Shapes mirror the official `node-nexus-api` response objects so callers can
 * interoperate with existing Nexus tooling. The trilogy's three games each map
 * to a distinct Nexus "domain" (the slug in `nexusmods.com/<domain>`), captured
 * by {@link NEXUS_DOMAINS} / {@link domainToGameId}.
 */
import type { GameId } from '../game/gameinfo.js';

/** Result of `GET /v1/users/validate.json` — confirms an API key + account. */
export interface ValidateResult {
  user_id: number;
  key: string;
  name: string;
  email: string;
  profile_url: string;
  is_premium: boolean;
  is_supporter: boolean;
}

/** Result of `GET /v1/games/{domain}/mods/{mod_id}.json`. */
export interface NexusModInfo {
  mod_id: number;
  game_id: number;
  domain_name: string;
  name: string;
  summary: string;
  description: string;
  version: string;
  author: string;
  uploaded_by: string;
  picture_url: string | null;
  category_id: number;
  created_timestamp: number;
  updated_timestamp: number;
  endorsement_count: number;
  mod_downloads: number;
  contains_adult_content: boolean;
  available: boolean;
  status: string;
}

/** A single uploaded file belonging to a mod (entry in {@link ModFilesResult}). */
export interface FileInfo {
  file_id: number;
  name: string;
  version: string;
  category_id: number;
  category_name: string | null;
  is_primary: boolean;
  size: number;
  size_kb: number;
  file_name: string;
  uploaded_timestamp: number;
  mod_version: string;
  description: string;
}

/** Result of `GET /v1/games/{domain}/mods/{mod_id}/files.json`. */
export interface ModFilesResult {
  files: FileInfo[];
  file_updates: any[];
}

/** A CDN download mirror returned by the download-link endpoint. */
export interface DownloadLink {
  name: string;
  short_name: string;
  URI: string;
}

/**
 * The most recent rate-limit window state, parsed from the `x-rl-*` response
 * headers. `null` fields mean the corresponding header was absent.
 */
export interface RateLimit {
  dailyRemaining: number | null;
  hourlyRemaining: number | null;
  dailyReset: string | null;
  hourlyReset: string | null;
}

/**
 * Error thrown for non-2xx Nexus API responses. The `status` field carries the
 * HTTP status so callers can branch:
 *   - 401 invalid / expired API key
 *   - 403 a direct download link requires Premium (use the nxm flow instead)
 *   - 429 rate-limited (inspect {@link RateLimit} for reset times)
 */
export class NexusError extends Error {
  /** HTTP status code that produced this error. */
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Nexus API error (HTTP ${status})`);
    this.name = 'NexusError';
    this.status = status;
    // Preserve prototype chain when targeting ES5-ish transpilation.
    Object.setPrototypeOf(this, NexusError.prototype);
  }
}

/** Human {@link GameId} -> Nexus domain slug. */
export const NEXUS_DOMAINS: Record<GameId, string> = {
  XIII: 'finalfantasy13',
  'XIII-2': 'finalfantasyxiii2',
  'XIII-LR': 'lightningreturnsfinalfantasy13',
};

/** Reverse of {@link NEXUS_DOMAINS}: Nexus domain slug -> human {@link GameId}. */
export const domainToGameId: Record<string, GameId> = Object.fromEntries(
  (Object.entries(NEXUS_DOMAINS) as [GameId, string][]).map(([id, domain]) => [domain, id]),
) as Record<string, GameId>;
