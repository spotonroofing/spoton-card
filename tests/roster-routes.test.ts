// Route checks for who the roster lets through. Run with --experimental-test-module-mocks.
import { test, mock, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoreRosterEntry } from '../src/lib/roster';

// Every person here is fictional (example.com), except the claims contact address the
// claims route checks for, which is read from the real module.

const src = (p: string) => pathToFileURL(path.join(process.cwd(), 'src', p)).href;

type Session = { user: { repId: string; email?: string } } | null;
let session: Session = null;
const reps: any[] = [];
const created: any[] = [];

const prisma = {
  rep: {
    findUnique: async ({ where }: any) =>
      reps.find((r) => (where.id ? r.id === where.id : where.slug ? r.slug === where.slug : r.email === where.email)) ?? null,
    create: async ({ data }: any) => {
      const rep = { id: `new-${created.length}`, ...data };
      created.push(rep);
      return rep;
    },
  },
  user: { upsert: async () => ({}) },
  companySettings: { findFirst: async () => ({ inviteCode: 'INVITE', companyName: 'SpotOnRoof', companyAddress: '', companyWebsite: '' }) },
};

mock.module(src('lib/auth.ts'), { namedExports: { auth: async () => session } });
mock.module(src('lib/prisma.ts'), { namedExports: { prisma } });
mock.module(src('lib/utils.ts'), { namedExports: { generateSlug: async (f: string, l: string) => `${f}-${l}`.toLowerCase() } });

const ADMIN = { id: 'adm', email: 'owner@example.com', firstName: 'Pat', lastName: 'Owner', slug: 'pat-owner', role: 'admin', isActive: true, jobTitle: '', phone: '' };
const REP = { id: 'rep', email: 'sam@example.com', firstName: 'Sam', lastName: 'Rivera', slug: 'sam-rivera', role: 'rep', isActive: true, jobTitle: 'Rep', phone: '6145550101', profilePhoto: null };
const GONE = { id: 'gone', email: 'quit@example.com', firstName: 'Quinn', lastName: 'Left', slug: 'quinn-left', role: 'rep', isActive: true, jobTitle: 'Rep', phone: '6145550102', profilePhoto: null };

const entry = (o: Partial<CoreRosterEntry>): CoreRosterEntry => ({
  email: null, name: null, active: true, phone: null, firstName: null, lastName: null,
  roleLabel: 'Rep', workEmail: null, personalEmail: null, status: 'active', ...o,
});
let roster: CoreRosterEntry[] = [];
const realFetch = global.fetch;

let routes: any;
let resetLiveRosterCache: () => void;
before(async () => {
  ({ resetLiveRosterCache } = await import('../src/lib/roster'));
  routes = {
    sync: await import('../src/app/api/admin/sync-roster/route'),
    register: await import('../src/app/api/register/route'),
    adminReps: await import('../src/app/api/admin/reps/route'),
    vcard: await import('../src/app/api/vcard/[slug]/route'),
    claims: await import('../src/app/api/vcard/claims/route'),
  };
});

beforeEach(() => {
  process.env.SPOTON_ROSTER_URL = 'https://core.example/api/roster';
  process.env.SPOTON_ROSTER_KEY = 'test-key';
  resetLiveRosterCache();
  session = null;
  reps.splice(0, reps.length, ADMIN, REP, GONE);
  created.length = 0;
  roster = [
    entry({ firstName: 'Pat', lastName: 'Owner', workEmail: 'owner@example.com' }),
    entry({ firstName: 'Sam', lastName: 'Rivera', workEmail: 'sam@example.com' }),
    entry({ firstName: 'Quinn', lastName: 'Left', workEmail: 'quit@example.com', active: false, status: 'inactive' }),
    entry({ firstName: 'Nia', lastName: 'New', workEmail: 'nia@example.com' }),
  ];
  global.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ entries: roster, total: roster.length }), text: async () => '' })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

const post = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as any;

test('sync-roster refuses a signed-out caller', async () => {
  const res = await routes.sync.POST();
  assert.equal(res.status, 403);
});

test('sync-roster refuses a signed-in rep (not admin)', async () => {
  session = { user: { repId: 'rep' } };
  const res = await routes.sync.POST();
  assert.equal(res.status, 403);
});

test('register refuses an email that is not on the live roster', async () => {
  const res = await routes.register.POST(post({ firstName: 'Quinn', lastName: 'Left', email: 'quit@example.com', inviteCode: 'INVITE' }));
  assert.equal(res.status, 403);
  assert.equal(created.length, 0);
});

test('register lets a current roster member create a card', async () => {
  const res = await routes.register.POST(post({ firstName: 'Nia', lastName: 'New', email: 'nia@example.com', inviteCode: 'INVITE' }));
  assert.equal(res.status, 200);
  assert.equal(created.length, 1);
});

test('admin create refuses a signed-out caller', async () => {
  const res = await routes.adminReps.POST(post({ firstName: 'Nia', lastName: 'New', email: 'nia@example.com' }));
  assert.equal(res.status, 403);
});

test('admin create refuses a person who is not on the live roster', async () => {
  session = { user: { repId: 'adm' } };
  const res = await routes.adminReps.POST(post({ firstName: 'Quinn', lastName: 'Left', email: 'quit@example.com' }));
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

test('vCard is refused for a stored rep who has left the roster', async () => {
  const res = await routes.vcard.GET(new Request('http://x') as any, { params: Promise.resolve({ slug: 'quinn-left' }) });
  assert.equal(res.status, 404);
});

test('vCard is served for a current roster member', async () => {
  const res = await routes.vcard.GET(new Request('http://x') as any, { params: Promise.resolve({ slug: 'sam-rivera' }) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /FN:Sam Rivera/);
});

test('claims vCard is refused when the claims contact is not on the live roster', async () => {
  const res = await routes.claims.GET();
  assert.equal(res.status, 404);
});
