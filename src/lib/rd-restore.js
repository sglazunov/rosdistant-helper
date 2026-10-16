/*
 * Restores an iSpring flip-book PDF back to a monolithic file.
 *
 * iSpring guts the source PDF: every large image XObject keeps only its
 * dictionary, with `/Length 0`, a 32-byte stub after `stream`, and the real
 * picture moved to an external file referenced by `/F`:
 *
 *     220 0 obj << /ColorSpace /DeviceRGB /F (data/res/img_1.jpg)
 *                  /FFilter /DCTDecode /Width 731 /Height 991 /Length 0 >> stream
 *
 * Their patched pdf.js worker forwards `/F` to the page, which does
 * `img.src = <that path>` and paints the picture over the gutted page. A plain
 * download therefore yields a "chopped" book: text and layout, no images.
 *
 * Here we put them back:
 *   1. repairStubs()  — empty those streams so a strict parser accepts the file.
 *      Byte count is preserved (padding after `endstream`), because growing the
 *      file shifts every offset and the xref stream stops matching.
 *   2. qpdf --decrypt — `/F` is an encrypted string; only after decryption does
 *      it read as `data/res/img_1.jpg`. qpdf also flattens object streams.
 *   3. fetch each `/F` asset with the page session.
 *   4. splice it back: JPEG goes in verbatim (/DCTDecode); PNG is decoded to
 *      raw samples and stored losslessly (/FlateDecode + /SMask for alpha).
 *   5. rewrite the document with a fresh xref table.
 *
 * Exposes globalThis.__rdRestore = { hasExternals, restore }.
 */
