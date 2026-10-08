import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BookingForm } from '../ui/App.jsx';

const room = { id: 'cedar', name: 'Cedar', capacity: 4, location: 'Ground floor', description: 'Small team. Big ideas.' };
const date = '2030-06-12';

function jsonResponse(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const singleConflictMessage =
  'Room Cedar is already booked from 09:00 to 11:00, resulting in a conflict from 10:00 to 11:00.';
const multiConflictMessage =
  'Room Cedar is already booked from 09:00 to 10:00, resulting in a conflict from 09:30 to 10:00. ' +
  'Room Cedar is already booked from 10:30 to 11:30, resulting in a conflict from 10:30 to 11:00.';

function fillForm({ title = 'Product brainstorm', organizer = 'Alex Morgan', startTime = '09:00', endTime = '10:00' } = {}) {
  fireEvent.change(screen.getByTestId('booking-form-title-input'), { target: { value: title } });
  fireEvent.change(screen.getByTestId('booking-form-organizer-input'), { target: { value: organizer } });
  fireEvent.change(screen.getByTestId('booking-form-start-time-input'), { target: { value: startTime } });
  fireEvent.change(screen.getByTestId('booking-form-end-time-input'), { target: { value: endTime } });
}

function submit() {
  fireEvent.click(screen.getByTestId('booking-form-submit-button'));
}

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('BookingForm — conflict message display (req-ui-conflict-message, req-conflict-response-contract)', () => {
  test('renders the mandated single-conflict sentence verbatim in the alert', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(409, { error: singleConflictMessage }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm();
    submit();

    const alert = await screen.findByTestId('booking-form-error-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(singleConflictMessage);
  });

  test('renders every space-joined per-conflict sentence in full for a multi-booking conflict', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(409, { error: multiConflictMessage }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm();
    submit();

    const alert = await screen.findByTestId('booking-form-error-alert');
    expect(alert).toHaveTextContent(multiConflictMessage);
    expect(within(alert).getByText(multiConflictMessage)).toBeInTheDocument();
  });
});

describe('BookingForm — field preservation after an error (req-preserve-form-on-conflict)', () => {
  test('keeps title, organizer, start time, and end time after a 409 conflict', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(409, { error: singleConflictMessage }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm({ title: 'Design review', organizer: 'Sam Rivera', startTime: '10:00', endTime: '12:00' });
    submit();
    await screen.findByTestId('booking-form-error-alert');

    expect(screen.getByTestId('booking-form-title-input')).toHaveValue('Design review');
    expect(screen.getByTestId('booking-form-organizer-input')).toHaveValue('Sam Rivera');
    expect(screen.getByTestId('booking-form-start-time-input')).toHaveValue('10:00');
    expect(screen.getByTestId('booking-form-end-time-input')).toHaveValue('12:00');
  });

  test('also preserves field values for a non-conflict validation error, via the same generic catch path', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(400, { error: 'End time must be after start time.' }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm({ title: 'Design review', organizer: 'Sam Rivera', startTime: '10:00', endTime: '10:00' });
    submit();
    const alert = await screen.findByTestId('booking-form-error-alert');

    expect(alert).toHaveTextContent('End time must be after start time.');
    expect(screen.getByTestId('booking-form-title-input')).toHaveValue('Design review');
    expect(screen.getByTestId('booking-form-organizer-input')).toHaveValue('Sam Rivera');
  });
});

describe('BookingForm — resubmission and request lifecycle (story-regression-safety-net)', () => {
  test('clears the stale error as soon as a corrected resubmission starts, then shows the fresh message', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(409, { error: singleConflictMessage }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm({ startTime: '10:00', endTime: '12:00' });
    submit();
    await screen.findByTestId('booking-form-error-alert');

    let resolveSecond;
    global.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    fillForm({ startTime: '11:00', endTime: '12:00' });
    submit();

    expect(screen.queryByTestId('booking-form-error-alert')).not.toBeInTheDocument();

    resolveSecond(jsonResponse(409, { error: multiConflictMessage }));
    const alert = await screen.findByTestId('booking-form-error-alert');
    expect(alert).toHaveTextContent(multiConflictMessage);
    expect(alert).not.toHaveTextContent(singleConflictMessage);
  });

  test('disables the form while the request is in flight and re-enables it after a conflict', async () => {
    let resolveFetch;
    global.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm();
    submit();

    expect(screen.getByTestId('booking-form-submit-button')).toBeDisabled();

    resolveFetch(jsonResponse(409, { error: singleConflictMessage }));
    await screen.findByTestId('booking-form-error-alert');

    expect(screen.getByTestId('booking-form-submit-button')).toBeEnabled();
  });

  test('on success, calls onBooked and resets the form (regression guard for the non-conflict path)', async () => {
    const booking = { id: 'b1', roomId: 'cedar', title: 'Product brainstorm', organizer: 'Alex Morgan', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z' };
    global.fetch.mockResolvedValueOnce(jsonResponse(201, booking));
    const onBooked = vi.fn();
    render(<BookingForm room={room} date={date} onBooked={onBooked} />);

    fillForm({ title: 'Product brainstorm', organizer: 'Alex Morgan' });
    submit();

    await vi.waitFor(() => expect(onBooked).toHaveBeenCalledWith(booking));
    expect(screen.queryByTestId('booking-form-error-alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('booking-form-title-input')).toHaveValue('');
    expect(screen.getByTestId('booking-form-organizer-input')).toHaveValue('');
  });

  test('sends the booking request with the room id and the date-joined UTC start/end timestamps', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(409, { error: singleConflictMessage }));
    render(<BookingForm room={room} date={date} onBooked={vi.fn()} />);

    fillForm({ title: 'Design review', organizer: 'Sam Rivera', startTime: '10:00', endTime: '12:00' });
    submit();
    await screen.findByTestId('booking-form-error-alert');

    expect(global.fetch).toHaveBeenCalledWith('/api/bookings', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'cedar',
        title: 'Design review',
        organizer: 'Sam Rivera',
        startTime: '2030-06-12T10:00:00Z',
        endTime: '2030-06-12T12:00:00Z',
      }),
    }));
  });
});
