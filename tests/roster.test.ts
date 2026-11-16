import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOnRoster,
  isOnLiveRoster,
  isRepLive,
  resetLiveRosterCache,
  type CoreRosterEntry,
} from '../src/lib/roster';

// Every person here is fictional (example.com).

function entry(overrides: Partial<CoreRosterEntry>): CoreRosterEntry {
  return {
    email: null, name: null, active: true, phone: null, firstName: null, lastName: null,
    roleLabel: 'Rep', workEmail: null, personalEmail: null, status: 'active', ...overrides,
  };
}

const ROSTER = [
  entry({ firstName: 'Sam', lastName: 'Rivera', workEmail: 'sam@example.com', personalEmail: 'sam.home@example.com' }),
  entry({ name: 'Kai Name Only', personalEmail: 'kai@example.com' }),
  entry({ firstName: 'Quinn', lastName: 'Left', workEmail: 'quit@example.com', active: false, status: 'inactive' }),
  entry({ name: 'Help desk check (automated)', roleLabel: null, email: 'check@example.com' }),
];

test('isOnRoster matches any roster email, case-insensitively', () => {
  assert.equal(isOnRoster(ROSTER, { email: 'SAM.HOME@example.com' }), true);
  assert.equal(isOnRoster(ROSTER, { email: 'kai@example.com' }), true);
});

test('isOnRoster falls back to the full name', () => {
  assert.equal(isOnRoster(ROSTER, { email: 'old@example.com', firstName: 'Sam', lastName: 'Rivera' }), true);
  assert.equal(isOnRoster(ROSTER, { email: 'x@example.com', firstName: 'Kai', lastName: 'Name Only' }), true);
});

test('isOnRoster refuses former people, seatless system accounts and strangers', () => {
  assert.equal(isOnRoster(ROSTER, { email: 'quit@example.com', firstName: 'Quinn', lastName: 'Left' }), false);
  assert.equal(isOnRoster(ROSTER, { email: 'check@example.com' }), false);
  assert.equal(isOnRoster(ROSTER, { email: 'nobody@example.com', firstName: 'No', lastName: 'Body' }), false);
});

const realFetch = global.fetch;
let calls = 0;
let fail = false;

beforeEach(() => {
  process.env.SPOTON_ROSTER_URL = 'https://core.example/api/roster';
  process.env.SPOTON_ROSTER_KEY = 'test-key';
  resetLiveRosterCache();
  calls = 0;
  fail = false;
  global.fetch = (async () => {
    calls++;
    if (fail) throw new Error('down');
    return { ok: true, status: 200, json: async () => ({ entries: ROSTER, total: ROSTER.length }), text: async () => '' };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SPOTON_ROSTER_URL;
  delete process.env.SPOTON_ROSTER_KEY;
});

test('isOnLiveRoster reads Core once and caches the roster', async () => {
  assert.equal(await isOnLiveRoster({ email: 'sam@example.com' }), true);
  assert.equal(await isOnLiveRoster({ email: 'quit@example.com' }), false);
  assert.equal(calls, 1);
});

test('isOnLiveRoster returns null when Core has never been readable', async () => {
  fail = true;
  assert.equal(await isOnLiveRoster({ email: 'sam@example.com' }), null);
});

test('isRepLive: inactive or off-roster reps are never shown; Core down falls back to the active flag', async () => {
  const sam = { email: 'sam@example.com', firstName: 'Sam', lastName: 'Rivera', isActive: true };
  const quinn = { email: 'quit@example.com', firstName: 'Quinn', lastName: 'Left', isActive: true };
  assert.equal(await isRepLive(sam), true);
  assert.equal(await isRepLive(quinn), false);
  assert.equal(await isRepLive({ ...sam, isActive: false }), false);
  resetLiveRosterCache();
  fail = true;
  assert.equal(await isRepLive(sam), true);
});
