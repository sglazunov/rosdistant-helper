/*
 * SCORM textbooks (Moodle mod_scorm, /mod/scorm/player.php).
 *
 * Rosdistant also serves lectures as SCORM packages built with «Конструктор
 * электронных курсов v5» (CEv5_* / EC_* templates): a Vue app (index.html +
 * js/*.js) that renders everything from json/rawStructure.json. We read that
 * JSON directly — every longread, slide, list, quote, both sides of flip cards,
 * images — and build a PDF with selectable text. Unlike a DOM snapshot this
 * captures the WHOLE course, not just the longread currently on screen.
 *
 * Packages from other authoring tools (no rawStructure.json) fall back to a
 * self-contained HTML snapshot of the rendered page.
 *
 * Exposes globalThis.__rdScorm = { isScormFrame, exportScorm, collectCourse }.
 * Runs in the SCORM content frame (…/mod_scorm/content/N/…), injected with
 * jspdf.umd.min.js (sets `jspdf`) and rd-fonts.js (sets `__rdFonts`).
 */
(() => {
	const SCORM_RE = /\/mod_scorm\/content\/\d+\//;

	function scormBase(href) {
		const clean = String(href || "").split("#")[0].split("?")[0];
		const m = clean.match(SCORM_RE);
		return m ? clean.slice(0, m.index + m[0].length) : null;
	}

	/* ---------- text helpers ---------- */

	const ENT = {
		nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", amp: "&", lt: "<",
		gt: ">", quot: '"', apos: "'", hellip: "…", bull: "•", rsquo: "’", lsquo: "‘",
		rdquo: "”", ldquo: "“", bdquo: "„", times: "×", deg: "°", copy: "©",
		reg: "®", minus: "-", rarr: "->", larr: "<-", shy: "", middot: "·"
	};

	function decode(s) {
		return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
			if (e[0] === "#") {
				const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				try { return Number.isFinite(c) ? String.fromCodePoint(c) : " "; } catch (_) { return " "; }
			}
			const v = ENT[e.toLowerCase()];
			return v !== undefined ? v : " ";
		});
	}

	// Keep only glyphs our bundled Roboto subset has (Latin-1, Cyrillic, common
	// punctuation): drop stress marks (Де́ннис -> Деннис), map arrows etc.
	function fitFont(s) {
		return String(s)
			.normalize("NFC")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[→⟶➜⇒]/g, "->")
			.replace(/[←⇐]/g, "<-")
			.replace(/−/g, "-")
			.replace(/[  -​ ]/g, " ")
			.replace(/[‌-‏⁠﻿]/g, "");
	}

	// CMS rich text (p/ul/ol/li/h*/blockquote/br/span/strong) -> lines.
	function htmlToLines(html) {
		let h = String(html || "");
		if (!/[<&]/.test(h)) {
			return h.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((t) => ({ t, kind: "p" }));
		}
		h = h.replace(/\r/g, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
		// a short paragraph that is bold as a whole acts as a sub-heading
		h = h.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, inner) => {
			const core = inner.replace(/<\/?span[^>]*>/gi, "").replace(/&nbsp;/gi, " ").trim();
			const whole = /^<(strong|b)\b[^>]*>[\s\S]*<\/\1>$/i.test(core) &&
				!/<\/(strong|b)>[\s\S]*?[^\s<][\s\S]*?<(strong|b)\b/i.test(core);
			const len = core.replace(/<[^>]+>/g, "").trim().length;
			return whole && len > 0 && len <= 120 ? "\n\u0003" + inner + "\n" : m;
		});
		h = h.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (m, inner) => {
			let n = 0;
			return "\n" + inner.replace(/<li[^>]*>/gi, () => "\n\u0004" + (++n) + ". ") + "\n";
		});
		h = h.replace(/<li[^>]*>/gi, "\n\u0004• ")
			.replace(/<h[1-6][^>]*>/gi, "\n\u0003")
			.replace(/<blockquote[^>]*>/gi, "\n\u0005")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|ul|ol|table)>/gi, "\n")
			.replace(/<(p|div|tr|ul|table)(\s[^>]*)?>/gi, "\n")
			.replace(/<\/?(td|th)[^>]*>/gi, " ")
			.replace(/<[^>]+>/g, "");
		h = decode(h);

		const out = [];
		let prefix = null; // "• " / "3. " left alone on its line (<li><p>…)
		for (let raw of h.split("\n")) {
			let kind = "p";
			if (raw.includes("\u0003")) kind = "h";
			else if (raw.includes("\u0004")) kind = "li";
			else if (raw.includes("\u0005")) kind = "q";
			let line = raw.replace(/[\u0003\u0004\u0005]/g, "")
				.replace(/_{3,}/g, " ") // decorative "______" rules / underline prefixes
				.replace(/[ \t]+/g, " ").trim();
			if (!line) continue;
			if (/^(•|\d+\.)$/.test(line)) { prefix = line + " "; continue; }
			if (/^[\s\-–—=*·.]+$/.test(line)) continue;
			if (prefix) { line = prefix + line; kind = "li"; prefix = null; }
			out.push({ t: line, kind });
		}
		return out;
	}

	/* ---------- rawStructure.json -> blocks ---------- */

	// field -> role of its text
	const TEXT_KEYS = {
		title: "h3", heading: "h3", subtitle: "h3",
		question: "p", text: "p", description: "p",
		caption: "cap", author: "author", answer: "li"
	};
	const IMAGE_KEYS = new Set(["image", "src", "background", "backgroundImage", "picture", "img", "photo"]);
	const SKIP_KEYS = new Set([
		"config", "settings", "style", "styles", "id", "type", "component", "editorTemplate",
		"longreadNextNavigation", "longreadPrevNavigation", "btnText", "side", "color", "icon",
		"redirect", "objectives", "sfid", "theme", "fonts", "navigation", "link", "url", "href",
		"alt", "entry", "success", "fail", "result", "results", "feedback", "retry"
	]);
	// template placeholders / decorative assets that carry no content
	const PLACEHOLDER_RE = /template-image|default-image|placeholder|\/color\/|\/icons?\//i;
	// reading order inside a slide (e.g. flip card: front before back)
	const KEY_ORDER = ["title", "heading", "subtitle", "image", "front", "question", "text",
		"caption", "items", "list", "cards", "author", "back"];
	const SKIP_COMPONENTS = new Set(["contents", "feedback"]);

	function orderedKeys(o) {
		const rank = (k) => { const i = KEY_ORDER.indexOf(k); return i < 0 ? 99 : i; };
		return Object.keys(o).sort((a, b) => rank(a) - rank(b));
	}

	// stock texts of empty template fields
	const PLACEHOLDER_TEXT = new Set([
		"Описание к изображению", "Подпись к изображению", "Введите текст", "Введите заголовок"
	]);

	// ctx: { role: "h3"|"li"|"q" (overrides plain paragraphs), prefix: "• "/"3. " for
	// the first line of a list item — consumed once }
	function pushLines(out, html, kind0, ctx) {
		for (const l of htmlToLines(html)) {
			if (PLACEHOLDER_TEXT.has(l.t)) continue;
			let kind = l.kind === "p" ? kind0 : l.kind; // keep <h*>/<li>/<blockquote> from the HTML
			let t = l.t;
			if (ctx && ctx.prefix) { t = ctx.prefix + t; kind = "li"; ctx.prefix = null; }
			out.push({ kind, t });
		}
	}

	function walk(node, out, key, ctx) {
		ctx = ctx || {};
		if (node == null) return;
		if (typeof node === "string") {
			if (IMAGE_KEYS.has(key)) {
				if (/\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(node) && !PLACEHOLDER_RE.test(node)) {
					out.push({ kind: "img", src: node });
				}
				return;
			}
			const role = TEXT_KEYS[key];
			if (!role) return;
			if (role === "author") { pushLines(out, node, "author", ctx); return; }
			const kind = role === "h3" ? "h3" : (ctx.role || (role === "p" ? "p" : role));
			pushLines(out, node, kind, ctx);
			return;
		}
		if (Array.isArray(node)) {
			// test answers -> bullet list (correctness flags are deliberately not exported)
			if (key === "answers") { node.forEach((a) => walk(a, out, "", { role: "li", prefix: "• " })); return; }
			for (const x of node) walk(x, out, key, ctx);
			return;
		}
		if (typeof node === "object") {
			const tpl = node.template || node.name;
			// bullet / numbered lists: items[].text, list type in theme.listType
			if (tpl === "CEv5_Template_List_Block" && Array.isArray(node.items)) {
				const th = node.theme || {};
				if (th.hasListTitle && th.listTitle) pushLines(out, th.listTitle, "h3");
				const numbered = th.listType === "number";
				node.items.forEach((it, i) =>
					walk(it, out, "", { role: "li", prefix: numbered ? (i + 1) + ". " : "• " }));
				return;
			}
			const isQuote = tpl === "CEv5_Template_Quote";
			const noCaption = node.theme && node.theme.hasDescription === false;
			for (const k of orderedKeys(node)) {
				if (SKIP_KEYS.has(k)) continue;
				if (k === "caption" && noCaption) continue;
				let c = ctx;
				if (k === "front") c = { role: "h3" };       // flip card: term in bold
				else if (k === "back") c = {};               // …definition below it
				else if (isQuote && k === "text") c = { role: "q" };
				walk(node[k], out, k, c);
			}
		}
	}

	function collectCourse(json) {
		const blocks = [];
		let title = "";
		const visit = (item) => {
			if (!item || SKIP_COMPONENTS.has(item.component)) return;
			if (item.type === "slide") { walk(item.content, blocks, ""); return; }
			if (item.type === "test") {
				const at = blocks.length;
				blocks.push({ kind: "h3", t: "Вопрос для самопроверки" });
				if (typeof item.text === "string") walk(item.text, blocks, "text");
				walk(item.content, blocks, "");
				if (blocks.length === at + 1) blocks.pop();
				return;
			}
			const kids = (item.items || []).filter((k) => k && !SKIP_COMPONENTS.has(k.component));
			if (!kids.length && !item.content) return;
			if (item.name) blocks.push({ kind: "h2", t: String(item.name).trim() });
			if (item.content) walk(item.content, blocks, "");
			kids.forEach(visit);
		};
		for (const course of (json && json.courses) || []) {
			if (!title && course.name) title = String(course.name).trim();
			(course.items || []).forEach(visit);
		}
		// drop consecutive duplicates (some templates repeat the same text/image)
		const dedup = [];
		for (const b of blocks) {
			const p = dedup[dedup.length - 1];
			if (p && p.kind === b.kind && p.t === b.t && p.src === b.src) continue;
			dedup.push(b);
		}
		// drop section headings that ended up with no content after them
		const clean = dedup.filter((b, i) => !(b.kind === "h2" && (!dedup[i + 1] || dedup[i + 1].kind === "h2")));
		return { title, blocks: clean };
	}

	/* ---------- images ---------- */

	async function loadImage(url) {
		try {
			const r = await fetch(url, { credentials: "include" });
			if (!r.ok) return null;
			const obj = URL.createObjectURL(await r.blob());
			try {
				const img = await new Promise((res, rej) => {
					const i = new Image();
					i.onload = () => res(i);
					i.onerror = rej;
					i.src = obj;
				});
				let w = img.naturalWidth || img.width;
				let h = img.naturalHeight || img.height;
				if (!w || !h) { w = 800; h = 600; } // SVG without intrinsic size
				const k = Math.min(1, 1600 / w);
				const cw = Math.max(1, Math.round(w * k));
				const ch = Math.max(1, Math.round(h * k));
				const c = document.createElement("canvas");
				c.width = cw; c.height = ch;
				const ctx = c.getContext("2d");
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, cw, ch);
				ctx.drawImage(img, 0, 0, cw, ch);
				const data = c.toDataURL("image/jpeg", 0.85);
				c.width = c.height = 0;
				return { data, w: cw, h: ch };
			} finally {
				URL.revokeObjectURL(obj);
			}
		} catch (_) { return null; }
	}

	/* ---------- PDF ---------- */

	async function buildPdf(title, blocks, base, onProgress) {
		const J = globalThis.jspdf;
		if (!J || !J.jsPDF) throw new Error("jsPDF не загружен");
		const F = globalThis.__rdFonts;
		const doc = new J.jsPDF({ unit: "pt", format: "a4", compress: true });
		let fam = "helvetica";
		if (F && F.regular) {
			doc.addFileToVFS("RdReg.ttf", F.regular);
			doc.addFont("RdReg.ttf", "Rd", "normal");
			if (F.bold) { doc.addFileToVFS("RdBold.ttf", F.bold); doc.addFont("RdBold.ttf", "Rd", "bold"); }
			fam = "Rd";
		}
		const W = doc.internal.pageSize.getWidth();
		const H = doc.internal.pageSize.getHeight();
		const M = 50;
		const maxW = W - M * 2;
		let y = M;

		const need = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
		const write = (text, o) => {
			doc.setFont(fam, o.bold ? "bold" : "normal");
			doc.setFontSize(o.size);
			doc.setTextColor(o.color[0], o.color[1], o.color[2]);
			const indent = o.indent || 0;
			const lines = doc.splitTextToSize(fitFont(text), maxW - indent);
			const step = o.size * (o.lh || 1.4);
			for (const ln of lines) { need(step); doc.text(ln, M + indent, y); y += step; }
			y += o.gap || 0;
		};

		write(title, { size: 19, color: [17, 17, 17], bold: true, gap: 4, lh: 1.25 });
		write("Скачано расширением «Росдистант Помощник»", { size: 10, color: [120, 120, 120], gap: 14, lh: 1.3 });

		const cache = new Map();
		const total = blocks.filter((b) => b.kind === "img").length;
		let done = 0;
		for (const b of blocks) {
			switch (b.kind) {
				case "h2":
					need(52); y += 10;
					write(b.t, { size: 16, color: [26, 58, 122], bold: true, gap: 8, lh: 1.3 });
					break;
				case "h":
				case "h3":
					need(32); y += 4;
					write(b.t, { size: 12.5, color: [20, 20, 20], bold: true, gap: 5, lh: 1.35 });
					break;
				case "li":
					write(b.t, { size: 11, color: [25, 25, 25], indent: 14, gap: 3, lh: 1.42 });
					break;
				case "q":
					write(b.t, { size: 11, color: [55, 60, 95], indent: 18, gap: 6, lh: 1.45 });
					break;
				case "author":
					write("— " + b.t, { size: 10, color: [110, 110, 110], indent: 18, gap: 8, lh: 1.35 });
					break;
				case "cap":
					write(b.t, { size: 9.5, color: [110, 110, 110], gap: 6, lh: 1.35 });
					break;
				case "img": {
					let url;
					try { url = new URL(b.src, base).href; } catch (_) { break; }
					if (!cache.has(url)) cache.set(url, await loadImage(url));
					const im = cache.get(url);
					done++;
					if (onProgress) onProgress(done, total);
					if (!im || im.w < 48 || im.h < 32) break;
					let w = Math.min(maxW, im.w * 0.75);
					let h = im.h * (w / im.w);
					const maxH = H - M * 2 - 10;
					if (h > maxH) { h = maxH; w = im.w * (h / im.h); }
					need(h + 10);
					doc.addImage(im.data, "JPEG", M + (maxW - w) / 2, y, w, h);
					y += h + 12;
					break;
				}
				default:
					write(b.t, { size: 11, color: [25, 25, 25], gap: 6, lh: 1.45 });
			}
		}
		return new Uint8Array(doc.output("arraybuffer"));
	}

	/* ---------- fallback: self-contained HTML snapshot ---------- */

	async function snapshotHtml() {
		const here = location.href;
		const abs = (u, b) => { try { return new URL(u, b || here).href; } catch (_) { return u; } };
		const toData = async (url) => {
			try {
				const r = await fetch(url, { credentials: "include" });
				if (!r.ok) return null;
				const blob = await r.blob();
				return await new Promise((res) => {
					const fr = new FileReader();
					fr.onload = () => res(fr.result);
					fr.onerror = () => res(null);
					fr.readAsDataURL(blob);
				});
			} catch (_) { return null; }
		};
		const inlineCss = async (css, cssUrl) => {
			const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
			const cache = new Map();
			let out = "";
			let last = 0;
			let m;
			while ((m = re.exec(css))) {
				out += css.slice(last, m.index);
				last = re.lastIndex;
				const u = m[2].trim();
				if (/^(data:|#|about:)/i.test(u)) { out += m[0]; continue; }
				const a = abs(u, cssUrl);
				if (!cache.has(a)) cache.set(a, await toData(a));
				const d = cache.get(a);
				out += d ? 'url("' + d + '")' : 'url("")';
			}
			return out + css.slice(last);
		};

		const root = document.documentElement.cloneNode(true);
		root.querySelectorAll("script, noscript, iframe, object, embed, link[rel=modulepreload], link[rel=preload], link[rel=prefetch]")
			.forEach((n) => n.remove());
		root.querySelectorAll("*").forEach((el) => {
			for (const at of [...el.attributes]) if (/^on/i.test(at.name)) el.removeAttribute(at.name);
		});
		root.querySelectorAll(".preloader-wrapper, .preloader, .header, .navigation-menu").forEach((n) => n.remove());
		root.querySelectorAll(".accordion-item").forEach((n) => n.classList.add("accordion-item--active"));
		root.querySelectorAll("details:not([open])").forEach((d) => d.setAttribute("open", ""));

		for (const link of [...root.querySelectorAll('link[rel~="stylesheet"]')]) {
			const href = link.getAttribute("href");
			let css = "";
			if (href) {
				const a = abs(href);
				try { const r = await fetch(a, { credentials: "include" }); if (r.ok) css = await inlineCss(await r.text(), a); } catch (_) {}
			}
			const st = document.createElement("style");
			st.textContent = css;
			link.replaceWith(st);
		}
		for (const st of root.querySelectorAll("style")) {
			if (st.textContent.includes("url(")) st.textContent = await inlineCss(st.textContent, here);
		}
		for (const img of root.querySelectorAll("img[src]")) {
			const s = img.getAttribute("src");
			if (!s || s.startsWith("data:")) continue;
			const d = await toData(abs(s));
			if (d) { img.setAttribute("src", d); img.removeAttribute("srcset"); img.removeAttribute("loading"); }
		}
		for (const el of root.querySelectorAll('[style*="url("]')) {
			el.setAttribute("style", await inlineCss(el.getAttribute("style"), here));
		}

		const fix = document.createElement("style");
		fix.textContent =
			"html,body{overflow:auto!important;height:auto!important;max-height:none!important;position:static!important}" +
			"#player,.player__wrapper,.content,.content__main,.longread,.slide,.slide__inner,.longread-content{height:auto!important;max-height:none!important;overflow:visible!important;position:static!important}" +
			"*{user-select:text!important;-webkit-user-select:text!important}" +
			".flip-card{min-height:0!important}.flip-card__inner{transform:none!important;position:relative!important}" +
			".flip-card__content{position:static!important;transform:none!important;backface-visibility:visible!important;-webkit-backface-visibility:visible!important;height:auto!important;margin-bottom:12px}" +
			".accordion-body,.accordion-item__body,.CEv5-accordion .accordion-content{height:auto!important;max-height:none!important;overflow:visible!important}";
		const head = root.querySelector("head");
		if (head) head.appendChild(fix);
		return "<!DOCTYPE html>\n" + root.outerHTML;
	}

	/* ---------- entry ---------- */

	function composeTitle(name) {
		let top = "";
		try { top = (window.top.document.title || "").trim(); } catch (_) {}
		name = (name || "").trim();
		if (top && name && !top.includes(name) && !/^(scorm|курс)$/i.test(top)) return top + " — " + name;
		return name || top || "Учебник Росдистант";
	}

	function isScormFrame() {
		return !!scormBase(location.href);
	}

	// -> { ok, kind:"pdf", bytes, title, sections } | { ok, kind:"html", html, title } | { ok:false }
	async function exportScorm(onProgress) {
		const base = scormBase(location.href);
		if (!base) return { ok: false };
		let json = null;
		try {
			const r = await fetch(base + "json/rawStructure.json", { credentials: "include", cache: "no-cache" });
			if (r.ok) json = await r.json();
		} catch (_) {}
		if (json && Array.isArray(json.courses) && json.courses.length) {
			const { title, blocks } = collectCourse(json);
			if (blocks.some((b) => b.kind !== "h2")) {
				const name = composeTitle(title);
				const bytes = await buildPdf(name, blocks, base, onProgress);
				return { ok: true, kind: "pdf", bytes, title: name, sections: blocks.filter((b) => b.kind === "h2").length };
			}
		}
		return { ok: true, kind: "html", html: await snapshotHtml(), title: composeTitle(document.title) };
	}

	globalThis.__rdScorm = { isScormFrame, exportScorm, collectCourse, htmlToLines, fitFont, scormBase };
})();
