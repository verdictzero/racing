/**
 * The appearance theme.
 *
 * A DEVICE preference, deliberately never written to the collaborative document: two people editing
 * the same chart may read it in different palettes, and one person's contrast choice must not follow
 * their colleague's screen. Same storage key and same names as `index.html`, so a browser that has
 * used the legacy app keeps the theme it was already set to.
 *
 * Dark is the default and an unset preference is NOT resolved against `prefers-color-scheme` — the
 * tool looks the same on a fresh machine whatever the OS is set to. Light and high contrast are
 * opt-in, which is the legacy behaviour and worth keeping: for a chart people read in a briefing,
 * "it looked different on my laptop" is a real cost.
 */

export const THEME_KEY = 'raci-matrix-theme-v1';

/** Picker order is also the arrow-key order: the two everyday themes, then the high-contrast family. */
export const THEMES = ['dark', 'light', 'hc-light', 'hc-dark', 'hc-neon'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * 'contrast' was the single high-contrast theme before v0.34, and it was this exact palette. A
 * stored preference lands on the variant its owner actually chose rather than being reset to dark.
 */
const THEME_ALIASES: Record<string, ThemeName> = { contrast: 'hc-dark' };

export function normalizeTheme(value: string | null | undefined): ThemeName {
  if (value && (THEMES as readonly string[]).includes(value)) return value as ThemeName;
  return (value && THEME_ALIASES[value]) || 'dark';
}

export interface ThemeControl {
  readonly theme: Ref<ThemeName>;
  set(next: ThemeName): void;
}

/**
 * Read and set the theme.
 *
 * The initial value comes off `<html>` rather than out of storage: a small script in the document
 * head has already applied it before first paint (see nuxt.config), and reading the result keeps one
 * source of truth instead of two that can disagree.
 */
export function useTheme(): ThemeControl {
  const theme = useState<ThemeName>('raci:theme', () => 'dark');

  onMounted(() => {
    theme.value = normalizeTheme(document.documentElement.getAttribute('data-theme'));
  });

  function set(next: ThemeName): void {
    theme.value = next;
    if (!import.meta.client) return;
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // A browser with storage blocked still gets the theme for this session; it just will not
      // remember it. Losing the preference is not a reason to fail the click.
    }
  }

  return { theme, set };
}
