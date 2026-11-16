import { fetchCoreRoster, isCurrentMember, isOnRoster, type CoreRosterEntry } from './roster';

export { RosterConfigError, type CoreRosterEntry } from './roster';

/** Roster emails that get the admin role. Grants a role only; removal still follows the roster. */
export const ADMIN_EMAILS = [
  'brack@spotonroof.com',
  'jarrod@spotonroof.com',
  'admin@spotonroof.com',
];

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: string[];
}

interface RepRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

/** The subset of the Prisma client the sync writes through (injected for tests). */
export interface RosterDb {
  rep: {
    findFirst(args: unknown): Promise<RepRow | null>;
    findUnique(args: unknown): Promise<RepRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<RepRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<RepRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  user: {
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: { where: { email: { in: string[] } } }): Promise<unknown>;
  };
  verificationToken: {
    deleteMany(args: { where: { identifier: { in: string[] } } }): Promise<unknown>;
  };
}

function generateSlugFromName(firstName: string, lastName: string): string {
  return `${firstName}-${lastName}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

export function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
  if (!isAllCaps) return trimmed;
  return trimmed
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || part === '-') return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

interface RosterPerson {
  firstName: string;
  lastName: string;
  email: string;
  /** undefined = leave the existing value untouched (Core has no value). */
  phone: string | undefined;
  jobTitle: string | undefined;
}

/**
 * Rep upsert for one current roster member: match by email then by name, update or create
 * (skipping slug collisions), and mirror into the User table for magic-link login.
 */
async function syncPerson(db: RosterDb, person: RosterPerson, result: SyncResult): Promise<void> {
  const { firstName, lastName, email, phone, jobTitle } = person;
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'rep';
  const slug = generateSlugFromName(firstName, lastName);

  try {
    let existing = await db.rep.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    let matchedBy: 'email' | 'name' | null = existing ? 'email' : null;

    if (!existing) {
      existing = await db.rep.findFirst({
        where: {
          firstName: { equals: firstName, mode: 'insensitive' },
          lastName: { equals: lastName, mode: 'insensitive' },
        },
      });
      if (existing) matchedBy = 'name';
    }

    if (existing) {
      await db.rep.update({
        where: { id: existing.id },
        data: {
          firstName,
          lastName,
          email,
          ...(jobTitle !== undefined ? { jobTitle } : {}),
          ...(phone !== undefined ? { phone } : {}),
          role,
          isActive: true,
        },
      });
      console.log(
        `[sync-roster] UPDATE ${firstName} ${lastName} <${email}> from Core (matched by ${matchedBy}, existing id=${existing.id}, existing email=${existing.email})`
      );
      result.updated++;
    } else {
      const slugOwner = await db.rep.findUnique({ where: { slug } });
      if (slugOwner) {
        const warning = `Slug "${slug}" already belongs to ${slugOwner.firstName} ${slugOwner.lastName} <${slugOwner.email}> (id=${slugOwner.id}). Skipping ${firstName} ${lastName} <${email}> from Core.`;
        console.warn(`[sync-roster] SKIP ${warning}`);
        result.errors.push(warning);
        result.skipped++;
        return;
      }

      const createdRep = await db.rep.create({
        data: {
          firstName,
          lastName,
          email,
          slug,
          jobTitle: jobTitle ?? '',
          phone: phone ?? '',
          role,
          isActive: true,
        },
      });
      console.log(
        `[sync-roster] CREATE ${firstName} ${lastName} <${email}> from Core (id=${createdRep.id}, slug=${slug})`
      );
      result.created++;
    }

    await db.user.upsert({
      where: { email },
      update: { name: `${firstName} ${lastName}` },
      create: { email, name: `${firstName} ${lastName}` },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync-roster] ERROR Core entry (${email}): ${message}`);
    result.errors.push(`Core entry (${email}): ${message}`);
  }
}

/**
 * Someone who left: delete their card (analytics cascade) and every login record under
 * any of their emails, so nothing here can show them or email them.
 */
async function removePerson(
  db: RosterDb,
  roster: CoreRosterEntry[],
  firstName: string,
  lastName: string,
  emails: string[],
  result: SyncResult
): Promise<void> {
  let existing: RepRow | null = null;
  for (const email of emails) {
    existing = await db.rep.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) break;
  }
  if (!existing) {
    existing = await db.rep.findFirst({
      where: {
        firstName: { equals: firstName, mode: 'insensitive' },
        lastName: { equals: lastName, mode: 'insensitive' },
      },
    });
  }

  // A former row never removes someone who is also a current member (rehire, shared name).
  if (existing && isOnRoster(roster, existing)) return;
  if (isOnRoster(roster, { email: '', firstName, lastName })) return;

  const allEmails = Array.from(new Set([...emails, ...(existing ? [existing.email.toLowerCase()] : [])]))
    .filter((e) => !isOnRoster(roster, { email: e }));
  try {
    if (existing) {
      await db.rep.delete({ where: { id: existing.id } });
      console.log(`[sync-roster] REMOVE ${firstName} ${lastName} (id=${existing.id}, Core active=false)`);
      result.removed++;
    }
    await db.user.deleteMany({ where: { email: { in: allEmails } } });
    await db.verificationToken.deleteMany({ where: { identifier: { in: allEmails } } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync-roster] ERROR removing ${firstName} ${lastName}: ${message}`);
    result.errors.push(`Remove ${firstName} ${lastName}: ${message}`);
  }
}

/**
 * Sync from SpotOn Core's live roster: current members are upserted into Rep; anyone Core
 * marks inactive is removed. Removal follows each row's `active` flag, never absence from
 * the response, so a short or failed response can't wipe current people.
 */
export async function syncFromCore(db: RosterDb): Promise<SyncResult> {
  const entries: CoreRosterEntry[] = await fetchCoreRoster();
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, removed: 0, errors: [] };

  console.log(`[sync-roster] Starting Core sync: ${entries.length} roster entries`);

  for (const entry of entries) {
    let firstName = normalizeName(entry.firstName || '');
    let lastName = normalizeName(entry.lastName || '');
    if ((!firstName || !lastName) && entry.name) {
      const parts = entry.name.trim().split(/\s+/);
      firstName = firstName || normalizeName(parts[0] || '');
      lastName = lastName || normalizeName(parts.slice(1).join(' '));
    }

    const emails = [entry.workEmail, entry.personalEmail, entry.email]
      .map((e) => (e || '').trim().toLowerCase())
      .filter((e, i, all) => e && all.indexOf(e) === i);

    if (!entry.active) {
      if (firstName && lastName) await removePerson(db, entries, firstName, lastName, emails, result);
      continue;
    }

    if (!firstName || !lastName) continue;

    if (!isCurrentMember(entry)) {
      console.log(`[sync-roster] SKIP Core entry: ${firstName} ${lastName} (no roster seat)`);
      result.skipped++;
      continue;
    }

    const email = emails[0];
    if (!email) {
      console.log(`[sync-roster] SKIP Core entry: ${firstName} ${lastName} (no email)`);
      result.skipped++;
      continue;
    }

    await syncPerson(
      db,
      {
        firstName,
        lastName,
        email,
        phone: (entry.phone || '').trim() || undefined,
        jobTitle: (entry.roleLabel || '').trim() || undefined,
      },
      result
    );
  }

  console.log(
    `[sync-roster] Done. created=${result.created}, updated=${result.updated}, skipped=${result.skipped}, removed=${result.removed}, errors=${result.errors.length}`
  );

  return result;
}
