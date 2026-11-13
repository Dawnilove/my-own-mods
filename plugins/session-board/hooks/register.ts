// session-board: 여러 세션의 상태를 오른쪽 패널에 모아 보여 준다. 진행 중 / 응답 대기 / 완료·유휴.
// 모드는 세션마다 따로 돌고 다른 세션 목록을 주는 API 가 없다. 그래서 세션마다 자기 상태를 파일 하나에 쓰고,
// 패널이 그 폴더를 읽어 모은다. 세션 하나가 파일 하나만 쓰므로 쓰기가 겹치지 않는다.
// 왼쪽 사이드바 항목에는 모드가 그릴 수 없다. 뱃지는 패널 안 카드에 단다.
// 세션을 열면 패널이 같이 열린다(넓은 창에서만 그려진다). "접기" 버튼은 패널을 좁은 너비로 다시 열고 개수 알약만 그린다.
// 호스트가 소스에서 on(...) 과 $.noun.method(...) 를 읽으므로 literal 로 쓰고, $ 를 받는 도우미는 최상위 함수로 둔다.

import type { Register } from 'claude-code'

const PANE_ID = 'session-board'
const TICK_MS = 5_000 // 패널이 열려 있으면 5초마다 폴더를 다시 읽는다
const BEAT_EVERY = 6 // 6틱(30초)마다 살아 있다고 다시 기록한다
const STALE_MS = 90_000 // 90초 넘게 기록이 없으면 죽은 세션으로 보고 숨긴다
const PURGE_MS = 24 * 60 * 60 * 1000 // 하루 넘은 파일은 시작할 때 지운다

export type State = 'running' | 'waiting' | 'idle' | 'ended'
export type Rec = {
  id: string
  name: string
  state: State
  since: number // 지금 상태가 시작된 시각
  turnStartedAt: number | null
  waitFor: string | null
  done: number // 작업 목록 완료 단계
  total: number // 작업 목록 전체 단계
  step: string // 지금 하는 단계(작업 목록의 진행 중 항목)
  updatedAt: number
}

// 색은 my-own-mods 의 다른 모드와 같다. 앱 테마는 읽을 수 없어 고정 색을 쓴다.
const C = { ink: '#14172B', dim: '#5B6080', line: '#E3E6F2', soft: '#EEF0F8', white: '#FFFFFF', indigo: '#4F6BFF', amber: '#FBBF24' }

// ---- 순수 함수(시험 대상) -------------------------------------------------------

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`
  return `${Math.floor(s / 3600)}시간 ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}분`
}

/** 파일 내용이 기록 모양인지 확인한다. 깨진 파일은 null. */
export function parseRec(text: unknown): Rec | null {
  if (typeof text !== 'string') return null
  try {
    const r = JSON.parse(text)
    const okState = r.state === 'running' || r.state === 'waiting' || r.state === 'idle' || r.state === 'ended'
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || !okState || !Number.isFinite(r.since) || !Number.isFinite(r.updatedAt)) return null
    return {
      id: r.id,
      name: r.name,
      state: r.state,
      since: r.since,
      turnStartedAt: Number.isFinite(r.turnStartedAt) ? r.turnStartedAt : null,
      waitFor: typeof r.waitFor === 'string' ? r.waitFor : null,
      done: Number.isFinite(r.done) ? r.done : 0,
      total: Number.isFinite(r.total) ? r.total : 0,
      step: typeof r.step === 'string' ? r.step : '',
      updatedAt: r.updatedAt,
    }
  } catch {
    return null
  }
}

export type Group = 'running' | 'waiting' | 'idle' | 'hidden'
export function groupOf(r: Rec, now: number): Group {
  if (r.state === 'ended' || now - r.updatedAt > STALE_MS) return 'hidden'
  return r.state
}

export type Badge = { text: string; main: boolean }
/** 카드에 달 뱃지. 첫 번째가 알약(주), 나머지는 흐린 글자(보조). */
export function badges(r: Rec, now: number): Badge[] {
  const progress = r.total > 0 ? `${r.done}/${r.total} 단계` : ''
  const elapsed = r.turnStartedAt !== null ? `경과 ${fmtDur(now - r.turnStartedAt)}` : ''
  const list: string[] =
    r.state === 'waiting'
      ? [`${r.waitFor ?? '응답'} 대기`, `대기 ${fmtDur(now - r.since)}`, progress]
      : r.state === 'running'
        ? progress ? [progress, elapsed] : [elapsed]
        : [`${fmtDur(now - r.since)} 전`, progress && `${progress}`]
  return list.filter(t => t !== '').map((text, i) => ({ text, main: i === 0 }))
}

export function barSvg(done: number, total: number, color: string, w = 160): string {
  const fill = total > 0 ? Math.round((w * Math.min(done, total)) / total) : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 6"><rect width="${w}" height="6" rx="3" fill="${C.line}"/>${fill > 0 ? `<rect width="${fill}" height="6" rx="3" fill="${color}"/>` : ''}</svg>`
}

