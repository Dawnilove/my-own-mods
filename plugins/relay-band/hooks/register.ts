// relay-band: 입력창 위의 통합 띠 한 줄.
//   검증 │ 자식 N │ 컨텍스트 % │ 주 % · 오늘 x/y │ 턴 │ 비용 │ 캐시 │ 날씨·추이 │ 페이스
// 창이 좁으면 우선순위가 낮은 칸(번호가 큰 것)부터 숨긴다.
// 호스트가 소스에서 on(...) 과 $.noun.method(...) 를 읽으므로 literal 로 쓰고, $ 를 받는 도우미는 최상위 함수로 둔다.

import type { Register } from 'claude-code'

const DAY = 86_400_000
// ponytail 줄의 안쪽 여백에 맞추는 들여쓰기 칸 수(데스크톱 화면만). 화면에서 보고 어긋나면 이 값만 바꾼다.
const INDENT = 1
// shortcut: ponytail 띠가 이미 비용을 보여줘서 뺐다. ponytail 없이 쓰면 true 로 바꾼다.
const SHOW_COST = false
const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'
const CACHE_MINUTES = 60
const TSC_TIMEOUT_MS = 45_000
// shortcut: 쉬는 날 가중치를 상수로 박았다. 사람마다 다르면 userConfig 로 올린다.
const WEIGHT_WEEKEND = 0.3

type Verify = { state: 'ok' | 'fail' | 'skip'; text: string } | null
type Seg = { prio: number; text: string; color?: string; dim?: boolean }

let verify: Verify = null
let verifying = false
let edited = new Set<string>()
let turnStartedAt = 0
let lastTurnSec: number | null = null
let lastAnswerAt = 0
let children = 0
let context: { percent: number; tokens: number; window: number } | null = null
let costUsd: number | null = null
let week: { percent: number; resetsAt?: string } | null = null
let dayBase: { date: string; reset: string; percent: number } | null = null
let history: number[] = []
let ticker: { cancel: () => void } | null = null
let lastUsageAt = 0
let limitKinds: string[] = [] // 진단용: 엔진이 알려 준 한도 창의 종류

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    ticker?.cancel()
    ticker = $.clock.every(5000, () => tick($))
    try {
      applyUsage(await $.session.usage())
      await trackDay($)
    } catch {
      // 사용량을 아직 못 읽어도 띠는 나머지 칸으로 뜬다
    }
    $.ui.invalidate('ui.render')
    return result
  })

  on('session.measure', async ($, e, next) => {
    applyUsage(e)
    await trackDay($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    turnStartedAt = await $.clock.now()
    return next(e)
  })

  for (const tool of ['Edit', 'Write', 'MultiEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran: any = await next(e)
      if (ran.deny === undefined && ran.isError !== true) edited.add(String((e as any).file_path ?? ''))
      return ran
    })
  }

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await tick($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((e as any).agentId) return result // 하위 에이전트의 턴은 건너뛴다
    const now = await $.clock.now()
    lastTurnSec = Math.round((now - turnStartedAt) / 1000)
    lastAnswerAt = now
    if (context) history = [...history, context.percent].slice(-HISTORY)
    const files = [...edited].filter(f => f !== '')
    edited = new Set()
    if (files.length > 0) {
      verifying = true
      $.ui.invalidate('ui.render')
      try {
        verify = await runVerify($, files)
      } finally {
        verifying = false
      }
    } else {
      verify = null
    }
    await tick($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props: any = (e as any).props ?? {}
    if (props.hasSurvey) return next(e)
    const segs = buildSegs(Date.now(), props.isWorking === true)
    if (segs.length === 0) return next(e)
    // 입력창 위 띠는 한 자리라서, 아래 플러그인(예: ponytail)의 띠를 먼저 받아 위에 함께 그린다.
    const beneath: any = await next(e)
    const cols: number = props.bodyColumns ?? 80
    const { Box, Text } = $.ui.resolve(e) as any
    // 데스크톱 화면에서는 ponytail 의 버튼이 안쪽 여백을 두껍게 그려서 그 줄이 오른쪽으로 밀린다. 같은 만큼 들여쓴다.
    const indent = (e as any).surface === 'desktop' ? INDENT : 0
    // 2층 구조: 1층은 ponytail 줄, 2층은 이 줄 하나. 폭이 좁으면 번호가 큰 칸부터 뺀다.
    const floor = (key: string, list: Seg[]) => {
      const kept = fit(list, cols - indent)
      const children: any[] = []
      kept.forEach((s, i) => {
        if (i > 0) children.push(Text({ key: `${key}sep${i}`, dimColor: true, children: ' │ ' }))
        children.push(Text({ key: `${key}s${i}`, color: s.color, dimColor: s.dim, children: s.text }))
      })
      return Box({ key, children })
    }
    const shown = SHOW_COST ? segs : segs.filter(s => s.prio !== 6)
    const mine = Box({ key: 'relay', paddingLeft: indent, children: [floor('f1', shown)] })
    return beneath ? Box({ flexDirection: 'column', children: [Box({ key: 'beneath', children: [beneath] }), mine] }) : mine
  })
}

