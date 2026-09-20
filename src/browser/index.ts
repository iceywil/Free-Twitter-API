export {
  browserLogin,
  type BrowserLoginOptions,
  type BrowserLoginResult,
} from './login.js';

export {
  importChromeCookies,
  defaultChromeUserDataDir,
  defaultChromeExecutable,
  type ImportChromeCookiesOptions,
  type ImportedSession,
} from './chromeCookies.js';

export {
  PROFILE_ROOT,
  profileDirFor,
  stealthContextOptions,
  typeLikeHuman,
  type StealthLaunchOptions,
} from './stealth.js';
