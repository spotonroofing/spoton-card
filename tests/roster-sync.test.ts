import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncFromCore,
  RosterConfigError,
  type RosterDb,
  type CoreRosterEntry,
} from '../src/lib/roster-sync';

// Every person here is fictional (example.com, 555 numbers).

interface FakeRep {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  slug: string;
  jobTitle: string;
  phone: string;
  role: string;
  isActive: boolean;
}

function makeFakeDb(seed: Partial<FakeRep>[] = [], seedUsers: string[] = [], seedTokens: string[] = []) {
  let nextId = 1;
  const reps: FakeRep[] = seed.map((r) => ({
    id: r.id ?? `seed-${nextId++}`,
    email: r.email ?? '',
    firstName: r.firstName ?? '',
    lastName: r.lastName ?? '',
    slug: r.slug ?? '',
    jobTitle: r.jobTitle ?? '',
    phone: r.phone ?? '',
    role: r.role ?? 'rep',
    isActive: r.isActive ?? true,
  }));
  const users = new Set(seedUsers);
  const tokens = new Set(seedTokens);
  const userUpserts: { email: string; name: string }[] = [];
  const createdData: Record<string, unknown>[] = [];

  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const db: RosterDb = {
    rep: {
      async findFirst(args: any) {
        const w = args.where;
        if (w.email) return reps.find((r) => eq(r.email, w.email.equals)) ?? null;
        return (
          reps.find(
            (r) => eq(r.firstName, w.firstName.equals) && eq(r.lastName, w.lastName.equals)
          ) ?? null
        );
      },
      async findUnique(args: any) {
        if (args.where.slug) return reps.find((r) => r.slug === args.where.slug) ?? null;
        return reps.find((r) => r.id === args.where.id) ?? null;
      },
      async create(args: any) {
        createdData.push(args.data);
        const rep = { id: `new-${nextId++}`, ...args.data } as FakeRep;
        reps.push(rep);
        return rep;
      },
      async update(args: any) {
        const rep = reps.find((r) => r.id === args.where.id)!;
        Object.assign(rep, args.data);
        return rep;
      },
      async delete(args: any) {
        const i = reps.findIndex((r) => r.id === args.where.id);
        reps.splice(i, 1);
        return {};
      },
    },
    user: {
      async upsert(args: any) {
        userUpserts.push({ email: args.where.email, name: args.create.name });
        users.add(args.where.email);
        return {};
      },
      async deleteMany(args: any) {
        for (const e of args.where.email.in) users.delete(e);
        return {};
      },
    },
    verificationToken: {
      async deleteMany(args: any) {
        for (const e of args.where.identifier.in) tokens.delete(e);
        return {};
      },
    },
  };

  return { db, reps, users, tokens, userUpserts, createdData };
}

function coreEntry(overrides: Partial<CoreRosterEntry>): CoreRosterEntry {
  return {
    email: null,
    name: null,
    active: true,
    phone: null,
    firstName: null,
    lastName: null,
    roleLabel: 'Rep',
    workEmail: null,
    personalEmail: null,
    status: 'active',
    ...overrides,
  };
}

const realFetch = global.fetch;
let fetchCalls: { url: string; headers: Record<string, string> }[] = [];

function stubCoreApi(entries: CoreRosterEntry[]) {
  fetchCalls = [];
  global.fetch = (async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), headers: init?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ entries, total: entries.length, page: 1, perPage: 200 }),
      text: async () => '',
    };
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.SPOTON_ROSTER_URL = 'https://core.example/api/roster';
  process.env.SPOTON_ROSTER_KEY = 'test-key';
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SPOTON_ROSTER_URL;
  delete process.env.SPOTON_ROSTER_KEY;
});

test('sync throws RosterConfigError when env vars are missing', async () => {
  delete process.env.SPOTON_ROSTER_URL;
  const { db } = makeFakeDb();
  await assert.rejects(() => syncFromCore(db), RosterConfigError);
});

test('current roster members are created with the established Rep shape', async () => {
  stubCoreApi([
    coreEntry({
      firstName: 'Sam',
      lastName: 'Rivera',
      roleLabel: 'Exterior Specialist',
      phone: '6145550101',
      workEmail: 'sam@example.com',
      personalEmail: 'sam.personal@example.com',
      email: 'sam@example.com',
    }),
  ]);
  const { db, createdData, userUpserts } = makeFakeDb();
  const result = await syncFromCore(db);

  assert.equal(result.created, 1);
  assert.deepEqual(createdData[0], {
    firstName: 'Sam',
    lastName: 'Rivera',
    email: 'sam@example.com',
    slug: 'sam-rivera',
    jobTitle: 'Exterior Specialist',
    phone: '6145550101',
    role: 'rep',
    isActive: true,
  });
  assert.deepEqual(userUpserts[0], { email: 'sam@example.com', name: 'Sam Rivera' });
  assert.equal(fetchCalls[0].headers['x-spoton-key'], 'test-key');
  assert.ok(fetchCalls[0].url.startsWith('https://core.example/api/roster?page=1'));
});

