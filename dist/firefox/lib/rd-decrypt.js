/*
 * In-frame book handler — injected into Rosdistant pages alongside qpdf.js.
 *
 * Runs inside the frame that actually hosts the iSpring viewer, so it has the
 * frame's cookies (for fetching the file), its localStorage (for the password)
 * and its DOM (for triggering the download). Exposes globalThis.__rdDownloadBook
 * which the background worker calls.
 *
 * Flow: read fileOpenParams + password -> fetch the PDF with the session ->
 * decrypt it with qpdf-wasm using that password -> save an UNLOCKED copy that
 * opens without any password and can be forwarded freely.
 */
(() => {
	// qpdf.js (injected just before this file) declares a global `Module` factory.
	const QPDF = (typeof Module !== "undefined") ? Module : (globalThis.Module || null);

	const isPdf = (b) =>
		b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

	function sanitize(name) {
		return (name || "rosdistant-book")
			.replace(/\.pdf$/i, "")
			.replace(/[\\/:*?"<>|]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120) || "rosdistant-book";
	}

	// iSpring stores the document password as part of a storage key, e.g.
	// "ispring::book/<PASSWORD>". Scan both localStorage and sessionStorage with
	// a couple of key shapes and return the most recently updated match.
	function scanStore(store) {
		let best = null;
		try {
			for (let i = 0; i < store.length; i++) {
				const k = store.key(i);
				if (!k) continue;
				const km = k.match(/ispring::book\/(.+)$/) || k.match(/ispring.*book[\/:]+(.+)$/i);
				if (!km) continue;
				let u = 0;
				try { u = (JSON.parse(JSON.parse(store.getItem(k))) || {}).updated || 0; } catch (_) {}
				if (!best || u > best.u) best = { p: km[1], u };
			}
		} catch (_) {}
		return best;
	}

	function findPassword() {
		let best = null;
		try { best = scanStore(window.localStorage); } catch (_) {}
		if (!best) { try { best = scanStore(window.sessionStorage); } catch (_) {} }
		return best && best.p ? best.p : null;
	}

	// Reads the iSpring descriptor + page images + stored password from this frame.
	function extract() {
		const out = {
			ok: false, type: "none",
			title: document.title || "rosdistant-book",
			filePath: null, images: [], password: null
		};
		const html = document.documentElement.outerHTML;
		const isISpring = !!document.querySelector('script[src*="viewer.js"]') ||
			/var\s+fileOpenParams\s*=/.test(html);
		if (!isISpring) return out;

		const m = html.match(/var\s+fileOpenParams\s*=\s*(\{[\s\S]*?\});/);
		if (m) {
			try {
				const b = JSON.parse(m[1]);
				if (b && b.filePath) {
					out.filePath = new URL(b.filePath, location.href).href;
					out.type = "file";
					out.ok = true;
					if (b.title) out.title = b.title;
				}
			} catch (_) {}
		}

		const imgs = Array.from(document.images)
			.map((i) => i.currentSrc || i.src)
			.filter((s) => s && /\/(res|data|pages?|slides?)\//i.test(s));
		out.images = Array.from(new Set(imgs)).map((s) => new URL(s, location.href).href);

		out.password = findPassword();

		if (!out.ok && out.images.length) { out.type = "images"; out.ok = true; }
		return out;
	}

	function saveBytes(bytes, filename, mime) {
		const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.style.display = "none";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 15000);
	}

	// Removes the password from `input` using qpdf-wasm. Returns the unlocked
	// bytes, or null if decryption was not possible.
	function qpdfDecrypt(wasmBinary, input, password) {
		return new Promise((resolve) => {
			if (!QPDF) return resolve(null);
			const opts = {
				noInitialRun: true,
				print: () => {},
				printErr: () => {},
				instantiateWasm: (imports, cb) => {
					WebAssembly.instantiate(wasmBinary, imports)
						.then((o) => cb(o.instance, o.module))
						.catch(() => cb(null));
					return {};
				}
			};
			Promise.resolve().then(() => QPDF(opts)).then((m) => {
				try {
					m.FS.writeFile("in.pdf", input);
					try { m.callMain(["--decrypt", "--password=" + password, "in.pdf", "out.pdf"]); } catch (_) {}
					let o = null;
					try { o = m.FS.readFile("out.pdf"); } catch (_) {}
					resolve(o);
				} catch (_) { resolve(null); }
			}).catch(() => resolve(null));
		});
	}

	function printImages(images, title) {
		const body = images
			.map((s) => '<img src="' + s + '" style="display:block;width:100%;page-break-after:always;">')
			.join("\n");
		const doc = '<!doctype html><meta charset="utf-8"><title>' + (title || "book") +
			'</title><style>@page{margin:0}body{margin:0}img{max-width:100%}</style>' + body;
		const ifr = document.createElement("iframe");
		ifr.style.cssText = "visibility:hidden;display:none;";
		document.body.appendChild(ifr);
		ifr.src = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
		ifr.onload = () => setTimeout(() => {
			ifr.focus();
			ifr.contentWindow.print();
			setTimeout(() => ifr.remove(), 1000);
		}, 400);
	}

	globalThis.__rdDownloadBook = async function (wasmUrl) {
		const info = extract();
		if (!info.ok) return { skip: true };

		if (info.type === "images" && info.images.length) {
			try {
				printImages(info.images, info.title);
				return { ok: true, mode: "images", decrypted: false,
					password: info.password || null, pages: info.images.length };
			} catch (e) { return { ok: false, message: e.message }; }
		}

		// file mode
		let bytes;
		try {
			const r = await fetch(info.filePath, { credentials: "include" });
			if (!r.ok) throw new Error("HTTP " + r.status);
			bytes = new Uint8Array(await r.arrayBuffer());
		} catch (e) {
			return { ok: false, mode: "file", fetchFailed: true,
				filePath: info.filePath, password: info.password || null, message: e.message };
		}

		let decrypted = false;
		if (info.password && isPdf(bytes)) {
			try {
				const wb = await (await fetch(wasmUrl)).arrayBuffer();
				const out = await qpdfDecrypt(wb, bytes, info.password);
				if (out && isPdf(out)) { bytes = out; decrypted = true; }
			} catch (_) {}
		}

		const filename = sanitize(info.title) + ".pdf";
		saveBytes(bytes, filename, "application/pdf");
		return {
			ok: true, mode: "file", decrypted, filename,
			password: decrypted ? null : (info.password || null)
		};
	};
})();
