/**
 * Tiny dependency-free INI parser/writer that reproduces the byte-level quirks
 * of the `modconfig.ini` format (the Win32 profile-string layout: `[Section]`
 * headers with `Key= value` entries).
 *
 * Quirks faithfully replicated for interop:
 *  - Section and key names are CASE-SENSITIVE (a lookup for `Name` will not
 *    match `name`). This matters because the manifest uses the deliberately
 *    MISSPELLED section `NovaChysaliaConfig`, which must be preserved verbatim.
 *  - On write, EVERY value is emitted with a LEADING SPACE after the `=`
 *    (i.e. `Key= value`). On read, that single leading space is tolerated and
 *    stripped so callers see the logical value.
 *  - Boolean semantics: a missing or empty value is `false`; otherwise the
 *    value is parsed as `true`/`false` case-insensitively (anything that is not
 *    a case-insensitive `true` is treated as `false`).
 */
import { promises as fs } from 'node:fs';

/** A parsed INI document: ordered sections, each an ordered map of key→value. */
export type IniData = Record<string, Record<string, string>>;

/**
 * Parse INI text into a nested object `{ [section]: { [key]: value } }`.
 *
 * Section/key names are kept exactly as written (case-sensitive). A single
 * leading space after the `=` is stripped from each value (the format always
 * writes one); any further whitespace is preserved. Lines before the first
 * `[Section]` header are ignored, matching the Win32 profile API behaviour.
 * Blank lines and `;`/`#` comment lines are skipped.
 */
export function parseIni(text: string): IniData {
  const out: IniData = {};
  let current: string | null = null;

  // Split on any newline style; do not trim full lines (we strip selectively).
  const lines = text.split(/\r\n|\r|\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (line === '') continue;
    if (line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close > 0) {
        current = line.slice(1, close); // verbatim, case-sensitive
        if (!(current in out)) out[current] = {};
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue; // not a key=value line; ignore
    if (current === null) continue; // values before any section are dropped

    const key = line.slice(0, eq); // case-sensitive, keep as-is (no trim of name)
    let value = line.slice(eq + 1);
    // Tolerate the format's single leading space after '='.
    if (value.startsWith(' ')) value = value.slice(1);
    out[current][key] = value;
  }

  return out;
}

/**
 * Serialize a nested object back to INI text. Sections are written in insertion
 * order; within a section, keys are written in insertion order. Every value is
 * emitted as `Key= value` (note the LEADING SPACE) as the format requires.
 * Sections are separated by a blank line.
 */
export function stringifyIni(data: IniData): string {
  const parts: string[] = [];
  for (const section of Object.keys(data)) {
    parts.push(`[${section}]`);
    const keys = data[section];
    for (const key of Object.keys(keys)) {
      parts.push(`${key}= ${keys[key]}`);
    }
    parts.push(''); // blank line between sections
  }
  return parts.join('\r\n');
}

/**
 * Interpret an INI value as a boolean: `undefined`/empty → `false`; otherwise
 * `true` only when the value is a case-insensitive `"true"`, else `false`.
 */
export function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  if (v === '') return false;
  return v.toLowerCase() === 'true';
}

/**
 * In-memory, case-sensitive INI document with byte-compatible read/write
 * semantics, plus file helpers. Wraps {@link parseIni}/{@link stringifyIni}.
 */
export class Ini {
  /** The backing nested data; mutate via the accessors to preserve ordering. */
  readonly data: IniData;

  constructor(data: IniData = {}) {
    this.data = data;
  }

  /** Build an Ini from raw INI text. */
  static parse(text: string): Ini {
    return new Ini(parseIni(text));
  }

  /** Read an INI file from disk (UTF-8) and parse it. */
  static async readFile(filePath: string): Promise<Ini> {
    const text = await fs.readFile(filePath, 'utf8');
    return Ini.parse(text);
  }

  /**
   * Get a string value, or `undefined` if the section/key is absent. The lookup
   * is case-sensitive.
   */
  get(section: string, key: string): string | undefined {
    return this.data[section]?.[key];
  }

  /**
   * Get a string value with a fallback used when the section/key is absent.
   */
  getOr(section: string, key: string, fallback: string): string {
    const v = this.get(section, key);
    return v === undefined ? fallback : v;
  }

  /** Get a value as a boolean using {@link parseBool} semantics. */
  getBool(section: string, key: string): boolean {
    return parseBool(this.get(section, key));
  }

  /**
   * Set a string value, creating the section if needed. Insertion order of new
   * sections/keys is preserved for stable, byte-compatible output.
   */
  set(section: string, key: string, value: string): this {
    if (!(section in this.data)) this.data[section] = {};
    this.data[section][key] = value;
    return this;
  }

  /** Set a boolean value, written as the lowercase literal `true`/`false`. */
  setBool(section: string, key: string, value: boolean): this {
    return this.set(section, key, value ? 'true' : 'false');
  }

  /** True if the section exists. */
  hasSection(section: string): boolean {
    return section in this.data;
  }

  /** Serialize to INI text (every value gets the leading-space quirk). */
  stringify(): string {
    return stringifyIni(this.data);
  }

  /** Write the document to disk as UTF-8 INI text. */
  async writeFile(filePath: string): Promise<void> {
    await fs.writeFile(filePath, this.stringify(), 'utf8');
  }
}
