#!/usr/bin/env node
/**
 * Собирает index.json формата 1 для Discover в DSH.
 *
 * Правило: в свой индекс попадает всё публичное — и публикуемое, и непубликуемое.
 * Источник версии выбирается сам: если пакет уже опубликован в npm под нужным именем,
 * берётся npm; иначе — git с закреплённым коммитом.
 *
 * Запуск:  node market/build-index.mjs [--git-only] [--out <path>]
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Скоуп npm, под которым публикуются публикуемые плагины. */
const SCOPE = '@machine202502'

/**
 * dir        — папка плагина в этой директории
 * category   — категория в индексе
 * npm        — публикуем ли в npm (false → только git-источник)
 */
const PLUGINS = [
  { dir: 'dsh-browser', category: 'tools', npm: true },
  { dir: 'dsh-screenshoot', category: 'tools', npm: true },
  { dir: 'dsh-restart', category: 'tools', npm: true },
  { dir: 'dsh-choice', category: 'ui', npm: true },
  { dir: 'dsh-notify-win', category: 'ui', npm: true },
  { dir: 'dsh-voice-ext', category: 'integration', npm: true },
  { dir: 'dsh-pricing', category: 'tools', npm: false },
]

const CATEGORIES = {
  ui: { title: { en: 'Interface', ru: 'Интерфейс' } },
  tools: { title: { en: 'Tools', ru: 'Инструменты' } },
  integration: { title: { en: 'Models & integrations', ru: 'Модели и интеграции' } },
}

const args = process.argv.slice(2)
const gitOnly = args.includes('--git-only')
const outFlag = args.indexOf('--out')
const rootFlag = args.indexOf('--root')
// В CI папки плагинов лежат не рядом с генератором, а в отдельном каталоге:
// --root задаёт корень, в котором находятся dsh-<name>.
const root = rootFlag >= 0 ? resolve(args[rootFlag + 1]) : resolve(here, '..')
const outFile = outFlag >= 0 ? resolve(args[outFlag + 1]) : join(here, 'index.json')
const outDir = dirname(outFile)
const iconsDir = join(outDir, 'icons')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function git(dir, ...argv) {
  return execFileSync('git', argv, { cwd: join(root, dir), encoding: 'utf8' }).trim()
}

function localeMeta(dir, lang) {
  const path = join(root, dir, 'locale', `${lang}.json`)
  if (!existsSync(path)) return undefined
  try {
    return readJson(path).meta
  } catch {
    return undefined
  }
}

function localized(en, ru) {
  const text = { en: en ?? ru }
  if (ru && ru !== en) text.ru = ru
  return text
}

async function npmVersion(name, version) {
  if (gitOnly) return undefined
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

mkdirSync(iconsDir, { recursive: true })

const plugins = []
for (const entry of PLUGINS) {
  const dir = join(root, entry.dir)
  const pkg = readJson(join(dir, 'package.json'))
  const version = pkg.version

  const en = localeMeta(entry.dir, 'en') ?? {}
  const ru = localeMeta(entry.dir, 'ru') ?? {}
  const title = localized(en.title ?? pkg.name, ru.title)
  const description = localized(en.description ?? pkg.description, ru.description ?? pkg.description)

  const iconFile = `icons/${entry.dir}.svg`
  if (existsSync(join(dir, 'icon.svg'))) {
    copyFileSync(join(dir, 'icon.svg'), join(iconsDir, `${entry.dir}.svg`))
  }

  // Наш репозиторий, а не апстрим форка: коммит, на который ссылается индекс, живёт
  // только в нашей копии.
  const ownRepo = `https://github.com/machine202502/${entry.dir}`
  const declaredRepo = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  const repoUrl = declaredRepo.includes('machine202502') ? declaredRepo : ownRepo
  const homepage = (pkg.homepage ?? '').includes('machine202502')
    ? pkg.homepage
    : `${ownRepo}#readme`

  let source
  let publishedAt
  // Имя в индексе должно совпадать с именем пакета в источнике: npm-версия живёт под
  // скоупом, git-версия — под именем из package.json в репозитории.
  // Чужой npm-пакет с тем же именем источником не считаем: сверяем только скоуп.
  let name = pkg.name
  const published = entry.npm ? await npmVersion(`${SCOPE}/${entry.dir}`, pkg.version) : undefined
  if (published) {
    name = `${SCOPE}/${entry.dir}`
    source = { type: 'npm' }
    try {
      const doc = await (
        await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
          signal: AbortSignal.timeout(8000),
        })
      ).json()
      publishedAt = Math.floor(Date.parse(doc.time[version]) / 1000)
    } catch {
      publishedAt = undefined
    }
  } else {
    const commit = git(entry.dir, 'rev-parse', 'HEAD')
    source = { type: 'git', url: repoUrl, commit }
    publishedAt = Number(git(entry.dir, 'log', '-1', '--format=%ct'))
  }

  plugins.push({
    name,
    title,
    description,
    icon: iconFile,
    author: pkg.author ?? 'machine202502',
    homepage,
    repository: { url: repoUrl },
    metadata: { category: entry.category },
    versions: [
      {
        version,
        publishTimestamp: publishedAt ?? Math.floor(Date.now() / 1000),
        source,
        ...(pkg.engines?.dsh ? { engines: { dsh: pkg.engines.dsh } } : {}),
      },
    ],
  })
}

const index = {
  format: 1,
  title: { en: 'machine202502 plugins', ru: 'Плагины machine202502' },
  description: {
    en: 'Everything public from machine202502: interface, tools, models.',
    ru: 'Всё публичное от machine202502: интерфейс, инструменты, модели.',
  },
  metadata: { categories: CATEGORIES },
  plugins,
}

writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

const byKind = plugins.map((p) => `${p.name} (${p.versions[0].source.type})`).join(', ')
console.log(`index: ${outFile}`)
console.log(`plugins: ${plugins.length} — ${byKind}`)
