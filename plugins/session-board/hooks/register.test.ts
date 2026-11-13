import { expect, test } from 'claude-code/testing'

import { badges, barSvg, fmtDur, groupOf, parseRec, type Rec } from './register'

const NOW = 1_000_000_000_000
const rec = (p: Partial<Rec> = {}): Rec => ({ id: 's1', name: '프로젝트', state: 'idle', since: NOW, turnStartedAt: null, waitFor: null, done: 0, total: 0, step: '', updatedAt: NOW, ...p })

test('시간은 초, 분, 시간 단위로 줄여 쓴다', () => {
  expect(fmtDur(5_000)).toBe('5초')
  expect(fmtDur(252_000)).toBe('4분 12초')
  expect(fmtDur(3_900_000)).toBe('1시간 05분')
  expect(fmtDur(-1)).toBe('0초')
})

test('깨진 기록 파일은 버리고, 모양이 맞으면 읽는다', () => {
  expect(parseRec('not json')).toBeNull()
  expect(parseRec('{"id":"a"}')).toBeNull()
  expect(parseRec(JSON.stringify({ ...rec(), state: 'zzz' }))).toBeNull()
  expect(parseRec({ base64: 'x' })).toBeNull()
  expect(parseRec(JSON.stringify(rec({ state: 'running', done: 2, total: 5 })))?.total).toBe(5)
})

test('90초 넘게 기록이 없거나 끝난 세션은 숨긴다', () => {
  expect(groupOf(rec({ state: 'running' }), NOW + 89_000)).toBe('running')
  expect(groupOf(rec({ state: 'running' }), NOW + 91_000)).toBe('hidden')
  expect(groupOf(rec({ state: 'ended' }), NOW)).toBe('hidden')
  expect(groupOf(rec({ state: 'waiting' }), NOW)).toBe('waiting')
})

test('뱃지는 진척도, 경과 시간, 대기 사유를 담는다', () => {
  const run = badges(rec({ state: 'running', done: 3, total: 7, turnStartedAt: NOW - 252_000 }), NOW)
  expect(run.map(b => b.text)).toEqual(['3/7 단계', '경과 4분 12초'])
  expect(run[0].main).toBe(true)
  expect(run[1].main).toBe(false)

  const wait = badges(rec({ state: 'waiting', waitFor: 'Bash 승인', since: NOW - 65_000, done: 1, total: 4 }), NOW)
  expect(wait.map(b => b.text)).toEqual(['Bash 승인 대기', '대기 1분 05초', '1/4 단계'])

  const idle = badges(rec({ state: 'idle', since: NOW - 300_000 }), NOW)
  expect(idle.map(b => b.text)).toEqual(['5분 00초 전'])

  // 작업 목록이 없으면 경과 시간이 주 뱃지
  expect(badges(rec({ state: 'running', turnStartedAt: NOW - 3_000 }), NOW).map(b => b.text)).toEqual(['경과 3초'])
})

test('진척 막대는 채움 길이가 단계 비율과 같고 한도를 넘지 않는다', () => {
  expect(barSvg(1, 4, '#4F6BFF', 160)).toContain('width="40"')
  expect(barSvg(9, 4, '#4F6BFF', 160)).toContain('width="160" height="6" rx="3" fill="#4F6BFF"')
  expect(barSvg(0, 4, '#4F6BFF')).not.toContain('#4F6BFF')
})

test('승인 대화상자와 질문은 대기로 기록하고, 풀리면 진행 중으로 돌아간다', async ($, on) => {
  const states: [string, string | null][] = []
  on('env.get', () => ({ value: 'C:/home' }))
  on('session.cwd', () => ({ value: 'C:/work/p' }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }) as any)
  on('command.register', () => ({ value: { command: 'session_board' } }))
  on('fs.list', () => ({ value: [] }) as any)
  on('fs.write', (_, e: any) => {
    const r = JSON.parse(e.text)
    states.push([r.state, r.waitFor])
    return { value: undefined } as any
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'ask' }) as any)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(states).toContainEqual(['waiting', 'Bash 승인'])
  expect(states.at(-1)).toEqual(['running', null])

  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  expect(states).toContainEqual(['waiting', '답변'])
  expect(states.at(-1)).toEqual(['running', null])
})

// 세션 시작부터 패널까지: 작업 목록과 질문 대기를 파일에 쓰고, 패널이 폴더의 다른 세션과 함께 그린다.
test('내 상태를 파일에 쓰고, 패널은 다른 세션 기록과 함께 그린다', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const other = JSON.stringify(rec({ id: 'other', name: '다른 프로젝트', state: 'running', done: 2, total: 5, step: '시험 실행', turnStartedAt: Date.now() - 60_000, since: Date.now() - 60_000, updatedAt: Date.now() }))
  on('env.get', () => ({ value: 'C:/home' }))
  on('session.cwd', () => ({ value: 'C:/work/내 프로젝트' }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }) as any)
  on('command.register', () => ({ value: { command: 'session_board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.write', (_, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined } as any
  })
  on('fs.list', () => ({ value: [{ name: 'other.json', kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false }] }) as any)
  on('fs.read', () => ({ value: other }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Windows 에서는 엔진이 경로 구분자를 \ 로 바꿔 넘긴다
  expect(writes.at(-1)?.path.replaceAll('\\', '/')).toBe('C:/home/.claude/session-board/me.json')
  expect(JSON.parse(writes.at(-1)!.text).name).toBe('내 프로젝트')

  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'completed', activeForm: 'a 중' }, { content: 'b', status: 'in_progress', activeForm: 'b 하는 중' }, { content: 'c', status: 'pending', activeForm: 'c' }] })
  const saved = JSON.parse(writes.at(-1)!.text)
  expect([saved.done, saved.total, saved.step]).toEqual([1, 3, 'b 하는 중'])

  await $.command.run({ command: 'session_board', args: '' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-board', component: 'Pane', requestId: 'session-board', props: { title: '세션', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }, surface } as any)
    const found = await Promise.all([/다른 프로젝트/, /2\/5 단계/, /1\/3 단계/, /지금: 시험 실행/].map(async text => (await ui.find({ type: 'Text', text }))?.text !== undefined))
    expect([surface, ...found]).toEqual([surface, true, true, true, true])
    await ui.unmount()
  }
})
