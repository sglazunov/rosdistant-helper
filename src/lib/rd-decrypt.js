/*
 * In-frame book handler — injected into Rosdistant pages.
 *
 * Runs inside the frame that hosts the iSpring viewer, so it has the frame's
 * cookies (for fetching the file), its localStorage (for the password) and its
 * DOM (for triggering the download). Exposes globalThis.__rdDownloadBook.
 *
 * Flow: read fileOpenParams + password -> fetch the PDF with the session ->
 * ask the background worker to strip the password with qpdf (decryption runs in
 * the extension context, immune to the page's CSP) -> save the UNLOCKED copy,
 * which opens without a password and can be forwarded freely.
 */
(() => {
	const isPdf = (b) =>
		b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

	// Compact, JSON-safe transport for binary across runtime messaging.
	function bytesToB64(bytes) {
		let bin = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(bin);
	}
	function b64ToBytes(b64) {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

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

	// Asks the background worker to remove the password. Returns unlocked bytes
	// (Uint8Array) or null. Decryption runs in the extension context, so it is
	// not affected by the page's Content-Security-Policy.
	function requestDecrypt(bytes, password) {
		return new Promise((resolve) => {
			let done = false;
			const finish = (v) => { if (!done) { done = true; resolve(v); } };
			try {
				chrome.runtime.sendMessage(
					{ type: "DECRYPT_PDF", b64: bytesToB64(bytes), password },
					(resp) => {
						if (chrome.runtime.lastError) return finish(null);
						finish(resp && resp.ok && resp.b64 ? b64ToBytes(resp.b64) : null);
					}
				);
			} catch (_) { finish(null); }
			// safety timeout in case the worker never answers
			setTimeout(() => finish(null), 60000);
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

	globalThis.__rdDownloadBook = async function () {
		const info = extract();
		if (!info.ok) return { skip: true };

		if (info.type === "images" && info.images.length) {
			try {
				printImages(info.images, info.title);
				return { ok: true, mode: "images", decrypted: false,
					password: info.password || null, pages: info.images.length };
			} catch (e) { return { ok: false, message: e.message }; }
		}

		// file mode — fetch with the page session (cookies)
		let bytes;
		try {
			const r = await fetch(info.filePath, { credentials: "include" });
			if (!r.ok) throw new Error("HTTP " + r.status);
			bytes = new Uint8Array(await r.arrayBuffer());
		} catch (e) {
			return { ok: false, mode: "file", fetchFailed: true,
				filePath: info.filePath, password: info.password || null, message: e.message };
		}

		// strip the password in the background (immune to page CSP)
		let decrypted = false;
		if (info.password && isPdf(bytes)) {
			const out = await requestDecrypt(bytes, info.password);
			if (out && isPdf(out)) { bytes = out; decrypted = true; }
		}

		const filename = sanitize(info.title) + ".pdf";
		saveBytes(bytes, filename, "application/pdf");
		return {
			ok: true, mode: "file", decrypted, filename,
			password: decrypted ? null : (info.password || null)
		};
	};
})();
