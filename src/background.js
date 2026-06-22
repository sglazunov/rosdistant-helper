/*
 * Помощь росдистантикам — Rosdistant Helper
 * Background service worker / event page.
 *
 * Centralises all privileged work: injecting extraction code into Rosdistant
 * pages, opening links in the user's authenticated session, and saving files
 * through the downloads API (which automatically reuses the session cookies,
 * so password-protected textbooks download just like in the browser).
 *
 * Works in Chrome/Yandex/Edge/Opera (service_worker) and Firefox (scripts).
 */

const api = (typeof browser !== "undefined") ? browser : chrome;

/* ----------------------------------------------------------------------- *
 *  Injectable functions
 *  These are serialised and executed inside the Rosdistant page. They must
 *  be fully self-contained (no references to anything outside their body).
 * ----------------------------------------------------------------------- */

// Reads the iSpring book descriptor that Rosdistant embeds on a textbook page
// and returns enough information to download the source file (and, as a
// fallback, the rendered page images).
function inj_extractBook() {
	const result = {
		ok: false,
		type: "none", // "file" | "images" | "none"
		title: document.title || "rosdistant-book",
		filePath: null,
		images: [],
		message: ""
	};

	const docHTML = document.documentElement.outerHTML;
	const isISpring = !!document.querySelector('script[src*="viewer.js"]') ||
		/var\s+fileOpenParams\s*=/.test(docHTML);

	if (!isISpring) {
		result.message = "На этой странице не найден просмотрщик учебника iSpring.";
		return result;
	}

	// Pull out: var fileOpenParams = {...};
	const m = docHTML.match(/var\s+fileOpenParams\s*=\s*(\{[\s\S]*?\});/);
	if (m) {
		try {
			const book = JSON.parse(m[1]);
			if (book && book.filePath) {
				result.filePath = new URL(book.filePath, location.href).href;
				result.type = "file";
				result.ok = true;
				if (book.title) result.title = book.title;
			}
		} catch (e) {
			result.message = "Не удалось разобрать параметры учебника: " + e.message;
		}
	}

	// Fallback: collect every rendered page image inside the viewer so the
	// popup can still assemble a printable PDF if the source file is gone.
	const imgs = Array.from(document.images)
		.map((img) => img.currentSrc || img.src)
		.filter((src) => src && /\/(res|data|pages?|slides?)\//i.test(src));
	result.images = Array.from(new Set(imgs))
		.map((src) => new URL(src, location.href).href);

	if (!result.ok && result.images.length) {
		result.type = "images";
		result.ok = true;
		result.message = "Прямой файл не найден — собраны изображения страниц.";
	}

	if (!result.ok && !result.message) {
		result.message = "Учебник найден, но ссылка на файл недоступна. " +
			"Откройте сам учебник (не оглавление) и повторите.";
	}
	return result;
}

// Original "Export Test" — saves the finished test as a styled HTML file.
function inj_exportTestHtml() {
	const breadcrumbNav = document.querySelector("div.breadcrumb-nav");
	const testForm = document.querySelector("form.questionflagsaveform");
	if (!testForm || !breadcrumbNav) return { ok: false, message: "Страница с тестом не найдена." };

	let html = '<meta charset="utf-8" />\n';
	html += '<link rel="stylesheet" type="text/css" href="https://edu.rosdistant.ru/theme/styles.php/lambda/1698921777_1634732626/all" />\n';
	html += '<style>.formulation input[type="text"],.formulation select{min-width:300px;}</style>\n';
	html += breadcrumbNav.outerHTML + "\n" + testForm.outerHTML;

	const uuid = "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
		(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
	const blob = new Blob([html], { type: "text/html;charset=UTF-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.download = uuid + ".html";
	a.style.display = "none";
	a.href = url;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	return { ok: true };
}

// Original "Export to PDF" — opens the print dialog on the rendered test.
function inj_exportTestPrint() {
	const breadcrumbNav = document.querySelector("div.breadcrumb-nav");
	const testForm = document.querySelector("form.questionflagsaveform");
	if (!testForm || !breadcrumbNav) return { ok: false, message: "Страница с тестом не найдена." };

	let html = '<meta charset="utf-8" />\n';
	html += '<link rel="stylesheet" type="text/css" href="https://edu.rosdistant.ru/theme/styles.php/lambda/1698921777_1634732626/all" />\n';
	html += '<style>.formulation input[type="text"],.formulation select{min-width:300px;}</style>\n';
	html += breadcrumbNav.outerHTML + "\n" + testForm.outerHTML;

	const iframe = document.createElement("iframe");
	const blob = new Blob([html], { type: "text/html; charset=utf-8" });
	iframe.style.cssText = "visibility:hidden;display:none;";
	document.body.appendChild(iframe);
	iframe.src = URL.createObjectURL(blob);
	iframe.onload = () => setTimeout(() => {
		iframe.focus();
		iframe.contentWindow.print();
		document.body.removeChild(iframe);
	}, 150);
	return { ok: true };
}

// Fallback "book → PDF": render the collected page images into a printable
// document and open the print dialog so the user can "Save as PDF".
function inj_printImages(images, title) {
	if (!images || !images.length) return { ok: false, message: "Изображения страниц не найдены." };
	const body = images.map((src) =>
		'<img src="' + src + '" style="display:block;width:100%;page-break-after:always;" />').join("\n");
	const html = '<!doctype html><meta charset="utf-8"><title>' + (title || "book") +
		'</title><style>@page{margin:0}body{margin:0}img{max-width:100%}</style>' + body;

	const iframe = document.createElement("iframe");
	const blob = new Blob([html], { type: "text/html; charset=utf-8" });
	iframe.style.cssText = "visibility:hidden;display:none;";
	document.body.appendChild(iframe);
	iframe.src = URL.createObjectURL(blob);
	iframe.onload = () => setTimeout(() => {
		iframe.focus();
		iframe.contentWindow.print();
		setTimeout(() => document.body.removeChild(iframe), 1000);
	}, 400);
	return { ok: true };
}

/* ----------------------------------------------------------------------- *
 *  Helpers
 * ----------------------------------------------------------------------- */

function sanitizeFilename(name) {
	return (name || "rosdistant-book")
		.replace(/[\\/:*?"<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120) || "rosdistant-book";
}

function extOf(url) {
	try {
		const path = new URL(url).pathname;
		const dot = path.lastIndexOf(".");
		if (dot > -1 && dot > path.lastIndexOf("/")) return path.slice(dot);
	} catch (_) {}
	return ".pdf";
}

function execInTab(tabId, func, args) {
	return new Promise((resolve, reject) => {
		api.scripting.executeScript(
			{ target: { tabId, allFrames: true }, func, args: args || [] },
			(results) => {
				const err = api.runtime.lastError;
				if (err) return reject(new Error(err.message));
				resolve(results || []);
			}
		);
	});
}

// Picks the first frame that actually found a book.
function pickBookResult(results) {
	for (const r of results) {
		if (r && r.result && r.result.ok) return r.result;
	}
	// none ok — return the most informative failure
	for (const r of results) {
		if (r && r.result) return r.result;
	}
	return { ok: false, type: "none", message: "Учебник на странице не найден." };
}

function downloadUrl(url, filename) {
	return new Promise((resolve, reject) => {
		api.downloads.download({ url, filename, saveAs: false }, (id) => {
			const err = api.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(id);
		});
	});
}

// Opens a URL in a background tab and waits until it has fully loaded.
function openTabAndWait(url) {
	return new Promise((resolve, reject) => {
		api.tabs.create({ url, active: false }, (tab) => {
			const err = api.runtime.lastError;
			if (err) return reject(new Error(err.message));
			const tabId = tab.id;
			const timeout = setTimeout(() => {
				api.tabs.onUpdated.removeListener(listener);
				resolve(tabId); // proceed anyway; extractor will poll
			}, 25000);
			function listener(updatedId, info) {
				if (updatedId === tabId && info.status === "complete") {
					clearTimeout(timeout);
					api.tabs.onUpdated.removeListener(listener);
					resolve(tabId);
				}
			}
			api.tabs.onUpdated.addListener(listener);
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tries extraction a few times — the iSpring viewer injects fileOpenParams
// shortly after the page reports "complete".
async function extractWithRetries(tabId, attempts = 6) {
	let last = { ok: false, type: "none", message: "Учебник не найден." };
	for (let i = 0; i < attempts; i++) {
		try {
			const results = await execInTab(tabId, inj_extractBook);
			last = pickBookResult(results);
			if (last.ok) return last;
		} catch (e) {
			last = { ok: false, type: "none", message: e.message };
		}
		await sleep(1200);
	}
	return last;
}

/* ----------------------------------------------------------------------- *
 *  Core actions
 * ----------------------------------------------------------------------- */

async function getActiveTabId() {
	return new Promise((resolve) => {
		api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			resolve(tabs && tabs[0] ? tabs[0].id : null);
		});
	});
}

async function downloadBook({ url }) {
	let tabId;
	let openedTab = false;

	if (url) {
		if (!/^https?:\/\/[^/]*rosdistant\.ru/i.test(url)) {
			return { ok: false, message: "Ссылка должна вести на домен rosdistant.ru." };
		}
		tabId = await openTabAndWait(url);
		openedTab = true;
	} else {
		tabId = await getActiveTabId();
		if (!tabId) return { ok: false, message: "Нет активной вкладки." };
	}

	try {
		const book = await extractWithRetries(tabId, openedTab ? 8 : 3);
		if (!book.ok) return { ok: false, message: book.message };

		if (book.type === "file" && book.filePath) {
			const filename = sanitizeFilename(book.title) + extOf(book.filePath);
			await downloadUrl(book.filePath, filename);
			return { ok: true, message: 'Учебник скачивается: «' + filename + '».' };
		}

		if (book.type === "images" && book.images.length) {
			// Fallback runs in the page that already has the images loaded.
			await execInTab(tabId, inj_printImages, [book.images, book.title]);
			return {
				ok: true,
				message: "Прямой файл недоступен. Открыт диалог печати — выберите " +
					'"Сохранить как PDF" (' + book.images.length + " стр.)."
			};
		}

		return { ok: false, message: book.message || "Не удалось определить файл учебника." };
	} finally {
		if (openedTab && tabId) {
			// give the download a moment to register before closing the tab
			setTimeout(() => api.tabs.remove(tabId, () => void api.runtime.lastError), 2500);
		}
	}
}

async function runOnActiveTab(func, args) {
	const tabId = await getActiveTabId();
	if (!tabId) return { ok: false, message: "Нет активной вкладки." };
	const results = await execInTab(tabId, func, args);
	const r = results.find((x) => x && x.result);
	return (r && r.result) || { ok: true };
}

/* ----------------------------------------------------------------------- *
 *  Message router (from popup.js)
 * ----------------------------------------------------------------------- */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		try {
			switch (msg && msg.type) {
				case "DOWNLOAD_BOOK":
					sendResponse(await downloadBook({ url: msg.url }));
					break;
				case "EXPORT_TEST_HTML":
					sendResponse(await runOnActiveTab(inj_exportTestHtml));
					break;
				case "EXPORT_TEST_PDF":
					sendResponse(await runOnActiveTab(inj_exportTestPrint));
					break;
				default:
					sendResponse({ ok: false, message: "Неизвестная команда." });
			}
		} catch (e) {
			sendResponse({ ok: false, message: e.message || String(e) });
		}
	})();
	return true; // keep the message channel open for the async response
});
