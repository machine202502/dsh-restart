# market — индекс плагинов DSH

`index.json` — индекс формата 1 для вкладки **Discover** в DeepSeek Harness: семь
плагинов machine202502. Шесть ведут на npm (`@machine202502/dsh-*`), `dsh-pricing`
идёт из git с закреплённым коммитом — он не публикуется в npm.

## Адреса

| Источник | URL |
|---|---|
| GitHub Pages | `https://machine202502.github.io/dsh-restart/market/index.json` |
| jsDelivr | `https://cdn.jsdelivr.net/gh/machine202502/dsh-restart@main/market/index.json` |
| raw | `https://raw.githubusercontent.com/machine202502/dsh-restart/main/market/index.json` |

Pages нужно один раз включить: **Settings → Pages → Source: Deploy from a branch →
`main` → `/ (root)`**. Сайт собирается пару минут, после этого адрес отдаёт JSON.
Файл `.nojekyll` в корне репозитория отключает обработку Jekyll, чтобы файлы
отдавались как есть.

jsDelivr и raw работают сразу после пуша, без всяких настроек — если Pages ещё не
включён или отдаёт 404, используйте их.

## Как обновлять

Индекс собирается из рабочей папки плагинов, а не пишется руками:

```sh
node market/build-index.mjs --out dsh-restart/market/index.json
```

Скрипт берёт из каждого пакета имя, версию, описание, иконку и источник версии
(npm, если пакет опубликован, иначе git с коммитом), и кладёт иконки в `icons/`
рядом с индексом. После публикации новой версии — пересобрать и закоммитить.

## Как подключить

**Плагины → Экспериментальные плагины → Custom plugin indexes** (включить) →
вкладка **Discover** → **Add index source** → вставить URL. Источник запомнится в
профиле; после пересборки индекса в Discover достаточно нажать **Refresh**.

Индекс проверен официальным валидатором `@deepseek-ai/dsh-plugin-market-index`:
формат 1, семь плагинов, все установочные строки собираются.
