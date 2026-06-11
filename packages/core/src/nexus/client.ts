/**
 * Thin client for the Nexus Mods public API (v1).
 *
 * Scope is deliberately minimal — exactly what the mod manager needs: validate
 * a key, read mod + file metadata, pick the primary download, and resolve a CDN
 * download link (Premium direct, or via an `nxm://` key/expires grant for
 * everyone else).
 *
 * The API key is sensitive. This client merely accepts it as a constructor
 * argument; persistence is the host app's responsibility (Electron
 * `safeStorage`). `fetchImpl` is injectable so the unit tests run with no
 * network access.
 */
import os from 'node:os';
import {
  NexusError,
  type ValidateResult,
  type NexusModInfo,
  type FileInfo,
  type ModFilesResult,
  type DownloadLink,
  type RateLimit,
} from './types.js';

const BASE_URL = 'https://api.nexusmods.com/v1';
const DEFAULT_APP_VERSION = '0.1.0';

/** Construction options for {@link NexusClient}. */
export interface NexusClientOptions {
  /** Nexus personal API key (sent as the `apikey` header). */
  apiKey: string;
  /** App version advertised in `Application-Version` / `User-Agent`. */
  appVersion?: string;
  /** Injectable fetch (defaults to the global `fetch`). Used by tests. */
  fetchImpl?: typeof fetch;
}

/** Optional nxm grant used to authorize a non-Premium download. */
export interface NxmGrant {
  key: string;
  expires: number;
}

/**
 * Minimal Nexus Mods API client. One instance is bound to a single API key.
 * After any request, {@link NexusClient.lastRateLimit} reflects the rate-limit
 * headers from that response.
 */
export class NexusClient {
  /** Most recent rate-limit window state, refreshed on every request. */
  lastRateLimit: RateLimit = {
    dailyRemaining: null,
    hourlyRemaining: null,
    dailyReset: null,
    hourlyReset: null,
  };

  private readonly apiKey: string;
  private readonly appVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NexusClientOptions) {
    this.apiKey = options.apiKey;
    this.appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Validate the API key and return the associated account details. */
  async validate(): Promise<ValidateResult> {
    return this.request<ValidateResult>('/users/validate.json');
  }

  /** Fetch metadata for a single mod. */
  async getModInfo(domain: string, modId: number): Promise<NexusModInfo> {
    return this.request<NexusModInfo>(`/games/${domain}/mods/${modId}.json`);
  }

  /** List the files (and file updates) uploaded for a mod. */
  async getModFiles(domain: string, modId: number): Promise<ModFilesResult> {
    return this.request<ModFilesResult>(`/games/${domain}/mods/${modId}/files.json`);
  }

  /**
   * Choose the file a user most likely wants to download: the flagged primary,
   * else a `MAIN`-category file, else the most recently uploaded.
   */
  pickPrimaryFile(files: FileInfo[]): FileInfo | undefined {
    if (files.length === 0) return undefined;
    const primary = files.find((f) => f.is_primary);
    if (primary) return primary;
    const main = files.find((f) => f.category_name === 'MAIN');
    if (main) return main;
    return files.reduce((newest, f) =>
      f.uploaded_timestamp > newest.uploaded_timestamp ? f : newest,
    );
  }

  /**
   * Resolve CDN download mirrors for a file.
   *
   * Premium accounts can request a direct link with no query params. Everyone
   * else must pass the `key` + `expires` grant carried by an `nxm://` deep link
   * ({@link NxmGrant}). When no grant is supplied and the account is not
   * Premium, the API answers 403 — surfaced here as a {@link NexusError} with
   * status 403 and a hint to use the nxm flow.
   */
  async getDownloadLink(
    domain: string,
    modId: number,
    fileId: number,
    nxm?: NxmGrant,
  ): Promise<DownloadLink[]> {
    const path = `/games/${domain}/mods/${modId}/files/${fileId}/download_link.json`;
    const query = nxm ? { key: nxm.key, expires: String(nxm.expires) } : undefined;
    try {
      return await this.request<DownloadLink[]>(path, query);
    } catch (err) {
      if (err instanceof NexusError && err.status === 403 && !nxm) {
        throw new NexusError(
          403,
          'Direct download requires a Premium account. Use the "Mod Manager Download" button on Nexus Mods to obtain an nxm:// link, then pass its key/expires grant.',
        );
      }
      throw err;
    }
  }

  /**
   * Issue a GET against the API: build auth + identification headers, parse the
   * rate-limit headers into {@link NexusClient.lastRateLimit}, map error
   * statuses to {@link NexusError}, and return the parsed JSON body.
   */
  private async request<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(BASE_URL + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }

    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        apikey: this.apiKey,
        Accept: 'application/json',
        'Application-Name': 'open-nova',
        'Application-Version': this.appVersion,
        'User-Agent': `open-nova/${this.appVersion} (${os.platform()})`,
      },
    });

    this.parseRateLimit(res);

    if (!res.ok) {
      if (res.status === 401) throw new NexusError(401, 'Invalid or expired Nexus API key.');
      if (res.status === 429) throw new NexusError(429, 'Rate-limited by the Nexus API.');
      throw new NexusError(res.status, `Nexus API error (HTTP ${res.status}).`);
    }

    return (await res.json()) as T;
  }

  /** Parse the `x-rl-*` headers from a response into {@link NexusClient.lastRateLimit}. */
  private parseRateLimit(res: Response): void {
    const num = (name: string): number | null => {
      const v = res.headers.get(name);
      return v === null || v === '' ? null : Number(v);
    };
    const str = (name: string): string | null => res.headers.get(name);

    this.lastRateLimit = {
      dailyRemaining: num('x-rl-daily-remaining'),
      hourlyRemaining: num('x-rl-hourly-remaining'),
      dailyReset: str('x-rl-daily-reset'),
      hourlyReset: str('x-rl-hourly-reset'),
    };
  }
}
