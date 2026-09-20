/**
 * A real device profile, measured from the Chrome on the machine that ran
 * scripts/dbg-harvest-profile.ts.
 *
 * Regenerate with that script rather than hand-editing: the values have to stay
 * mutually consistent, since the GPU string, the plugin list, the screen and the
 * user agent all have to describe one plausible machine.
 */

export const DEFAULT_DEVICE_PROFILE = {
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "appVersion": "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "platform": "MacIntel",
  "vendor": "Google Inc.",
  "languages": [
    "en-US"
  ],
  "language": "en-US",
  "hardwareConcurrency": 12,
  "deviceMemory": 32,
  "maxTouchPoints": 0,
  "pdfViewerEnabled": true,
  "uaData": {
    "brands": [
      {
        "brand": "Google Chrome",
        "version": "153"
      },
      {
        "brand": "Not_A Brand",
        "version": "8"
      },
      {
        "brand": "Chromium",
        "version": "153"
      }
    ],
    "mobile": false,
    "platform": "macOS"
  },
  "plugins": [
    {
      "name": "PDF Viewer",
      "filename": "internal-pdf-viewer",
      "description": "Portable Document Format"
    },
    {
      "name": "Chrome PDF Viewer",
      "filename": "internal-pdf-viewer",
      "description": "Portable Document Format"
    },
    {
      "name": "Chromium PDF Viewer",
      "filename": "internal-pdf-viewer",
      "description": "Portable Document Format"
    },
    {
      "name": "Microsoft Edge PDF Viewer",
      "filename": "internal-pdf-viewer",
      "description": "Portable Document Format"
    },
    {
      "name": "WebKit built-in PDF",
      "filename": "internal-pdf-viewer",
      "description": "Portable Document Format"
    }
  ],
  "mimeTypes": [
    {
      "type": "application/pdf",
      "suffixes": "pdf",
      "description": "Portable Document Format"
    },
    {
      "type": "text/pdf",
      "suffixes": "pdf",
      "description": "Portable Document Format"
    }
  ],
  "screen": {
    "width": 1728,
    "height": 1117,
    "availWidth": 1728,
    "availHeight": 1003,
    "colorDepth": 30,
    "pixelDepth": 30
  },
  "devicePixelRatio": 2,
  "innerWidth": 1200,
  "innerHeight": 816,
  "outerWidth": 1200,
  "outerHeight": 959,
  "timezone": "Europe/Paris",
  "timezoneOffset": -120,
  "canvas2d": "data:image/png;base64,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",
  "webgl": {
    "params": {
      "3379": 16384,
      "3386": [
        16384,
        16384
      ],
      "3410": 8,
      "3411": 8,
      "3412": 8,
      "3413": 8,
      "3414": 24,
      "3415": 0,
      "7936": "WebKit",
      "7937": "WebKit WebGL",
      "7938": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
      "33901": [
        1,
        511
      ],
      "33902": [
        1,
        1
      ],
      "34024": 16384,
      "34076": 16384,
      "34921": 16,
      "34930": 16,
      "35660": 16,
      "35661": 32,
      "35724": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
      "36347": 1024,
      "36348": 30,
      "36349": 1024,
      "37445": "Google Inc. (Apple)",
      "37446": "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)"
    },
    "unmaskedVendorEnum": 37445,
    "unmaskedRendererEnum": 37446,
    "extensions": [
      "ANGLE_instanced_arrays",
      "EXT_blend_minmax",
      "EXT_clip_control",
      "EXT_color_buffer_half_float",
      "EXT_depth_clamp",
      "EXT_disjoint_timer_query",
      "EXT_float_blend",
      "EXT_frag_depth",
      "EXT_polygon_offset_clamp",
      "EXT_shader_texture_lod",
      "EXT_texture_compression_bptc",
      "EXT_texture_compression_rgtc",
      "EXT_texture_filter_anisotropic",
      "EXT_texture_mirror_clamp_to_edge",
      "EXT_sRGB",
      "KHR_parallel_shader_compile",
      "OES_element_index_uint",
      "OES_fbo_render_mipmap",
      "OES_standard_derivatives",
      "OES_texture_float",
      "OES_texture_float_linear",
      "OES_texture_half_float",
      "OES_texture_half_float_linear",
      "OES_vertex_array_object",
      "WEBGL_blend_func_extended",
      "WEBGL_color_buffer_float",
      "WEBGL_compressed_texture_astc",
      "WEBGL_compressed_texture_etc",
      "WEBGL_compressed_texture_etc1",
      "WEBGL_compressed_texture_pvrtc",
      "WEBGL_compressed_texture_s3tc",
      "WEBGL_compressed_texture_s3tc_srgb",
      "WEBGL_debug_renderer_info",
      "WEBGL_debug_shaders",
      "WEBGL_depth_texture",
      "WEBGL_draw_buffers",
      "WEBGL_lose_context",
      "WEBGL_multi_draw",
      "WEBGL_polygon_mode"
    ]
  },
  "audio": {
    "sum": 18614.61449613873,
    "sampleRate": 44100,
    "length": 44100
  },
  "mediaQueries": {
    "any-pointer: fine": true,
    "any-hover: hover": true,
    "pointer: fine": true,
    "hover: hover": true,
    "prefers-reduced-motion: reduce": false,
    "prefers-color-scheme: dark": false,
    "forced-colors: active": false
  },
  "connection": {
    "effectiveType": "4g",
    "rtt": 100,
    "downlink": 10,
    "saveData": false
  }
} as const;
