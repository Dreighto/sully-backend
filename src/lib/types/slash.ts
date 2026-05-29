// Shared slash-command type. Previously duplicated (and drifted) between
// chat/+page.svelte and Composer.svelte — the page's copy had `run`, the
// Composer's did not, which broke the onpickSlash callback type. One source
// of truth now.
export type SlashCmd = {
	key: string; // text after the slash, e.g. 'clear'
	usage: string; // display form: '/clear' or '/new <name>'
	description: string;
	run: (rest: string) => Promise<void> | void;
};