async function tick($: any) {
  try {
    const list: any[] = await $.agent.list()
    children = list.filter(a => a.status === 'running').length
  } catch {
    // 목록을 못 읽으면 이전 값을 둔다
  }
  $.ui.invalidate('ui.render')
}

function applyUsage(u: any) {
  lastUsageAt = Date.now()
  const c = u?.context
  if (c?.window) {
    const tokens = c.tokens ?? 0
    context = { tokens, window: c.window, percent: Math.round(c.percent ?? (tokens / c.window) * 100) }
  }
  if (u?.cost) costUsd = u.cost.usd
  const limits: any[] = u?.rateLimits ?? []
  limitKinds = limits.map(r => String(r.kind))
  const w = limits.find(r => r.kind === 'seven_day') ?? limits.find(r => String(r.kind).startsWith('seven_day'))
  if (w) week = { percent: w.percentUsed, resetsAt: w.resetsAt }
}

// 오늘 시작 때의 주간 %를 저장해 두고, 현재 값에서 빼서 "오늘 쓴 양"을 계산한다.
// shortcut: 그날 첫 읽기를 시작점으로 삼아서, 하루 중간에 처음 켜면 그 전 사용량은 빠진다.
async function trackDay($: any) {
  if (!week) return
  const date = dateKey(Date.now())
  const reset = week.resetsAt ?? ''
  if (!dayBase) {
    const saved: any = await $.store.get('dayBase')
    if (saved && typeof saved.percent === 'number') dayBase = saved
  }
  if (!dayBase || dayBase.date !== date || dayBase.reset !== reset || week.percent < dayBase.percent) {
    dayBase = { date, reset, percent: week.percent }
    await $.store.set('dayBase', dayBase)
  }
}

function dateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function weight(day: number): number {
  return day === 0 || day === 6 ? WEIGHT_WEEKEND : 1
}

/** 오늘 권장 사용량(%p)과 페이스(%p, +면 앞서감). 리셋 시각을 모르면 null. */
export function dailyBudget(percent: number, base: number, resetsAt: string | undefined, now: number) {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(reset) || reset <= now) return null
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const today = weight(d.getDay())
  let sum = 0
  while (d.getTime() < reset) {
    // 리셋이 낀 마지막 날은 리셋 시각까지의 몫만 센다.
    sum += weight(d.getDay()) * Math.min(1, (reset - d.getTime()) / DAY)
    d.setDate(d.getDate() + 1)
  }
  if (sum <= 0) return null
  const recommended = ((100 - base) * today) / sum
  const elapsed = 1 - (reset - now) / (7 * DAY)
  return { recommended, pace: percent - elapsed * 100 }
}

function buildSegs(now: number, isWorking: boolean): Seg[] {
  const segs: Seg[] = []
  if (verifying) segs.push({ prio: 1, text: '검증 중…', color: 'cyan' })
  else if (verify) segs.push({ prio: 1, text: verify.text, color: verify.state === 'ok' ? 'green' : verify.state === 'fail' ? 'red' : 'yellow' })

  segs.push({ prio: 2, text: `자식 ${children}`, dim: children === 0, color: children > 0 ? 'cyan' : undefined })

  if (context) {
    const p = context.percent
    segs.push({ prio: 3, text: `컨텍스트 ${p}%`, color: p >= 85 ? 'red' : p >= 70 ? 'yellow' : undefined })
  }

  if (week) {
    const b = dayBase ? dailyBudget(week.percent, dayBase.percent, week.resetsAt, now) : null
    if (b && dayBase) {
      const used = Math.max(0, week.percent - dayBase.percent)
      const color = used > b.recommended * 1.5 ? 'red' : used > b.recommended ? 'yellow' : undefined
      segs.push({ prio: 4, text: `주 ${Math.round(week.percent)}% · 오늘 ${used.toFixed(0)}/${b.recommended.toFixed(0)}`, color })
      const pace = Math.round(b.pace)
      segs.push({ prio: 9, text: pace > 0 ? `페이스 +${pace}%p 앞섬` : `페이스 ${pace}%p 여유`, color: pace > 10 ? 'yellow' : undefined, dim: pace <= 10 })
    } else {
      segs.push({ prio: 4, text: `주 ${Math.round(week.percent)}%` })
    }
  }

  else if (lastUsageAt > 0) {
    // 주간 한도를 못 찾았을 때 이유를 띠에 보여 준다. 확인이 끝나면 지운다.
    segs.push({ prio: 4, text: limitKinds.length > 0 ? `한도 종류 ${limitKinds.join(',')}` : '한도 값 없음', dim: true })
  }

  if (isWorking && turnStartedAt > 0) segs.push({ prio: 5, text: `턴 ${fmt(Math.round((now - turnStartedAt) / 1000))}`, color: 'cyan' })
  else if (lastTurnSec !== null) segs.push({ prio: 5, text: `턴 ${fmt(lastTurnSec)}`, dim: true })

  if (costUsd !== null) segs.push({ prio: 6, text: `$${costUsd.toFixed(2)}` })

  if (!isWorking && lastAnswerAt > 0) {
    const left = CACHE_MINUTES - Math.floor((now - lastAnswerAt) / 60_000)
    if (left <= 0) segs.push({ prio: 7, text: '캐시 만료', color: 'red' })
    else segs.push({ prio: 7, text: `캐시 ${left}분`, color: left <= 10 ? 'red' : left <= 20 ? 'yellow' : undefined, dim: left > 20 })
  }

  if (context && history.length > 0) {
    const bars = history.map(p => BARS[Math.min(BARS.length - 1, Math.floor((p / 100) * BARS.length))]).join('')
    segs.push({ prio: 8, text: `${forecast(context.percent)} ${bars}`, dim: true })
  }
  return segs
}

