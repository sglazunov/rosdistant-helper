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

const passEl = $("pass");
const passValue = $("pass-value");
const passCopy = $("pass-copy");
const passFile = $("pass-file");
const passHint = $("pass-hint");
const passForget = $("pass-forget");

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (_) {
		try {
			passValue.focus();
			const r = document.createRange();
			r.selectNodeContents(passValue);
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
			return document.execCommand("copy");
		} catch (__) { return false; }
	}
}

// opts: { filename, remembered, autocopy }
function showPassword(password, opts) {
	opts = opts || {};
	if (!password) { passEl.hidden = true; return; }
	passValue.textContent = password;
	passEl.hidden = false;

	if (opts.filename) {
		passFile.textContent = "Учебник: " + opts.filename;
		passFile.hidden = false;
	} else {
		passFile.hidden = true;
	}
	passHint.textContent = opts.remembered
		? "Пароль от последнего скачанного учебника. Вставьте его в окне «Необходимо ввести пароль»."
		: "Вставьте этот пароль в окне «Необходимо ввести пароль».";

	if (opts.autocopy !== false) {
		copyText(password).then((ok) => {
			if (ok) {
				passCopy.classList.add("copied");
				setTimeout(() => passCopy.classList.remove("copied"), 1500);
			}
		});
	}
}

passCopy.addEventListener("click", async () => {
	const ok = await copyText(passValue.textContent);
	passCopy.classList.toggle("copied", ok);
	setTimeout(() => passCopy.classList.remove("copied"), 1500);
});

passForget.addEventListener("click", () => {
	send({ type: "FORGET_LAST_BOOK" });
	passEl.hidden = true;
});

// On open, restore the password of the last downloaded textbook (if any).
send({ type: "GET_LAST_BOOK" }).then((last) => {
	if (last && last.password) {
		showPassword(last.password, { filename: last.filename, remembered: true, autocopy: false });
	}
});

async function run(btn, message, busyText) {
	setBusy(btn, true);
	setStatus(busyText, "busy");
	passEl.hidden = true;
	const resp = await send(message);
	setBusy(btn, false);
	setStatus(resp.message || (resp.ok ? "Готово." : "Не удалось выполнить."),
		resp.ok ? "ok" : "err");
	showPassword(resp.password, { filename: resp.filename, remembered: false, autocopy: true });
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
