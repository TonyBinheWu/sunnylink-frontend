const RAW_PREFIX = 'M0';
const GZIP_PREFIX = 'M1';

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(base64);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function gzip(value: string): Promise<Uint8Array> {
	const stream = new Blob([new TextEncoder().encode(value)])
		.stream()
		.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(value: Uint8Array): Promise<string> {
	const stream = new Blob([value as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

export function isMapboxPublicToken(value: string): boolean {
	return value.trim().startsWith('pk.');
}

/** Adaptive compact transport encoding. This is not encryption. */
export async function encodeMapboxToken(value: string): Promise<string> {
	const token = value.trim();
	if (!isMapboxPublicToken(token)) throw new Error('Mapbox public token must start with pk.');

	const rawCode = `${RAW_PREFIX}${token.slice(3)}`;
	if (typeof CompressionStream === 'undefined') return rawCode;

	const gzipCode = `${GZIP_PREFIX}${toBase64Url(await gzip(token))}`;
	return gzipCode.length < rawCode.length ? gzipCode : rawCode;
}

/** Accepts either an original pk. token or an M0/M1 compact code. */
export async function decodeMapboxToken(value: string): Promise<string> {
	const input = value.trim();
	if (isMapboxPublicToken(input)) return input;

	let token: string;
	if (input.startsWith(RAW_PREFIX)) {
		token = `pk.${input.slice(RAW_PREFIX.length)}`;
	} else if (input.startsWith(GZIP_PREFIX)) {
		if (typeof DecompressionStream === 'undefined') {
			throw new Error('This browser cannot decode compressed Mapbox codes.');
		}
		token = await gunzip(fromBase64Url(input.slice(GZIP_PREFIX.length)));
	} else {
		throw new Error('Enter a pk. token or an M0/M1 compact code.');
	}

	if (!isMapboxPublicToken(token)) throw new Error('Decoded value is not a Mapbox public token.');
	return token;
}
