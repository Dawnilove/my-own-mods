import { expect, test } from 'claude-code/testing'

import { DEFAULT_FRAMES, FRAMES, catState, catSvg, fmtTime, groupOf } from './register'

// 디자인 패키지의 원본 SVG 64개(유형 4 x 상태 4 x 프레임 4) 길이. 같은 칸을 같은 순서로 찍었는지 본다.
const GOLDEN: Record<string, number> = {"Explore_done_0":7009,"Explore_done_1":6984,"Explore_done_2":7009,"Explore_done_3":6984,"Explore_fail_0":6998,"Explore_fail_1":7004,"Explore_fail_2":6963,"Explore_fail_3":7004,"Explore_idle_0":6166,"Explore_idle_1":6108,"Explore_idle_2":6343,"Explore_idle_3":6502,"Explore_run_0":6613,"Explore_run_1":6605,"Explore_run_2":6669,"Explore_run_3":6106,"Plan_done_0":7009,"Plan_done_1":6984,"Plan_done_2":7009,"Plan_done_3":6984,"Plan_fail_0":7055,"Plan_fail_1":7061,"Plan_fail_2":7020,"Plan_fail_3":7061,"Plan_idle_0":6223,"Plan_idle_1":6165,"Plan_idle_2":6400,"Plan_idle_3":6559,"Plan_run_0":6670,"Plan_run_1":6662,"Plan_run_2":6669,"Plan_run_3":6163,"default_done_0":7121,"default_done_1":7040,"default_done_2":7121,"default_done_3":7040,"default_fail_0":6768,"default_fail_1":6774,"default_fail_2":6733,"default_fail_3":6774,"default_idle_0":5936,"default_idle_1":5878,"default_idle_2":6113,"default_idle_3":6272,"default_run_0":6383,"default_run_1":6375,"default_run_2":6439,"default_run_3":5876,"general-purpose_done_0":7237,"general-purpose_done_1":7212,"general-purpose_done_2":7237,"general-purpose_done_3":7212,"general-purpose_fail_0":6884,"general-purpose_fail_1":6890,"general-purpose_fail_2":6849,"general-purpose_fail_3":6890,"general-purpose_idle_0":6051,"general-purpose_idle_1":5993,"general-purpose_idle_2":6228,"general-purpose_idle_3":6387,"general-purpose_run_0":6497,"general-purpose_run_1":6490,"general-purpose_run_2":6553,"general-purpose_run_3":5991}

test('고양이 64장은 원본 도트판과 같은 길이로 만들어진다', () => {
  for (const [key, len] of Object.entries(GOLDEN)) {
    const [kind, state, f] = key.split('_')
    const svg = catSvg(state as any, Number(f), kind)
    expect(svg.length).toBe(len)
    expect(svg.length).toBeLessThan(131072) // Svg 요소의 한도
  }
  // 모르는 유형은 기본 고양이, 프레임은 4로 돌아간다
  expect(catSvg('run', 4, 'Explore')).toBe(catSvg('run', 0, 'Explore'))
})

test('에이전트 상태는 고양이 상태 네 가지로 빠짐없이 옮겨진다', () => {
  expect(catState('running')).toBe('run')
  expect(catState('pending')).toBe('run')
  expect(catState('completed')).toBe('done')
  expect(catState('failed')).toBe('fail')
  expect(catState('killed')).toBe('fail')
  expect(catState('idle')).toBe('idle')
  expect(catState('waiting')).toBe('idle')
})

const PANE = {
  plugin: 'agent-panel',
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: '에이전트', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  surface: 'desktop',
} as const

test('캐릭터는 한 글자이고 두 칸이 될 수 있는 글자를 쓰지 않는다', () => {
  const ambiguous = /[àáæè-êìíðòó÷-úüþ]/ // 동아시아 모호 폭(Latin-1)
  for (const set of [...Object.values(FRAMES), DEFAULT_FRAMES]) {
    for (const ch of set) {
      expect([...ch].length).toBe(1)
      expect(ambiguous.test(ch)).toBe(false)
    }
  }
})

test('에이전트가 없으면 안내 문구를 그린다', async ($, on) => {
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /하위 에이전트가 없습니다/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('시작한 에이전트와 도구 호출 수를 한 줄로 그린다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'x' }) as any)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: '코드 탐색', subagentType: 'Explore' } as any)
  await $.tool.call({ tool: 'Grep', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Read', agentId: 'a1' } as any)

  const ui = await $.ui.mount(PANE as any)
  // 두 줄: 윗줄은 이름, 아랫줄은 상태·유형·호출
  expect((await ui.find({ type: 'Text', text: /코드 탐색/ }))?.text).toContain('코드 탐색')
  const sub = await ui.find({ type: 'Text', text: /Explore/ })
  expect(sub?.text).toContain('실행 중')
  expect(sub?.text).toContain('호출 2회 · Read')
  // 묶음 머리글과 합계 줄
  expect((await ui.find({ type: 'Text', text: /^실행 중 · 1$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^합계 1개 · 호출 2회$/ }))?.text).toBeDefined()
  // 데스크톱은 도트 고양이(Svg)를 그린다
  expect(await ui.find({ type: 'Svg' })).toBeTruthy()
  await ui.unmount()
})

test('넓은 패널은 두 줄 대신 표로 그린다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'x' }) as any)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: '코드 탐색', subagentType: 'Explore' } as any)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as any)
  for (const head of ['이름', '유형', '상태', '시간', '호출', '마지막']) expect((await ui.find({ type: 'Text', text: new RegExp(`^${head}$`) }))?.text).toBe(head)
  expect((await ui.find({ type: 'Text', text: /^합계 1개/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('Svg 가 없는 터미널은 고양이 없이 글자 얼굴로 그린다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent_panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: { cancel: () => {} } }) as any)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'x' }) as any)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: '코드 탐색', subagentType: 'Explore' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /코드 탐색/ }))?.text).toContain('코드 탐색')
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.unmount()
})

test('상태는 세 묶음으로 나뉘고 시간은 짧게 쓴다', () => {
  expect(groupOf('running')).toBe('live')
  expect(groupOf('pending')).toBe('live')
  expect(groupOf('failed')).toBe('check')
  expect(groupOf('killed')).toBe('check')
  expect(groupOf('completed')).toBe('done')
  expect(groupOf('idle')).toBe('done')
  expect(fmtTime(9)).toBe('9초')
  expect(fmtTime(75)).toBe('1분15초')
})
