import { expect, test } from 'claude-code/testing'

import { classify, corruptReason, draw, measure } from './register'

// 요소 생성기를 그대로 돌려주는 가짜 표: 그리는 함수가 어떤 글자를 내는지만 본다.
const fake = { Box: (p: any) => p, Text: (p: any) => p, Button: (p: any) => p }
const held = (report: any, over: any = {}) => ({ command: 'rm -rf build', risk: { kind: 'rm', label: 'rm -rf' }, report, decision: null, where: 'pane', cwd: '/proj', showCommand: false, leftMs: 582_000, ...over })

test('확인 패널은 영향 → 복구 → 위치 순이고 명령은 접혀 있다', () => {
  const json = JSON.stringify(draw(fake, held({ summary: '파일 2개 삭제', lines: ['/proj/a.txt', 'b.txt'], recover: [['warn', '⚠ 휴지통을 거치지 않습니다']] }) as any))
  expect(json.indexOf('파일 2개 삭제')).toBeLessThan(json.indexOf('휴지통'))
  expect(json.indexOf('휴지통')).toBeLessThan(json.indexOf('위치'))
  expect(json.indexOf('위치')).toBeLessThan(json.indexOf('a.txt'))
  expect(json).toContain('▸ 명령 보기')
  expect(json).not.toContain('rm -rf build') // 접힌 명령은 그리지 않는다
  expect(json).toContain('9:42 남음')
  expect(json).toContain('"a.txt"') // 폴더 앞부분은 뺀 상대 경로
  // 취소는 왼쪽에 두고 강조한다
  expect(json.indexOf('"취소"')).toBeLessThan(json.indexOf('"진행"'))
  expect(json).toContain('"variant":"primary"')
})

test('git 변경 목록은 글자 배지와 해시로 나눠 그린다', () => {
  const json = JSON.stringify(draw(fake, held({ summary: '변경 2개', lines: [' M a.txt', 'A  c.txt', 'a1b2c3d 커밋 제목'] }, { risk: { kind: 'git-reset', label: 'git reset --hard' } }) as any))
  expect(json).toContain('변경 버리기')
  expect(json).toContain('"children":"M"')
  expect(json).toContain('"children":"A"')
  expect(json).toContain('"children":"a1b2c3d"')
})

test('모름 패널은 명령을 펼치고 변수를 오류 색으로 낸다', () => {
  const json = JSON.stringify(
    draw(fake, held({ summary: '지울 대상을 확인하지 못했습니다', lines: [], unknown: true, facts: [['원인', '변수 $D 를 풀지 못했습니다']] }, { showCommand: true, command: 'rm -rf "$D"' })) as any,
  )
  expect(json).toContain('영향 범위 모름')
  expect(json).toContain('그래도 진행')
  expect(json).toContain('원인')
  expect(json).toMatch(/"color":"error"[^}]*"children":"\$D"/) // 명령 안의 $D
  // 시안 C: 위치 줄과 접기 버튼이 없고 명령 상자만 항상 보인다
  expect(json).not.toContain('"위치"')
  expect(json).not.toContain('명령 접기')
  expect(json).toContain('cmdbox')
})

test('긴 명령은 상자에 몇 줄만 보인다', () => {
  const long = Array.from({ length: 10 }, (_, i) => `echo ${i}`).join('\n')
  const json = JSON.stringify(draw(fake, held({ summary: '지울 대상을 확인하지 못했습니다', lines: [], unknown: true }, { showCommand: true, command: long })) as any)
  expect(json).toContain('echo 5')
  expect(json).not.toContain('echo 6')
  expect(json).toContain('… 외 4줄')
})

test('패널을 못 놓는 창은 한 줄 구성으로 그린다', () => {
  const json = JSON.stringify(draw(fake, held({ summary: '파일 9개 · 820 KB 삭제', lines: ['a'], recover: [['warn', '⚠ 휴지통을 거치지 않습니다']] }) as any, true))
  expect(json).toContain('⚠ 삭제 확인')
  expect(json).toContain('파일 9개')
  expect(json).not.toContain('▸ 명령 보기') // 접기 버튼과 목록은 없다
})

