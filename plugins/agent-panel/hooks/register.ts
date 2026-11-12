// agent-panel: 하위 에이전트를 옆 패널에 한 줄씩 보여 준다.
//   캐릭터 이름 유형 상태 경과 호출수 마지막도구
// 패널을 못 그리는 좁은 창에서는 아무것도 그리지 않는다(relay-band 의 "자식 N" 칸이 대신한다).
// 호스트가 소스에서 on(...) 과 $.noun.method(...) 를 읽으므로 literal 로 쓰고, $ 를 받는 도우미는 최상위 함수로 둔다.

import type { Register } from 'claude-code'

const PANE_ID = 'agent-panel'
const FRAME_MS = 500
const LIST_EVERY = 10 // 프레임 10개마다(5초) 목록을 다시 읽는다
const KEEP = 20 // shortcut: 끝난 에이전트는 최근 20개만 남긴다

type A = {
  id: string
  name: string
  type: string
  status: string
  startedAt: number
  endedAt: number | null
  calls: number
  lastTool: string
}

const agents = new Map<string, A>()
let frame = 0
let ticker: { cancel: () => void } | null = null
let isOpen = false
let autoOpened = false

// 유형마다 표정 순서가 다르다. 한 글자(한 코드포인트)이고 동아시아 모호 폭이 아닌 글자만 쓴다(ö ô õ o).
// ò ó 는 한국어 터미널에서 두 칸이 될 수 있어 뺐다.
export const FRAMES: Record<string, string[]> = {
  Explore: ['õ', 'ö', 'ô', 'ö'], // 두리번
  Plan: ['õ', 'õ', 'ö', 'ô'], // 골똘
  'general-purpose': ['ö', 'ö', 'ö', 'o'], // 깜빡
}
export const DEFAULT_FRAMES = ['ö', 'ö', 'o', 'o']

const LABEL: Record<string, string> = {
  pending: '준비',
  running: '실행 중',
  waiting: '대기',
  idle: '대기',
  completed: '완료',
  failed: '실패',
  killed: '중단',
}
const isLive = (status: string) => status === 'running' || status === 'pending'
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'agent_panel', description: '하위 에이전트 패널을 열거나 닫습니다' })
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => step($))
    return result
  })

  on('command.run', { command: 'agent_panel' }, async $ => {
    if (isOpen) {
      await $.ui.close({ id: PANE_ID })
      isOpen = false
      return { text: '에이전트 패널을 닫았습니다.' }
    }
    const opened = await $.ui.open({ id: PANE_ID, title: '에이전트' })
    isOpen = opened.isPlaced
    return { text: opened.isPlaced ? '에이전트 패널을 열었습니다.' : '이 화면에는 패널을 놓을 자리가 없습니다. 입력창 위 띠의 "자식" 칸을 보세요.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result: any = await next(e)
    if (result?.agentId) {
      agents.set(result.agentId, {
        id: result.agentId,
        name: String((e as any).description ?? '') || result.agentId,
        type: String((e as any).subagentType ?? ''),
        status: 'running',
        startedAt: await $.clock.now(),
        endedAt: null,
        calls: 0,
        lastTool: '-',
      })
      if (!autoOpened) {
        autoOpened = true
        const opened = await $.ui.open({ id: PANE_ID, title: '에이전트' })
        isOpen = opened.isPlaced
      }
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // 하위 에이전트의 도구 호출만 센다. 호출은 막지도 바꾸지도 않는다.
  on('tool.call', async ($, e, next) => {
    const id = (e as any).agentId as string | undefined
    const a = id ? agents.get(id) : undefined
    // 하위 에이전트가 결과를 돌려주는 내부 호출은 작업으로 세지 않는다.
    if (a && (e as any).tool !== 'SubagentHandback') {
      a.calls += 1
      a.lastTool = String((e as any).tool ?? '-')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e) as any
    const rows = [...agents.values()].sort((a, b) => b.startedAt - a.startedAt)
    const now = Date.now()
    const body = rows.length === 0
      ? [Text({ key: 'empty', dimColor: true, children: '실행한 하위 에이전트가 없습니다.' })]
      : rows.map(a =>
          Text({
            key: a.id,
            color: a.status === 'failed' ? 'red' : isLive(a.status) ? 'cyan' : undefined,
            dimColor: !isLive(a.status) && a.status !== 'failed',
            wrap: 'truncate-end',
            children: line(a, now),
          }),
        )
    return Box({ flexDirection: 'column', children: body })
  })
}

function line(a: A, now: number): string {
  const set = FRAMES[a.type] ?? DEFAULT_FRAMES
  const mark = isLive(a.status) ? set[frame % set.length] : a.status === 'completed' ? '✓' : a.status === 'failed' ? '✗' : '·'
  const sec = Math.max(0, Math.round(((a.endedAt ?? now) - a.startedAt) / 1000))
  const time = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분${String(sec % 60).padStart(2, '0')}초`
  return `${mark} ${a.name} · ${a.type || '-'} · ${LABEL[a.status] ?? a.status} · ${time} · ${a.calls}회 ${a.lastTool}`
}

// 한 프레임: 캐릭터를 한 칸 넘기고, 가끔 목록을 읽어 상태를 맞춘다.
async function step($: any) {
  frame += 1
  const anyLive = [...agents.values()].some(a => isLive(a.status))
  if (frame % LIST_EVERY === 0) await syncList($)
  if (anyLive || frame % LIST_EVERY === 0) $.ui.invalidate('ui.render')
}

async function syncList($: any) {
  try {
    const list: any[] = await $.agent.list()
    const now = await $.clock.now()
    for (const info of list) {
      let a = agents.get(info.id)
      if (!a) {
        a = { id: info.id, name: info.description || info.id, type: info.type ?? '', status: info.status, startedAt: now, endedAt: null, calls: 0, lastTool: '-' }
        agents.set(info.id, a)
      }
      a.status = info.status
      if (!isLive(a.status) && a.endedAt === null) a.endedAt = now
    }
    const finished = [...agents.values()].filter(a => a.endedAt !== null).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
    for (const old of finished.slice(KEEP)) agents.delete(old.id)
  } catch {
    // 목록을 못 읽으면 이전 값을 둔다
  }
}
