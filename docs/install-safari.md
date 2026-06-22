# Установка в Safari

> Safari-расширения **можно собрать только на macOS** с установленным Xcode.
> На Windows или Linux собрать Safari-версию нельзя — это ограничение Apple.
> Сам код расширения общий: Safari использует тот же MV3-пакет, что и Chrome.

## Что нужно

- Mac с macOS 12+;
- [Xcode](https://apps.apple.com/app/xcode/id497799835) и command-line tools
  (`xcode-select --install`);
- Node.js 18+.

## Шаги

```bash
# 1. собрать общий Chromium-пакет
npm run build                # создаёт dist/chrome

# 2. сконвертировать его в проект Safari (официальный конвертер Apple)
bash scripts/build-safari.sh
```

Скрипт вызывает `xcrun safari-web-extension-converter` и создаёт проект Xcode
в папке `safari/`.

## Запуск

1. Откройте созданный `.xcodeproj` в Xcode.
2. Выберите свою команду подписи (Signing & Capabilities → Team).
3. Нажмите **Run** — соберётся приложение-контейнер с расширением.
4. В Safari: **Настройки → Расширения** включите «Rosdistant Helper».
   Для локального теста сначала включите меню **Разработка** (Settings →
   Advanced → Show Develop menu) и пункт **«Разрешить неподписанные расширения»**.

## Использование

То же, что и в других браузерах: войдите в Росдистант, нажмите на значок,
вставьте ссылку на учебник (или оставьте поле пустым на открытой странице) и
нажмите **«Скачать учебник»**.
