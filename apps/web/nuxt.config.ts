// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  /**
   * The palettes, then the structural rules that consume them. Both are ported from index.html so
   * the rebuild is recognisably the same tool; see the header comments in each file.
   */
  css: ['~/assets/css/themes.css', '~/assets/css/shell.css'],

  // Nitro's WebSocket support carries the Yjs sync protocol. It is behind a flag in Nitro, so the
  // collaboration endpoint does not exist without this.
  nitro: {
    experimental: { websocket: true },
  },

  typescript: {
    strict: true,
    typeCheck: false, // run in CI via `pnpm typecheck`, not on every dev-server reload
  },

  /**
   * Everything under `runtimeConfig` (except `public`) is server-only and is read from the
   * environment at RUNTIME, not baked in at build time. That is what lets one built image be
   * promoted from a test network to a closed one with different secrets — which the air-gapped
   * deployment needs, and which a build-time `import.meta.env` would make impossible.
   */
  runtimeConfig: {
    databaseUrl: '',
    sessionSecret: '',
    authOidcIssuer: '',
    authOidcClientId: '',
    authOidcClientSecret: '',
    authOidcRedirectUri: '',
    authOidcScopes: 'openid profile email',
    authOidcPostLogoutRedirectUri: '',
    authRolesClaim: 'realm_access.roles',
    authSubjectClaim: 'sub',
    /** JSON object mapping IdP role names to viewer|editor|admin. */
    authRoleMap: '{}',
    directoryProvider: 'none',
    collabSnapshotEvery: '200',

    public: {
      appName: 'ASIC RACI Tool',
      collabWsPath: '/api/collab',
    },
  },

  app: {
    head: {
      title: 'ASIC RACI Tool',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      /**
       * The theme is applied BEFORE first paint, which is why this is a raw script in the head
       * rather than anything in the app: resolving it after hydration means a light-theme user
       * watches the dark palette flash on every navigation. Kept deliberately in step with
       * `useTheme.ts` — same key, same names, same 'contrast' migration.
       */
      script: [
        {
          innerHTML:
            "(function(){try{var t=localStorage.getItem('raci-matrix-theme-v1');" +
            "if(t==='contrast')t='hc-dark';" +
            "document.documentElement.setAttribute('data-theme'," +
            "(t==='light'||t==='hc-light'||t==='hc-dark'||t==='hc-neon')?t:'dark');" +
            "}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();",
          tagPosition: 'head',
        },
      ],
    },
  },
});
