/*
 * In-frame book handler — injected into Rosdistant pages together with
 * pdf.min.js (sets `pdfjsLib`) and jspdf.umd.min.js (sets `jspdf`).
 *
 * Runs inside the frame that hosts the iSpring viewer, so it has the frame's
 * cookies (to fetch the file), its localStorage (the password) and its DOM
 * (canvas + download). Exposes globalThis.__rdDownloadBook.
 *
 * Why pdf.js instead of qpdf: Rosdistant textbooks are password-protected PDFs
 * that iSpring writes off-spec on purpose (image streams declare `/Length 0`),
 * so strict tools like qpdf abort with "expected endstream". pdf.js — the same
 * engine browsers use to display them — opens them leniently. We decrypt with
 * the password, render every page, and rebuild a normal, UNLOCKED PDF that
 * opens without a password and can be forwarded freely.
 */
(() => {
	const PDFJS = (typeof pdfjsLib !== "undefined") ? pdfjsLib : (globalThis.pdfjsLib || null);
	const JSPDF = (typeof jspdf !== "undefined") ? jspdf : (globalThis.jspdf || null);

	function sanitize(name) {
		return (name || "rosdistant-book")
			.replace(/\.pdf$/i, "")
			.replace(/[\\/:*?"<>|]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120) || "rosdistant-book";
	}

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
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	function reportProgress(done, total) {
		try { chrome.runtime.sendMessage({ type: "PROGRESS", done, total }); } catch (_) {}
	}

	let workerReady = false;
	async function ensureWorker(workerUrl) {
		if (workerReady || !PDFJS) return;
		try {
			// Load the worker from a same-origin blob so the page can spawn it
			// (a chrome-extension:// worker would be cross-origin to the page).
			const code = await (await fetch(workerUrl)).text();
			const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
			PDFJS.GlobalWorkerOptions.workerSrc = blobUrl;
			workerReady = true;
		} catch (_) {
			// fall back to main-thread rendering
			try { PDFJS.GlobalWorkerOptions.workerSrc = ""; } catch (__) {}
		}
	}

	// Decrypts with pdf.js and rebuilds an unlocked image-based PDF. Returns the
	// new PDF bytes (Uint8Array), or null if it couldn't be done.
	async function rebuildUnlocked(bytes, password, workerUrl) {
		if (!PDFJS || !JSPDF || !JSPDF.jsPDF) return null;
		await ensureWorker(workerUrl);
		let doc;
		try {
			doc = await PDFJS.getDocument({ data: bytes, password: password || undefined }).promise;
		} catch (_) { return null; }

		const N = doc.numPages;
		let out = null;
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		try {
			for (let i = 1; i <= N; i++) {
				const page = await doc.getPage(i);
				const vp = page.getViewport({ scale: 2 });
				canvas.width = Math.ceil(vp.width);
				canvas.height = Math.ceil(vp.height);
				await page.render({ canvasContext: ctx, viewport: vp }).promise;
				const jpg = canvas.toDataURL("image/jpeg", 0.82);
				const wpt = (vp.width * 72) / 96;
				const hpt = (vp.height * 72) / 96;
				const orient = wpt > hpt ? "landscape" : "portrait";
				if (i === 1) out = new JSPDF.jsPDF({ unit: "pt", format: [wpt, hpt], orientation: orient });
				else out.addPage([wpt, hpt], orient);
				out.addImage(jpg, "JPEG", 0, 0, wpt, hpt);
				page.cleanup();
				reportProgress(i, N);
			}
		} catch (_) {
			if (!out) return null; // nothing usable
		}
		canvas.width = canvas.height = 0;
		try { return new Uint8Array(out.output("arraybuffer")); } catch (_) { return null; }
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

	const isPdf = (b) =>
		b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

	/* ---- iSpring Suite presentation (slides) -> text PDF via print ---- */

	function escapeHtml(s) {
		return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
	}

	// iSpring stores notes/transcript as HTML; turn it into clean plain text
	// while keeping paragraph breaks.
	function cleanNotes(h) {
		if (!h) return "";
		return h
			.replace(/<\s*(br|p|div|li|tr)[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/gi, " ").replace(/&laquo;/gi, "«").replace(/&raquo;/gi, "»")
			.replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
			.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"').replace(/&[a-z]+;/gi, " ")
			.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
	}

	// zlib(base64) -> string, used for the presentation manifest (presInfo).
	async function inflateB64(b64) {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const ds = new DecompressionStream("deflate");
		const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
		return new TextDecoder("utf-8").decode(buf);
	}

	// Returns { ok, title, subtitle, slides:[{title,notes}] } if this frame is an
	// iSpring presentation, otherwise { ok:false }.
	async function extractPresentation() {
		const html = document.documentElement.outerHTML;
		const m = html.match(/presInfo\s*=\s*"([A-Za-z0-9+/=]+)"/);
		if (!m) return { ok: false };
		let obj;
		try { obj = JSON.parse(await inflateB64(m[1])); } catch (_) { return { ok: false }; }
		if (!obj || !Array.isArray(obj.s) || !obj.s.length) return { ok: false };
		const slides = obj.s.map((s) => ({
			title: (s.t || "").trim(),
			subtitle: (s.x || "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean).join(" · "),
			notes: cleanNotes(s.n)
		}));
		const title = (document.title || slides[0].subtitle || slides[0].title || "Презентация").trim();
		return { ok: true, title, slides };
	}

	// Renders the presentation text into a real, downloadable PDF (selectable
	// Cyrillic text) using jsPDF + a bundled Roboto subset. No print dialog.
	function buildPresentationPdf(pres) {
		const fonts = globalThis.__rdFonts;
		const doc = new JSPDF.jsPDF({ unit: "pt", format: "a4", compress: true });
		let family = "helvetica";
		if (fonts && fonts.regular) {
			doc.addFileToVFS("RdReg.ttf", fonts.regular);
			doc.addFont("RdReg.ttf", "Rd", "normal");
			if (fonts.bold) { doc.addFileToVFS("RdBold.ttf", fonts.bold); doc.addFont("RdBold.ttf", "Rd", "bold"); }
			family = "Rd";
		}
		const W = doc.internal.pageSize.getWidth();
		const H = doc.internal.pageSize.getHeight();
		const M = 50;
		const maxW = W - M * 2;
		let y = M;

		function need(h) { if (y + h > H - M) { doc.addPage(); y = M; } }
		function write(text, { size, color, bold, gap, lh }) {
			doc.setFont(family, bold ? "bold" : "normal");
			doc.setFontSize(size);
			doc.setTextColor(color[0], color[1], color[2]);
			const lines = doc.splitTextToSize(text, maxW);
			const step = size * (lh || 1.4);
			for (const ln of lines) { need(step); doc.text(ln, M, y); y += step; }
			y += (gap || 0);
		}

		// title block
		write(pres.title, { size: 19, color: [17, 17, 17], bold: true, gap: 4, lh: 1.25 });
		write(pres.slides.length + " слайдов · скачано расширением «Помощь росдистантикам»",
			{ size: 10, color: [120, 120, 120], gap: 16, lh: 1.3 });

		pres.slides.forEach((s, i) => {
			need(40);
			y += 8;
			write((i + 1) + ".  " + (s.title || "Слайд " + (i + 1)),
				{ size: 14, color: [26, 58, 122], bold: true, gap: 6, lh: 1.3 });
			const text = s.notes || s.subtitle || "";
			text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
				.forEach((p) => write(p.replace(/\n/g, " "), { size: 11, color: [25, 25, 25], gap: 7, lh: 1.45 }));
		});

		return new Uint8Array(doc.output("arraybuffer"));
	}

	globalThis.__rdDownloadBook = async function (workerUrl) {
		// 1) iSpring Suite presentation (slides) -> text PDF via print
		let pres;
		try { pres = await extractPresentation(); } catch (_) { pres = { ok: false }; }
		if (pres.ok) {
			try {
				const pdf = buildPresentationPdf(pres);
				saveBytes(pdf, sanitize(pres.title) + ".pdf", "application/pdf");
				return { ok: true, mode: "presentation", slides: pres.slides.length,
					filename: sanitize(pres.title) + ".pdf" };
			} catch (e) { return { ok: false, message: e.message }; }
		}

		// 2) flip-book (iSpring viewer / PDF) or rendered images
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

		const filename = sanitize(info.title) + ".pdf";

		// decrypt + rebuild as an unlocked PDF
		try {
			const rebuilt = await rebuildUnlocked(bytes.slice(), info.password, workerUrl);
			if (rebuilt && isPdf(rebuilt)) {
				saveBytes(rebuilt, filename, "application/pdf");
				return { ok: true, mode: "file", decrypted: true, filename, password: null };
			}
		} catch (_) {}

		// could not unlock — save the original and surface the password
		saveBytes(bytes, filename, "application/pdf");
		return { ok: true, mode: "file", decrypted: false, filename, password: info.password || null };
	};
})();