(() => {
	let DEC = null;
	function toStr(bytes) {
		if (!DEC) DEC = new TextDecoder("latin1");
		return DEC.decode(bytes);
	}
	function toBytes(str) {
		const out = new Uint8Array(str.length);
		for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
		return out;
	}
	function concat(chunks) {
		let n = 0;
		for (const c of chunks) n += c.length;
		const out = new Uint8Array(n);
		let o = 0;
		for (const c of chunks) { out.set(c, o); o += c.length; }
		return out;
	}

	/* ---------- 1. offset-preserving stub repair ---------- */

	// Empties `/Length 0` streams that actually carry stub bytes, padding the
	// same number of bytes after `endstream` so every offset stays put.
	function repairStubs(bytes) {
		const s = toStr(bytes);
		const re = /\/FFilter[\s\S]{0,600}?\/Length\s+0[^0-9][\s\S]{0,600}?stream(\r?\n)/g;
		const parts = [];
		let last = 0, fixed = 0, m;
		while ((m = re.exec(s))) {
			const dataStart = m.index + m[0].length;
			const end = s.indexOf("endstream", dataStart);
			if (end < 0 || end - dataStart > 4096) continue;
			const n = end - dataStart;
			if (n === 0) continue;
			parts.push(s.slice(last, dataStart));
			parts.push("endstream" + " ".repeat(n));
			last = end + "endstream".length;
			fixed++;
			re.lastIndex = last;
		}
		if (!fixed) return { bytes, fixed: 0 };
		parts.push(s.slice(last));
		return { bytes: toBytes(parts.join("")), fixed };
	}

	/* ---------- 2. object model ---------- */

	// Splits a classic (qpdf-normalised) PDF into its indirect objects. Stream
	// payloads are skipped using /Length so binary data is never mis-scanned.
	function parseObjects(s) {
		const objs = [];
		const re = /(\d+)\s+(\d+)\s+obj\b/g;
		let m;
		while ((m = re.exec(s))) {
			const start = m.index;
			const afterHead = re.lastIndex;
			const sIdx = s.indexOf("stream", afterHead);
			const eIdx = s.indexOf("endobj", afterHead);
			if (eIdx < 0) break;
			let end;
			if (sIdx >= 0 && sIdx < eIdx) {
				const dict = s.slice(afterHead, sIdx);
				const lm = dict.match(/\/Length\s+(\d+)[^0-9]/);
				let dataStart = sIdx + "stream".length;
				if (s[dataStart] === "\r") dataStart++;
				if (s[dataStart] === "\n") dataStart++;
				let es = -1;
				if (lm) {
					const cand = dataStart + parseInt(lm[1], 10);
					es = s.startsWith("endstream", cand)
						? cand
						: s.indexOf("endstream", Math.max(dataStart, cand - 2));
				}
				if (es < 0) es = s.indexOf("endstream", dataStart);
				const eo = s.indexOf("endobj", es < 0 ? dataStart : es);
				if (eo < 0) break;
				end = eo + "endobj".length;
			} else {
				end = eIdx + "endobj".length;
			}
			objs.push({ num: +m[1], gen: +m[2], text: s.slice(start, end) });
			re.lastIndex = end;
		}
		return objs;
	}

	function unescapePdfString(v) {
		const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
		return v.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (mm, g) =>
			map[g] !== undefined ? map[g] : String.fromCharCode(parseInt(g, 8)));
	}

	// Image XObjects still pointing at an external file.
	function findExternals(objs) {
		const out = [];
		for (const o of objs) {
			const head = o.text.slice(0, 1500);
			if (!/\/Subtype\s*\/Image/.test(head)) continue;
			const fm = head.match(/\/F\s*\(((?:\\.|[^\\()])*)\)/);
			if (!fm) continue;
			const dictStart = o.text.indexOf("<<");
			const dictEnd = o.text.indexOf(">>");
			out.push({
				num: o.num,
				path: unescapePdfString(fm[1]),
				width: +((head.match(/\/W(?:idth)?\s+(\d+)/) || [])[1] || 0),
				height: +((head.match(/\/H(?:eight)?\s+(\d+)/) || [])[1] || 0),
				dict: dictEnd > dictStart ? o.text.slice(dictStart, dictEnd + 2) : ""
			});
		}
		return out;
	}

	function hasExternals(bytes) {
		const s = toStr(bytes.subarray(0, Math.min(bytes.length, 8e6)));
		return /\/FFilter/.test(s) && /\/F\s*[(<]/.test(s);
	}

	/* ---------- 3. assets ---------- */

	async function fetchAsset(url) {
		const r = await fetch(url, { credentials: "include" });
		if (!r.ok) throw new Error("HTTP " + r.status);
		return new Uint8Array(await r.arrayBuffer());
	}

	const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
	const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

	async function deflate(bytes) {
		const cs = new CompressionStream("deflate"); // zlib wrapper == /FlateDecode
		const stream = new Blob([bytes]).stream().pipeThrough(cs);
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	// PNG -> raw samples, losslessly: RGB plane + optional 8-bit alpha (SMask).
	async function decodePng(bytes) {
		const blob = new Blob([bytes], { type: "image/png" });
		let src, w, h;
		if (typeof createImageBitmap === "function") {
			src = await createImageBitmap(blob);
			w = src.width; h = src.height;
		} else {
			const url = URL.createObjectURL(blob);
			try {
				src = await new Promise((res, rej) => {
					const i = new Image();
					i.onload = () => res(i);
					i.onerror = rej;
					i.src = url;
				});
				w = src.naturalWidth; h = src.naturalHeight;
			} finally { URL.revokeObjectURL(url); }
		}
		const canvas = document.createElement("canvas");
		canvas.width = w; canvas.height = h;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(src, 0, 0);
		const data = ctx.getImageData(0, 0, w, h).data;
		canvas.width = canvas.height = 0;
		if (src.close) { try { src.close(); } catch (_) {} }

		const px = w * h;
		const rgb = new Uint8Array(px * 3);
		const alpha = new Uint8Array(px);
		let translucent = false;
		for (let i = 0, j = 0; i < px; i++) {
			const k = i * 4;
			rgb[j++] = data[k];
			rgb[j++] = data[k + 1];
			rgb[j++] = data[k + 2];
			const a = data[k + 3];
			alpha[i] = a;
			if (a !== 255) translucent = true;
		}
		return {
			w, h,
			rgb: await deflate(rgb),
			alpha: translucent ? await deflate(alpha) : null
		};
	}

	/* ---------- 4. object bodies ---------- */

	// Strips external-file keys and stale stream keys, leaving the picture's own
	// attributes (ColorSpace, BitsPerComponent, Decode, Interpolate, …).
	function cleanDict(dict) {
		return dict
			.replace(/\/F\s*\((?:\\.|[^\\()])*\)/, "")
			.replace(/\/FFilter\s*(\/\w+|\[[^\]]*\])/, "")
			.replace(/\/FDecodeParms\s*(<<[\s\S]*?>>|\/\w+|\[[^\]]*\]|null)/, "")
			.replace(/\/DL\s+\d+/, "")
			.replace(/\/Length\s+\d+/, "")
			.replace(/\/Filter\s*(\/\w+|\[[^\]]*\])/, "")
			.replace(/\/DecodeParms\s*(<<[\s\S]*?>>|\/\w+|\[[^\]]*\]|null)/, "")
			.replace(/\/SMask\s+\d+\s+\d+\s+R/, "")
			.replace(/^\s*<</, "")
			.replace(/>>\s*$/, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	function imageObject(num, dictBody, payload) {
		return {
			num,
			head: num + " 0 obj\n<< " + dictBody + " >>\nstream\n",
			data: payload,
			tail: "\nendstream\nendobj\n"
		};
	}

	/* ---------- 5. writer ---------- */

	// Rewrites the document: objects in order, then a fresh xref table — needed
	// because replacing payloads shifts every later offset.
	function writePdf(objs, replacements, trailerInfo) {
		const byNum = new Map(replacements.map((r) => [r.num, r]));
		const chunks = [];
		const header = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
		chunks.push(toBytes(header));
		let offset = header.length;
		const xref = new Map();
		let maxNum = 0;

		const push = (num, parts) => {
			xref.set(num, offset);
			for (const p of parts) {
				const b = typeof p === "string" ? toBytes(p) : p;
				chunks.push(b);
				offset += b.length;
			}
			if (num > maxNum) maxNum = num;
		};

		for (const o of objs) {
			const r = byNum.get(o.num);
			if (r) push(o.num, [r.head, r.data, r.tail]);
			else push(o.num, [o.text.endsWith("\n") ? o.text : o.text + "\n"]);
		}
		// extra objects (alpha SMasks) created during restore
		for (const r of replacements) {
			if (r.extra) for (const e of r.extra) push(e.num, [e.head, e.data, e.tail]);
		}

		const size = maxNum + 1;
		const startxref = offset;
		let x = "xref\n0 " + size + "\n0000000000 65535 f \n";
		for (let i = 1; i < size; i++) {
			const off = xref.get(i);
			x += off === undefined
				? "0000000000 65535 f \n"
				: String(off).padStart(10, "0") + " 00000 n \n";
		}
		x += "trailer\n<< /Size " + size + " /Root " + trailerInfo.root + " 0 R" +
			(trailerInfo.info ? " /Info " + trailerInfo.info + " 0 R" : "") +
			" >>\nstartxref\n" + startxref + "\n%%EOF\n";
		chunks.push(toBytes(x));
		return concat(chunks);
	}

	function readTrailer(s, objs) {
		let root = null, info = null;
		const t = s.lastIndexOf("trailer");
		if (t >= 0) {
			const tail = s.slice(t, t + 3000);
			root = (tail.match(/\/Root\s+(\d+)\s+\d+\s+R/) || [])[1] || null;
			info = (tail.match(/\/Info\s+(\d+)\s+\d+\s+R/) || [])[1] || null;
		}
		if (!root) {
			const cat = objs.find((o) => /\/Type\s*\/Catalog/.test(o.text.slice(0, 600)));
			if (cat) root = String(cat.num);
		}
		return { root, info };
	}

	/* ---------- entry ---------- */

	// opts: { bytes, password, decrypt(bytes, password) -> Uint8Array|null,
	//         baseUrl, onProgress(done, total) }
	// -> { ok, bytes, restored, total, skipped } | { ok:false, reason }
	async function restore(opts) {
		if (!hasExternals(opts.bytes)) return { ok: false, reason: "no-externals" };

		const rep = repairStubs(opts.bytes);
		let plain = null;
		try { plain = await opts.decrypt(rep.bytes, opts.password); } catch (_) {}
		if (!plain) return { ok: false, reason: "decrypt-failed" };

		const s = toStr(plain);
		const objs = parseObjects(s);
		if (!objs.length) return { ok: false, reason: "parse-failed" };
		const externals = findExternals(objs);
		if (!externals.length) return { ok: false, reason: "no-externals" };
		const trailerInfo = readTrailer(s, objs);
		if (!trailerInfo.root) return { ok: false, reason: "no-root" };

		let nextNum = objs.reduce((a, o) => Math.max(a, o.num), 0) + 1;
		const replacements = [];
		let done = 0, skipped = 0;

		for (const ex of externals) {
			done++;
			if (opts.onProgress) opts.onProgress(done, externals.length);
			let asset;
			try { asset = await fetchAsset(new URL(ex.path, opts.baseUrl).href); }
			catch (_) { skipped++; continue; }

			const base = cleanDict(ex.dict);
			try {
				if (isJpeg(asset)) {
					replacements.push(imageObject(ex.num,
						base + " /Filter /DCTDecode /Length " + asset.length, asset));
				} else if (isPng(asset)) {
					const png = await decodePng(asset);
					let dict = base
						.replace(/\/W(?:idth)?\s+\d+/, "/Width " + png.w)
						.replace(/\/H(?:eight)?\s+\d+/, "/Height " + png.h)
						.replace(/\/ColorSpace\s*(\/\w+|\[[^\]]*\]|\d+\s+\d+\s+R)/, "/ColorSpace /DeviceRGB")
						.replace(/\/BitsPerComponent\s+\d+/, "/BitsPerComponent 8");
					if (!/\/ColorSpace/.test(dict)) dict += " /ColorSpace /DeviceRGB";
					if (!/\/BitsPerComponent/.test(dict)) dict += " /BitsPerComponent 8";
					if (!/\/Width/.test(dict)) dict += " /Width " + png.w;
					if (!/\/Height/.test(dict)) dict += " /Height " + png.h;
					const extra = [];
					if (png.alpha) {
						const sm = nextNum++;
						dict += " /SMask " + sm + " 0 R";
						extra.push(imageObject(sm,
							"/Type /XObject /Subtype /Image /Width " + png.w +
							" /Height " + png.h + " /ColorSpace /DeviceGray" +
							" /BitsPerComponent 8 /Filter /FlateDecode /Length " + png.alpha.length,
							png.alpha));
					}
					const r = imageObject(ex.num,
						dict + " /Filter /FlateDecode /Length " + png.rgb.length, png.rgb);
					r.extra = extra;
					replacements.push(r);
				} else {
					skipped++;
				}
			} catch (_) { skipped++; }
		}

		if (!replacements.length) return { ok: false, reason: "no-assets" };
		return {
			ok: true,
			bytes: writePdf(objs, replacements, trailerInfo),
			restored: replacements.length,
			total: externals.length,
			skipped
		};
	}

	globalThis.__rdRestore = {
		hasExternals, restore,
		_internals: { repairStubs, parseObjects, findExternals, writePdf, readTrailer, cleanDict, imageObject, decodePng }
	};
})();
