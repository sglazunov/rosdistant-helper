#!/usr/bin/env node
/*
 * Packs dist/chrome and dist/firefox into distributable .zip files using the
 * system zip if available, otherwise a pure-Node store-only zip writer.
 *
 *   node scripts/pack.mjs    (run after build.mjs)
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

async function walk(dir, base = dir, out = []) {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walk(p, base, out);
		else out.push({ abs: p, name: relative(base, p).split("\\").join("/") });
	}
	return out;
}

// Minimal ZIP (deflate) writer — enough for store/CRX-less distribution.
function zip(files) {
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const f of files) {
		const data = f.data;
		const comp = deflateRawSync(data);
		const crc = crc32(data) >>> 0;
		const name = Buffer.from(f.name, "utf8");

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8
		local.writeUInt16LE(8, 8);      // deflate
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(comp.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		chunks.push(local, name, comp);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(8, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(comp.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([cen, name]));

		offset += local.length + name.length + comp.length;
	}

	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cd, end]);
}

for (const target of ["chrome", "firefox"]) {
	const dir = join(dist, target);
	try { await stat(dir); } catch { continue; }
	const entries = await walk(dir);
	const files = [];
	for (const e of entries) files.push({ name: e.name, data: await readFile(e.abs) });
	const outZip = join(dist, `rosdistant-helper-${target}.zip`);
	await writeFile(outZip, zip(files));
	console.log(`✔ ${outZip}`);
}
