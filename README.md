# my-own-mods

릴레이형 작업(설계 → 구현 → 리뷰 → 인계)을 위한 Claude Code 모드, 스킬, 에이전트 모음입니다. 플러그인 5개가 들어 있고, 각각 따로 설치할 수 있습니다.

## 한눈에 보기

| 이름 | 종류 | 나타나는 곳 | 하는 일 |
|---|---|---|---|
| [edit-guard](plugins/edit-guard) | 모드 | 확인 패널 (패널을 못 놓는 창은 입력창 위) | 파일을 깨뜨리는 명령은 한국어 사유로 막고, 위험한 삭제·git 명령은 영향 범위를 보여준 뒤 진행/취소를 묻습니다. |
| [relay-band](plugins/relay-band) | 모드 | 입력창 위 한 줄 (터미널·데스크톱) | 검증 결과, 자식 에이전트 수, 컨텍스트, 주간 한도와 오늘 권장량, 턴 시간, 캐시, 날씨 추이, 페이스를 한 줄로 보여줍니다. |
| [agent-panel](plugins/agent-panel) | 모드 | 옆 패널 (패널을 못 놓는 창은 그리지 않음) | 실행 중인 하위 에이전트를 보여줍니다(이름, 유형, 상태, 경과 시간, 도구 호출 수, 마지막 도구). `/agent_panel`로 열고 닫습니다. |
| [relay-skills](plugins/relay-skills) | 스킬 | 직접 입력할 때만 | `/handoff`: 실행한 명령의 결과를 본 것만 "완료"로 적는 인계 요약. `/confirm-first`: 큰 작업 전에 해석을 적어 확인받기. |
| [relay-agents](plugins/relay-agents) | 에이전트 | 하위 에이전트 호출 | `relay-design`(Fable, high), `relay-build`(Opus, medium), `relay-review`(Opus, high). 모델과 노력 수준이 파일에 고정되어 상한선이 됩니다. |

## 설치

Claude Code 터미널 세션의 입력창에서:

```
/plugin install edit-guard --marketplace Dawnilove/my-own-mods
```

`y`로 마켓플레이스를 추가한 뒤 범위를 고릅니다. 다른 항목은 이름만 바꿔 같은 방식으로 설치합니다.

설치한 뒤 확인하는 방법:
1. edit-guard: 위험한 삭제 명령을 시키면 확인 패널이 뜹니다.
2. relay-band: 입력창 위에 한 줄 띠가 보입니다.
3. agent-panel: `/agent_panel`을 입력하면 패널이 열립니다.
4. relay-skills: `/handoff`, `/confirm-first`가 자동 완성에 나옵니다.

## 먼저 알아 둘 것

- 만든 사람의 환경(Windows, Claude Code 데스크톱 앱)에서만 확인했습니다. 다른 환경은 확인하지 못했습니다.
- `edit-guard`는 실수로 나가는 명령을 막는 안전장치입니다. 일부러 우회하는 입력을 막는 보안 장치가 아닙니다.

## 플러그인별 자세한 설명

<details>
<summary>edit-guard</summary>

- `sed -i`, heredoc 쓰기, 문자열 치환 같은 파일 훼손 명령은 한국어 사유로 막습니다.
- `rm -rf`, `git reset --hard`, 강제 푸시, `Remove-Item -Recurse`는 영향 범위를 보여주고 진행/취소를 묻습니다.
- 영향 범위 계산은 `bash`와 `git`이 필요합니다. Windows에서는 Git에 딸린 `bash.exe`를 대신 찾습니다. 못 찾으면 "측정 실패"라고 알리고 진행/취소는 그대로 묻습니다.
- 정규식으로 명령을 읽습니다. 주석이나 `it\'s` 같은 가짜 따옴표, `$( )`와 백틱 안의 명령은 보지 못합니다.

</details>

<details>
<summary>relay-band</summary>

- 폭이 좁으면 중요도가 낮은 칸부터 숨깁니다.
- 입력창 위 띠 자리를 [ponytail](https://github.com/DietrichGebert/ponytail)의 띠와 나눠 씁니다. 그 띠 아래에 붙고, 데스크톱 화면에서는 줄을 맞추려고 1칸 들여씁니다(코드 맨 위의 `INDENT`).
- 비용 칸은 ponytail이 이미 보여줘서 기본으로 숨깁니다(`SHOW_COST`).
- 주간 한도 칸은 계정이 `seven_day` 한도 값을 줄 때만 나옵니다.

</details>

<details>
<summary>agent-panel</summary>

- `/agent_panel`로 패널을 열고 닫습니다.
- 패널을 놓을 자리가 없는 좁은 창에서는 아무것도 그리지 않습니다. relay-band의 "자식" 칸이 대신합니다.

</details>

<details>
<summary>relay-skills</summary>

- 두 스킬은 사용자가 직접 입력할 때만 실행됩니다.

</details>

<details>
<summary>relay-agents</summary>

- 세 에이전트의 모델과 노력 수준은 각 파일에 고정되어 있습니다.

</details>

## 라이선스

MIT
