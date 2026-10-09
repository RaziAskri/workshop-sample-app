import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConflictError,
  createBooking,
  findConflicts,
  formatConflictMessage,
  listBookings,
  ValidationError,
} from '../src/bookings.js';
import { createStore } from '../src/store.js';

const validBooking = {
  roomId: 'cedar',
  title: 'Product brainstorm',
  organizer: 'Alex Morgan',
  startTime: '2030-06-12T09:00:00Z',
  endTime: '2030-06-12T10:00:00Z',
};

test('each store starts with three stable rooms and no bookings', () => {
  const first = createStore();
  assert.deepEqual(first.rooms.map((room) => room.id), ['cedar', 'maple', 'aspen']);
  first.bookings.push({});
  first.rooms[0].name = 'Changed';
  const second = createStore();
  assert.equal(second.bookings.length, 0);
  assert.equal(second.rooms[0].name, 'Cedar');
});

test('creates a booking, trims text, and normalizes UTC timestamps', () => {
  const store = createStore();
  const result = createBooking(store, { ...validBooking, title: '  Product brainstorm  ', ignored: true });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result, {
    id: result.id, ...validBooking,
    startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z',
  });
  assert.equal(store.bookings.length, 1);
});

test('lists only the selected room and date in start-time order', () => {
  const store = createStore();
  const late = createBooking(store, { ...validBooking, startTime: '2030-06-12T14:00:00Z', endTime: '2030-06-12T15:00:00Z' });
  const early = createBooking(store, validBooking);
  createBooking(store, { ...validBooking, roomId: 'maple' });
  createBooking(store, { ...validBooking, startTime: '2030-06-13T09:00:00Z', endTime: '2030-06-13T10:00:00Z' });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12').map((booking) => booking.id), [early.id, late.id]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('a booking spanning midnight appears on each affected day, but not after its end', () => {
  const store = createStore();
  const booking = createBooking(store, {
    ...validBooking, startTime: '2030-06-12T23:00:00Z', endTime: '2030-06-14T00:00:00Z',
  });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-13'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('accepts a real leap day and millisecond timestamps', () => {
  const booking = createBooking(createStore(), {
    ...validBooking, startTime: '2032-02-29T09:00:00.125Z', endTime: '2032-02-29T10:00:00.125Z',
  });
  assert.equal(booking.startTime, '2032-02-29T09:00:00.125Z');
});

const invalidInputs = [
  ['missing body', undefined],
  ['null body', null],
  ['array body', []],
  ['unknown room', { ...validBooking, roomId: 'missing' }],
  ['missing title', { ...validBooking, title: undefined }],
  ['blank title', { ...validBooking, title: '  ' }],
  ['long title', { ...validBooking, title: 'a'.repeat(101) }],
  ['blank organizer', { ...validBooking, organizer: ' ' }],
  ['non-string organizer', { ...validBooking, organizer: 123 }],
  ['missing timestamp', { ...validBooking, startTime: undefined }],
  ['invalid timestamp', { ...validBooking, startTime: 'not-a-date' }],
  ['missing UTC suffix', { ...validBooking, startTime: '2030-06-12T09:00:00' }],
  ['non-UTC offset', { ...validBooking, startTime: '2030-06-12T09:00:00+02:00' }],
  ['impossible day', { ...validBooking, startTime: '2030-02-30T09:00:00Z' }],
  ['invalid leap day', { ...validBooking, startTime: '2030-02-29T09:00:00Z' }],
  ['impossible hour', { ...validBooking, startTime: '2030-06-12T24:00:00Z' }],
  ['zero duration', { ...validBooking, endTime: validBooking.startTime }],
  ['negative duration', { ...validBooking, endTime: '2030-06-12T08:00:00Z' }],
];

for (const [description, input] of invalidInputs) {
  test(`rejects ${description} without storing a booking`, () => {
    const store = createStore();
    assert.throws(() => createBooking(store, input), ValidationError);
    assert.equal(store.bookings.length, 0);
  });
}

for (const date of [undefined, '', '2030-2-1', '2030-02-30', 'not-a-date']) {
  test(`rejects invalid date filter: ${String(date)}`, () => {
    assert.throws(() => listBookings(createStore(), 'cedar', date), ValidationError);
  });
}

test('rejects an unknown room filter', () => {
  assert.throws(() => listBookings(createStore(), 'missing', '2030-06-12'), ValidationError);
});

