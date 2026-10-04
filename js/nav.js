// 画面離脱の確認（計測中・通話中など）。main.js のルーターが参照する。

let guard = null;

/** 画面側から「離れる前に確認する」関数を登録する（null で解除）。 */
export function setLeaveGuard(fn) { guard = fn; }
export function leaveGuard() { return guard; }
