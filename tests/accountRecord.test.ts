import { describe, expect, it } from 'vitest';
import { parseAccountRecord, accountSessionCookies } from '../src/client/accountRecord.js';

// A base64 cookie jar with the essential x.com session cookies.
const jar = Buffer.from(
  JSON.stringify([
    { name: 'auth_token', value: 'aaaa', domain: '.x.com' },
    { name: 'ct0', value: 'cccc', domain: '.x.com' },
    { name: 'guest_id', value: 'gggg', domain: '.x.com' },
    { name: 'twid', value: 'u%3D123', domain: '.x.com' },
    { name: 'cf_clearance', value: 'CFCF', domain: '.x.com' },
  ])
).toString('base64');

describe('parseAccountRecord', () => {
  it('parses username/password and detects fields by shape', () => {
    const rec = parseAccountRecord(
      `user1:pass1:ZLFZRH4ZSPSVYBHP:me@mail.com:emailpw:eb512731a70fe66aa7892c83b05124c5a50ff8e4:${jar}`
    );
    expect(rec.username).toBe('user1');
    expect(rec.password).toBe('pass1');
    expect(rec.totpSecret).toBe('ZLFZRH4ZSPSVYBHP');
    expect(rec.email).toBe('me@mail.com');
    expect(rec.emailPassword).toBe('emailpw');
    expect(rec.authToken).toBe('eb512731a70fe66aa7892c83b05124c5a50ff8e4');
    expect(rec.cookies?.auth_token).toBe('aaaa');
  });

  it('handles a bare username:password', () => {
    const rec = parseAccountRecord('u:p');
    expect(rec.username).toBe('u');
    expect(rec.password).toBe('p');
    expect(rec.totpSecret).toBeUndefined();
    expect(accountSessionCookies(rec)).toBeUndefined();
  });

  it('throws on a malformed record', () => {
    expect(() => parseAccountRecord('nocolon')).toThrow();
  });
});

describe('accountSessionCookies', () => {
  it('keeps the session cookies and drops fingerprint-bound cf_clearance', () => {
    const rec = parseAccountRecord(`u:p:${jar}`);
    const s = accountSessionCookies(rec)!;
    expect(s.auth_token).toBe('aaaa');
    expect(s.ct0).toBe('cccc');
    expect(s.guest_id).toBe('gggg');
    expect(s.twid).toBe('u%3D123');
    expect(s.cf_clearance).toBeUndefined();
  });

  it('falls back to the auth_token field when there is no jar', () => {
    const rec = parseAccountRecord('u:p:eb512731a70fe66aa7892c83b05124c5a50ff8e4');
    expect(accountSessionCookies(rec)).toEqual({ auth_token: 'eb512731a70fe66aa7892c83b05124c5a50ff8e4' });
  });
});
