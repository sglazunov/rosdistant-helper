/*
 * Popup UI controller. Thin layer: collects the URL (if any), asks the
 * background worker to do the real work, and reports the result.
 */
const api = (typeof browser !== "undefined") ? browser : chrome;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const buttons = ["btn-book", "btn-test-html", "btn-test-pdf"].map($);

function setStatus(text, kind) {
	statusEl.textContent = text || "";
	statusEl.className = "status" + (kind ? " is-" + kind : "");
}

function setBusy(busy) {
	buttons.forEach((b) => { if (b) b.disabled = busy; });
}

function send(message) {
	return new Promise((resolve) => {
		api.runtime.sendMessage(message, (resp) => {
			const err = api.runtime.lastError;
			if (err) return resolve({ ok: false, message: err.message });
			resolve(resp || { ok: false, message: "Нет ответа от расширения." });
		});
	});
}

async function run(message, busyText) {
	setBusy(true);
	setStatus(busyText, "busy");
	const resp = await send(message);
	setBusy(false);
	setStatus(resp.message || (resp.ok ? "Готово." : "Не удалось выполнить."),
		resp.ok ? "ok" : "err");
}

$("btn-book").addEventListener("click", () => {
	const url = $("url").value.trim();
	run({ type: "DOWNLOAD_BOOK", url: url || null },
		url ? "Открываю ссылку и ищу учебник…" : "Ищу учебник на странице…");
});

$("btn-test-html").addEventListener("click", () =>
	run({ type: "EXPORT_TEST_HTML" }, "Сохраняю тест…"));

$("btn-test-pdf").addEventListener("click", () =>
	run({ type: "EXPORT_TEST_PDF" }, "Готовлю печать…"));

// Submit URL field with Enter.
$("url").addEventListener("keydown", (e) => {
	if (e.key === "Enter") $("btn-book").click();
});
