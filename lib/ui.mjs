// @ts-check
import { createInterface } from 'node:readline/promises'
import { ReleaseError } from './util.mjs'

/**
 * @typedef {object} Choice
 * @property {string} label
 * @property {any} value
 * @property {string} [hint]
 * @property {string} [group] heading printed before the first choice of a group
 */

/**
 * @typedef {object} UI
 * @property {(message: string, choices: Choice[], options?: { default?: number }) => Promise<any>} select
 * @property {(message: string, options?: { default?: boolean }) => Promise<boolean>} confirm
 * @property {(message: string, options?: { default?: string, validate?: (v: string) => string | null }) => Promise<string>} input
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} step
 * @property {(message: string) => void} status a line that is replaced while waiting
 */

/** Terminal prompts: numbered choices, Enter takes the marked default. */
export class TerminalUI {
  constructor(input = process.stdin, output = process.stderr) {
    this.inputStream = input
    this.output = output
    this.statusShown = false
  }

  /** @param {string} question */
  async ask(question) {
    this.clearStatus()
    if (!this.inputStream.isTTY && process.env.RELEASE_TOOLS_ALLOW_PIPE !== '1') {
      throw new ReleaseError(`needs an answer, but there is no terminal: ${question.trim()}`)
    }
    const rl = createInterface({ input: this.inputStream, output: this.output })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }

  /** @type {UI['select']} */
  async select(message, choices, options = {}) {
    const def = options.default ?? 0
    for (;;) {
      this.write(`${message}\n`)
      let group = null
      choices.forEach((c, i) => {
        if (c.group && c.group !== group) {
          group = c.group
          this.write(`${c.group}\n`)
        }
        this.write(`${i === def ? '❯' : ' '} ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? `   ${c.hint}` : ''}\n`)
      })
      const a = (await this.ask(`Choose 1-${choices.length} [${def + 1}]: `)).trim()
      if (!a) return choices[def].value
      const n = Number(a)
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value
      this.write('Type the number of a choice.\n')
    }
  }

  /** @type {UI['confirm']} */
  async confirm(message, options = {}) {
    const def = options.default ?? false
    for (;;) {
      const a = (await this.ask(`${message} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
      if (!a) return def
      if (['y', 'yes'].includes(a)) return true
      if (['n', 'no'].includes(a)) return false
    }
  }

  /** @type {UI['input']} */
  async input(message, options = {}) {
    for (;;) {
      const a = (await this.ask(`${message}${options.default ? ` [${options.default}]` : ''}: `)).trim() || options.default || ''
      const problem = options.validate?.(a) ?? null
      if (!problem) return a
      this.write(`${problem}\n`)
    }
  }

  /** @param {string} s */
  write(s) {
    this.clearStatus()
    this.output.write(s)
  }

  clearStatus() {
    if (this.statusShown && /** @type {any} */ (this.output).isTTY) this.output.write('\r\x1b[K')
    this.statusShown = false
  }

  /** @param {string} m */
  info(m) {
    this.write(`${m}\n`)
  }

  /** @param {string} m */
  warn(m) {
    this.write(`warning: ${m}\n`)
  }

  /** @param {string} m */
  step(m) {
    this.write(`→ ${m}\n`)
  }

  /** @param {string} m */
  status(m) {
    if (/** @type {any} */ (this.output).isTTY) {
      this.output.write(`\r\x1b[K${m}`)
      this.statusShown = true
    } else {
      this.output.write(`${m}\n`)
    }
  }
}

/**
 * Scripted answers for tests: each answer is matched by a substring of the question.
 * @implements {UI}
 */
export class ScriptedUI {
  /** @param {{ match: string | RegExp, answer: any }[]} answers */
  constructor(answers = []) {
    this.answers = [...answers]
    /** @type {string[]} */
    this.log = []
    if (process.env.RELEASE_TOOLS_DEBUG_UI) {
      const push = this.log.push.bind(this.log)
      this.log.push = (...items) => {
        for (const i of items) process.stderr.write(`[ui] ${i}\n`)
        return push(...items)
      }
    }
  }

  /** @param {{ match: string | RegExp, answer: any }[]} more */
  push(...more) {
    this.answers.push(...more)
  }

  /** @param {string} question */
  take(question) {
    const i = this.answers.findIndex((a) => (typeof a.match === 'string' ? question.includes(a.match) : a.match.test(question)))
    if (i < 0) throw new Error(`ScriptedUI: no answer for "${question}"`)
    const [a] = this.answers.splice(i, 1)
    return a.answer
  }

  /** @type {UI['select']} */
  async select(message, choices) {
    const full = `${message}\n${choices.map((c) => `${c.label} ${c.hint ?? ''}`).join('\n')}`
    this.log.push(`? ${full}`)
    const a = this.take(message)
    const found =
      typeof a === 'function'
        ? choices.find(a)
        : choices.find((c) => c.label === a || (typeof a === 'string' && c.label.startsWith(a)) || c.value === a)
    if (!found) throw new Error(`ScriptedUI: "${String(a)}" is not a choice of "${message}":\n${full}`)
    return found.value
  }

  /** @type {UI['confirm']} */
  async confirm(message) {
    this.log.push(`? ${message}`)
    const a = this.take(message)
    // A function answer runs while the question is open (tests change things "during" the question).
    return !!(typeof a === 'function' ? await a() : a)
  }

  /** @type {UI['input']} */
  async input(message, options = {}) {
    this.log.push(`? ${message}`)
    const a = String(this.take(message) ?? options.default ?? '')
    const problem = options.validate?.(a) ?? null
    if (problem) throw new Error(`ScriptedUI: invalid input for "${message}": ${problem}`)
    return a
  }

  /** @param {string} m */
  info(m) {
    this.log.push(m)
  }

  /** @param {string} m */
  warn(m) {
    this.log.push(`warning: ${m}`)
  }

  /** @param {string} m */
  step(m) {
    this.log.push(`→ ${m}`)
  }

  /** @param {string} m */
  status(m) {
    if (this.log[this.log.length - 1] !== `… ${m}`) this.log.push(`… ${m}`)
  }

  text() {
    return this.log.join('\n')
  }
}
