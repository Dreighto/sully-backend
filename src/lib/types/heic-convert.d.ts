// `heic-convert` ships no type declarations. Typed to match the single call
// site in src/routes/api/chat/uploads/+server.ts (default export = the async
// convert function). The package also exposes `convert.all` for multi-image
// HEIC, which we don't use.
declare module 'heic-convert' {
	type HeicConvertOptions = {
		buffer: ArrayBuffer | Uint8Array;
		format: 'JPEG' | 'PNG';
		quality?: number;
	};
	const convert: (options: HeicConvertOptions) => Promise<Buffer>;
	export default convert;
}
