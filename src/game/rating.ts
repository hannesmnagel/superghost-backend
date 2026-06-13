const K = 32

export function computeElo(
  ratingWinner: number,
  ratingLoser: number,
): { winnerNew: number; loserNew: number; delta: number } {
  const expectedWin = 1 / (1 + 10 ** ((ratingLoser - ratingWinner) / 400))
  const delta = Math.round(K * (1 - expectedWin))
  return {
    winnerNew: ratingWinner + delta,
    loserNew: Math.max(0, ratingLoser - delta),
    delta,
  }
}
