import { describe, expect, it } from 'vitest';
import { playwrightProxy } from '../src/browser/stealth.js';

describe('playwrightProxy', () => {
  it('splits embedded credentials into separate fields (Playwright ignores them in the URL)', () => {
    expect(playwrightProxy('http://user1:p%40ss@host.example:8080')).toEqual({
      server: 'http://host.example:8080',
      username: 'user1',
      password: 'p@ss', // URL-decoded
    });
  });

  it('omits credentials when there are none', () => {
    expect(playwrightProxy('http://host.example:8080')).toEqual({ server: 'http://host.example:8080' });
  });

  it('preserves the socks5 scheme', () => {
    expect(playwrightProxy('socks5://u:p@1.2.3.4:1080')).toEqual({
      server: 'socks5://1.2.3.4:1080',
      username: 'u',
      password: 'p',
    });
  });
});
