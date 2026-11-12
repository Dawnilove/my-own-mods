// edit-guard: 파일을 깨뜨리는 명령은 막고, 위험한 삭제·git 명령은 영향 범위를 보여준 뒤 진행/취소를 묻는다.
// 기법은 anthropics/claude-code-playground 의 blast-radius 를 따랐다.
//
// tool.call (Bash, PowerShell):
//   1) sed -i, heredoc 로 파일 쓰기, python/PowerShell 문자열 치환 → 바로 거부 (Edit/Write 도구 안내)
//   2) rm -r/-f, git reset --hard, git clean, git push --force, git checkout/restore . , Remove-Item -Recurse
//      → 영향 범위를 재서 패널에 띄우고 진행/취소를 기다림
// 호스트가 소스에서 on(...) 과 $.noun.method(...) 를 읽으므로 literal 로 쓰고, $ 를 받는 도우미는 최상위 함수로 둔다.

import type { Register } from 'claude-code'

const PANE_ID = 'edit-guard'
const HOLD_LIMIT_MS = 10 * 60 * 1000
const LIST_MAX = 10
const POLL_MS = 250

// unknown: 영향 범위를 알 수 없는 경우. "없음"으로 단정하지 않고 모름 패널로 그린다.
// recover: 되돌릴 수 있는지, 단계(err/warn/mute)와 문구. 알 수 없으면 비운다.
// facts: "원인 …", "해결 …" 처럼 이름표가 붙은 줄.
type Recover = ['err' | 'warn' | 'mute', string]
type Report = { summary: string; lines: string[]; more?: number; note?: string; unknown?: boolean; recover?: Recover[]; facts?: [string, string][] }
type Risk = { kind: string; label: string; targets?: string[]; args?: string[]; dir?: string }
// cwd: 영향을 잰 폴더. showCommand: 명령 펼침. leftMs: 기다릴 수 있는 남은 시간.
type Held = { command: string; risk: Risk; report: Report | null; decision: string | null; where: 'pane' | 'band'; cwd: string; showCommand: boolean; leftMs: number }

// 붙잡고 있는 호출. 한 번에 하나만.
let held: Held | null = null
// 위험으로 분류된 명령 문자열. 훅이 실패했을 때 거부할지 가르는 데 쓴다.
const flagged = new Set<string>()

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => guard($, e, next, 'Bash')).catch(failClosed)
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => guard($, e, next, 'PowerShell')).catch(failClosed)

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) return next(e)
    return draw($.ui.resolve(e), held)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== 'band') return next(e)
    return draw($.ui.resolve(e), held, true)
  })
}

// 훅이 중간에 실패해도 위험 명령은 지나가지 못하게 한다. 위험하지 않은 명령은 그대로 보낸다.
function failClosed($: any, e: any, next: any) {
  if (next.called || !flagged.has(String(e.command ?? ''))) return next(e)
  return { deny: 'edit-guard: 위험 명령을 확인하다 실패해서 실행하지 않았습니다. 사용자가 요청하기 전에는 다시 시도하지 마세요.' }
}

