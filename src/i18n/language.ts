import { FA_EXACT, FA_PATTERNS } from './translations'

export type AppLanguage = 'en' | 'fa'

const CACHE_KEY = 'super-record-language'
const ATTRIBUTES = ['placeholder', 'title', 'aria-label'] as const

type Record_ = { original: string; applied: string }

let language: AppLanguage = 'en'
let observer: MutationObserver | null = null
const textRecords = new Map<Text, Record_>()
const attributeRecords = new Map<Element, Map<string, Record_>>()

export function normalizeLanguage(value: unknown): AppLanguage {
  return value === 'fa' ? 'fa' : 'en'
}

/** Translates one English string, or returns null when it has no Persian form. */
export function translate(source: string): string | null {
  const core = source.trim()
  if (!core) return null
  const exact = FA_EXACT[core]
  if (exact !== undefined) return exact
  for (const [pattern, build] of FA_PATTERNS) {
    const match = core.match(pattern)
    if (match) return build(match, (value) => translate(value) ?? value)
  }
  return null
}

function withOuterSpace(source: string, translated: string): string {
  const lead = source.match(/^\s*/)?.[0] ?? ''
  const tail = source.match(/\s*$/)?.[0] ?? ''
  return `${lead}${translated}${tail}`
}

function processText(node: Text) {
  const current = node.nodeValue ?? ''
  const record = textRecords.get(node)
  if (language === 'fa') {
    if (record && record.applied === current) return
    const translated = translate(current)
    if (translated === null) {
      textRecords.delete(node)
      return
    }
    const applied = withOuterSpace(current, translated)
    textRecords.set(node, { original: current, applied })
    node.nodeValue = applied
  } else if (record) {
    if (record.applied === current) node.nodeValue = record.original
    textRecords.delete(node)
  }
}

function processAttribute(element: Element, name: string) {
  const current = element.getAttribute(name)
  if (current === null) return
  const records = attributeRecords.get(element)
  const record = records?.get(name)
  if (language === 'fa') {
    if (record && record.applied === current) return
    const translated = translate(current)
    if (translated === null) {
      records?.delete(name)
      return
    }
    const next = records ?? new Map<string, Record_>()
    next.set(name, { original: current, applied: translated })
    attributeRecords.set(element, next)
    element.setAttribute(name, translated)
  } else if (record) {
    if (record.applied === current) element.setAttribute(name, record.original)
    records?.delete(name)
  }
}

function processTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    processText(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node: Node | null = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = (node as Text).parentElement
      if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE') {
        processText(node as Text)
      }
    } else {
      const element = node as Element
      for (const name of ATTRIBUTES) {
        if (element.hasAttribute(name)) processAttribute(element, name)
      }
    }
    node = walker.nextNode()
  }
}

function handleMutations(mutations: MutationRecord[]) {
  if (textRecords.size > 3000) prune()
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') {
      if (mutation.target.nodeType === Node.TEXT_NODE) processText(mutation.target as Text)
    } else if (mutation.type === 'attributes') {
      if (mutation.attributeName) processAttribute(mutation.target as Element, mutation.attributeName)
    } else {
      mutation.addedNodes.forEach((added) => processTree(added))
    }
  }
}

function prune() {
  for (const node of textRecords.keys()) if (!node.isConnected) textRecords.delete(node)
  for (const element of attributeRecords.keys()) if (!element.isConnected) attributeRecords.delete(element)
}

function applyDocumentState() {
  const root = document.documentElement
  root.lang = language === 'fa' ? 'fa' : 'en'
  root.classList.toggle('lang-fa', language === 'fa')
}

/** Switches the whole interface (and the native confirm dialogs) to a language. */
export function setLanguage(next: AppLanguage) {
  if (next === language && observer) return
  language = next
  try {
    localStorage.setItem(CACHE_KEY, next)
  } catch {
    // The cache is only a start-up shortcut.
  }
  applyDocumentState()
  if (!observer) {
    observer = new MutationObserver(handleMutations)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES],
    })
  }
  prune()
  // Re-walk the whole page; records make this safe in both directions.
  if (language === 'en') {
    for (const [node, record] of [...textRecords]) {
      if (node.nodeValue === record.applied) node.nodeValue = record.original
      textRecords.delete(node)
    }
    for (const [element, records] of [...attributeRecords]) {
      for (const [name, record] of records) {
        if (element.getAttribute(name) === record.applied) element.setAttribute(name, record.original)
      }
      attributeRecords.delete(element)
    }
  } else {
    processTree(document.body)
  }
}

/** Starts the translator with the language used last time, before React renders. */
export function initLanguage() {
  let cached: AppLanguage = 'en'
  try {
    cached = normalizeLanguage(localStorage.getItem(CACHE_KEY))
  } catch {
    // Ignore.
  }
  setLanguage(cached)

  const nativeConfirm = window.confirm.bind(window)
  window.confirm = (message?: string) =>
    nativeConfirm(language === 'fa' && message ? (translate(message) ?? message) : message)
  const nativeAlert = window.alert.bind(window)
  window.alert = (message?: unknown) =>
    nativeAlert(language === 'fa' && typeof message === 'string' ? (translate(message) ?? message) : message)
}
