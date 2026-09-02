#!/usr/bin/env node
'use strict';
/*
 * encode_radicals.js
 *
 * Converts radicals.js (a map of hanja -> { t, s:[ [path, isRadical], ... ], r, n })
 * into a compact binary format radicals.hjs.
 *
 * Binary layout (all little-endian unless noted):
 *
 *   Header:
 *     3 x char  "HJS"                     magic
 *     1 x u8    version (1)
 *     2 x u16   entry count
 *
 *   String table (radical characters + Korean radical names, UTF-8):
 *     2 x u16   string count
 *     repeated:
 *       2 x u16  byte length
 *       N bytes  UTF-8
 *
 *   Transform table (SVG group transform strings, UTF-8):
 *     1 x u8    transform count
 *     repeated:
 *       2 x u16  byte length
 *       N bytes  UTF-8
 *
 *   Entry index (sorted by codepoint), 14 bytes each:
 *     4 x u32  codepoint
 *     1 x u8   transform index
 *     1 x u8   stroke count
 *     2 x u16  index into string table (radical char, '' if none)
 *     2 x u16  index into string table (Korean name, '' if none)
 *     4 x u32  offset into stroke blob (relative to stroke blob start)
 *
 *   Stroke blob, per stroke:
 *     1 x u8   flag: 0xFF = raw UTF-8 path string (format B),
 *                    0x00/0x01 = bit-packed (format A), value is isRadical
 *     2 x u16  payload length in bytes
 *     2 x u16  for format A: number of valid bits (to skip padding);
 *              for format B: payload length (unused)
 *     N bytes  payload
 *
 *   Bit-packed path (format A): for each command
 *     3 bits   command code: M=0 L=1 Q=2 C=3 Z=4 s=5
 *     per argument (2/2/4/6/0/4): 12 bits = (coord*2 + 322)
 *     Coord offset 322 accounts for the minimum observed coord (-161).
 *     Commands with a non-standard argument count fall back to format B.
 *
 * Usage: node encode_radicals.js [input.js] [output.hjs]
 *   Defaults: radicals.js -> radicals.hjs (in this directory).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TRANSFORM = 'scale(1,-1) translate(0, -871)';
const COORD_OFFSET = 322; // min coord is -161, *2 = -322; offset to make unsigned
const CMD_MAP = { M: 0, L: 1, Q: 2, C: 3, Z: 4, m: 0, l: 1, q: 2, c: 3, z: 4, s: 5 };
const CMD_ARGS = [2, 2, 4, 6, 0, 4]; // M, L, Q, C, Z, s
const CMD_CHARS = ['M', 'L', 'Q', 'C', 'Z', 's'];
const ENTRY_SIZE = 14;

/* Parse an SVG path 'd' string into [{ cmd, nums:[...] }] groups. */
function parsePath(d) {
	const cmds = [];
	const tokens = d.match(/[MLQCZmlqczs]|-?[0-9]+(\.[0-9]+)?/g);
	if(!tokens) return cmds;
	for(const t of tokens) {
		if(/[a-zA-Z]/.test(t)) {
			cmds.push({ cmd: t, nums: [] });
		} else {
			cmds[cmds.length - 1].nums.push(parseFloat(t));
		}
	}
	return cmds;
}

/* Write bits most-significant-first into an array of numbers. */
class BitWriter {
	constructor() { this.bits = []; }
	writeBits(val, n) {
		for(let i = n - 1; i >= 0; i--) {
			this.bits.push((val >> i) & 1);
		}
	}
	toUint8Array() {
		const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
		for(let i = 0; i < this.bits.length; i++) {
			if(this.bits[i]) bytes[i >> 3] |= (1 << (7 - (i & 7)));
		}
		return bytes;
	}
}

/*
 * Encode a path into bit-packed bytes.
 * Returns { bytes: Uint8Array, numBits: number } or null if the path uses a
 * non-standard argument count (then the caller stores it as a raw string).
 */
