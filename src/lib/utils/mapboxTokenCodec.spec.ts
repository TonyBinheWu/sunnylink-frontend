import { describe, expect, it } from 'vitest';
import { decodeMapboxToken, encodeMapboxToken } from './mapboxTokenCodec';

describe('Mapbox token compact codec', () => {
	it('round-trips a normal public token', async () => {
		const token = 'pk.eyJ1IjoidGVzdCIsImEiOiJjbXAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIn0.signature';
		const encoded = await encodeMapboxToken(token);
		expect(await decodeMapboxToken(encoded)).toBe(token);
	});

	it('accepts the original token without conversion', async () => {
		expect(await decodeMapboxToken('pk.original')).toBe('pk.original');
	});

	it('rejects secret tokens', async () => {
		await expect(encodeMapboxToken('sk.secret')).rejects.toThrow('must start with pk.');
	});
});
