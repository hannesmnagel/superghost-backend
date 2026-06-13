import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { Trie } from './trie.js'
import { db } from '../db/prisma.js'
import { config } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../../data')

export type Lang = 'en' | 'de'
export const MIN_WORD_LEN = 4

const ALLOWED_EN = 'abcdefghijklmnopqrstuvwxyz'
const ALLOWED_DE = 'abcdefghijklmnopqrstuvwxyzäöüß'

function allowedLetters(lang: Lang): string {
  return lang === 'de' ? ALLOWED_DE : ALLOWED_EN
}

interface LangData {
  wordSet: Set<string>
  forwardTrie: Trie   // words as-is (for appending)
  reverseTrie: Trie   // reversed words (for prepending)
}

const langData: Map<Lang, LangData> = new Map()

export function loadWordList(lang: Lang): void {
  const path = join(DATA_DIR, `${lang}.txt`)
  if (!existsSync(path)) {
    console.warn(`[WordService] Word list not found for ${lang}: ${path}. Run npm run build:words`)
    langData.set(lang, { wordSet: new Set(), forwardTrie: new Trie(), reverseTrie: new Trie() })
    return
  }

  const words = readFileSync(path, 'utf8')
    .split('\n')
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= MIN_WORD_LEN && /^[a-zäöüß]+$/.test(w))

  const wordSet = new Set(words)
  const forwardTrie = new Trie()
  const reverseTrie = new Trie()

  for (const w of words) {
    forwardTrie.insert(w)
    reverseTrie.insert(w.split('').reverse().join(''))
  }

  langData.set(lang, { wordSet, forwardTrie, reverseTrie })
  console.log(`[WordService] Loaded ${words.length} ${lang} words`)
}

export function loadAll(): void {
  loadWordList('en')
  loadWordList('de')
}

function getData(lang: Lang): LangData {
  const d = langData.get(lang)
  if (!d) throw new Error(`Word list not loaded for ${lang}`)
  return d
}

export function isWordLocal(seq: string, lang: Lang): boolean {
  if (seq.length < MIN_WORD_LEN) return false
  return getData(lang).wordSet.has(seq.toLowerCase())
}

export function canExtend(seq: string, lang: Lang, superghost: boolean): boolean {
  const s = seq.toLowerCase()
  const d = getData(lang)
  // Can we append? (prefix in forward trie that isn't the word itself)
  if (d.forwardTrie.hasPrefix(s)) return true
  // Can we prepend? (suffix in reverse trie — i.e., reversed seq is a prefix)
  if (superghost) {
    const rev = s.split('').reverse().join('')
    if (d.reverseTrie.hasPrefix(rev)) return true
  }
  return false
}

// Letters that can be legally appended (result still extendable, not already a word)
export function extendingLetters(seq: string, lang: Lang, superghost: boolean): { append: Set<string>; prepend: Set<string> } {
  const s = seq.toLowerCase()
  const d = getData(lang)
  const letters = allowedLetters(lang)

  const appendSet = new Set<string>()
  const prependSet = new Set<string>()

  // Append: forward trie next letters
  for (const ch of d.forwardTrie.nextLetters(s)) {
    appendSet.add(ch)
  }

  // Prepend: reversed trie next letters after reversed seq
  if (superghost) {
    const rev = s.split('').reverse().join('')
    for (const ch of d.reverseTrie.nextLetters(rev)) {
      prependSet.add(ch)
    }
  }

  return { append: appendSet, prepend: prependSet }
}

// Collect sample words that contain seq at end (append) or start (prepend) — for hints/bot
export function sampleWordsAppending(seq: string, lang: Lang, n = 10): string[] {
  return getData(lang).forwardTrie.wordsWithPrefix(seq.toLowerCase(), n)
}

export function sampleWordsPrepending(seq: string, lang: Lang, n = 10): string[] {
  const rev = seq.toLowerCase().split('').reverse().join('')
  return getData(lang).reverseTrie
    .wordsWithPrefix(rev, n)
    .map(w => w.split('').reverse().join(''))
}

export function sampleWordsContaining(seq: string, lang: Lang, superghost: boolean, n = 10): string[] {
  const append = sampleWordsAppending(seq, lang, n)
  if (!superghost) return append
  const prepend = sampleWordsPrepending(seq, lang, n)
  return [...new Set([...append, ...prepend])].slice(0, n)
}

// AI fallback for disputed words — time-boxed, result cached in DB
export async function isWordWithAiFallback(word: string, lang: Lang): Promise<boolean> {
  if (isWordLocal(word, lang)) return true
  if (!config.OPENROUTER_API_KEY) return false

  const w = word.toLowerCase()

  // Check cache
  const cached = await db.wordVerdict.findUnique({ where: { word_language: { word: w, language: lang } } })
  if (cached) return cached.valid

  try {
    const result = await Promise.race<{ valid: boolean; reason: string }>([
      queryAiForWord(w, lang),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 4000)),
    ])

    await db.wordVerdict.upsert({
      where: { word_language: { word: w, language: lang } },
      create: { word: w, language: lang, valid: result.valid, reason: result.reason },
      update: { valid: result.valid, reason: result.reason },
    })

    return result.valid
  } catch {
    return false
  }
}

async function queryAiForWord(word: string, lang: Lang): Promise<{ valid: boolean; reason: string }> {
  const langName = lang === 'de' ? 'German' : 'English'
  const prompt = `Is "${word}" a valid ${langName} dictionary word (not a proper noun, abbreviation, or very archaic/obsolete form)? Answer ONLY with valid JSON: {"valid":true|false,"reason":"brief reason"}`

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
    }),
  })

  const data = await response.json() as { choices: Array<{ message: { content: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim() ?? '{}'
  const match = content.match(/\{.*\}/s)
  if (!match) throw new Error('No JSON in AI response')
  return JSON.parse(match[0]) as { valid: boolean; reason: string }
}

// Check whether a submitted word is valid for challenge response
export async function validateSubmittedWord(word: string, sequence: string, lang: Lang): Promise<boolean> {
  if (!word.toLowerCase().includes(sequence.toLowerCase())) return false
  return await isWordWithAiFallback(word, lang)
}