export type PlanItem = { content: string; status: string }

/** 데스크톱 앱 작업 목록 도구(update_plan)의 호출 하나를 목록에 적용한다. items 는 통째로 바꾸고, advance/done/start 는 한 단계씩 고친다(번호는 1부터). */
export function applyPlan(plan: PlanItem[], a: any): PlanItem[] {
  const next: PlanItem[] = Array.isArray(a?.items)
    ? a.items.map((i: any) => ({ content: String(i?.content ?? ''), status: String(i?.status ?? 'pending') }))
    : plan.map(i => ({ ...i }))
  if (a?.advance === true) {
    const cur = next.findIndex(i => i.status === 'in_progress')
    if (cur >= 0) next[cur].status = 'completed'
    const nxt = next.findIndex(i => i.status === 'pending')
    if (nxt >= 0) next[nxt].status = 'in_progress'
  }
  for (const n of Array.isArray(a?.done) ? a.done : []) if (next[n - 1]) next[n - 1].status = 'completed'
  if (Number.isInteger(a?.start) && next[a.start - 1]) next[a.start - 1].status = 'in_progress'
  return next
}

/** 목록에서 기록에 쓸 진척(전체·완료·지금 단계)을 뽑는다. */
export const progress = (plan: PlanItem[]) => ({ total: plan.length, done: plan.filter(i => i.status === 'completed').length, step: plan.find(i => i.status === 'in_progress')?.content ?? '' })

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
let plan: PlanItem[] = [] // 이 세션의 작업 목록. 한 단계씩 고치는 호출을 받으려고 기억해 둔다
const waitLabel = (tool: string) => (tool === 'AskUserQuestion' ? '답변' : tool === 'ExitPlanMode' ? '계획 승인' : `${tool} 승인`)

// ---- 세션 하나의 상태 ---------------------------------------------------------

let me: Rec | null = null
let dir = ''
let board: Rec[] = []
let isOpen = false // 패널을 열어 두려는 중(사용자가 닫으면 false)
let folded = false // 옆으로 접은 상태: 좁은 너비로 다시 열고 요약 알약만 그린다
let ticker: { cancel: () => void } | null = null
let tick = 0
const FOLD_COLUMNS = 16 // 접었을 때 바라는 너비. 호스트가 지킬지는 앱에서 확인해야 한다

/** 패널을 연다. 접힌 상태면 좁은 너비를 바란다. 사용자가 시킨 열기가 아니면 넓은 창(144칸 이상)에서만 그려진다. */
async function openPane($: any) {
  const opened = await $.ui.open({ id: PANE_ID, title: '세션', ...(folded ? { columns: FOLD_COLUMNS } : {}) })
  isOpen = true
  await refresh($)
  return opened
}

/** 접기/펼치기: 패널을 닫고 바뀐 너비로 다시 연다. 고른 상태는 다음 세션에도 이어진다. */
async function setFolded($: any, value: boolean) {
  folded = value
  try {
    await $.store.set('folded', value)
  } catch {
    // 저장하지 못해도 이번 세션에서는 바뀐다
  }
  await $.ui.close({ id: PANE_ID })
  await openPane($)
}

/** 내 기록을 고쳐 파일에 쓴다. 어떤 오류도 던지지 않는다: tool.call 을 쥔 훅이 이 함수 때문에 도구를 막으면 안 된다. */
async function save($: any, patch: Partial<Rec> = {}) {
  if (!me || dir === '') return
  try {
    Object.assign(me, patch, { updatedAt: await $.clock.now() })
    await $.fs.write(`${dir}/${me.id}.json`, JSON.stringify(me))
    board = [me, ...board.filter(r => r.id !== me!.id)]
    if (isOpen) $.ui.invalidate('ui.render')
  } catch {
    // 쓰지 못하면 다음 박동(30초)에 다시 쓴다
  }
}

async function go($: any, state: State, waitFor: string | null = null) {
  if (!me || (me.state === state && me.waitFor === waitFor)) return
  try {
    await save($, { state, waitFor, since: await $.clock.now() })
  } catch {
    // 시계를 못 읽어도 도구 호출은 계속한다
  }
}

