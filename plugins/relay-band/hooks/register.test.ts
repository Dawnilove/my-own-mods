import { expect, test } from 'claude-code/testing'

import { dailyBudget, fit } from './register'

const DAY = 86_400_000

test('오늘 권장량은 남은 한도를 남은 날에 나눈다', () => {
  // 수요일 정오, 리셋은 4일 뒤(목·금·토·일 지나 월요일 0시 전). 평일 가중치 1, 주말 0.3.
  const wed = new Date(2026, 10, 11, 12, 0, 0).getTime() // 2026-11-11 은 수요일
  const resets = new Date(2026, 10, 16, 0, 0, 0).toISOString() // 다음 월요일 0시
  const b = dailyBudget(40, 40, resets, wed)
  // 남은 날: 수·목·금(1+1+1) + 토·일(0.3+0.3) = 3.6, 오늘 가중치 1 → (100-40)/3.6
  expect(Math.round(b!.recommended * 10) / 10).toBe(16.7)
  // 리셋을 모르면 계산하지 않는다
  expect(dailyBudget(40, 40, undefined, wed)).toBeNull()
  void DAY
})

test('리셋이 낀 마지막 날은 리셋 시각까지의 몫만 센다', () => {
  const wed = new Date(2026, 10, 11, 12, 0, 0).getTime()
  const resets = new Date(2026, 10, 16, 6, 0, 0).toISOString() // 월요일 06시: 마지막 날은 0.25 몫
  // 수·목·금(3) + 토·일(0.6) + 월(0.25) = 3.85 → (100-40)/3.85
  expect(Math.round(dailyBudget(40, 40, resets, wed)!.recommended * 10) / 10).toBe(15.6)
})

test('좁으면 번호가 큰 칸부터 숨긴다', () => {
  const segs = [
    { prio: 1, value: '✓ 검증 2' },
    { prio: 3, label: '컨텍스트', value: '43%' },
    { prio: 7, label: '캐시', value: '38분' },
    { prio: 9, label: '페이스', value: '+6%p 앞섬' },
  ]
  expect(fit(segs, 200).length).toBe(4)
  const narrow = fit(segs, 36)
  expect(narrow.map(s => s.prio)).toEqual([1, 3])
})

test('아주 좁아도 이상 칸은 남긴다', () => {
  const segs = [
    { prio: 1, value: '✓ 검증 2', level: 'ok' as const },
    { prio: 3, label: '컨텍스트', value: '⚠ 72%', level: 'warn' as const },
    { prio: 7, label: '캐시', value: '38분', level: 'mute' as const },
  ]
  expect(fit(segs, 18).map(s => s.prio)).toEqual([3])
  // 이상 칸이 없으면 번호가 작은 칸이 남는다
  expect(fit(segs.map(s => ({ ...s, level: undefined })), 18).map(s => s.prio)).toEqual([1])
})

test('띠는 컨텍스트 값을 그린다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: {} }) as any)
  // 아래 플러그인(ponytail 등)이 이미 띠를 그리는 경우: 내 띠가 그것을 가리지 않고 함께 그려야 한다
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e) as any
    return Text({ children: 'ponytail 띠' })
  })
  on('state.get', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'relay-band',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 120, maxRows: 10 },
  } as any)
  expect((await ui.find({ type: 'Text', text: /자식 0/ }))?.text).toBe('자식 0')
  expect((await ui.find({ type: 'Text', text: /ponytail 띠/ }))?.text).toBe('ponytail 띠')
  await ui.unmount()
})
