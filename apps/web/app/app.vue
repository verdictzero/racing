<template>
  <NuxtPage />
</template>

<script setup lang="ts">
/**
 * Deliberately empty.
 *
 * The frame lives in the workspace shell (`pages/w/[id].vue`), which mirrors index.html's two-rail
 * layout, and the landing page carries its own lighter chrome. An app-level header would either
 * duplicate the rail or fight it for the top of the screen.
 *
 * All styling comes from `assets/css/legacy.css` — index.html's whole stylesheet, verbatim — and
 * the few rebuild-only rules in `assets/css/ours.css`, wired in nuxt.config. There is no base CSS
 * here on purpose: a second `:root` block would silently override the source's palettes and no
 * theme would look right.
 */
</script>