async function guard($: any, e: any, next: any, tool: 'Bash' | 'PowerShell') {
  const command = String(e.command ?? '')

  const corrupt = corruptReason(command, tool)
  if (corrupt !== null) {
    return {
      // 이름표(이유·대신·재시도)를 줄로 나눠 구조를 만든다. 판정과 안내 내용은 그대로다.
      deny: `✗ edit-guard 막음 · ${corrupt}\n이유   파일을 조용히 깨뜨릴 수 있는 명령입니다\n대신   Edit 또는 Write 도구로 수정한 뒤 결과를 확인하세요\n재시도 사용자가 이 방식을 직접 요청한 경우에만 다시 시도하세요`,
    }
  }

  const risk = classify(command, tool)
  if (risk === null) return next(e)
  flagged.add(command)

  // 한 번에 하나만 붙잡는다. 이미 붙잡힌 호출이 있으면 끝날 때까지 기다린다.
  try {
    while (held !== null) {
      if (next.signal?.aborted) throw new Error('aborted')
      await pause($)
    }
  } catch {
    return { deny: 'edit-guard: 이 명령을 붙잡았지만 턴이 중단되어 실행하지 않았습니다. 사용자가 요청하기 전에는 다시 시도하지 마세요.' }
  }

  const mine: Held = { command, risk, report: null, decision: null, where: 'pane', cwd: '', showCommand: false, leftMs: HOLD_LIMIT_MS }
  held = mine
  let isPlaced = false
  let summary = risk.label
  let unknown = false

  try {
    const sessionCwd: string = await $.session.cwd()
    const cwd = risk.dir ? resolvePath(sessionCwd, risk.dir) : sessionCwd
    mine.report = await measure($, risk, cwd)
    summary = mine.report.summary
    unknown = mine.report.unknown === true
    mine.cwd = cwd
    mine.showCommand = unknown // 영향을 모를 때는 명령을 처음부터 펼쳐 보인다

    const opened = await $.ui.open({ id: PANE_ID, title: 'edit-guard', focus: true, rows: paneRows(mine.report) })
    isPlaced = opened.isPlaced
    if (!isPlaced) mine.where = 'band' // 패널을 못 그리는 좁은 화면이면 입력창 위 띠로 대신 그린다
    $.ui.invalidate('ui.render')

    const startedAt: number = await $.clock.now()
    while (mine.decision === null) {
      mine.leftMs = HOLD_LIMIT_MS - ((await $.clock.now()) - startedAt)
      if (mine.leftMs <= 0) {
        mine.decision = 'timeout'
        break
      }
      if (next.signal?.aborted) {
        mine.decision = 'interrupted'
        break
      }
      // 남은 시간과 명령 펼침 상태를 다시 그린다.
      $.ui.invalidate('ui.render')
      await pause($)
    }
  } catch {
    // 중단이면 interrupted, 그 밖의 예외는 안전하게 거부한다.
    mine.decision = next.signal?.aborted ? 'interrupted' : 'error'
  } finally {
    try {
      if (isPlaced) await $.ui.close({ id: PANE_ID })
    } catch {
      // 이미 닫힘
    }
    if (held === mine) held = null
    $.ui.invalidate('ui.render')
  }

  if (mine.decision === 'proceed') {
    $.ui.toast('edit-guard: 진행합니다')
    return next(e)
  }
  const why =
    ({
      cancel: '사용자가 취소를 눌렀습니다',
      timeout: '10분 안에 답이 없었습니다',
      interrupted: '턴이 중단되었습니다',
      error: 'edit-guard 에서 오류가 났습니다',
    } as Record<string, string>)[mine.decision ?? ''] ?? '답이 기록되지 않았습니다'
  return {
    deny: `edit-guard: 이 명령을 붙잡아 실행하지 않았습니다 (${why}). ${unknown ? `영향 범위를 알 수 없었습니다 (${summary})` : `실행하면 ${summary}`}. 사용자가 요청하기 전에는 다시 시도하지 마세요.`,
  }
}

// 훅 자신의 시간은 10초뿐이고 $.clock.sleep 도 그 안에서 센다. $ 호출 안에서 보낸 시간은 세지 않으므로
// 프로세스를 띄워서 기다린다(blast-radius 가 sleep 프로세스를 쓰는 것과 같은 이유).
async function pause($: any) {
  for (const argv of [['powershell', '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700'], ['C:/Program Files/Git/bin/bash.exe', '-c', 'sleep 0.7']]) {
    try {
      await $.process.run(argv, { timeoutMs: 5000 })
      return
    } catch {
      // 다음 후보
    }
  }
  throw new Error('기다릴 방법이 없음')
}

// ---- 1) 파일을 깨뜨리는 명령 ------------------------------------------------

