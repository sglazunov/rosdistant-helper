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

// Shows decryption/render progress on the toolbar badge (works even after the
// popup is closed). `done`/`total` are page counts.
function setProgressBadge(done, total) {
	try {
		if (!api.action || !api.action.setBadgeText) return;
		if (!total || done >= total) {
			api.action.setBadgeText({ text: "" });
			return;
		}
		const pct = Math.min(99, Math.round((done / total) * 100));
		api.action.setBadgeBackgroundColor({ color: "#4f6ef7" });
		api.action.setBadgeText({ text: pct + "%" });
	} catch (_) {}
}

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
		password: null,
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

	// The iSpring viewer stores the document password as part of a storage key
	// like "ispring::book/<PASSWORD>" — grab the most recently updated one from
	// localStorage or sessionStorage.
	function scanStore(store) {
		let best = null;
		try {
			for (let i = 0; i < store.length; i++) {
				const k = store.key(i);
				if (!k) continue;
				const km = k.match(/ispring::book\/(.+)$/) || k.match(/ispring.*book[\/:]+(.+)$/i);
				if (!km) continue;
				let updated = 0;
				try { updated = (JSON.parse(JSON.parse(store.getItem(k))) || {}).updated || 0; } catch (_) {}
				if (!best || updated > best.updated) best = { password: km[1], updated };
			}
		} catch (_) {}
		return best;
	}
	const pw = scanStore(localStorage) || scanStore(sessionStorage);
	if (pw && pw.password) result.password = pw.password;

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

function injectFilesAllFrames(tabId, files) {
	return new Promise((resolve, reject) => {
		api.scripting.executeScript({ target: { tabId, allFrames: true }, files }, (results) => {
			const err = api.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(results || []);
		});
	});
}

// Called inside each frame; delegates to the handler injected from rd-decrypt.js.
function inj_callRunner(workerUrl) {
	if (typeof globalThis.__rdDownloadBook !== "function") return { skip: true, noRunner: true };
	return globalThis.__rdDownloadBook(workerUrl);
}

function mapRunnerResult(r, filenameHint) {
	if (!r.ok) {
		if (r.fetchFailed) {
			return {
				ok: false,
				_fallbackFile: r.filePath || null,
				_password: r.password || null,
				message: "Не удалось загрузить файл из вкладки (" + (r.message || "ошибка") + ")."
			};
		}
		return { ok: false, message: r.message || "Не удалось обработать учебник." };
	}
	if (r.mode === "images") {
		return {
			ok: true,
			password: r.password || null,
			filename: null,
			message: "Прямой файл недоступен — открыт диалог печати (" + r.pages +
				" стр.). Выберите «Сохранить как PDF»."
		};
	}
	const name = r.filename || filenameHint || "учебник.pdf";
	if (r.decrypted) {
		return {
			ok: true,
			password: null,
			filename: name,
			message: "Готово! Учебник «" + name + "» скачан и разблокирован — " +
				"пароль вводить не нужно, файл можно пересылать."
		};
	}
	if (r.password) {
		return {
			ok: true,
			password: r.password,
			filename: name,
			message: "Учебник «" + name + "» скачан, но снять пароль автоматически не удалось. " +
				"Пароль — ниже (уже скопирован), вставьте его при открытии файла."
		};
	}
	return {
		ok: true,
		password: null,
		filename: name,
		message: "Учебник «" + name + "» скачан, но он защищён паролем, а сам пароль " +
			"не найден. Откройте учебник в просмотрщике один раз и повторите."
	};
}

// Last-resort path: download the raw (possibly encrypted) file via the
// downloads API and surface the password, used if the in-frame decrypt flow
// could not run (e.g. the page blocked script injection).
async function fallbackDownload(tabId, filePathHint, passwordHint) {
	if (filePathHint) {
		const filename = sanitizeFilename("rosdistant-book") + extOf(filePathHint);
		await downloadUrl(filePathHint, filename);
		return {
			ok: true,
			password: passwordHint || null,
			message: "Учебник скачивается. " +
				(passwordHint ? "Снять пароль не получилось — введите его при открытии." : "")
		};
	}
	const book = await extractWithRetries(tabId, 3);
	if (!book.ok) return { ok: false, message: book.message };
	if (book.type === "file" && book.filePath) {
		const filename = sanitizeFilename(book.title) + extOf(book.filePath);
		await downloadUrl(book.filePath, filename);
		return {
			ok: true,
			password: book.password || null,
			message: "Учебник скачивается: «" + filename + "»." +
				(book.password ? " Введите пароль при открытии." : "")
		};
	}
	if (book.type === "images" && book.images.length) {
		await execInTab(tabId, inj_printImages, [book.images, book.title]);
		return { ok: true, password: book.password || null,
			message: "Открыт диалог печати (" + book.images.length + " стр.) — «Сохранить как PDF»." };
	}
	return { ok: false, message: book.message || "Учебник не найден." };
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

	const workerUrl = api.runtime.getURL("lib/pdf.worker.min.js");
	try {
		let injected = false;
		try {
			await injectFilesAllFrames(tabId,
				["lib/pdf.min.js", "lib/jspdf.umd.min.js", "lib/rd-decrypt.js"]);
			injected = true;
		} catch (_) { /* restricted page — fall back below */ }

		if (injected) {
			const attempts = openedTab ? 10 : 4;
			for (let i = 0; i < attempts; i++) {
				let results = [];
				try { results = await execInTab(tabId, inj_callRunner, [workerUrl]); } catch (_) {}
				const acted = results.find((r) => r && r.result && !r.result.skip);
				if (acted) {
					const mapped = mapRunnerResult(acted.result);
					if (mapped.ok || !mapped._fallbackFile) return mapped;
					return await fallbackDownload(tabId, mapped._fallbackFile, mapped._password);
				}
				await sleep(1200);
			}
		}

		// the in-page flow never ran or never found the book — try the simple path.
		return await fallbackDownload(tabId, null, null);
	} finally {
		setProgressBadge(1, 1); // clear badge
		if (openedTab && tabId) {
			// keep the tab long enough for the in-page download to start
			setTimeout(() => api.tabs.remove(tabId, () => void api.runtime.lastError), 4000);
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

// Remembers the password of the most recently downloaded textbook so the popup
// can show it again even after it was closed and reopened.
function rememberLastBook(resp) {
	try {
		if (!resp || !resp.ok) return;
		if (resp.password) {
			api.storage.local.set({
				lastBook: {
					password: resp.password,
					filename: resp.filename || null,
					ts: Date.now()
				}
			});
		}
		// note: a successfully decrypted book has no password to remember; we keep
		// the previous entry untouched rather than clearing it.
	} catch (_) {}
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		try {
			switch (msg && msg.type) {
				case "DOWNLOAD_BOOK": {
					const resp = await downloadBook({ url: msg.url });
					rememberLastBook(resp);
					sendResponse(resp);
					break;
				}
				case "PROGRESS":
					setProgressBadge(msg.done, msg.total);
					sendResponse({ ok: true });
					break;
				case "GET_LAST_BOOK":
					api.storage.local.get("lastBook", (d) => sendResponse((d && d.lastBook) || null));
					break;
				case "FORGET_LAST_BOOK":
					api.storage.local.remove("lastBook", () => sendResponse({ ok: true }));
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
