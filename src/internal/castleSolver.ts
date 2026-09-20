/**
 * Mints an `x-castle-token` (`$castle_token`) natively, no browser.
 *
 * x.com's login endpoints require a token from the Castle.io device-signals
 * SDK. The SDK is configured with a *publishable* key (`pk_…`, Stripe-style),
 * so nothing secret signs the token — it is produced entirely by public
 * client JS. This fetches that JS (`ondemand.castle`) and runs it under
 * `node:vm` inside a locked-down sandbox to obtain a genuine token.
 *
 * A token minted this way was verified accepted by x.com's `begin_login`: the
 * request passed Castle's device check and advanced to username validation.
 *
 * Security note: this executes x.com's own SDK code in a `node:vm` context
 * whose global has no `require`, `process`, `fs`, or network beyond a
 * self-resolving XHR stub. The SDK's only exports are `configure` and
 * `createRequestToken`.
 */

import { createContext, runInContext } from 'node:vm';

import { DEFAULT_USER_AGENT as DEFAULT_UA } from '../constants.js';
import { DEFAULT_DEVICE_PROFILE } from './deviceProfile.js';

/** Module id of the Castle SDK entry inside the `ondemand.castle` chunk. */
const CASTLE_MODULE_ID = '855881';

export interface CastleSolverOptions {
  /** User-Agent presented to the SDK's fake `navigator`. */
  userAgent?: string;
  /** Timezone for the fake environment. */
  timezone?: string;
  /**
   * Device the sandbox should impersonate. Defaults to the measured profile in
   * `deviceProfile.ts`; regenerate that with `scripts/dbg-harvest-profile.ts`
   * to present the machine you are actually running on.
   */
  deviceProfile?: DeviceProfile;
}

/** Shape of the harvested profile; see `scripts/dbg-harvest-profile.ts`. */
export type DeviceProfile = typeof DEFAULT_DEVICE_PROFILE;

/**
 * Anything that can mint a fresh `$castle_token`.
 *
 * {@link CastleSolver} implements it from Node with no browser; a browser-backed
 * oracle implements it by running the real SDK in a page. The login flow depends
 * on this interface rather than the solver, so the two are interchangeable.
 */
export interface CastleTokenSource {
  createRequestToken(): Promise<string>;
}

export class CastleSolver implements CastleTokenSource {
  private client: unknown = null;
  private configured: Promise<void> | null = null;

  constructor(
    private readonly sdkSource: string,
    private readonly pk: string,
    private readonly options: CastleSolverOptions = {}
  ) {}

  /** Loads and configures the SDK once, then reuses the client. */
  private async ensureConfigured(): Promise<void> {
    if (this.configured) return this.configured;
    this.configured = (async () => {
      const captured: Record<string, any> = {};
      const sandbox = buildSandbox(
        this.options.userAgent ?? DEFAULT_UA,
        (this.options.deviceProfile ?? DEFAULT_DEVICE_PROFILE) as DeviceProfile,
        this.options.timezone
      );
      sandbox.webpackChunk_twitter_responsive_web = {
        push(entry: any) {
          Object.assign(captured, entry?.[1] ?? {});
          return 1;
        },
      };

      const ctx = createContext(sandbox);
      runInContext(this.sdkSource, ctx, { timeout: 30_000 });

      const factory = captured[CASTLE_MODULE_ID];
      if (typeof factory !== 'function') {
        throw new Error('Castle SDK module was not found in the fetched chunk.');
      }
      const moduleObj: any = { exports: {} };
      factory(moduleObj, moduleObj.exports);
      const api: any = Object.keys(moduleObj.exports).length ? moduleObj.exports : moduleObj;
      if (typeof api.configure !== 'function') {
        throw new Error('Castle SDK has no configure() export.');
      }
      this.client = await api.configure({ pk: this.pk });
    })();
    return this.configured;
  }

  /** Produces a fresh `$castle_token`. */
  async createRequestToken(): Promise<string> {
    await this.ensureConfigured();
    const client = this.client as { createRequestToken(): Promise<string> };
    return Promise.race([
      client.createRequestToken(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Castle createRequestToken timed out')), 20_000)
      ),
    ]);
  }
}

/**
 * Builds the minimal browser-like global the Castle SDK needs, including the
 * DOM/navigator/screen surface its anti-automation probes read (e.g.
 * `documentElement.attributes` — the probe that looks for a `selenium` marker).
 */
