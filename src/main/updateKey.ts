/**
 * 화면 번들 서명 공개키 (store-app.md §8.1). 개인키는 빌드하는 PC 의
 * {@code ~/.sunmoon/ui-signing-ed25519.pem} 에만 있습니다(scripts/keygen.mjs, 2026-09-28).
 *
 * <p>셸이 받은 화면 번들은 이 키로 서명이 확인되어야만 풀립니다. 배포 기록이 잘못
 * 들어가도(BO 계정 탈취 등) 우리 빌드 기계가 만들지 않은 코드는 돌지 않습니다.
 * 키를 바꾸면 <b>모든 셸을 다시 설치</b>해야 합니다 — 이 값이 셸에 박혀 있기 때문입니다.
 */
export const UI_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIykRhLG/4sCuu54Boe5728kMRxxlwiTbKcbv9V6lIt8=
-----END PUBLIC KEY-----
`