const stripQuoted = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
// 진짜 heredoc 표시만: <<WORD, <<-WORD, <<'WORD'. <<< (here-string) 와 1<<2 (산술) 는 아니다. lookbehind 는 쓰지 않는다.
const HEREDOC = /(^|[^<])<<-?\s*['"]?([A-Za-z_]\w*)['"]?/
// 본문이 그대로 실행되는 해석기 앞의 heredoc 은 본문도 명령이므로 지우지 않는다.
const INTERPRETER = /\b(?:bash|sh|zsh|dash|python3?|py|node|pwsh|powershell)(?:\.exe)?\b[^|;&\n]*<</

/** heredoc 본문(두 번째 줄부터 끝 표시까지)을 뺀다. 파일에 쓰는 본문은 명령이 아니라 글자다. */
function dropHeredocBodies(cmd: string): string {
  const out: string[] = []
  let end: string | null = null
  for (const line of cmd.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    out.push(line)
    // 따옴표 안의 << 는 표시가 아니다. 표시 끝 단어의 따옴표(<<'EOF')만 먼저 벗긴다.
    const plain = stripQuoted(line.replace(/<<-?\s*(['"])([A-Za-z_]\w*)\1/g, '<<$2'))
    const m = HEREDOC.exec(plain)
    if (m && !INTERPRETER.test(plain)) end = m[2]
  }
  return out.join('\n')
}

/** 따옴표 안의 글자와 heredoc 본문을 비워서, 명령이 아닌 글자에 걸리지 않게 한 문자열. */
function visibleText(command: string): string {
  const marked = dropHeredocBodies(command).replace(/(^|[^<])<<-?\s*['"]?([A-Za-z_]\w*)['"]?/g, '$1<<$2')
  return stripQuoted(marked)
}

// shell -c "..." 와 powershell -Command "..." 는 따옴표 안이 실제 명령이다. 앞에 sudo·env·옵션이 붙어도 푼다.
const WRAP_PREFIX = new Set(['command', 'exec', 'env', 'nohup', 'time', 'sudo'])
function unwrap(seg: string): { script: string; tool: 'Bash' | 'PowerShell' } | null {
  const words = tokenize(seg.trim())
  while (words.length > 0 && (WRAP_PREFIX.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift()
  const first = words[0] ?? ''
  if (/^(?:.*[\\/])?(?:bash|sh|zsh|dash)(?:\.exe)?$/i.test(first)) {
    const k = words.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w))
    return k >= 0 ? { script: words[k + 1] ?? '', tool: 'Bash' } : null
  }
  if (/^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i.test(first)) {
    const k = words.findIndex((w, i) => i > 0 && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(w))
    return k >= 0 ? { script: words.slice(k + 1).join(' '), tool: 'PowerShell' } : null
  }
  return null
}

// python 으로 읽은 글자를 바꿔서 같은 파일에 다시 쓰는 패턴. 읽기만 하는 코드는 걸리지 않는다.
function isPyReplace(command: string, visible: string): boolean {
  return (
    /\b(?:python3?|py)\b/.test(visible) &&
    /(?:open\([^)]*['"][wa]b?\+?['"]|write_text\(|write_bytes\()/.test(command) &&
    /(?:\.replace\(|re\.sub\(|\.sub\()/.test(command)
  )
}

// shortcut: 정규식으로 본다. 따옴표 안과 heredoc 본문은 뺐지만, 변수나 $( ) 로 만든 명령은 못 본다. 새는 게 보이면 토큰 분석으로 올린다.
export function corruptReason(command: string, tool: 'Bash' | 'PowerShell'): string | null {
  const visible = visibleText(command)
  if (tool === 'PowerShell') {
    const writes = /(Set-Content|Out-File|WriteAllText|Add-Content)/i.test(visible)
    if (writes && /(-[ci]?replace\b|\.Replace\()/i.test(visible)) return 'PowerShell 문자열 치환 후 덮어쓰기'
    if (isPyReplace(command, visible)) return 'python 문자열 치환 후 덮어쓰기'
    return null
  }
  // bash -c "sed -i ..." 처럼 따옴표 안에 든 명령도 본다.
  for (const seg of splitTop(dropHeredocBodies(command))) {
    const w = unwrap(seg)
    const r = w ? corruptReason(w.script, w.tool) : null
    if (r !== null) return r
  }
  // 옵션 묶음은 해당 도구의 한 글자 옵션만 본다. perl -Mstrict 의 i 는 옵션이 아니다.
  if (/\bsed\b[^\n|;&]*\s(?:-[nEefrsuzl]*i|--in-place)/.test(visible)) return 'sed -i'
  if (/\bperl\b[^\n|;&]*\s-[pnals0-9]*i/.test(visible)) return 'perl -i'
  const toFile = '>{1,2}\\s*(?!/dev/null)[^\\s&|;]+'
  const hereDocToFile =
    new RegExp(`<<\\w+[^\\n;&|]*${toFile}`).test(visible) ||
    new RegExp(`\\b(?:cat|tee)\\b[^\\n;&|]*${toFile}[^\\n;&|]*<<\\w+`).test(visible) ||
    /\btee\b\s+(?:-[a-zA-Z]+\s+)*[^\s&|;<>-][^\n;&|]*<<\w+/.test(visible)
  if (hereDocToFile) return 'heredoc 으로 파일 쓰기'
  if (isPyReplace(command, visible)) return 'python 문자열 치환 후 덮어쓰기'
  return null
}

// ---- 2) 붙잡을 위험 명령 -----------------------------------------------------

function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) words.push(m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, '$1') : (m[2] ?? m[3]))
  return words
}

function resolvePath(base: string, p: string): string {
  return /^([A-Za-z]:|\/|~)/.test(p) ? p : `${base}/${p}`
}

// shortcut: cd 로 옮긴 폴더는 따라가지 않고 세션 폴더 기준으로 잰다. 어긋나면 cd 추적을 붙인다.
export function classify(command: string, tool: 'Bash' | 'PowerShell'): Risk | null {
  const visible = visibleText(command)
  // `gci -Recurse | Remove-Item` 처럼 지울 대상을 파이프로 넘기면 미리 셀 수 없다.
  const isWhatIf = /\s-wh(?:a(?:t(?:i(?:f)?)?)?)?\b/i.test(visible) // 미리보기는 아무것도 지우지 않는다
  if (tool === 'PowerShell' && !isWhatIf && /\|\s*(?:Remove-Item|ri|del|rm|rmdir|rd)\b/i.test(visible) && /\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/i.test(visible)) {
    return { kind: 'unmeasured', label: 'Remove-Item -Recurse (파이프)' }
  }
  for (const seg of splitTop(dropHeredocBodies(command))) {
    // bash -c "..." / powershell -Command "..." 안의 명령도 같은 눈으로 본다.
    const w = unwrap(seg)
    if (w !== null) {
      const r = classify(w.script, w.tool)
      if (r !== null) return r
      continue
    }
    const r = tool === 'PowerShell' ? classifyPs(seg) : classifySh(seg)
    if (r !== null) return r
  }
  return null
}

// 알려진 한계(정규식 방식): 주석이나 it\'s 의 가짜 따옴표, "C:\out\" 의 \", $( )·백틱 안의 명령은 못 본다.
// 실수성 명령을 막는 안전장치이며, 일부러 우회하는 입력을 막는 보안 장치는 아니다.

/** ; | & 줄바꿈으로 나누되 따옴표 안은 나누지 않는다. 2>&1 의 & 는 나누지 않는다. */
function splitTop(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (quote !== null) {
      cur += c
      if (c === '\\' && quote === '"') cur += command[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const isRedirectAmp = c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && !isRedirectAmp)) {
      out.push(cur)
      cur = ''
      while ((c === '&' || c === '|') && command[i + 1] === c) i += 1
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!', 'sudo'])

function classifySh(segment: string): Risk | null {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
  while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift()
  const [first, ...args] = words
  if (first === undefined) return null
  const cmd = first.replace(/^\\/, '')

  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter(a => a.startsWith('-'))
    const recursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const force = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (recursive || force) {
      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets: args.filter(a => !a.startsWith('-')) }
    }
  }

  // xargs rm -rf, find -delete 는 지울 대상을 미리 셀 수 없어서 영향 범위 없이 묻는다.
  if (cmd === 'xargs') {
    const k = args.indexOf('rm')
    const inner = k >= 0 ? classifySh(args.slice(k).join(' ')) : null
    if (inner?.kind === 'rm') return { kind: 'unmeasured', label: `xargs ${inner.label}` }
  }
  if (cmd === 'find') {
    if (args.includes('-delete')) return { kind: 'unmeasured', label: 'find -delete' }
    const k = args.findIndex(a => a === '-exec' || a === '-execdir')
    if (k >= 0 && /(?:^|\/)rm$/.test(args[k + 1] ?? '')) return { kind: 'unmeasured', label: 'find -exec rm' }
  }

  if (cmd === 'git') {
    let dir: string | undefined
    let i = 0
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) {
        dir = args[i + 1]
        i += 2
      } else if (args[i] === '-c' && i + 1 < args.length) i += 2
      else i += 1
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (sub === 'reset' && rest.includes('--hard')) return { kind: 'git-reset', label: 'git reset --hard', args: rest, dir }
    if (sub === 'clean') {
      if (rest.some(a => a === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return null // 미리보기는 아무것도 지우지 않는다
      return { kind: 'git-clean', label: 'git clean', args: rest, dir }
    }
    if (sub === 'push' && rest.some(a => a.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))) {
      return { kind: 'git-push-force', label: 'git push --force', args: rest, dir }
    }
    const stagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !stagedOnly) {
      return { kind: 'git-checkout', label: `git ${sub} .`, args: rest, dir }
    }
  }
  return null
}

function classifyPs(segment: string): Risk | null {
  const words = tokenize(segment.trim())
  const [first, ...args] = words
  if (first === undefined || !/^(Remove-Item|rm|del|ri|rmdir|rd)$/i.test(first)) {
    return first !== undefined && first.toLowerCase() === 'git' ? classifySh(segment) : null
  }
  const recurse = args.some(a => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(a)) // -r, -rec, -recurse 모두
  if (!recurse || args.some(a => /^-wh(?:a(?:t(?:i(?:f)?)?)?)?$/i.test(a))) return null // -WhatIf 는 미리보기
  const targets: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (/^-(path|literalpath)$/i.test(a)) targets.push(args[++i] ?? '')
    else if (/^-(include|exclude|filter|stream)$/i.test(a)) i += 1
    else if (!a.startsWith('-')) targets.push(...a.split(','))
  }
  return { kind: 'ps-remove', label: 'Remove-Item -Recurse', targets: targets.filter(t => t !== '') }
}

// ---- 영향 범위 측정 ----------------------------------------------------------

// 변수·명령 치환이 든 경로는 우리가 풀지 못한다. 못 푼 경로로 "없음"을 말하면 안 된다.
function hasVar(targets: string[]): boolean {
  return targets.some(t => /[$`]|%\w+%/.test(t))
}

export async function measure($: any, risk: Risk, cwd: string): Promise<Report> {
  if (risk.kind === 'unmeasured') {
    return {
      summary: '지울 대상을 확인하지 못했습니다',
      lines: [],
      unknown: true,
      recover: [NOT_NONE],
      facts: [['원인', '지울 대상을 미리 셀 수 없는 명령입니다']],
    }
  }
  try {
    if (risk.kind === 'rm') return await measureRm($, risk, cwd)
    if (risk.kind === 'ps-remove') return await measurePsRemove($, risk, cwd)
    return await measureGit($, risk, cwd)
  } catch (error: any) {
    return {
      summary: '영향 범위를 재지 못했습니다',
      lines: [],
      unknown: true,
      recover: [NOT_NONE],
      facts: [['원인', `측정 실패: ${String(error?.message ?? error).slice(0, 200)}`], ['확인', 'bash 와 git 이 PATH 에 있는지']],
    }
  }
}

// 모름 상태의 안내. 영향이 없다는 뜻이 아니다.
const NOT_NONE: Recover = ['mute', '파일이 없다는 뜻이 아닙니다. 명령을 읽고 판단하세요.']
const REMOVE_WARN: Recover = ['warn', '⚠ 휴지통을 거치지 않습니다 · git 에 올려 둔 파일이면 되살릴 수 있습니다']
const varName = (targets: string[]) => (targets.join(' ').match(/\$\{?\w+\}?|%\w+%/) ?? ['변수'])[0]

// 경로는 인자로만 넘겨 그 안의 글자가 실행되지 않게 한다.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`

async function measureRm($: any, risk: Risk, cwd: string): Promise<Report> {
  const targets = risk.targets ?? []
  if (targets.length === 0) return { summary: '경로 없는 rm', lines: [], note: '지울 경로가 없습니다.' }
  const run = await runBash($, ['-c', RM_SCRIPT, 'edit-guard', ...targets], { cwd, timeoutMs: 15000 })
  const [head, ...rest] = String(run.stdout).split('\n').filter((l: string) => l !== '')
  const [files, bytes, found] = (head ?? '0 0 0').split(' ').map(Number)
  if (!found && hasVar(targets)) {
    return { summary: '지울 대상을 확인하지 못했습니다', lines: [], unknown: true, recover: [NOT_NONE], facts: [['원인', `변수 ${varName(targets)} 를 풀지 못했습니다`], ['경로', targets.join(' ')]] }
  }
  if (!found) return { summary: `지울 것이 없음: ${targets.join(' ')} 와 맞는 파일이 없습니다`, lines: [], note: '경로가 없어서 rm 이 지울 것이 없습니다.' }
  if (!files) return { summary: `파일 없는 경로 ${found}개를 지웁니다`, lines: [], note: `경로: ${targets.join(' ')}` }
  return {
    summary: `파일 ${files}개 · ${size(bytes)} 삭제`,
    lines: rest.map((l: string) => l.replace(/^\.\//, '')),
    more: Math.max(0, files - rest.length),
    note: `경로: ${targets.join(' ')}`,
    recover: [REMOVE_WARN],
  }
}

// Windows 에서는 bash 가 PATH 에 없는 경우가 많아서 Git 에 딸린 bash 를 대신 시도한다.
async function runBash($: any, args: string[], opts: any) {
  let last: unknown
  for (const exe of ['bash', 'C:/Program Files/Git/bin/bash.exe']) {
    try {
      return await $.process.run([exe, ...args], opts)
    } catch (error) {
      last = error
    }
  }
  throw last
}

function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

async function measurePsRemove($: any, risk: Risk, cwd: string): Promise<Report> {
  const targets = risk.targets ?? []
  if (targets.length === 0) return { summary: '경로 없는 Remove-Item', lines: [], note: '지울 경로가 없습니다.' }
  const script =
    `$t=@(${targets.map(psq).join(',')}); $f=@(); ` +
    `foreach($x in $t){ $f += @(Get-ChildItem -Path $x -Recurse -Force -File -ErrorAction SilentlyContinue) }; ` +
    `$s=($f | Measure-Object Length -Sum).Sum; if(-not $s){$s=0}; "$($f.Count) $s"; ` +
    `$f | Select-Object -First ${LIST_MAX} -ExpandProperty FullName`
  const run = await $.process.run(['powershell', '-NoProfile', '-Command', script], { cwd, timeoutMs: 20000 })
  const [head, ...rest] = String(run.stdout).split(/\r?\n/).filter((l: string) => l !== '')
  const [files, bytes] = (head ?? '0 0').split(' ').map(Number)
  if (!files && hasVar(targets)) {
    return { summary: '지울 대상을 확인하지 못했습니다', lines: [], unknown: true, recover: [NOT_NONE], facts: [['원인', `변수 ${varName(targets)} 를 풀지 못했습니다`], ['경로', targets.join(' ')]] }
  }
  if (!files) return { summary: `지울 파일이 없음: ${targets.join(' ')}`, lines: [], note: '경로가 없거나 파일이 없는 폴더입니다.' }
  return {
    summary: `파일 ${files}개 · ${size(bytes)} 삭제`,
    lines: rest,
    more: Math.max(0, files - rest.length),
    note: `경로: ${targets.join(' ')}`,
    recover: [REMOVE_WARN],
  }
}

async function measureGit($: any, risk: Risk, cwd: string): Promise<Report> {
  const args = risk.args ?? []
  if (risk.kind === 'git-push-force') return await measurePush($, args, cwd)

  if (risk.kind === 'git-clean') {
    const flags: string[] = []
    const paths: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]
      if (a === '--') {
        paths.push(...args.slice(i + 1))
        break
      }
      if (a === '-e' || a === '--exclude') {
        flags.push(a, args[i + 1] ?? '')
        i += 1
      } else if (a.startsWith('--exclude=') || /^-e./.test(a)) flags.push(a)
      else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, '') // -n 은 아래에서 붙인다. -f -i -q 는 미리보기를 바꾼다
        if (kept !== '-') flags.push(kept)
      } else if (!a.startsWith('-')) paths.push(a)
    }
    const run = await $.process.run(['git', 'clean', '-n', ...flags, '--', ...paths], { cwd, timeoutMs: 15000 })
    if (run.exitCode !== 0) return { summary: '영향 범위를 재지 못했습니다', lines: [], unknown: true, recover: [NOT_NONE], facts: [['원인', 'git clean 미리보기에 실패했습니다']], note: String(run.stderr).trim().slice(0, 200) }
    const gone = String(run.stdout).split('\n').filter((l: string) => l.startsWith('Would remove ')).map((l: string) => l.slice(13))
    return {
      summary: gone.length === 0 ? '지울 것이 없음: 맞는 추적 안 된 파일이 없습니다' : `추적 안 된 경로 ${gone.length}개 삭제`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: 'git clean -n 결과입니다.',
      recover: gone.length === 0 ? undefined : [['err', '✗ 추적 안 된 파일이라 git 으로는 되살리기 어렵습니다']],
    }
  }

  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 15000 })
  if (status.exitCode !== 0) return { summary: '영향 범위를 재지 못했습니다', lines: [], unknown: true, recover: [NOT_NONE], facts: [['원인', 'git 저장소인지 확인하지 못했습니다']], note: String(status.stderr).trim().slice(0, 200) }
  const rows = String(status.stdout).split('\n').filter((l: string) => l.length > 3 && !l.startsWith('??'))
  // reset --hard 는 스테이징·작업 트리 변경을 모두, checkout . 은 작업 트리 변경만 버린다.
  const lost = risk.kind === 'git-reset' ? rows : rows.filter((l: string) => l[1] !== ' ')
  const stat = await $.process.run(['git', 'diff', '--shortstat', risk.kind === 'git-reset' ? 'HEAD' : '--'], { cwd, timeoutMs: 15000 })
  const statText = String(stat.stdout).trim()
  // reset --hard <커밋> 은 작업 트리가 깨끗해도 그 사이 커밋을 현재 브랜치에서 내린다.
  const target = risk.kind === 'git-reset' ? args.find(a => !a.startsWith('-')) : undefined
  let dropped: string[] = []
  if (target !== undefined && target !== 'HEAD') {
    const log = await $.process.run(['git', 'log', '--oneline', '--no-decorate', `${target}..HEAD`], { cwd, timeoutMs: 15000 })
    if (log.exitCode === 0) dropped = String(log.stdout).split('\n').filter((l: string) => l !== '')
  }
  if (dropped.length > 0) {
    return {
      summary: `커밋 ${dropped.length}개를 현재 브랜치에서 내리고, 커밋 안 한 변경 ${lost.length}개 파일을 버립니다`,
      lines: [...dropped.slice(0, LIST_MAX), ...lost.slice(0, Math.max(0, LIST_MAX - dropped.length)).map((l: string) => `${l.slice(0, 2)} ${l.slice(3)}`)],
      more: Math.max(0, dropped.length + lost.length - LIST_MAX),
      recover: [
        ...(lost.length > 0 ? ([['err', '✗ 커밋 안 한 변경은 git 으로 되살리기 어렵습니다']] as Recover[]) : []),
        ['warn', `⚠ 커밋 ${dropped.length}개도 현재 브랜치에서 내려갑니다 · reflog 로 복구 가능`],
      ],
    }
  }
  return {
    summary: lost.length === 0 ? '버릴 것이 없음: 커밋 안 한 변경이 없습니다' : `커밋 안 한 변경 ${lost.length}개 파일을 버립니다`,
    lines: lost.slice(0, LIST_MAX).map((l: string) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: statText !== '' ? `${statText}.` : 'git status --porcelain 결과입니다.',
    recover: lost.length === 0 ? undefined : [['err', '✗ 커밋 안 한 변경은 git 으로 되살리기 어렵습니다']],
  }
}

async function measurePush($: any, args: string[], cwd: string): Promise<Report> {
  const positional = args.filter(a => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source, branch] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = (branch ?? '').replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })
    branch = String(head.stdout).trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd, timeoutMs: 10000 })
  if (known.exitCode !== 0) {
    return {
      summary: `${ref} 에서 사라질 커밋을 알 수 없습니다`,
      lines: [],
      unknown: true,
      recover: [['warn', '⚠ 원격 기록을 덮어씁니다']],
      facts: [['원인', `${ref} 의 로컬 사본이 없습니다`], ['해결', `git fetch ${remote}`]],
    }
  }
  const log = await $.process.run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], { cwd, timeoutMs: 15000 })
  const dropped = String(log.stdout).split('\n').filter((l: string) => l !== '')
  return {
    summary: dropped.length === 0 ? `${ref} 강제 푸시: 사라지는 커밋 없음` : `${ref} 강제 푸시: 커밋 ${dropped.length}개가 사라집니다`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `${ref} 에 있고 ${source} 에는 없는 커밋입니다 (마지막 fetch 기준).`,
    recover: dropped.length === 0 ? undefined : [['warn', '⚠ 원격 기록을 덮어씁니다 · 마지막 fetch 기준']],
  }
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// ---- 그리기 ----------------------------------------------------------------

// 칸 수: 테두리 2 + 제목 1 + 영향 2 + 위치 2 + 목록 앞 빈 줄 1 + 메모 1 + 명령 토글 1 + 펼친 명령 3 + 버튼 1 + 남은 시간 1, 거기에 복구·원인·목록 줄.
function paneRows(report: Report): number {
  return Math.min(28, 15 + report.lines.length + (report.more ? 1 : 0) + (report.recover?.length ?? 0) + (report.facts?.length ?? 0))
}

// 위험을 한 단어로 먼저 말한다.
const TITLE: Record<string, string> = {
  rm: '삭제 확인',
  'ps-remove': '삭제 확인',
  unmeasured: '삭제 확인',
  'git-reset': '변경 버리기',
  'git-checkout': '변경 버리기',
  'git-clean': '추적 안 된 파일 삭제',
  'git-push-force': '강제 푸시',
}
const RECOVER_COLOR: Record<string, string | undefined> = { err: 'error', warn: 'warning', mute: undefined }
const BADGE: Record<string, string> = { M: 'warning', A: 'success', D: 'error' }

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 시안의 읽는 순서: 영향(큰 글씨) → 복구 → 위치 → 목록 → 명령 → 버튼 → 남은 시간.
// 명령은 접어 두고, 영향을 모를 때만 처음부터 펼친다. compact 는 패널을 못 놓는 창(입력창 위)용 한 줄 구성이다.
export function draw(t: any, state: Held, compact = false) {
  const { Box, Text, Button } = t
  const report = state.report as Report
  const unknown = report.unknown === true
  const cwd = state.cwd.replace(/\\/g, '/')
  const rel = (p: string) => {
    const q = p.replace(/\\/g, '/')
    return cwd !== '' && q.startsWith(`${cwd}/`) ? q.slice(cwd.length + 1) : q
  }
  // 버튼은 이 패널이 그려진 그 호출에만 답한다. 취소를 왼쪽에 두고 강조한다.
  const decide = (choice: string) => () => {
    if (state.decision === null) state.decision = choice
  }
  const buttons = Box({
    key: 'buttons',
    gap: 2,
    children: [
      Button({ key: 'cancel', label: '취소', hotkey: '2', variant: 'primary', autoFocus: true, onPress: decide('cancel') }),
      Button({ key: 'proceed', label: unknown ? '그래도 진행' : '진행', hotkey: '1', variant: 'secondary', onPress: decide('proceed') }),
    ],
  })
  const wait = Text({ key: 'wait', dimColor: true, children: `Claude 가 기다리는 중 · ${clock(state.leftMs)} 남음` })
  const title = unknown ? '? 영향 범위 모름' : `⚠ ${TITLE[state.risk.kind] ?? state.risk.label}`
  const titleColor = unknown ? 'inactive' : 'warning'
  // 모름은 빨강(위험 단정)이 아니라 평범한 글자색으로 그린다.
  const heroColor = unknown ? undefined : 'error'

  if (compact) {
    const first = report.recover?.[0]
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        Box({
          key: 'one',
          gap: 1,
          children: [
            Text({ key: 't', bold: true, color: titleColor, children: title }),
            Text({ key: 'h', bold: true, color: heroColor, wrap: 'truncate-end', children: report.summary }),
            first ? Text({ key: 'r', dimColor: true, wrap: 'truncate-end', children: `· ${first[1]}` }) : null,
          ],
        }),
        buttons,
        wait,
      ],
    })
  }

  // 목록: 변경 상태(M A D)는 글자 배지로, 커밋은 짧은 해시를 흐리게.
  const row = (line: string, i: number) => {
    const commit = /^([0-9a-f]{7,40}) (.*)$/.exec(line)
    if (commit) return Box({ key: `l${i}`, gap: 1, children: [Text({ dimColor: true, mono: true, children: commit[1] }), Text({ wrap: 'truncate-end', children: commit[2] })] })
    const st = /^([ MADRCU?!]{2}) (.+)$/.exec(line)
    if (st) {
      const letter = st[1][0] !== ' ' ? st[1][0] : st[1][1]
      return Box({ key: `l${i}`, gap: 1, children: [Text({ color: BADGE[letter] ?? 'inactive', bold: true, mono: true, children: letter }), Text({ mono: true, wrap: 'truncate-end', children: rel(st[2]) })] })
    }
    return Text({ key: `l${i}`, mono: true, wrap: 'truncate-end', children: rel(line) })
  }
  const list = report.lines.map(row)
  if (report.more) list.push(Text({ key: 'more', dimColor: true, children: `+ ${report.more}개 더` }))
  // 명령 안의 변수($D 같은 것)는 오류 색으로 표시한다.
  const cmd = state.command
    .split(/(\$\{?\w+\}?|%\w+%)/)
    .filter(p => p !== '')
    .map((p, i) => (/^[$%]/.test(p) ? Text({ key: `c${i}`, color: 'error', bold: true, children: p }) : Text({ key: `c${i}`, children: p })))

  return Box({
    flexDirection: 'column',
    gap: 1,
    borderStyle: 'round',
    borderColor: unknown ? 'inactive' : 'warning',
    paddingX: 1,
    children: [
      Box({
        key: 'hd',
        justifyContent: 'space-between',
        gap: 1,
        children: [Text({ key: 't', bold: true, color: titleColor, children: title }), Text({ key: 'chip', dimColor: true, mono: true, wrap: 'truncate-end', children: state.risk.label })],
      }),
      Text({ key: 'hero', size: 'heading', weight: 'bold', color: heroColor, wrap: 'wrap', children: report.summary }),
      ...(report.recover ?? []).map(([lv, text], i) => Text({ key: `rec${i}`, color: RECOVER_COLOR[lv], dimColor: lv === 'mute', wrap: 'wrap', children: text })),
      Box({ key: 'where', flexDirection: 'column', children: [Text({ key: 'k', dimColor: true, children: '위치' }), Text({ key: 'v', mono: true, wrap: 'truncate-middle', children: state.cwd })] }),
      ...(report.facts ?? []).map(([k, v], i) => Box({ key: `fact${i}`, gap: 2, children: [Text({ key: 'k', dimColor: true, children: k }), Text({ key: 'v', wrap: 'wrap', children: v })] })),
      list.length > 0 ? Box({ key: 'list', flexDirection: 'column', children: list }) : null,
      report.note ? Text({ key: 'note', dimColor: true, italic: true, children: report.note, wrap: 'wrap' }) : null,
      Button({ key: 'cmdtoggle', label: state.showCommand ? '▾ 명령 접기' : '▸ 명령 보기', plain: true, dimColor: true, onPress: () => { state.showCommand = !state.showCommand } }),
      state.showCommand ? Text({ key: 'cmd', mono: true, wrap: 'wrap', children: cmd }) : null,
      buttons,
      wait,
    ],
  })
}