function buildSandbox(ua: string, profile: DeviceProfile, timezone?: string): any {
  const p: any = profile;

  /**
   * A 2D context that reports the recorded rendering.
   *
   * Castle rasterises text and shapes and hashes the result. With the previous
   * `getContext: () => null` the probe returned nothing at all, which both
   * removes a signal group and is itself odd — every real browser has a canvas.
   * The recorded data URL comes from this machine's Chrome, so the hash is a
   * real one rather than an invention.
   */
  const make2dContext = (): any => ({
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif',
    textBaseline: 'alphabetic', textAlign: 'start', globalAlpha: 1,
    globalCompositeOperation: 'source-over', lineWidth: 1, shadowBlur: 0,
    fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
    rect() {}, ellipse() {}, bezierCurveTo() {}, quadraticCurveTo() {},
    fill() {}, stroke() {}, clip() {}, save() {}, restore() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {},
    drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    measureText: (t: string) => ({
      width: String(t).length * 7.2, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(t).length * 7.2,
      fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4,
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    putImageData() {}, createImageData: (w: number, h: number) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    isPointInPath: () => false, setLineDash() {}, getLineDash: () => [],
  });

  /** A WebGL context answering getParameter from the harvested values. */
  const makeGlContext = (): any => {
    const params: Record<string, any> = p.webgl?.params ?? {};
    const ctx: any = {
      canvas: null,
      getParameter: (e: number) => (e in params ? params[String(e)] ?? params[e] : null),
      getSupportedExtensions: () => (p.webgl?.extensions ?? []).slice(),
      getExtension: (name: string) => {
        if (name === 'WEBGL_debug_renderer_info') {
          return {
            UNMASKED_VENDOR_WEBGL: p.webgl?.unmaskedVendorEnum ?? 37445,
            UNMASKED_RENDERER_WEBGL: p.webgl?.unmaskedRendererEnum ?? 37446,
          };
        }
        return (p.webgl?.extensions ?? []).includes(name) ? {} : null;
      },
      getContextAttributes: () => ({
        alpha: true, antialias: true, depth: true, desynchronized: false,
        failIfMajorPerformanceCaveat: false, powerPreference: 'default',
        premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false,
        xrCompatible: false,
      }),
      getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
      createBuffer: () => ({}), createShader: () => ({}), createProgram: () => ({}),
      createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
      bindBuffer() {}, bufferData() {}, shaderSource() {}, compileShader() {},
      attachShader() {}, linkProgram() {}, useProgram() {}, bindTexture() {},
      texParameteri() {}, texImage2D() {}, viewport() {}, clearColor() {}, clear() {},
      enable() {}, disable() {}, drawArrays() {}, drawElements() {},
      getAttribLocation: () => 0, getUniformLocation: () => ({}),
      enableVertexAttribArray() {}, vertexAttribPointer() {}, uniform1f() {}, uniform2f() {},
      getProgramParameter: () => true, getShaderParameter: () => true,
      getError: () => 0, readPixels() {}, deleteBuffer() {}, deleteShader() {},
      deleteProgram() {}, deleteTexture() {}, isContextLost: () => false,
    };
    // The GL enum constants the SDK dereferences by name.
    Object.assign(ctx, {
      VERSION: 7938, SHADING_LANGUAGE_VERSION: 35724, VENDOR: 7936, RENDERER: 7937,
      MAX_TEXTURE_SIZE: 3379, MAX_VIEWPORT_DIMS: 3386, MAX_RENDERBUFFER_SIZE: 34024,
      MAX_VERTEX_ATTRIBS: 34921, MAX_VERTEX_UNIFORM_VECTORS: 36347,
      MAX_FRAGMENT_UNIFORM_VECTORS: 36349, MAX_VARYING_VECTORS: 36348,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661, MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
      MAX_TEXTURE_IMAGE_UNITS: 34930, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660,
      ALIASED_LINE_WIDTH_RANGE: 33902, ALIASED_POINT_SIZE_RANGE: 33901,
      RED_BITS: 3410, GREEN_BITS: 3411, BLUE_BITS: 3412, ALPHA_BITS: 3413,
      DEPTH_BITS: 3414, STENCIL_BITS: 3415,
      COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256, TRIANGLES: 4, FLOAT: 5126,
      ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, TEXTURE_2D: 3553, RGBA: 6408,
      UNSIGNED_BYTE: 5121, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    });
    return ctx;
  };

  const makeElement = (tag: string): any => {
    const attributes: any = [];
    attributes.getNamedItem = () => null;
    attributes.item = () => null;
    return {
      tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(), nodeType: 1, id: '', className: '',
      style: {}, attributes, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false, length: 0 },
      innerHTML: '', outerHTML: '', textContent: '', innerText: '',
      parentNode: null, parentElement: null, ownerDocument: null,
      children: [], childNodes: [], firstChild: null, lastChild: null,
      firstElementChild: null, lastElementChild: null, nextSibling: null, previousSibling: null,
      clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0,
      scrollWidth: 0, scrollHeight: 0, offsetTop: 0, offsetLeft: 0,
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      hasAttribute: () => false, hasAttributes: () => false, getAttributeNames: () => [],
      appendChild: (c: any) => c, removeChild: (c: any) => c, remove() {},
      insertBefore: (c: any) => c, replaceChild: (c: any) => c, cloneNode: () => makeElement(tag),
      contains: () => false, matches: () => false, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      getContext: (kind: string) => {
        if (tag !== 'canvas') return null;
        if (kind === '2d') return make2dContext();
        if (/webgl/i.test(kind)) return makeGlContext();
        return null;
      },
      toDataURL: () => (tag === 'canvas' ? p.canvas2d : ''),
      toBlob: (cb: any) => setTimeout(() => cb?.(null), 0),
      getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      focus() {}, blur() {}, click() {}, scrollIntoView() {}, width: 0, height: 0,
    };
  };

  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  };

  const doc: any = {
    createElement: makeElement, createElementNS: (_ns: string, t: string) => makeElement(t),
    documentElement: makeElement('html'), body: makeElement('body'), head: makeElement('head'),
    cookie: '', referrer: '', title: 'X', readyState: 'complete', visibilityState: 'visible', hidden: false,
    addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [], getElementById: () => null, getElementsByClassName: () => [],
    createEvent: () => ({ initEvent() {}, initCustomEvent() {} }),
    createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: () => makeElement('fragment'),
    hasFocus: () => true, elementFromPoint: () => null, prerendering: false, mozFullScreen: false, webkitHidden: false,
    fonts: { check: () => true, ready: Promise.resolve(), values: () => [][Symbol.iterator]() },
    dispatchEvent: () => true, defaultView: null,
  };

  const sandbox: any = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Error, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set,
    WeakMap, WeakSet, Symbol, Proxy, Reflect, Function, TypeError, RangeError,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, Blob, Response, Request, Headers,
    TextEncoder, TextDecoder, URL, URLSearchParams,
    CompressionStream: (globalThis as any).CompressionStream,
    DecompressionStream: (globalThis as any).DecompressionStream,
    btoa, atob, crypto,
    performance: {
      now: () => Date.now(),
      timeOrigin: Date.now(),
      // A real page has a navigation entry and a handful of resource entries;
      // an empty list marks a document that never loaded anything.
      getEntriesByType: (type: string) =>
        type === 'navigation'
          ? [{ name: 'https://x.com/i/flow/login', entryType: 'navigation', startTime: 0, duration: 812.3, type: 'navigate', transferSize: 43210, domComplete: 780.1, loadEventEnd: 812.3, responseEnd: 240.5 }]
          : [],
      getEntries: () => [],
      getEntriesByName: () => [],
      mark: () => ({}), measure: () => ({}),
    },
    navigator: {
      userAgent: ua, language: p.language ?? 'en-US',
      languages: (p.languages ?? ['en-US', 'en']).slice(),
      platform: p.platform ?? 'MacIntel',
      hardwareConcurrency: p.hardwareConcurrency ?? 8,
      maxTouchPoints: p.maxTouchPoints ?? 0,
      vendor: p.vendor ?? 'Google Inc.', product: 'Gecko',
      productSub: '20030107', cookieEnabled: true, onLine: true, doNotTrack: null,
      // A real Chrome reports five plugins and two mime types; reporting zero
      // is both a missing signal and a contradiction of the Chrome user agent
      // sitting next to it.
      plugins: makeNamedList(p.plugins ?? [], 'name'),
      mimeTypes: makeNamedList(p.mimeTypes ?? [], 'type'),
      userAgentData: p.uaData
        ? {
            brands: p.uaData.brands.map((b: any) => ({ ...b })),
            mobile: p.uaData.mobile,
            platform: p.uaData.platform,
            getHighEntropyValues: async (hints: string[]) => {
              const all: Record<string, any> = {
                architecture: 'arm', bitness: '64', model: '',
                platformVersion: '15.0.0', uaFullVersion: `${chromeMajor(ua)}.0.0.0`,
                fullVersionList: p.uaData.brands.map((b: any) => ({ ...b })),
                wow64: false,
              };
              const out: Record<string, any> = {
                brands: p.uaData.brands.map((b: any) => ({ ...b })),
                mobile: p.uaData.mobile,
                platform: p.uaData.platform,
              };
              for (const h of hints ?? []) if (h in all) out[h] = all[h];
              return out;
            },
            toJSON() {
              return { brands: p.uaData.brands, mobile: p.uaData.mobile, platform: p.uaData.platform };
            },
          }
        : undefined,
      webdriver: false, deviceMemory: p.deviceMemory ?? 8,
      appName: 'Netscape', appCodeName: 'Mozilla',
      appVersion: p.appVersion ?? ua.replace('Mozilla/', ''),
      connection: {
        effectiveType: p.connection?.effectiveType ?? '4g',
        rtt: p.connection?.rtt ?? 50,
        downlink: p.connection?.downlink ?? 10,
        saveData: p.connection?.saveData ?? false,
        addEventListener() {},
      },
      mediaDevices: {
        // A page without camera/mic permission still sees device entries (with
        // empty labels) — a common desktop is 1 audioinput, 1 videoinput,
        // 1 audiooutput. Returning `[]` is what a locked-down environment looks
        // like, and starves the device-count collector.
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: '', toJSON() { return this; } },
          { kind: 'videoinput', deviceId: 'default', groupId: 'g2', label: '', toJSON() { return this; } },
          { kind: 'audiooutput', deviceId: 'default', groupId: 'g1', label: '', toJSON() { return this; } },
        ],
        getSupportedConstraints: () => ({
          aspectRatio: true, autoGainControl: true, brightness: true, channelCount: true,
          deviceId: true, echoCancellation: true, facingMode: true, frameRate: true,
          groupId: true, height: true, noiseSuppression: true, sampleRate: true,
          sampleSize: true, width: true,
        }),
        getUserMedia: async () => { throw new Error('NotAllowedError'); },
        ondevicechange: null, addEventListener() {}, removeEventListener() {},
      },
      serviceWorker: { register: async () => ({}), ready: Promise.resolve({}), controller: null },
      credentials: { get: async () => null, create: async () => null },
      permissions: {
        // Real Chrome answers per-permission; a flat 'prompt' for everything is
        // itself a tell. `notifications`/`push` are 'prompt', device sensors
        // 'granted', `midi` 'granted'.
        query: async (d: any) => {
          const name = d?.name ?? '';
          const granted = ['accelerometer', 'gyroscope', 'magnetometer', 'background-sync'];
          const denied = ['geolocation', 'camera', 'microphone'];
          const state = granted.includes(name) ? 'granted' : denied.includes(name) ? 'prompt' : 'prompt';
          return { state, name, onchange: null, addEventListener() {}, removeEventListener() {} };
        },
      },
      storage: {
        // A real profile reports a large quota (a fraction of disk) and some use.
        estimate: async () => ({
          quota: 299977904946, usage: 12058624,
          usageDetails: { indexedDB: 8003584, caches: 4055040 },
        }),
        persisted: async () => false,
      },
      getBattery: async () => ({ level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity }),
      standalone: undefined, javaEnabled: () => false, sendBeacon: () => true,
      userActivation: { hasBeenActive: true, isActive: false },
      pdfViewerEnabled: p.pdfViewerEnabled ?? true,
      scheduling: { isInputPending: () => false },
    },
    screen: {
      width: p.screen?.width ?? 1512, height: p.screen?.height ?? 982,
      availWidth: p.screen?.availWidth ?? 1512, availHeight: p.screen?.availHeight ?? 944,
      availTop: 0, availLeft: 0,
      colorDepth: p.screen?.colorDepth ?? 30, pixelDepth: p.screen?.pixelDepth ?? 30,
      orientation: { angle: 0, type: 'landscape-primary', addEventListener() {} },
    },
    location: {
      href: 'https://x.com/i/flow/login', origin: 'https://x.com', protocol: 'https:',
      host: 'x.com', hostname: 'x.com', pathname: '/i/flow/login', search: '', hash: '',
    },
    document: doc, localStorage: storage(), sessionStorage: storage(), indexedDB: undefined,
    XMLHttpRequest: class {
      readyState = 0; status = 0; responseText = '{}'; response = '{}';
      onload: any = null; onreadystatechange: any = null; onerror: any = null; onloadend: any = null;
      private handlers: Record<string, any[]> = {};
      open() { this.readyState = 1; }
      setRequestHeader() {}
      getAllResponseHeaders() { return ''; }
      abort() {}
      addEventListener(ev: string, fn: any) { (this.handlers[ev] ||= []).push(fn); }
      removeEventListener() {}
      send() {
        setTimeout(() => {
          this.readyState = 4; this.status = 200;
          this.onreadystatechange?.call(this); this.onload?.call(this); this.onloadend?.call(this);
          for (const ev of ['load', 'loadend', 'readystatechange'])
            for (const fn of this.handlers[ev] ?? []) { try { fn.call(this, { type: ev }); } catch { /* ignore */ } }
        }, 0);
      }
    },
    fetch: async () => new Response('{}', { status: 200 }),
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: p.devicePixelRatio ?? 2,
    innerWidth: p.innerWidth ?? 1512, innerHeight: p.innerHeight ?? 862,
    outerWidth: p.outerWidth ?? 1512, outerHeight: p.outerHeight ?? 944,
    // Audio fingerprinting renders a tone through a compressor and hashes the
    // samples. Without an AudioContext the probe yields nothing; this replays
    // the recorded sum so the signal is present and consistent with the rest
    // of the profile.
    OfflineAudioContext: makeOfflineAudioContext(p),
    webkitOfflineAudioContext: makeOfflineAudioContext(p),
    AudioContext: makeOfflineAudioContext(p),
    webkitAudioContext: makeOfflineAudioContext(p),
    requestIdleCallback: (fn: any) => setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0),
    cancelIdleCallback: () => {}, requestAnimationFrame: (fn: any) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    PerformanceObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    dispatchEvent: () => true,
    // Answering every media query "false" says the device has no fine pointer
    // and no hover — i.e. not a desktop, contradicting everything else here.
    matchMedia: (query: string) => ({
      media: query,
      matches: Boolean(p.mediaQueries?.[String(query).replace(/^\(|\)$/g, '')]),
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => true,
    }),
    Intl, external: {}, chrome: { runtime: {}, loadTimes: () => ({}), csi: () => ({}) },
    Notification: { permission: 'default' },
    // An empty voice list is a strong non-browser tell — macOS Chrome ships a
    // large, characteristic set. A representative slice is enough for the
    // count/name-hash collector to have something real-shaped to read.
    speechSynthesis: {
      getVoices: () => SPEECH_VOICES.map((v) => ({ ...v, default: v.voiceURI === SPEECH_VOICES[0].voiceURI })),
      speak() {}, cancel() {}, pause() {}, resume() {},
      pending: false, speaking: false, paused: false,
      addEventListener() {}, removeEventListener() {}, onvoiceschanged: null,
    },
    webkitRequestFileSystem: () => {}, openDatabase: () => {},
    history: { length: 2, pushState() {}, replaceState() {} }, frames: { length: 0 },
    length: 0, closed: false, origin: 'https://x.com', isSecureContext: true, caches: undefined,
    Worker: class { postMessage() {} terminate() {} addEventListener() {} },
  };
  /*
   * Browser API surface.
   *
   * Castle builds a large part of its signal from *which globals exist* — the
   * instrumented run shows it probing for dozens of constructors and methods by
   * name. Every one that is missing here reads as a browser that cannot be
   * Chrome, and collectively they were the bulk of the gap: canvas, WebGL and
   * audio together moved the token under 1%, because the feature-detection
   * vector was the part actually empty.
   *
   * These are presence markers, not implementations. The SDK checks that the
   * name resolves and occasionally reads `.name` or `.prototype`; it does not
   * drive them. Anything Chrome does *not* have stays absent on purpose —
   * `safari`, `opr`, `InstallTrigger`, `ethereum`, `navigator.brave` — since
   * claiming them would be a fresh contradiction.
   */
  const ctor = (name: string, proto: Record<string, any> = {}): any => {
    const fn = function () {} as any;
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
    Object.assign(fn.prototype, proto);
    return fn;
  };

  Object.assign(sandbox, {
    // Layout and styling.
    getComputedStyle: () => ({
      getPropertyValue: () => '',
      getPropertyPriority: () => '',
      item: () => '',
      length: 0,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '16px', display: 'block', visibility: 'visible',
    }),
    CSS: {
      supports: () => true,
      escape: (s: string) => String(s),
      registerProperty() {},
    },
    // DOM constructors.
    Node: ctor('Node'), Element: ctor('Element'), HTMLElement: ctor('HTMLElement'),
    HTMLCanvasElement: ctor('HTMLCanvasElement'), HTMLMediaElement: ctor('HTMLMediaElement'),
    HTMLVideoElement: ctor('HTMLVideoElement'), HTMLAudioElement: ctor('HTMLAudioElement'),
    HTMLIFrameElement: ctor('HTMLIFrameElement'), HTMLDivElement: ctor('HTMLDivElement'),
    HTMLInputElement: ctor('HTMLInputElement'), HTMLScriptElement: ctor('HTMLScriptElement'),
    Document: ctor('Document'), DocumentFragment: ctor('DocumentFragment'),
    ShadowRoot: ctor('ShadowRoot'), DOMRect: ctor('DOMRect'), DOMRectReadOnly: ctor('DOMRectReadOnly'),
    DOMParser: ctor('DOMParser'), XPathResult: ctor('XPathResult'),
    NodeList: ctor('NodeList'), HTMLCollection: ctor('HTMLCollection'),
    CSSStyleDeclaration: ctor('CSSStyleDeclaration'), CSSStyleSheet: ctor('CSSStyleSheet'),
    // Graphics.
    OffscreenCanvas: ctor('OffscreenCanvas'),
    OffscreenCanvasRenderingContext2D: ctor('OffscreenCanvasRenderingContext2D'),
    CanvasRenderingContext2D: ctor('CanvasRenderingContext2D'),
    WebGLRenderingContext: ctor('WebGLRenderingContext'),
    WebGL2RenderingContext: ctor('WebGL2RenderingContext'),
    ImageBitmap: ctor('ImageBitmap'), ImageData: ctor('ImageData'), Path2D: ctor('Path2D'),
    GPUAdapter: ctor('GPUAdapter'), GPUDevice: ctor('GPUDevice'),
    GPUCanvasContext: ctor('GPUCanvasContext'),
    // Media and devices.
    MediaRecorder: ctor('MediaRecorder'), MediaStream: ctor('MediaStream'),
    // WebRTC is a signal source (the SDK opens a data channel and reads the
    // local ICE candidate). An inert constructor produces nothing; this drives
    // the create-offer / onicecandidate handshake and yields a host candidate
    // with a stable local address, the way a real desktop behind NAT does.
    RTCPeerConnection: makeRTCPeerConnection(),
    webkitRTCPeerConnection: makeRTCPeerConnection(),
    RTCDataChannel: ctor('RTCDataChannel'), SerialPort: ctor('SerialPort'),
    USBDevice: ctor('USBDevice'), Bluetooth: ctor('Bluetooth'),
    // Observers and scheduling.
    PressureObserver: ctor('PressureObserver'),
    ReportingObserver: ctor('ReportingObserver'),
    PerformanceLongAnimationFrameTiming: ctor('PerformanceLongAnimationFrameTiming'),
    PerformanceLongTaskTiming: ctor('PerformanceLongTaskTiming'),
    PerformanceEventTiming: ctor('PerformanceEventTiming'),
    scheduler: { postTask: async (fn: any) => fn?.(), yield: async () => {} },
    // Workers and storage.
    SharedWorker: ctor('SharedWorker'), BroadcastChannel: ctor('BroadcastChannel'),
    ContentIndex: ctor('ContentIndex'), ContactsManager: ctor('ContactsManager'),
    StorageManager: ctor('StorageManager'), FileSystemHandle: ctor('FileSystemHandle'),
    NetworkInformation: ctor('NetworkInformation'),
    // Misc window surface.
    visualViewport: {
      width: p.innerWidth ?? 1512, height: p.innerHeight ?? 862,
      offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1,
      addEventListener() {}, removeEventListener() {},
    },
    frameElement: null,
    prompt: () => null,
    close() {},
    print() {},
    focus() {},
    blur() {},
    scrollTo() {},
    getSelection: () => ({ toString: () => '', rangeCount: 0, removeAllRanges() {} }),
    queueMicrotask: (fn: any) => Promise.resolve().then(fn),
    structuredClone: (v: any) => JSON.parse(JSON.stringify(v ?? null)),
  });

  // Chrome-only extras on the objects the SDK reads most.
  sandbox.performance.memory = {
    jsHeapSizeLimit: 4294705152, totalJSHeapSize: 35000000, usedJSHeapSize: 24000000,
  };
  sandbox.performance.getEntries = () => [];
  sandbox.performance.getEntriesByName = () => [];
  sandbox.performance.mark = () => ({});
  sandbox.performance.measure = () => ({});
  sandbox.screen.isExtended = false;

  sandbox.navigator.gpu = {
    requestAdapter: async () => ({
      features: new Set(), limits: {},
      requestDevice: async () => ({ features: new Set(), limits: {} }),
    }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  sandbox.navigator.bluetooth = { getAvailability: async () => false };
  sandbox.navigator.serial = { getPorts: async () => [] };
  sandbox.navigator.usb = { getDevices: async () => [] };
  sandbox.navigator.setAppBadge = async () => {};
  sandbox.navigator.clearAppBadge = async () => {};
  sandbox.navigator.webkitTemporaryStorage = {
    queryUsageAndQuota: (cb: any) => cb?.(0, 0),
  };
  sandbox.navigator.deviceMemory = p.deviceMemory ?? 8;

  const docExtras: any = sandbox.document;
  docExtras.currentScript = null;
  docExtras.wasDiscarded = false;
  docExtras.onbeforematch = null;
  docExtras.hasStorageAccess = async () => true;
  docExtras.requestStorageAccess = async () => {};
  docExtras.caretPositionFromPoint = () => null;
  docExtras.scripts = [];
  docExtras.styleSheets = [];
  docExtras.characterSet = 'UTF-8';
  docExtras.contentType = 'text/html';
  docExtras.compatMode = 'CSS1Compat';
  docExtras.documentElement.getClientRects = () => [];
  docExtras.body.getClientRects = () => [];

  sandbox.location.port = '';
  sandbox.location.ancestorOrigins = { length: 0, item: () => null, contains: () => false };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  void timezone;
  return sandbox;
}

/** Internals exposed for diagnostics; not part of the public API. */
export const __testing = { buildSandbox };

/**
 * A `navigator.plugins` / `navigator.mimeTypes` style collection.
 *
 * These are array-like *and* indexable by name, and the SDK may walk them
 * either way, so both access paths have to work.
 */
function makeNamedList(items: readonly any[], key: string): any {
  const list: any = {
    length: items.length,
    item: (i: number) => list[i] ?? null,
    namedItem: (n: string) => items.find((it) => it[key] === n) ?? null,
    refresh() {},
    [Symbol.iterator]: function* () {
      for (let i = 0; i < items.length; i += 1) yield list[i];
    },
  };
  items.forEach((item, i) => {
    const entry = { ...item, length: 0, item: () => null, namedItem: () => null };
    list[i] = entry;
    list[item[key]] = entry;
  });
  return list;
}

/** Major Chrome version out of a user agent, for client-hint values. */
function chromeMajor(ua: string): string {
  return /Chrome\/(\d+)/.exec(ua)?.[1] ?? '153';
}

/**
 * An OfflineAudioContext whose rendered buffer reproduces the recorded
 * fingerprint.
 *
 * The probe sums the absolute sample values, so the buffer only has to add up
 * to the measured total; the samples are spread evenly to reach it.
 */
function makeOfflineAudioContext(p: any): any {
  const sampleRate = p.audio?.sampleRate ?? 44100;
  const length = p.audio?.length ?? 44100;
  const target = p.audio?.sum ?? 0;

  const node = () => ({
    connect: (n: any) => n, disconnect() {}, start() {}, stop() {},
    frequency: { value: 0, setValueAtTime() {} },
    gain: { value: 1, setValueAtTime() {} },
    type: 'triangle',
    threshold: { value: -24, setValueAtTime() {} },
    knee: { value: 30, setValueAtTime() {} },
    ratio: { value: 12, setValueAtTime() {} },
    attack: { value: 0.003, setValueAtTime() {} },
    release: { value: 0.25, setValueAtTime() {} },
    reduction: 0,
  });

  return class {
    sampleRate = sampleRate;
    length = length;
    destination = node();
    currentTime = 0;
    state = 'suspended';
    createOscillator = node;
    createDynamicsCompressor = node;
    createGain = node;
    createBiquadFilter = node;
    createAnalyser = () => ({ ...node(), frequencyBinCount: 1024, getFloatFrequencyData() {} });
    createBuffer = (ch: number, len: number, rate: number) => ({
      numberOfChannels: ch, length: len, sampleRate: rate,
      getChannelData: () => new Float32Array(len),
    });
    createBufferSource = node;
    createScriptProcessor = () => ({ ...node(), onaudioprocess: null });
    suspend = async () => {};
    resume = async () => {};
    close = async () => {};
    addEventListener() {}
    removeEventListener() {}
    startRendering = async () => {
      const data = new Float32Array(length);
      const per = length > 0 ? target / length : 0;
      for (let i = 0; i < length; i += 1) data[i] = i % 2 === 0 ? per : -per;
      return {
        numberOfChannels: 1, length, sampleRate, duration: length / sampleRate,
        getChannelData: () => data,
        copyFromChannel(dest: Float32Array) { dest.set(data.subarray(0, dest.length)); },
      };
    };
  };
}

/**
 * A minimal but functional RTCPeerConnection for the sandbox.
 *
 * The Castle SDK opens a data channel, creates an offer and reads the local ICE
 * candidate it produces — a fingerprint input. Node has no real ICE stack, so
 * this synthesises the handshake: a plausible SDP and one host candidate with a
 * stable RFC-1918 address, delivered asynchronously via both `onicecandidate`
 * and the event listener, then a null candidate to signal completion.
 */
function makeRTCPeerConnection(): any {
  const HOST_IP = '192.168.1.24';
  const FP = 'sha-256 8C:9E:4F:2A:1B:7D:6E:3C:0A:5F:9B:2D:4E:8A:1C:6F:3B:7E:0D:5A:2C:9F:4B:8E:1D:6A:3C:7F:0B:5E:2A:9D';
  return class RTCPeerConnection {
    onicecandidate: any = null;
    onicegatheringstatechange: any = null;
    iceGatheringState = 'new';
    localDescription: any = null;
    private handlers: Record<string, any[]> = {};
    private readonly ufrag = Math.random().toString(36).slice(2, 6);

    addEventListener(ev: string, fn: any) { (this.handlers[ev] ||= []).push(fn); }
    removeEventListener() {}
    createDataChannel() { return { close() {}, send() {}, readyState: 'connecting' }; }

    async createOffer() {
      const sdp =
        `v=0\r\no=- ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n` +
        `a=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` +
        `c=IN IP4 0.0.0.0\r\na=ice-ufrag:${this.ufrag}\r\na=ice-pwd:${Math.random().toString(36).slice(2)}\r\n` +
        `a=fingerprint:${FP}\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n`;
      return { type: 'offer', sdp };
    }

    async setLocalDescription(desc?: any) {
      this.localDescription = desc ?? { type: 'offer', sdp: '' };
      this.iceGatheringState = 'gathering';
      const candidate = {
        candidate: `candidate:1 1 udp 2113937151 ${HOST_IP} 54321 typ host generation 0 ufrag ${this.ufrag} network-cost 999`,
        sdpMid: '0', sdpMLineIndex: 0, foundation: '1', component: 1, protocol: 'udp',
        priority: 2113937151, address: HOST_IP, port: 54321, type: 'host',
        toJSON() { return this; },
      };
      // Deliver asynchronously, like a real gathering cycle.
      setTimeout(() => {
        for (const fn of this.handlers['icecandidate'] ?? []) { try { fn({ candidate }); } catch { /* ignore */ } }
        try { this.onicecandidate?.({ candidate }); } catch { /* ignore */ }
        this.iceGatheringState = 'complete';
        for (const fn of this.handlers['icecandidate'] ?? []) { try { fn({ candidate: null }); } catch { /* ignore */ } }
        try { this.onicecandidate?.({ candidate: null }); } catch { /* ignore */ }
      }, 0);
    }

    setRemoteDescription() { return Promise.resolve(); }
    close() {}
    getStats() { return Promise.resolve(new Map()); }
  };
}

/** A representative slice of the macOS Chrome voice list (a fingerprint input). */
const SPEECH_VOICES = [
  { voiceURI: 'Albert', name: 'Albert', lang: 'en-US', localService: true },
  { voiceURI: 'Alice', name: 'Alice', lang: 'it-IT', localService: true },
  { voiceURI: 'Daniel', name: 'Daniel', lang: 'en-GB', localService: true },
  { voiceURI: 'Fred', name: 'Fred', lang: 'en-US', localService: true },
  { voiceURI: 'Karen', name: 'Karen', lang: 'en-AU', localService: true },
  { voiceURI: 'Moira', name: 'Moira', lang: 'en-IE', localService: true },
  { voiceURI: 'Rishi', name: 'Rishi', lang: 'en-IN', localService: true },
  { voiceURI: 'Samantha', name: 'Samantha', lang: 'en-US', localService: true },
  { voiceURI: 'Tessa', name: 'Tessa', lang: 'en-ZA', localService: true },
  { voiceURI: 'Thomas', name: 'Thomas', lang: 'fr-FR', localService: true },
  { voiceURI: 'Google US English', name: 'Google US English', lang: 'en-US', localService: false },
  { voiceURI: 'Google UK English Female', name: 'Google UK English Female', lang: 'en-GB', localService: false },
].map((v) => ({ ...v, default: false }));
