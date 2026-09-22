import type { MissionDef } from "./state.ts";
import type { UnitArchetype } from "./types.ts";

function e(archetype: UnitArchetype, x: number, y: number) {
  return { archetype, x, y };
}
function p(archetype: UnitArchetype, x: number, y: number) {
  return { archetype, x, y };
}

// Mission 1 — Infiltration (tutorial). Open sightlines, light security. 2 relays, core, extraction.
const M1 = [
  "##############",
  "#............#",
  "#..c....T....#",
  "#....v.......#",
  "#...OOOOOO...#",
  "#..^....c....#",
  "#.......v....#",
  "#...c.....T..#",
  "#..OO........#",
  "#........^...#",
  "#....v.......#",
  "#....P.....K.#",
  "#.......^.X..#",
  "##############",
];

// Mission 2 — Relay Junction. A wall spine with hackable security doors splits the board;
// vents + conceal floor let a patient crew bypass the guns, cameras watch the main corridors.
const M2 = [
  "##############",
  "#..v..#...v.X#",
  "#..c..D.....c#",
  "#..v..#..v...#",
  "#.....#.OO...#",
  "#.OOv.^....^.#",
  "#..v..D....v.#",
  "#.....#..R...#",
  "#..c..#..K.v.#",
  "#..T..#..T...#",
  "#..v..#....^.#",
  "#.....#..OO..#",
  "#..^..#..^...#",
  "##############",
];

// Mission 3 — Core Chamber. Central core ringed by pillars; cameras + turrets defend the
// approach, vents cut a shadowed lane through the middle.
const M3 = [
  "##############",
  "#..v...^.v...#",
  "#..OO....OO..#",
  "#..T.v..v..T.#",
  "#..c...c..c..#",
  "#.NA......A..#",
  "#.....KK.....#",
  "#....OOOO.X..#",
  "#..c..R.R..c.#",
  "#..^..v..v.^.#",
  "#...OOOOOO...#",
  "#..v.v.v.v...#",
  "#...v....M...#",
  "##############",
];

export const MISSIONS: MissionDef[] = [
  {
    index: 0,
    name: "Outer Perimeter",
    layout: M1,
    players: [p("vanguard", 1, 12), p("ghost", 2, 12), p("cipher", 1, 11)],
    enemies: [e("sentry", 10, 4), e("sentry", 11, 8), e("hunter", 12, 9)],
  },
  {
    index: 1,
    name: "Relay Junction",
    layout: M2,
    players: [p("vanguard", 1, 12), p("ghost", 2, 12), p("cipher", 1, 11)],
    enemies: [e("sentry", 3, 10), e("sentry", 11, 1), e("enforcer", 8, 9), e("hunter", 10, 3), e("warden", 11, 8)],
  },
  {
    index: 2,
    name: "Core Chamber",
    layout: M3,
    players: [p("vanguard", 2, 12), p("ghost", 3, 12), p("cipher", 1, 12)],
    enemies: [e("sentry", 2, 4), e("sentry", 11, 4), e("enforcer", 2, 8), e("hunter", 5, 4), e("hunter", 8, 4), e("warden", 3, 10)],
  },
];

export function missionByIndex(i: number): MissionDef {
  return MISSIONS[Math.max(0, Math.min(MISSIONS.length - 1, i))];
}