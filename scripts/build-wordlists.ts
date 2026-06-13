/**
 * Downloads and normalizes word lists for English and German.
 * Run: npx tsx scripts/build-wordlists.ts
 *
 * Sources:
 *   EN: https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt
 *   DE: https://raw.githubusercontent.com/enz/german-wordlist/master/words
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../data')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const MIN_LEN = 4

async function fetchText(url: string): Promise<string> {
  console.log(`Fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

function normalize(words: string[], allowedPattern: RegExp): string[] {
  return [
    ...new Set(
      words
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length >= MIN_LEN && allowedPattern.test(w))
    ),
  ].sort()
}

async function buildEnglish(): Promise<void> {
  const raw = await fetchText(
    'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt'
  )
  const words = normalize(raw.split('\n'), /^[a-z]+$/)
  const path = join(DATA_DIR, 'en.txt')
  writeFileSync(path, words.join('\n'), 'utf8')
  console.log(`EN: wrote ${words.length} words to ${path}`)
}

async function buildGerman(): Promise<void> {
  // Primary: enz/german-wordlist
  let raw: string
  try {
    raw = await fetchText(
      'https://raw.githubusercontent.com/enz/german-wordlist/master/words'
    )
  } catch {
    // Fallback: wortschatz
    raw = await fetchText(
      'https://raw.githubusercontent.com/davidak/wortliste/master/wortliste.txt'
    )
  }
  const words = normalize(raw.split('\n'), /^[a-zäöüß]+$/)
  const path = join(DATA_DIR, 'de.txt')
  writeFileSync(path, words.join('\n'), 'utf8')
  console.log(`DE: wrote ${words.length} words to ${path}`)
}

await Promise.all([buildEnglish(), buildGerman()])
console.log('Word lists built successfully.')
