import { Trie } from './trie.js'

export type Lang = 'en' | 'de'
export const MIN_WORD_LEN = 4

// NOTE: in production the LLM (services/ai.ts) is the word authority. These in-memory structures
// back only the offline test fake and an optional fallback — they are never loaded from disk.
interface LangData {
  wordSet: Set<string>
  forwardTrie: Trie // words as-is (for appending)
  reverseTrie: Trie // reversed words (for prepending)
}

const langData: Map<Lang, LangData> = new Map()

function buildLangData(words: string[]): LangData {
  const cleaned = words
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= MIN_WORD_LEN && /^[a-zäöüß]+$/.test(w))

  const wordSet = new Set(cleaned)
  const forwardTrie = new Trie()
  const reverseTrie = new Trie()
  for (const w of cleaned) {
    forwardTrie.insert(w)
    reverseTrie.insert(reverse(w))
  }
  return { wordSet, forwardTrie, reverseTrie }
}

function reverse(s: string): string {
  return s.split('').reverse().join('')
}

/** Load a language from an in-memory array. */
export function loadFromWords(lang: Lang, words: string[]): void {
  langData.set(lang, buildLangData(words))
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
  if (d.forwardTrie.hasPrefix(s)) return true
  if (superghost && d.reverseTrie.hasPrefix(reverse(s))) return true
  return false
}

/** Letters that keep `seq` extendable at each allowed end. */
export function extendingLetters(
  seq: string,
  lang: Lang,
  superghost: boolean,
): { append: Set<string>; prepend: Set<string> } {
  const s = seq.toLowerCase()
  const d = getData(lang)

  const append = new Set<string>(d.forwardTrie.nextLetters(s))
  const prepend = new Set<string>()
  if (superghost) {
    for (const ch of d.reverseTrie.nextLetters(reverse(s))) prepend.add(ch)
  }
  return { append, prepend }
}

export function sampleWordsAppending(seq: string, lang: Lang, n = 10): string[] {
  return getData(lang).forwardTrie.wordsWithPrefix(seq.toLowerCase(), n)
}

export function sampleWordsPrepending(seq: string, lang: Lang, n = 10): string[] {
  return getData(lang)
    .reverseTrie.wordsWithPrefix(reverse(seq.toLowerCase()), n)
    .map(reverse)
}

export function sampleWordsContaining(seq: string, lang: Lang, superghost: boolean, n = 10): string[] {
  const append = sampleWordsAppending(seq, lang, n)
  if (!superghost) return append
  const prepend = sampleWordsPrepending(seq, lang, n)
  return [...new Set([...append, ...prepend])].slice(0, n)
}
