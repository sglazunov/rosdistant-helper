/*
 * Popup UI controller. Thin layer: collects the URL (if any), asks the
 * background worker to do the real work, and reports the result.
 */
const api = (typeof browser !== "undefined") ? browser : chrome;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const statusText = statusEl.querySelector(".status-text");
const actionButtons = ["btn-book", "btn-test-html", "btn-test-pdf"].map($);

function setStatus(text, kind) {
	if (!text) { statusEl.hidden = true; return; }
	statusEl.hidden = false;
	statusEl.className = "status" + (kind ? " is-" + kind : "");
	statusText.textContent = text;
}

function setBusy(btn, busy) {
	actionButtons.forEach((b) => { if (b) b.disabled = busy; });
	if (btn) btn.classList.toggle("is-busy", busy);
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

async function run(btn, message, busyText) {
	setBusy(btn, true);
	setStatus(busyText, "busy");
	const resp = await send(message);
	setBusy(btn, false);
	setStatus(resp.message || (resp.ok ? "Готово." : "Не удалось выполнить."),
		resp.ok ? "ok" : "err");
}

$("btn-book").addEventListener("click", (e) => {
	const url = $("url").value.trim();
	run(e.currentTarget, { type: "DOWNLOAD_BOOK", url: url || null },
		url ? "Открываю ссылку и ищу учебник…" : "Ищу учебник на странице…");
});

$("btn-test-html").addEventListener("click", (e) =>
	run(e.currentTarget, { type: "EXPORT_TEST_HTML" }, "Сохраняю тест…"));

$("btn-test-pdf").addEventListener("click", (e) =>
	run(e.currentTarget, { type: "EXPORT_TEST_PDF" }, "Готовлю печать…"));

// Submit URL field with Enter.
$("url").addEventListener("keydown", (e) => {
	if (e.key === "Enter") $("btn-book").click();
});

// Collapsible "Экспорт тестов" section.
const toggle = $("extras-toggle");
const body = $("extras-body");
toggle.addEventListener("click", () => {
	const open = toggle.getAttribute("aria-expanded") === "true";
	toggle.setAttribute("aria-expanded", String(!open));
	body.hidden = open;
});
