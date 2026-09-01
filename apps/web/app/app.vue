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
 * All styling comes from `assets/css/themes.css` and `assets/css/shell.css`, wired in nuxt.config.
 * There is no component-scoped base CSS here on purpose: a second `:root` block would silently
 * override the ported palettes and no theme would look right.
 */
</script>