test('지울 파일을 세면 되돌릴 수 있는지 모름으로 적는다', async () => {
  const run = { process: { run: async () => ({ stdout: '2 2048 1\n./a\n./b\n', stderr: '', exitCode: 0 }) } }
  const r = await measure(run, { kind: 'rm', label: 'rm -rf', targets: ['d'] }, '/')
  expect(r.lines).toEqual(['a', 'b'])
  expect(r.summary).toContain('파일 2개 · 2.0 KB 삭제')
  expect(r.recover?.[0][1]).toContain('git 에 올려 둔 파일이면 되살릴 수 있습니다')
})

// 영향 범위를 못 읽었을 때는 "없음"이 아니라 "모름"이어야 한다.
test('변수 경로·측정 실패·미리 셀 수 없는 명령은 모름으로 낸다', async () => {
  const none = { process: { run: async () => ({ stdout: '0 0 0\n', stderr: '', exitCode: 0 }) } }
  const rm = (targets: string[]) => ({ kind: 'rm', label: 'rm -rf', targets })

  expect((await measure(none, rm(['$D/build']), '/')).unknown).toBe(true)
  // 변수가 없는 경로가 정말 없으면 지금처럼 "없음"을 말한다
  const missing = await measure(none, rm(['nothere']), '/')
  expect(missing.unknown).toBeUndefined()
  expect(missing.summary).toContain('지울 것이 없음')

  const psNone = { process: { run: async () => ({ stdout: '0 0\n', stderr: '', exitCode: 0 }) } }
  const ps = await measure(psNone, { kind: 'ps-remove', label: 'Remove-Item -Recurse', targets: ['$env:TEMP\\x'] }, '/')
  expect(ps.unknown).toBe(true)

  expect((await measure(none, { kind: 'unmeasured', label: 'find -delete' }, '/')).unknown).toBe(true)

  const broken = { process: { run: async () => { throw new Error('bash 없음') } } }
  const failed = await measure(broken, rm(['a']), '/')
  expect(failed.unknown).toBe(true)
  expect(failed.recover?.[0][1]).toContain('없다는 뜻이 아닙니다')
})

// 따옴표 안의 글자와 heredoc 본문은 명령이 아니다 (리뷰가 찾은 오탐).
test('따옴표 안과 heredoc 본문의 글자에는 걸리지 않는다', () => {
  expect(corruptReason('git commit -m "docs: sed -i 사용법 설명"', 'Bash')).toBeNull()
  expect(classify('git commit -m "docs; rm -rf x"', 'Bash')).toBeNull()
  expect(corruptReason('python3 -c "import sys; sys.stdout.write(open(a).read())"', 'Bash')).toBeNull()
  expect(corruptReason('psql <<EOF > /dev/null\nselect 1;\nEOF', 'Bash')).toBeNull()
  expect(classify('git clean -n', 'Bash')).toBeNull()
  expect(classify('git clean -nd', 'Bash')).toBeNull()
  expect(classify('echo hi 2>&1', 'Bash')).toBeNull()
})

// 새던 명령은 이제 잡힌다 (리뷰가 찾은 미탐).
test('새던 명령을 잡는다', () => {
  expect(corruptReason("sed -ie 's/a/b/' x", 'Bash')).toBe('sed -i')
  expect(corruptReason('tee a.txt <<EOF\nhi\nEOF', 'Bash')).toBe('heredoc 으로 파일 쓰기')
  expect(corruptReason("python -c \"p=open('a').read().replace('x','y'); open('a','w').write(p)\"", 'PowerShell')).toBe('python 문자열 치환 후 덮어쓰기')
  expect(corruptReason("(Get-Content a) -creplace 'a','b' | Set-Content a", 'PowerShell')).toBe('PowerShell 문자열 치환 후 덮어쓰기')

  expect(classify('git push -uf origin main', 'Bash')?.kind).toBe('git-push-force')
  expect(classify('git push --force-if-includes', 'Bash')?.kind).toBe('git-push-force')
  expect(classify('git ls-files | xargs rm -rf', 'Bash')?.kind).toBe('unmeasured')
  expect(classify('find . -name "*.tmp" -delete', 'Bash')?.kind).toBe('unmeasured')
  expect(classify('find . -exec rm {} ;', 'Bash')?.kind).toBe('unmeasured')
  expect(classify('bash -c "rm -rf build"', 'Bash')?.kind).toBe('rm')
  expect(classify('Remove-Item -Rec build', 'PowerShell')?.kind).toBe('ps-remove')
  expect(classify('gci -Recurse | Remove-Item', 'PowerShell')?.kind).toBe('unmeasured')
  expect(classify('powershell -Command "Remove-Item -Recurse x"', 'Bash')?.kind).toBe('ps-remove')
})

