import { describe, expect, it } from 'vitest';
import { __testing } from '../src/client/nativeLogin.js';

const { readableStrings, findError, findSessionToken } = __testing;

describe('readableStrings', () => {
  it('keeps a message whole across a typographic apostrophe', () => {
    // x.com writes "We've" with U+2019, which is not printable ASCII. Without
    // folding it the message splits and every pattern spanning it misses.
    const body = 'errors?We’ve temporarily limited your login. Please try again later.';
    expect(readableStrings(body)).toContain(
      "errors?We've temporarily limited your login. Please try again later."
    );
  });

  it('still splits on the control bytes that delimit fields', () => {
    const body = 'page\x00\x00\x00\x00onboarding\x00\x00\x00\x00section';
    expect(readableStrings(body)).toEqual(['page', 'onboarding', 'section']);
  });
});

describe('findError', () => {
  it('reports a rate limit as one sentence, not the duplicated pair', () => {
    // The body repeats each message once per field it applies to.
    const strings = readableStrings(
      'errors?We’ve temporarily limited your login. Please try again later.' +
        '\x00\x00\x00\x00error\x00\x00\x00\x00username_or_email?We’ve temporarily limited your login. Please try again later.'
    );
    expect(findError(strings)).toBe(
      "We've temporarily limited your login. Please try again later."
    );
  });

  it('returns null when nothing is wrong', () => {
    expect(findError(['page', 'onboarding', 'session_token$' + 'a'.repeat(8)])).toBeNull();
  });
});

describe('findSessionToken', () => {
  it('extracts the UUID even though it is glued to its field name', () => {
    // The real wire shape: the field name runs straight into the value, so an
    // anchored whole-string match never fires.
    const strings = ['password', 'session_token$59f6a1a9-3ff4-4d06-8e49-ff107e3cc7bc', 'password'];
    expect(findSessionToken(strings)).toBe('59f6a1a9-3ff4-4d06-8e49-ff107e3cc7bc');
  });

  it('prefers the labelled token over any other UUID present', () => {
    const strings = [
      'other$11111111-2222-3333-4444-555555555555',
      'session_token$59f6a1a9-3ff4-4d06-8e49-ff107e3cc7bc',
    ];
    expect(findSessionToken(strings)).toBe('59f6a1a9-3ff4-4d06-8e49-ff107e3cc7bc');
  });

  it('returns null when there is no token', () => {
    expect(findSessionToken(['page', 'onboarding'])).toBeNull();
  });
});