function encodePath(d) {
	const bw = new BitWriter();
	const cmds = parsePath(d);
	for(const c of cmds) {
		const type = CMD_MAP[c.cmd];
		if(type == null) throw new Error('Unknown path command: ' + c.cmd);
		bw.writeBits(type, 3);
		const nArgs = CMD_ARGS[type];
		if(c.nums.length !== nArgs) return null; // fall back to raw string
		for(let i = 0; i < nArgs; i++) {
			bw.writeBits(((c.nums[i] * 2) + COORD_OFFSET) & 0xFFF, 12);
		}
	}
	return { bytes: bw.toUint8Array(), numBits: bw.bits.length };
}

/* Decode a bit-packed path (used only for self-verification). */
function decodePath(bytes, numBits) {
	let bitPos = 0;
	function readBits(n) {
		let v = 0;
		for(let i = 0; i < n; i++) {
			const bi = bitPos >> 3;
			const bj = 7 - (bitPos & 7);
			v = (v << 1) | ((bytes[bi] >> bj) & 1);
			bitPos++;
		}
		return v;
	}
	let d = '';
	while(bitPos < numBits) {
		const type = readBits(3);
		if(type > 5) throw new Error('bad cmd type: ' + type + ' at bit ' + (bitPos - 3));
		const nargs = CMD_ARGS[type];
		d += CMD_CHARS[type];
		for(let i = 0; i < nargs; i++) {
			d += (i > 0 ? ' ' : '') + ((readBits(12) - COORD_OFFSET) / 2);
		}
	}
	return d;
}