// 재리뷰가 찾은 지적.
test('heredoc 은 진짜 표시만 인식하고, 실행되는 본문은 지우지 않는다', () => {
  // here-string, 산술 시프트, 따옴표 안의 << 뒤 줄은 본문이 아니다
  expect(classify('cat <<< "x"\nrm -rf build', 'Bash')?.kind).toBe('rm')
  expect(classify('echo $((1<<2))\nrm -rf build', 'Bash')?.kind).toBe('rm')
  expect(classify('echo "a <<EOF"\nrm -rf build', 'Bash')?.kind).toBe('rm')
  // 해석기가 실행하는 본문은 명령이다
  expect(classify('bash <<EOF\nrm -rf build\nEOF', 'Bash')?.kind).toBe('rm')
  // 파일에 쓰는 본문은 글자이므로 걸리지 않는다
  expect(classify("cat > doc.md <<'EOF'\nrm -rf build\nEOF", 'Bash')).toBeNull()
})

test('앞에 붙은 sudo·env·옵션과 약어, 안쪽 따옴표를 푼다', () => {
  expect(classify('sudo bash -c "rm -rf build"', 'Bash')?.kind).toBe('rm')
  expect(classify('env FOO=1 bash -e -c "rm -rf build"', 'Bash')?.kind).toBe('rm')
  expect(classify('powershell -Comm "Remove-Item -Recurse x"', 'Bash')?.kind).toBe('ps-remove')
  expect(classify('bash -c "rm -rf \\"my dir\\""', 'Bash')?.targets).toEqual(['my dir'])
  expect(corruptReason('bash -c "sed -i s/a/b/ x"', 'Bash')).toBe('sed -i')
})

test('미리보기와 옵션이 아닌 글자는 통과한다', () => {
  expect(classify('Remove-Item -Recurse x -WhatIf', 'PowerShell')).toBeNull()
  expect(classify('gci -Recurse | Remove-Item -WhatIf', 'PowerShell')).toBeNull()
  expect(corruptReason('perl -Mstrict -Mwarnings -e "print 1"', 'Bash')).toBeNull()
  expect(corruptReason('perl -pi -e "s/a/b/" x', 'Bash')).toBe('perl -i')
  expect(corruptReason('make | tee log; psql <<EOF\nselect 1;\nEOF', 'Bash')).toBeNull()
})

test('원래 잡던 것은 계속 잡는다', () => {
  expect(corruptReason("sed -i 's/a/b/' src/x.ts", 'Bash')).toBe('sed -i')
  expect(corruptReason("cat > a.txt <<'EOF'\nhi\nEOF", 'Bash')).toBe('heredoc 으로 파일 쓰기')
  expect(classify('rm -rf "my dir" && ls', 'Bash')?.targets).toEqual(['my dir'])
  expect(classify('git reset --hard HEAD~3', 'Bash')?.kind).toBe('git-reset')
  expect(classify('ls -la', 'Bash')).toBeNull()
  expect(classify('git status', 'Bash')).toBeNull()
})

// 각 시험의 첫 on('tool.call') 이 엔진을 대신한다: 막히지 않은 호출은 거기까지 내려온다.
test('파일을 깨뜨리는 명령은 한국어 사유로 거부된다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const cases = [
    "sed -i 's/a/b/' src/x.ts",
    "cat > a.txt <<'EOF'\nhi\nEOF",
    'python3 -c "p=open(\'a\').read().replace(\'x\',\'y\'); open(\'a\',\'w\').write(p)"',
  ]
  for (const command of cases) {
    const r: any = await $.tool.call({ tool: 'Bash', command })
    expect(String(r.deny)).toContain('edit-guard')
    // 시안 F: 이름표(이유·대신·재시도)를 줄로 나눈다
    expect(String(r.deny)).toContain('✗ edit-guard 막음')
    expect(String(r.deny)).toMatch(/\n이유 .*\n대신 .*\n재시도 /)
  }

  const ps: any = await $.tool.call({ tool: 'PowerShell', command: "(Get-Content a.txt) -replace 'a','b' | Set-Content a.txt" })
  expect(String(ps.deny)).toContain('edit-guard')
})

test('읽기 명령과 일반 명령은 그대로 지나간다', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const command of ['ls -la', 'git status', 'sed -n 1,5p a.txt', 'cat a.txt']) {
    const r: any = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
  }
})
