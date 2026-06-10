// Fontsource variable packages are CSS-only (side-effect imports in
// +layout.svelte per the locked spec §4 Option A); they ship no type
// declarations, so declare them for svelte-check/tsc.
declare module '@fontsource-variable/fraunces';
declare module '@fontsource-variable/bricolage-grotesque';
declare module '@fontsource-variable/jetbrains-mono';