async function refresh($: any) {
  if (dir === '') return
  try {
    const files = (await $.fs.list(dir)).filter((f: any) => f.kind === 'file' && f.name.endsWith('.json'))
    const recs = await Promise.all(files.map((f: any) => $.fs.read(`${dir}/${f.name}`).then(parseRec, () => null)))
    // 내 기록은 파일보다 메모리가 최신이다
    board = [...(me ? [me] : []), ...recs.filter((r): r is Rec => r !== null && r.id !== me?.id)]
  } catch {
    // 폴더가 아직 없으면 빈 목록
  }
}

async function purge($: any, now: number) {
  try {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs <= PURGE_MS) continue
      const p = `${dir}/${f.name}`
      await $.process.run(/^[A-Za-z]:/.test(p) ? ['cmd', '/c', 'del', '/q', p.replaceAll('/', '\\')] : ['rm', '-f', p])
    }
  } catch {
    // 지우지 못해도 STALE_MS 로 숨겨지니 괜찮다
  }
}

async function onTick($: any) {
  tick += 1
  if (tick % BEAT_EVERY === 0) await save($)
  if (isOpen) {
    await refresh($)
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    dir = home ? `${home}/.claude/session-board` : ''
    const cwd = await $.session.cwd()
    const now = await $.clock.now()
    me = { id: await $.session.id(), name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, state: 'idle', since: now, turnStartedAt: null, waitFor: null, done: 0, total: 0, step: '', updatedAt: now }
    await $.command.register({ name: 'session_board', description: '세션 상태판(진행 중 / 응답 대기 / 완료)을 열거나 닫습니다' })
    await purge($, now)
    await save($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => onTick($))
    // 세션을 열면 패널도 같이 연다. 사용자가 닫으면 이번 세션에서는 다시 열지 않는다.
    // 데스크톱 앱 세션은 SDK 로 실행돼 isInteractive 가 false 이고 화면도 늦게 붙는다. 그래도 열기를 요청해 두면 화면이 붙을 때 그려진다.
    folded = (await $.store.get('folded')) === true
    await openPane($)
    return result
  })

  on('command.run', { command: 'session_board' }, async $ => {
    // 그려지고 있으면 닫는다. 열어 두려 했지만 아직 못 그리는 중이면(좁은 창), 사용자가 시킨 열기로 다시 연다
    if ((await $.ui.panes()).some(p => p.id === PANE_ID && p.isPlaced)) {
      await $.ui.close({ id: PANE_ID })
      isOpen = false
      return { text: '세션 상태판을 닫았습니다.' }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? '세션 상태판을 열었습니다.' : '이 화면에는 패널을 놓을 자리가 없습니다.' }
  })

  on('turn.start', async ($, e, next) => {
    if (me && e.agentId === undefined) {
      // /clear 는 session.start 없이 세션 id 만 바꾼다
      const id = await $.session.id()
      if (id !== me.id) me = { ...me, id }
      const t = await $.clock.now()
      const finished = me.total > 0 && me.done === me.total
      if (finished) plan = []
      await save($, { state: 'running', since: t, turnStartedAt: t, waitFor: null, ...(finished ? { done: 0, total: 0, step: '' } : {}) })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await go($, 'idle')
    return next(e)
  })

  // 권한 확인은 tool.call 이 next 를 부른 뒤에 일어난다. 결과가 ask 면 승인 대화상자가 뜬다 → 승인 대기.
  // 질문·계획 승인은 tool.call 이 따로 잡는다. 승인이 끝난 때를 알려 주는 이벤트는 없어서, 도구가 끝나거나(tool.call 의 next 가 돌아옴) 턴이 끝나야 풀린다.
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.tool_use_id !== undefined && result.decision === 'ask' && e.tool !== 'AskUserQuestion' && e.tool !== 'ExitPlanMode') await go($, 'waiting', waitLabel(e.tool))
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.tool === 'TodoWrite') {
      // CLI 의 작업 목록: 호출마다 목록 전체가 온다
      const raw = (e as any).todos
      plan = (Array.isArray(raw) ? raw : []).map((t: any) => ({ content: String(t?.activeForm || t?.content || ''), status: String(t?.status ?? 'pending') }))
      await save($, progress(plan))
    } else if (e.tool === PLAN_TOOL) {
      // 데스크톱 앱의 작업 목록: 목록 전체이거나 한 단계씩 고친 것
      plan = applyPlan(plan, e)
      if (plan.length > 0) await save($, progress(plan))
    }
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') await go($, 'waiting', waitLabel(e.tool))
    const result = await next(e)
    if (me?.state === 'waiting') await go($, 'running') // 질문에 답했거나, 승인되어 도구가 끝났다
    return result
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    await save($, { state: 'ended' })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e, next) => {
    const { Box, Text, Svg, Button } = $.ui.resolve(e) as any
    const now = Date.now()
    const shown = board.map(r => ({ r, g: groupOf(r, now) })).filter(x => x.g !== 'hidden')
    const fold = Box({ key: 'fold', children: [Button({ key: 'fold-btn', label: folded ? '◂ 펼치기' : '접기 ▸', variant: 'secondary', onPress: () => setFolded($, !folded) })] })
    if (folded) {
      // 접은 상태: 묶음마다 알약 하나(개수만). 응답 대기가 있으면 호박색 알약이 눈에 띈다.
      const pills = GROUPS.map(g => ({ g, n: shown.filter(x => x.g === g.key).length }))
        .filter(x => x.n > 0)
        .map(x => Box({ key: x.g.key, children: [Text({ bold: true, color: x.g.fg, backgroundColor: x.g.bg, children: ` ${x.g.short} ${x.n} ` })] }))
      return Box({ flexDirection: 'column', gap: 1, children: [fold, ...(pills.length > 0 ? pills : [Text({ key: 'none', dimColor: true, children: '세션 없음' })])] })
    }
    if (shown.length === 0) {
      return Box({
        flexDirection: 'column',
        children: [
          fold,
          Text({ key: 'empty', dimColor: true, children: '표시할 세션이 없습니다.' }),
          Text({ key: 'hint', dimColor: true, children: '다른 세션에도 이 모드가 켜져 있어야 보입니다. 닫으려면 /session_board 를 입력하세요.' }),
        ],
      })
    }
    const body: any[] = [fold]
    for (const g of GROUPS) {
      const rows = shown
        .filter(x => x.g === g.key)
        .map(x => x.r)
        // 대기는 오래 기다린 것부터, 나머지는 최근 상태가 바뀐 것부터
        .sort((a, b) => (g.key === 'waiting' ? a.since - b.since : b.since - a.since))
      if (rows.length === 0) continue
      body.push(
        Box({
          key: `g-${g.key}`,
          flexDirection: 'column',
          gap: 1,
          marginTop: 1,
          children: [Box({ key: 'h', children: [Text({ bold: true, color: g.fg, backgroundColor: g.bg, children: ` ${g.title} · ${rows.length} ` })] }), ...rows.map(r => card(Box, Text, Svg, r, g.key, now))],
        }),
      )
    }
    body.push(Text({ key: 'total', dimColor: true, children: `세션 ${shown.length}개 · 열린 곳에서만 갱신됩니다` }))
    return Box({ flexDirection: 'column', children: body })
  })
}