// 단일 폭 기호(이모지 아님): 글꼴이 달라도 줄이 맞는다.
function forecast(p: number): string {
  return p < 25 ? '☀' : p < 50 ? '☁' : p < 75 ? '☂' : p < 90 ? '☇' : '↯'
}

function fmt(sec: number): string {
  return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`
}

/** 폭에 들어갈 때까지 번호가 가장 큰 칸부터 뺀다. 나머지는 원래 순서를 지킨다. */
export function fit(segs: Seg[], cols: number): Seg[] {
  // 한글·한자는 터미널에서 두 칸을 차지한다.
  const cells = (t: string) => [...t].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0)
  const width = (list: Seg[]) => list.reduce((n, s) => n + cells(s.text) + 3, 0) - 3
  let kept = [...segs]
  while (kept.length > 1 && width(kept) > cols - 2) {
    const worst = Math.max(...kept.map(s => s.prio))
    kept = kept.filter(s => s.prio !== worst)
  }
  return kept.sort((a, b) => a.prio - b.prio)
}

// ---- 검증: 편집한 파일을 확인하고 결과를 띠에 남긴다 --------------------------------

async function runVerify($: any, files: string[]): Promise<Verify> {
  const py = files.filter(f => /\.py$/i.test(f))
  const ts = files.filter(f => /\.(ts|tsx)$/i.test(f))
  if (py.length === 0 && ts.length === 0) return null // 확인 대상이 아닌 파일(문서 등)은 말하지 않는다

  const failed: string[] = []
  let checked = 0
  let skipped = 0

  for (const f of py) {
    const run = await tryRun($, [['python', '-m', 'py_compile', f], ['py', '-m', 'py_compile', f]], undefined, 20_000)
    if (run === null) skipped += 1
    else if (run.exitCode === 0) checked += 1
    else failed.push(base(f))
  }

  const dirs = new Set<string>()
  for (const f of ts) {
    const dir = await findTsconfigDir($, f)
    if (dir === null) skipped += 1
    else dirs.add(dir)
  }
  for (const dir of dirs) {
    const run = await tryRun($, [['npx', '--no-install', 'tsc', '--noEmit', '-p', dir], ['npx.cmd', '--no-install', 'tsc', '--noEmit', '-p', dir]], dir, TSC_TIMEOUT_MS)
    const out = run ? `${run.stdout}${run.stderr}` : ''
    if (run === null || (run.exitCode !== 0 && !/error TS\d+/.test(out))) skipped += 1 // tsc 가 없거나 못 돌았다
    else if (run.exitCode === 0) checked += 1
    else failed.push(`tsc ${base(dir)}`)
  }

  if (failed.length > 0) return { state: 'fail', text: `✗ 검증 실패: ${failed.slice(0, 2).join(', ')}` }
  if (checked === 0) return { state: 'skip', text: '⚠ 검증 못함 (도구 없음)' }
  return { state: 'ok', text: `✓ 검증 ${checked}${skipped > 0 ? ` (못한 것 ${skipped})` : ''}` }
}

function base(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
}

async function findTsconfigDir($: any, file: string): Promise<string | null> {
  let dir = file.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
  for (let i = 0; i < 8 && dir !== ''; i += 1) {
    if (await $.fs.exists(`${dir}/tsconfig.json`)) return dir
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir) break
    dir = up
  }
  return null
}

/** 명령 후보를 차례로 시도해서, 실행 파일을 찾은 첫 결과를 돌려준다. 하나도 못 돌리면 null. */
async function tryRun($: any, candidates: string[][], cwd: string | undefined, timeoutMs: number) {
  for (const argv of candidates) {
    try {
      return await $.process.run(argv, { cwd, timeoutMs })
    } catch {
      // 다음 후보
    }
  }
  return null
}
