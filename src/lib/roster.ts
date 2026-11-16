// The live SpotOn roster, read from SpotOn Core's keyed roster API. This app stores, shows
// and emails only people on it; nothing here keeps a hand-made list of people.

import { CLAIMS_CONTACT } from './claims-contact';

/** One roster row as SpotOn Core's keyed API serves it (dates arrive as JSON strings). */
export interface CoreRosterEntry {
  email: string | null;
  name: string | null;
  active: boolean;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  roleLabel: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  status: string;
}

/** Missing roster configuration: the sync route returns its message as a 500. */
export class RosterConfigError extends Error {}

/** Fetch every roster row (active and former) from Core. Throws when Core can't be read. */
export async function fetchCoreRoster(): Promise<CoreRosterEntry[]> {
  const baseUrl = process.env.SPOTON_ROSTER_URL;
  const apiKey = process.env.SPOTON_ROSTER_KEY;
  if (!baseUrl || !apiKey) {
    throw new RosterConfigError(
      'Missing SpotOn Core environment variables (SPOTON_ROSTER_URL, SPOTON_ROSTER_KEY)'
    );
  }

  const entries: CoreRosterEntry[] = [];
  const perPage = 200;
  for (let page = 1; ; page++) {
    const res = await fetch(`${baseUrl}?page=${page}&perPage=${perPage}`, {
      headers: { 'x-spoton-key': apiKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Core roster API responded ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { entries: CoreRosterEntry[]; total: number };
    entries.push(...body.entries);
    if (entries.length >= body.total || body.entries.length === 0) break;
  }
  return entries;
}

/** A current team member: active in Core and holding a seat (system accounts have no role). */
export function isCurrentMember(entry: CoreRosterEntry): boolean {
  return entry.active && !!(entry.roleLabel || '').trim();
}

export interface PersonRef {
  email: string;
  firstName?: string;
  lastName?: string;
}

function fullName(entry: CoreRosterEntry): string {
  const parts = [entry.firstName, entry.lastName].filter(Boolean).join(' ');
  return (parts || entry.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Is this person a current member of the given roster? Matches any roster email, then full name. */
export function isOnRoster(entries: CoreRosterEntry[], person: PersonRef): boolean {
  const email = person.email.trim().toLowerCase();
  const name = [person.firstName, person.lastName]
    .filter(Boolean)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return entries.some((entry) => {
    if (!isCurrentMember(entry)) return false;
    const emails = [entry.workEmail, entry.personalEmail, entry.email]
      .filter((e): e is string => !!e)
      .map((e) => e.trim().toLowerCase());
    if (email && emails.includes(email)) return true;
    return !!name && fullName(entry) === name;
  });
}

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; entries: CoreRosterEntry[] } | null = null;

/** Clears the in-memory roster cache (tests). */
export function resetLiveRosterCache(): void {
  cache = null;
}

/**
 * Is this person on the live roster right now? Cached for 5 minutes. Returns null only when
 * Core has never been readable in this process, so the caller decides how to fail.
 */
export async function isOnLiveRoster(person: PersonRef): Promise<boolean | null> {
  if (!cache || Date.now() - cache.at >= CACHE_MS) {
    try {
      cache = { at: Date.now(), entries: await fetchCoreRoster() };
    } catch (err) {
      console.error(
        `[roster] live roster unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
      if (!cache) return null;
    }
  }
  return isOnRoster(cache.entries, person);
}

/**
 * May this stored rep be shown to customers? Only while active here and on the live roster.
 * If Core can't be read, the last synced active flag decides.
 */
export async function isRepLive(rep: {
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}): Promise<boolean> {
  if (!rep.isActive) return false;
  return (await isOnLiveRoster(rep)) !== false;
}

/** The shared claims contact is offered to customers only while that person is on the roster. */
export async function isClaimsContactLive(): Promise<boolean> {
  return (await isOnLiveRoster(CLAIMS_CONTACT)) !== false;
}