const existing = { roomId: 'cedar', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T11:00:00.000Z' };

const overlapCases = [
  ['full overlap', '2030-06-12T10:00:00.000Z', '2030-06-12T12:00:00.000Z', true],
  ['partial overlap, candidate starts first', '2030-06-12T08:00:00.000Z', '2030-06-12T10:00:00.000Z', true],
  ['back-to-back before (candidate ends when existing starts)', '2030-06-12T08:00:00.000Z', '2030-06-12T09:00:00.000Z', false],
  ['back-to-back after (candidate starts when existing ends)', '2030-06-12T11:00:00.000Z', '2030-06-12T12:00:00.000Z', false],
  ['disjoint', '2030-06-12T12:00:00.000Z', '2030-06-12T13:00:00.000Z', false],
];

for (const [description, startTime, endTime, expectConflict] of overlapCases) {
  test(`findConflicts: ${description}`, () => {
    const result = findConflicts([existing], 'cedar', startTime, endTime);
    assert.deepEqual(result, expectConflict ? [existing] : []);
  });
}

test('findConflicts ignores bookings for a different room', () => {
  const result = findConflicts([existing], 'maple', existing.startTime, existing.endTime);
  assert.deepEqual(result, []);
});

test('findConflicts reports every overlapping booking, in store order', () => {
  const first = { roomId: 'cedar', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z' };
  const second = { roomId: 'cedar', startTime: '2030-06-12T10:30:00.000Z', endTime: '2030-06-12T11:30:00.000Z' };
  const result = findConflicts([first, second], 'cedar', '2030-06-12T09:30:00.000Z', '2030-06-12T11:00:00.000Z');
  assert.deepEqual(result, [first, second]);
});

test('formatConflictMessage renders the mandated template for a single conflict', () => {
  const room = { id: 'maple', name: 'Maple' };
  const conflict = { roomId: 'maple', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T11:00:00.000Z' };
  const message = formatConflictMessage(room, '2030-06-12T10:00:00.000Z', '2030-06-12T12:00:00.000Z', [conflict]);
  assert.equal(message, 'Room Maple is already booked from 09:00 to 11:00, resulting in a conflict from 10:00 to 11:00.');
});

test('formatConflictMessage joins one sentence per conflict with a single space, in order', () => {
  const room = { id: 'maple', name: 'Maple' };
  const first = { roomId: 'maple', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z' };
  const second = { roomId: 'maple', startTime: '2030-06-12T10:30:00.000Z', endTime: '2030-06-12T11:30:00.000Z' };
  const message = formatConflictMessage(room, '2030-06-12T09:30:00.000Z', '2030-06-12T11:00:00.000Z', [first, second]);
  assert.equal(
    message,
    'Room Maple is already booked from 09:00 to 10:00, resulting in a conflict from 09:30 to 10:00. ' +
      'Room Maple is already booked from 10:30 to 11:30, resulting in a conflict from 10:30 to 11:00.'
  );
});

test('formatConflictMessage never discloses the conflicting booking title or organizer', () => {
  const room = { id: 'maple', name: 'Maple' };
  const conflict = {
    roomId: 'maple',
    title: 'Secret planning',
    organizer: 'Someone Private',
    startTime: '2030-06-12T09:00:00.000Z',
    endTime: '2030-06-12T11:00:00.000Z',
  };
  const message = formatConflictMessage(room, '2030-06-12T10:00:00.000Z', '2030-06-12T12:00:00.000Z', [conflict]);
  assert.ok(!message.includes('Secret planning'));
  assert.ok(!message.includes('Someone Private'));
});

test('ConflictError carries a 409 status, like ValidationError carries 400', () => {
  assert.equal(new ConflictError('conflict').status, 409);
});

test('createBooking rejects an overlapping request for the same room with the mandated 409 message', () => {
  const store = createStore();
  createBooking(store, { ...validBooking, title: 'First meeting', startTime: '2030-06-12T09:00:00Z', endTime: '2030-06-12T11:00:00Z' });
  assert.throws(
    () => createBooking(store, { ...validBooking, startTime: '2030-06-12T10:00:00Z', endTime: '2030-06-12T12:00:00Z' }),
    (error) =>
      error instanceof ConflictError &&
      error.status === 409 &&
      error.message === 'Room Cedar is already booked from 09:00 to 11:00, resulting in a conflict from 10:00 to 11:00.'
  );
  assert.equal(store.bookings.length, 1);
});

test('createBooking does not write a conflicting booking to the store (no partial write)', () => {
  const store = createStore();
  createBooking(store, validBooking);
  assert.throws(() => createBooking(store, validBooking), ConflictError);
  assert.equal(store.bookings.length, 1);
});

test('createBooking allows back-to-back bookings for the same room', () => {
  const store = createStore();
  createBooking(store, { ...validBooking, startTime: '2030-06-12T09:00:00Z', endTime: '2030-06-12T11:00:00Z' });
  const second = createBooking(store, { ...validBooking, startTime: '2030-06-12T11:00:00Z', endTime: '2030-06-12T12:00:00Z' });
  assert.equal(store.bookings.length, 2);
  assert.equal(second.startTime, '2030-06-12T11:00:00.000Z');
});

test('createBooking allows the same or overlapping time range on a different room', () => {
  const store = createStore();
  createBooking(store, { ...validBooking, roomId: 'cedar' });
  const other = createBooking(store, { ...validBooking, roomId: 'maple' });
  assert.equal(store.bookings.length, 2);
  assert.equal(other.roomId, 'maple');
});
