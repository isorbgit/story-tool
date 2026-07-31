# story-tool

세계관·시나리오를 노드 그래프로 정리하는 개인용 도구.
언리얼 블루프린트 에디터의 조작감을 참고했다.

**빌드 도구 없음. 서버·DB 없음.** `index.html` 을 열면 그게 전부다.

**→ <https://isorbgit.github.io/story-tool/>**

## 쓰는 법

| 환경 | 방법 | 데이터가 저장되는 곳 |
|---|---|---|
| PC (Chrome / Edge) | `index.html` 더블클릭 → 폴더 선택 | 고른 폴더의 `data/` — 탐색기에서 보이고 git 으로 관리된다 |
| PC (Firefox / Safari) | `index.html` 더블클릭 | 브라우저 내부 저장소(OPFS) — 안 보인다. 정기적으로 내보낼 것 |
| 아이패드 | 위 주소를 Safari 로 열고 **홈 화면에 추가** | OPFS |

`serve.cmd` 를 더블클릭하면 `http://localhost:8777` 로도 열린다.

> **주소가 곧 저장소 신원이다.** `file://` 로 연 것과 `http://localhost` 로 연 것은
> 서로 다른 저장소를 쓴다. 하나를 정해서 계속 쓰고, 옮길 때는 내보내기/가져오기를 쓴다.

## 원격 저장소 (선택)

위 저장 방식들은 전부 **그 기기 안**에만 남는다. PC 와 아이패드가 같은 데이터를 보게
하려면 Supabase Storage 에 연결한다. 연결하면 번들을 주고받을 필요가 없어진다.

### 준비 (한 번만, 웹 콘솔에서)

1. [supabase.com](https://supabase.com) 에서 프로젝트를 만든다
2. **Storage → New bucket** — 이름 `worldmap`, **Public 체크 해제**
3. **Authentication → Users → Add user** — 쓸 이메일·비밀번호로 하나 만든다
   (Auto Confirm User 를 켜야 메일 확인 없이 바로 쓴다). 만들어진 **UUID 를 복사**한다
4. **Authentication → Sign In / Providers → Email — "Allow new users to sign up" 을 끈다**
5. **SQL Editor** 에서 아래를 실행한다.
   아래 UUID 두 군데를 3번에서 복사한 값으로 바꾼다 — **따옴표 안의 값만** 갈아끼우고
   따옴표는 남긴다. 꺾쇠 `< >` 같은 건 넣지 않는다:

```sql
drop policy if exists "worldmap owner" on storage.objects;

create policy "worldmap owner" on storage.objects for all
  using      (bucket_id = 'worldmap' and auth.uid() = '00000000-0000-0000-0000-000000000000')
  with check (bucket_id = 'worldmap' and auth.uid() = '00000000-0000-0000-0000-000000000000');
```

> `drop` 이 앞에 있어 몇 번을 실행해도 된다. 정책을 고칠 때도 이걸 다시 돌리면 된다.

> **`auth.role() = 'authenticated'` 로 걸면 안 된다.**
> anon key 는 공개된 앱 안에 그대로 실린다. 회원가입이 열려 있으면 누구든 소스에서
> 키를 꺼내 가입한 뒤 `authenticated` 가 되어 전부 읽는다. 그 조합에서 `authenticated`
> 는 경계 구실을 하지 못한다. 그래서 **4번(가입 차단)과 5번(uid 로 한정)을 같이** 한다.
>
> 버킷을 Public 으로 만들면 정책과 무관하게 누구나 읽는다. 반드시 private 이다.

6. **Project Settings → API** 에서 `URL` 과 `anon public` 키를 복사한다.
   여기서 필요한 건 `https://<ref>.supabase.co` 형태의 **API 주소**다 —
   브라우저 주소창의 대시보드 주소가 아니다

### 확인

설정이 실제로 안전한지 눌러서 확인한다. 값을 보고 넘겨짚지 않는다.

```
node test/supabase-check.js https://<ref>.supabase.co <anon key>
```

버킷 존재 · 가입 차단 · 익명 읽기/쓰기 차단 · 공개 경로 차단을 실제 요청으로 검사한다.

### 연결

시작 화면의 **[원격 저장소 연결]** 에 URL·anon key·버킷·이메일·비밀번호를 넣는다.
한 번 넣으면 다음부터 자동으로 연결되고, 아이패드에서도 같은 값을 넣으면 같은 데이터를 본다.

- `anon key` 는 클라이언트에 노출을 전제로 만든 키다. GitHub 토큰과 달리 여기 넣어도 된다 —
  실제 방어는 위 정책과 로그인이 한다
- 연결에 실패하면 **조용히 로컬 저장으로 내려간다.** 비행기 안에서 앱이 안 열리면 안 된다
- 원격이 비어 있는데 로컬에 데이터가 있으면, 올릴지 먼저 묻는다
- 버킷 안의 트리는 폴더 저장과 같은 모양(`data/`, `backup/`)이라 서로 옮겨 쓸 수 있다

```
node test/supabase.test.js     프로젝트 없이 도는 스모크 테스트
```

## 데이터

노드(존재) · 엣지(사실) · 배치(표현) 를 나눠 4개 JSON 으로 저장한다.

```
data/schema.json     타입·소켓·필드 정의 (툴의 설정)
data/nodes.json      인물·사건·조직·물건·개념·장소
data/edges.json      관계
data/canvases.json   캔버스별 배치
backup/              최근 10개 스냅샷
```

**이 저장소에는 데이터를 올리지 않는다** (`.gitignore` 참조). 앱 코드만 있다.

## 기능

- 표 뷰 / 그래프 캔버스 / 포커스 뷰 / 타임라인
- 스키마 편집기 — 타입·소켓·필드를 앱 안에서 고친다. 적용 전 검증과 영향 분석
- 번들 내보내기·가져오기 (기기 간 이동, 타임스탬프 기반 병합)
- 마크다운 문서 일괄 내보내기 (폴더 또는 ZIP)
- 검증 — 인과 순환, 시점 모순, 고아 노드, 중복 의심 등

## 빌드

```
build.cmd     →  worldmap-single.html   (모든 파일을 하나로 합침, 약 290KB)
```

파일 하나로 옮기고 싶을 때만 쓴다. 위 주소로 쓴다면 필요 없다.

## 설계 문서

[SPEC.md](SPEC.md) — 데이터 구조, 저장 어댑터, 캔버스 규칙, 검증 규칙, 연대 체계.
왜 그렇게 만들었는지가 같이 적혀 있다.