function main(args) {
	const dir = __dirname;
	const inFile = args[0] || path.join(dir, 'radicals.js');
	const outFile = args[1] || path.join(dir, 'radicals.hjs');

	const rsrc = fs.readFileSync(inFile, 'utf8');
	const R = JSON.parse(rsrc.slice(rsrc.indexOf('{'), rsrc.lastIndexOf('}') + 1));

	// Unique transform strings
	const transforms = [];
	const transformIdx = new Map();
	// Unique strings (radical chars + Korean names), UTF-8
	const stringTable = [];
	const stringIdx = new Map();
	function addString(s) {
		if(s == null) s = '';
		if(!stringIdx.has(s)) {
			stringIdx.set(s, stringTable.length);
			stringTable.push(s);
		}
		return stringIdx.get(s);
	}

	// Pre-populate the string table with Korean names (preserves original
	// insertion order for byte-for-byte identical output).
	for(const v of Object.values(R)) {
		addString(v.n || '');
	}

	// Build entries, sorted by codepoint
	const entries = Object.entries(R).map(([ch, v]) => {
		const t = v.t || DEFAULT_TRANSFORM;
		let ti = transformIdx.get(t);
		if(ti === undefined) {
			ti = transforms.length;
			transformIdx.set(t, ti);
			transforms.push(t);
		}
		return {
			cp: ch.codePointAt(0),
			ti,
			strokes: v.s || [],
			radicalIdx: addString(v.r || ''),
			nameIdx: addString(v.n || ''),
		};
	});
	entries.sort((a, b) => a.cp - b.cp);

	// ---- Stroke blob ----
	const strokeParts = [];
	const entryStrokeOffsets = new Uint32Array(entries.length);
	let strokeBlobOffset = 0;
	for(let i = 0; i < entries.length; i++) {
		entryStrokeOffsets[i] = strokeBlobOffset;
		for(const s of entries[i].strokes) {
			const isRad = s[1] ? 1 : 0;
			const encoded = encodePath(s[0]);
			const hdr = Buffer.alloc(5);
			if(encoded) {
				hdr[0] = isRad;
				hdr.writeUInt16LE(encoded.bytes.length, 1);
				hdr.writeUInt16LE(encoded.numBits, 3);
				const part = Buffer.from(encoded.bytes);
				strokeParts.push(hdr, part);
				strokeBlobOffset += 5 + part.length;
			} else {
				const part = Buffer.from(s[0], 'utf8');
				hdr[0] = 0xFF;
				hdr.writeUInt16LE(part.length, 1);
				hdr.writeUInt16LE(part.length, 3);
				strokeParts.push(hdr, part);
				strokeBlobOffset += 5 + part.length;
			}
		}
	}
	const strokeBlob = Buffer.concat(strokeParts);

	// ---- Entry index ----
	const entryBuf = Buffer.alloc(entries.length * ENTRY_SIZE);
	const entryDv = new DataView(entryBuf.buffer);
	for(let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const off = i * ENTRY_SIZE;
		entryDv.setUint32(off, e.cp, true);
		entryBuf[off + 4] = e.ti;
		entryBuf[off + 5] = e.strokes.length;
		entryDv.setUint16(off + 6, e.radicalIdx, true);
		entryDv.setUint16(off + 8, e.nameIdx, true);
		entryDv.setUint32(off + 10, entryStrokeOffsets[i], true);
	}

	// ---- Transform table ----
	let tOff = 1;
	let transformTableSize = 1;
	for(const t of transforms) transformTableSize += 2 + Buffer.byteLength(t, 'utf8');
	const transformTableBuf = Buffer.alloc(transformTableSize);
	transformTableBuf[0] = transforms.length;
	for(const t of transforms) {
		transformTableBuf.writeUInt16LE(Buffer.byteLength(t, 'utf8'), tOff);
		transformTableBuf.write(t, tOff + 2, 'utf8');
		tOff += 2 + Buffer.byteLength(t, 'utf8');
	}

	// ---- String table ----
	let sOff = 2;
	let stringTableSize = 2;
	for(const s of stringTable) stringTableSize += 2 + Buffer.byteLength(s, 'utf8');
	const stringTableBuf = Buffer.alloc(stringTableSize);
	stringTableBuf.writeUInt16LE(stringTable.length, 0);
	for(const s of stringTable) {
		const blen = Buffer.byteLength(s, 'utf8');
		stringTableBuf.writeUInt16LE(blen, sOff);
		stringTableBuf.write(s, sOff + 2, 'utf8');
		sOff += 2 + blen;
	}

	// ---- Assemble ----
	const HEADER_SIZE = 6;
	const totalSize = HEADER_SIZE + sOff + tOff + entryBuf.length + strokeBlob.length;
	const out = Buffer.alloc(totalSize);
	let w = 0;
	out.write('HJS', w, 'ascii'); w += 3;
	out[w++] = 1;
	out.writeUInt16LE(entries.length, w); w += 2;
	stringTableBuf.copy(out, w); w += sOff;
	transformTableBuf.copy(out, w); w += tOff;
	entryBuf.copy(out, w); w += entryBuf.length;
	strokeBlob.copy(out, w);

	fs.writeFileSync(outFile, out);

	// ---- Self-verification (round-trip decode) ----
	const strokeBlobFileOffset = HEADER_SIZE + sOff + tOff + entryBuf.length;
	let tested = 0, mismatches = 0;
	for(let i = 0; i < entries.length; i++) {
		const ent = entries[i];
		const ns = ent.strokes.length;
		if(ns === 0) continue;
		let p = strokeBlobFileOffset + entryStrokeOffsets[i];
		for(let s = 0; s < ns; s++) {
			const flag = out[p++];
			const pLen = out.readUInt16LE(p); p += 2;
			const bitCount = out.readUInt16LE(p); p += 2;
			const data = out.slice(p, p + pLen);
			p += pLen;
			const decoded = (flag === 0xFF) ? data.toString('utf8') : decodePath(data, bitCount);
			if(decoded !== ent.strokes[s][0]) {
				mismatches++;
				if(mismatches <= 5) {
					console.error('MISMATCH at ' + String.fromCodePoint(ent.cp) + ' stroke ' + s +
						' (orig ' + ent.strokes[s][0].length + ' vs decoded ' + decoded.length + ' chars)');
				}
			}
			tested++;
		}
	}

	console.log('radicals.js  : ' + rsrc.length + ' bytes');
	console.log('radicals.hjs : ' + totalSize + ' bytes (' + (totalSize / rsrc.length * 100).toFixed(1) + '%)');
	console.log('entries      : ' + entries.length);
	console.log('with strokes : ' + entries.filter(e => e.strokes.length > 0).length);
	console.log('strings      : ' + stringTable.length + '  transforms: ' + transforms.length);
	console.log('paths tested : ' + tested + '  mismatches: ' + mismatches);

	if(mismatches > 0) {
		console.error('ENCODER VERIFICATION FAILED');
		process.exit(1);
	}
	console.log('Wrote ' + outFile + ' (verified OK)');
}

main(process.argv.slice(2));
