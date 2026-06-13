export class Trie {
  private root: TrieNode = new TrieNode()

  insert(word: string): void {
    let node = this.root
    for (const ch of word) {
      let child = node.children.get(ch)
      if (!child) {
        child = new TrieNode()
        node.children.set(ch, child)
      }
      node = child
    }
    node.isEnd = true
  }

  hasPrefix(prefix: string): boolean {
    let node = this.root
    for (const ch of prefix) {
      const child = node.children.get(ch)
      if (!child) return false
      node = child
    }
    return true
  }

  isWord(word: string): boolean {
    let node = this.root
    for (const ch of word) {
      const child = node.children.get(ch)
      if (!child) return false
      node = child
    }
    return node.isEnd
  }

  // Returns letters that can extend `prefix` into a longer word
  nextLetters(prefix: string): Set<string> {
    let node = this.root
    for (const ch of prefix) {
      const child = node.children.get(ch)
      if (!child) return new Set()
      node = child
    }
    return new Set(node.children.keys())
  }

  // Collect up to `limit` words with this prefix
  wordsWithPrefix(prefix: string, limit = 20): string[] {
    let node = this.root
    for (const ch of prefix) {
      const child = node.children.get(ch)
      if (!child) return []
      node = child
    }
    const results: string[] = []
    this._collect(node, prefix, results, limit)
    return results
  }

  private _collect(node: TrieNode, current: string, results: string[], limit: number): void {
    if (results.length >= limit) return
    if (node.isEnd) results.push(current)
    for (const [ch, child] of node.children) {
      if (results.length >= limit) return
      this._collect(child, current + ch, results, limit)
    }
  }
}

class TrieNode {
  children: Map<string, TrieNode> = new Map()
  isEnd = false
}
