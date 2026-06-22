# Установка в Firefox

Firefox использует папку **`dist/firefox`** (отдельный манифест с
`browser_specific_settings`).

## Временная установка (для теста, сбрасывается при перезапуске)

1. Откройте `about:debugging#/runtime/this-firefox`.
2. Нажмите **Загрузить временное дополнение…** (Load Temporary Add-on).
3. Выберите файл **`dist/firefox/manifest.json`**.
4. Расширение появится на панели до закрытия Firefox.

## Постоянная установка (подписанный .xpi)

Firefox по умолчанию устанавливает только подписанные дополнения. Чтобы
получить `.xpi`:

1. Соберите zip: `npm run zip` → появится `dist/rosdistant-helper-firefox.zip`.
2. Загрузите его на [addons.mozilla.org Developer Hub](https://addons.mozilla.org/developers/)
   для самоподписи (можно «Unlisted» — только для себя), скачайте подписанный
   `.xpi` и установите его перетаскиванием в Firefox.

Для разработки удобнее **временная установка** выше или
[`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/):

```bash
npx web-ext run --source-dir dist/firefox
```

## Использование

То же, что в Chrome: войдите в Росдистант, нажмите на значок, вставьте ссылку на
учебник (или оставьте поле пустым на открытой странице учебника) и нажмите
**«Скачать учебник»**.