test('an ADMIN_EMAILS address gets the admin role', async () => {
  stubCoreApi([coreEntry({ firstName: 'Pat', lastName: 'Owner', roleLabel: 'Management', workEmail: 'jarrod@spotonroof.com' })]);
  const { db, createdData } = makeFakeDb();
  await syncFromCore(db);
  assert.equal(createdData[0].role, 'admin');
});

test('a combined name is split when first/last are missing', async () => {
  stubCoreApi([coreEntry({ name: 'Mary Jo Example', workEmail: 'maryjo@example.com' })]);
  const { db, createdData } = makeFakeDb();
  await syncFromCore(db);
  assert.equal(createdData[0].firstName, 'Mary');
  assert.equal(createdData[0].lastName, 'Jo Example');
});

test('active entries with no roster seat (system accounts) are skipped', async () => {
  stubCoreApi([coreEntry({ name: 'Help desk check (automated)', roleLabel: null, email: 'check@example.com' })]);
  const { db, createdData } = makeFakeDb();
  const result = await syncFromCore(db);
  assert.equal(createdData.length, 0);
  assert.equal(result.skipped, 1);
});

test('someone Core marks inactive is removed: card, login and pending sign-in tokens', async () => {
  const { db, reps, users, tokens } = makeFakeDb(
    [{ id: 'quit', email: 'quit@example.com', firstName: 'Quinn', lastName: 'Left', slug: 'quinn-left', phone: '6145550102' }],
    ['quit@example.com', 'quinn.home@example.com'],
    ['quit@example.com']
  );
  stubCoreApi([
    coreEntry({
      firstName: 'Quinn',
      lastName: 'Left',
      workEmail: 'quit@example.com',
      personalEmail: 'quinn.home@example.com',
      active: false,
      status: 'inactive',
    }),
  ]);
  const result = await syncFromCore(db);
  assert.equal(result.removed, 1);
  assert.equal(reps.length, 0);
  assert.equal(users.size, 0);
  assert.equal(tokens.size, 0);
});

test('admins are removed too when Core marks them inactive', async () => {
  const { db, reps } = makeFakeDb([
    { id: 'adm', email: 'jarrod@spotonroof.com', firstName: 'Pat', lastName: 'Owner', slug: 'pat-owner', role: 'admin' },
  ]);
  stubCoreApi([
    coreEntry({ firstName: 'Pat', lastName: 'Owner', workEmail: 'jarrod@spotonroof.com', active: false, status: 'inactive' }),
  ]);
  const result = await syncFromCore(db);
  assert.equal(result.removed, 1);
  assert.equal(reps.length, 0);
});

test('absence from the Core response never removes anyone', async () => {
  const { db, reps } = makeFakeDb([
    { id: 'absent', email: 'absent@example.com', firstName: 'Abby', lastName: 'Absent', slug: 'abby-absent' },
  ]);
  stubCoreApi([]);
  const result = await syncFromCore(db);
  assert.equal(result.removed, 0);
  assert.equal(reps.length, 1);
});

test('a former Core row never removes someone who is also a current member (rehire)', async () => {
  const { db, reps, users } = makeFakeDb(
    [{ id: 'back', email: 'back@example.com', firstName: 'Robin', lastName: 'Back', slug: 'robin-back' }],
    ['back@example.com']
  );
  stubCoreApi([
    coreEntry({ firstName: 'Robin', lastName: 'Back', workEmail: 'back@example.com', active: false, status: 'inactive' }),
    coreEntry({ firstName: 'Robin', lastName: 'Back', workEmail: 'back@example.com' }),
  ]);
  const result = await syncFromCore(db);
  assert.equal(result.removed, 0);
  assert.equal(reps.length, 1);
  assert.ok(users.has('back@example.com'));
});

test('phone is left untouched when Core has no value', async () => {
  const { db, reps } = makeFakeDb([
    { id: 'r1', email: 'lee@example.com', firstName: 'Lee', lastName: 'Example', slug: 'lee-example', jobTitle: 'Old', phone: '614-555-9999' },
  ]);
  stubCoreApi([coreEntry({ firstName: 'Lee', lastName: 'Example', workEmail: 'lee@example.com', roleLabel: 'Team Lead', phone: null })]);
  const result = await syncFromCore(db);
  assert.equal(result.updated, 1);
  const rep = reps.find((r) => r.id === 'r1')!;
  assert.equal(rep.jobTitle, 'Team Lead');
  assert.equal(rep.phone, '614-555-9999');
});

test('an existing inactive rep is updated and reactivated when Core says active', async () => {
  const { db, reps } = makeFakeDb([
    { id: 'r1', email: 'sam@example.com', firstName: 'Sam', lastName: 'Rivera', slug: 'sam-rivera', jobTitle: 'Old Title', isActive: false },
  ]);
  stubCoreApi([
    coreEntry({ firstName: 'Sam', lastName: 'Rivera', roleLabel: 'Exterior Specialist', phone: '6145550101', workEmail: 'sam@example.com' }),
  ]);
  const result = await syncFromCore(db);
  assert.equal(result.updated, 1);
  const rep = reps.find((r) => r.id === 'r1')!;
  assert.equal(rep.jobTitle, 'Exterior Specialist');
  assert.equal(rep.phone, '6145550101');
  assert.equal(rep.isActive, true);
});
