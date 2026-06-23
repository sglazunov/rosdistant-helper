# Политика конфиденциальности · Privacy Policy

_Обновлено: 2026-06-23_

## Кратко

Расширение «Помощь росдистантикам / Rosdistant Helper» **не собирает, не
хранит на сервере и не передаёт никому ваши персональные данные**. У проекта нет
серверов и аналитики. Вся работа происходит локально в вашем браузере.

## Какие данные обрабатываются и зачем

Расширение работает только на страницах домена `*.rosdistant.ru` и только когда
вы сами нажимаете кнопку. Локально, не покидая вашего браузера, оно использует:

- **Содержимое открытой страницы учебника** — чтобы найти ссылку на файл
  учебника и параметры просмотрщика.
- **Cookie вашей текущей сессии** — чтобы скачать файл от вашего имени, ровно
  как это делает сам браузер (расширение не видит и не сохраняет ваши логин и
  пароль от аккаунта).
- **`localStorage` страницы** — чтобы прочитать пароль документа, который сама
  платформа сохраняет в браузере для отображения учебника.
- **Локальное хранилище расширения (`storage.local`)** — чтобы запомнить пароль
  **последнего** скачанного учебника и показать его снова. Эти данные хранятся
  только на вашем устройстве; их можно стереть кнопкой «✕» в окне расширения
  или удалив расширение.

## Чего расширение НЕ делает

- Не отправляет ваши данные, файлы, пароли или историю на какие-либо серверы.
- Не использует аналитику, трекеры или рекламные сети.
- Не продаёт и не передаёт данные третьим лицам.
- Не работает на сайтах вне `*.rosdistant.ru`.

## Сторонние библиотеки

Расширение включает офлайн-копии [pdf.js](https://github.com/mozilla/pdf.js)
(Apache-2.0) и [jsPDF](https://github.com/parallax/jsPDF) (MIT), которые
выполняются локально и никуда не обращаются по сети.

## Контакт

Вопросы и обращения: раздел
[Issues](https://github.com/sglazunov/rosdistant-helper/issues) репозитория.

---

# Privacy Policy (English)

_Updated: 2026-06-23_

The "Rosdistant Helper" extension **does not collect, store on any server, or
share your personal data**. There are no servers and no analytics. Everything
runs locally in your browser.

It operates only on `*.rosdistant.ru` pages and only when you click its button.
Locally, it uses: the open textbook page content (to locate the file), your
current session cookies (to download the file on your behalf — it never sees or
stores your account login/password), the page's `localStorage` (to read the
document password the platform itself stores there), and the extension's own
`storage.local` (to remember the **last** downloaded book's password so it can
be shown again; stored on your device only, clearable via the "✕" button or by
removing the extension).

The extension does **not** transmit data anywhere, uses no analytics/trackers,
and never sells or shares data with third parties. Bundled third-party libraries
([pdf.js](https://github.com/mozilla/pdf.js), Apache-2.0;
[jsPDF](https://github.com/parallax/jsPDF), MIT) run locally with no network
access.

Contact: [Issues](https://github.com/sglazunov/rosdistant-helper/issues).
