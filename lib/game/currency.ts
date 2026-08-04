export const WEN_PER_GUAN = 1_000;

export function formatCashWen(value: number) {
  const cashWen = Math.max(0, Math.trunc(value));
  const guan = Math.floor(cashWen / WEN_PER_GUAN);
  const wen = cashWen % WEN_PER_GUAN;
  if (guan === 0) return `${wen}文`;
  if (wen === 0) return `${guan}贯`;
  return `${guan}贯${wen}文`;
}

export function legacySilverToWen(value: number) {
  return Math.max(0, Math.trunc(value)) * WEN_PER_GUAN;
}
