'use strict';

// 화면 문구 사전 (지령 016 — 용어표. 화면 '문구만' 바꾼다, 데이터 필드명은 유지)
// 모든 화면(홈·삼국 정립·군막 회의·책사 공적부·병법서·논공행상·관문 실행 창)이 이 사전을 쓴다.
// 보안·확인 절차 문구는 여기 있어도 줄이지 않는다(지령 016 — 용어만).

const TERMS = {
  home_title: '주군의 군영',
  rank_progress: (label, n) => `벼슬 ${label} · 태수까지 출병 ${n}/5`,
  nations_title: '삼국 정립',
  weekly_merit: '이번 주 논공',
  castles_title: '점령 중인 성',
  castle_enter: '입성',
  wall: '성벽',
  flag: '깃발',
  beacon: (n) => `봉화 ${n}/6`,
  weather_defense: '천하 정세 수성(방어)',
  weather_attack: '천하 정세 진격(공격)',
  weather_neutral: '천하 정세 관망(중립)',
  council_title: '군막 회의',
  council_today: '오늘의 군막 회의',
  merit_board: '책사 공적부',
  benchmark: '천하 대세(KODEX 200)',
  gate_exec: '옥새 찍는 곳',
  loot_title: '전리품과 포로',
  no_snapshot: '척후가 아직 돌아오지 않았습니다(08:30 도착 예정)',
  no_quotes: '봉화가 끊겼습니다',
  no_judged: '아직 전공 없음',
  gate_open: '관문 열림',
  gate_closed: '관문 닫힘',
  reference_note: '참고용, 최종 결정은 군주',
};

// 날씨 코드 → 문구
function weatherTerm(weather) {
  if (weather === 'defense') return TERMS.weather_defense;
  if (weather === 'attack') return TERMS.weather_attack;
  return TERMS.weather_neutral;
}

module.exports = { TERMS, weatherTerm };