const GROUPS = [
  { key: 'running', title: '진행 중', short: '진행', bg: C.indigo, fg: C.white },
  { key: 'waiting', title: '응답 대기', short: '대기', bg: C.amber, fg: C.ink },
  { key: 'idle', title: '완료·유휴', short: '유휴', bg: C.soft, fg: C.dim },
] as const

// 흰 카드 하나. 이름 / 뱃지 줄 / 진척 막대 / 지금 하는 단계.
function card(Box: any, Text: any, Svg: any, r: Rec, g: 'running' | 'waiting' | 'idle', now: number) {
  const tone = g === 'running' ? C.indigo : g === 'waiting' ? C.amber : C.dim
  const pillText = g === 'waiting' ? C.ink : g === 'running' ? C.white : C.dim
  const pillBg = g === 'idle' ? C.soft : tone
  const isMe = me?.id === r.id
  const pills = badges(r, now).map((b, i) =>
    b.main ? Text({ key: `b${i}`, bold: true, color: pillText, backgroundColor: pillBg, children: ` ${b.text} ` }) : Text({ key: `b${i}`, color: C.dim, children: b.text }),
  )
  const children: any[] = [
    Box({ key: 'top', gap: 1, children: [Text({ key: 'n', bold: true, color: C.ink, wrap: 'truncate-end', children: r.name }), isMe ? Text({ key: 'me', color: C.dim, children: '이 세션' }) : null] }),
    Box({ key: 'badges', gap: 1, children: pills }),
  ]
  if (r.total > 0) {
    children.push(
      Svg
        ? Box({ key: 'bar', children: [Svg({ source: barSvg(r.done, r.total, tone), alt: `진척 ${r.done}/${r.total}`, width: 160, height: 6 })] })
        : Text({ key: 'bar', color: tone, children: `${'█'.repeat(Math.round((10 * r.done) / r.total))}${'░'.repeat(10 - Math.round((10 * r.done) / r.total))}` }),
    )
  }
  if (g !== 'idle' && r.step !== '') children.push(Text({ key: 'step', color: C.dim, wrap: 'truncate-end', children: `지금: ${r.step}` }))
  return Box({ key: r.id, flexDirection: 'column', backgroundColor: C.white, borderStyle: 'round', borderColor: g === 'waiting' ? C.amber : C.line, paddingX: 1, children })
}
