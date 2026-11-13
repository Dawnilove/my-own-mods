import { expect, test } from 'claude-code/testing'

import { applyPlan, badges, barSvg, fmtDur, groupOf, parseRec, progress, type Rec } from './register'

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

test('앱의 작업 목록(update_plan)은 통째 교체와 한 단계씩 고침을 모두 따라간다', () => {
  const items = [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }]
  let plan = applyPlan([], { items })
  expect(progress(plan)).toEqual({ total: 3, done: 0, step: 'a' })
  plan = applyPlan(plan, { advance: true }) // a 끝, b 시작
  expect(progress(plan)).toEqual({ total: 3, done: 1, step: 'b' })
  plan = applyPlan(plan, { done: [2], start: 3 }) // 번호는 1부터
  expect(progress(plan)).toEqual({ total: 3, done: 2, step: 'c' })
  plan = applyPlan(plan, { advance: true })
  expect(progress(plan)).toEqual({ total: 3, done: 3, step: '' })
  // 목록이 없을 때 오는 고침 호출과 범위를 벗어난 번호는 무시한다
  expect(applyPlan([], { advance: true, done: [9], start: 0 })).toEqual([])
  expect(items[0].status).toBe('in_progress') // 받은 목록을 바꾸지 않는다
})

test('앱 작업 목록 호출이 오면 기록의 done/total/step 이 바뀐다', async ($, on) => {
  const writes: any[] = []
  on('env.get', () => ({ value: 'C:/home' }))
  on('session.cwd', () => ({ value: 'C:/work/p' }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }) as any)
  on('command.register', () => ({ value: { command: 'session_board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }) as any)
  on('fs.write', (_, e: any) => {
    writes.push(JSON.parse(e.text))
    return { value: undefined } as any
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: '조사', status: 'in_progress' }, { content: '구현', status: 'pending' }] } as any)
  expect(writes.at(-1)).toMatchObject({ done: 0, total: 2, step: '조사' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  expect(writes.at(-1)).toMatchObject({ done: 1, total: 2, step: '구현' })
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
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
  on('store.get', () => ({ value: undefined }))
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

  // 세션을 열 때 패널이 같이 열렸으니 따로 명령을 칠 필요가 없다
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-board', component: 'Pane', requestId: 'session-board', props: { title: '세션', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }, surface } as any)
    const found = await Promise.all([/다른 프로젝트/, /2\/5 단계/, /1\/3 단계/, /지금: 시험 실행/].map(async text => (await ui.find({ type: 'Text', text }))?.text !== undefined))
    expect([surface, ...found]).toEqual([surface, true, true, true, true])
    await ui.unmount()
  }
})

test('세션을 열면 패널이 같이 열리고, 접기를 누르면 좁은 너비로 다시 열어 요약 알약만 그린다', async ($, on) => {
  const opens: any[] = []
  let closes = 0
  const stored: any[] = []
  const waiting = JSON.stringify(rec({ id: 'w', name: '대기 중', state: 'waiting', waitFor: '답변', since: Date.now(), updatedAt: Date.now() }))
  on('env.get', () => ({ value: 'C:/home' }))
  on('session.cwd', () => ({ value: 'C:/work/p' }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }) as any)
  on('command.register', () => ({ value: { command: 'session_board' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e: any) => {
    stored.push(e.value)
    return { value: undefined } as any
  })
  on('ui.open', (_, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    closes += 1
    return { value: undefined } as any
  })
  on('fs.write', () => ({ value: undefined }) as any)
  on('fs.list', () => ({ value: [{ name: 'w.json', kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false }] }) as any)
  on('fs.read', () => ({ value: waiting }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens.length).toBe(1)
  expect(opens[0].columns).toBeUndefined() // 펼친 상태는 호스트 기본 너비

  const props = { title: '세션', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'session-board', component: 'Pane', requestId: 'session-board', props, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /응답 대기 · 1/ }))?.text).toBeDefined()

  await ui.press({ key: 'fold-btn' })
  expect(closes).toBe(1)
  expect(opens.length).toBe(2)
  expect(opens[1].columns).toBe(16)
  expect(stored).toEqual([true])
  // 접으면 묶음 카드 대신 개수 알약만 남는다
  expect((await ui.find({ type: 'Text', text: /대기 1/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /대기 중/ })).toBeUndefined()

  // 펼치기: 다시 기본 너비
  await ui.press({ key: 'fold-btn' })
  expect(opens[2].columns).toBeUndefined()
  expect(stored).toEqual([true, false])
  await ui.unmount()
})
