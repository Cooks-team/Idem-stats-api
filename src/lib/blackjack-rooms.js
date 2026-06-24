// Système de rooms Blackjack en mémoire — multi-joueurs casual.
//
// MODÈLE :
//   - Une room "main" persistante H24 + des overflows créées dynamiquement
//     quand toutes les rooms ouvertes sont pleines (6 sièges max). Les rooms
//     overflow sont supprimées quand elles se vident. La "main" ne l'est
//     jamais.
//   - Chaque joueur joue sa propre main contre le dealer commun. Pas de
//     tour-par-tour pendant 'playing' (libre).
//   - PAS DE TIMER auto sur betting/result : un joueur clique "Distribuer"
//     pour démarrer la partie (passe betting → playing), et clique
//     "Nouveau round" pour relancer (result → betting). Permet de jouer
//     à son rythme, surtout en solo.
//   - Le dealer joue dès que TOUT le monde a fini (stand/bust/blackjack).
//   - Si la dealer up-card est un As, on entre dans une phase 'insurance'
//     courte avant 'playing' : chaque joueur peut miser jusqu'à la moitié
//     de son bet sur "le dealer a un BJ". Payée 2:1 si BJ dealer.
//   - Le dealer a un nom (Bebeto/Jumper/Dim) qui tourne à chaque round.
//
// CYCLE DE ROUND :
//   waiting → betting (libre) → [insurance] → playing (libre) → dealer → result → waiting
//
// COINS :
//   - Bet prélevé sur le solde Prisma au moment de chaque mise (bet, double,
//     split, insurance) par le caller (routes/blackjack.js).
//   - Payout rendu en bloc au passage en phase 'result' via applyCoins(uid, delta).
//
// CLEANUP :
//   - tickCleanup() supprime les seats idle > 60s sans heartbeat. Si la
//     room overflow se vide → supprimée. La main reste toujours.

import { randomUUID } from 'crypto';

export const MAIN_ROOM_ID = 'main';
const MAX_SEATS = 6;
const SEAT_IDLE_TIMEOUT_MS = 60_000;
const DEALER_NAMES = ['Bebeto', 'Jumper', 'Dim'];

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** @type {Map<string, Room>} */
const rooms = new Map();

let broadcaster = null;
export function setBroadcaster(fn) { broadcaster = fn; }

let applyCoins = null;
export function setApplyCoins(fn) { applyCoins = fn; }

// ─ helpers cartes ──────────────────────────────────────────────────────
function makeDeck() {
  const deck = [];
  // 6 jeux de cartes mélangés — sabot type casino.
  for (let n = 0; n < 6; n++) {
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(c) {
  if (c.rank === 'A') return 11;
  if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J' || c.rank === '10') return 10;
  return parseInt(c.rank, 10);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    if (c.rank === 'A') { aces += 1; total += 11; }
    else total += cardValue(c);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

function isNaturalBlackjack(hand) {
  if (hand.length !== 2) return false;
  const isTen = (c) => c.rank === '10' || c.rank === 'J' || c.rank === 'Q' || c.rank === 'K';
  const [a, b] = hand;
  return (a.rank === 'A' && isTen(b)) || (b.rank === 'A' && isTen(a));
}

// ─ création / lookup ───────────────────────────────────────────────────
function newRoom(id) {
  const room = {
    id: id ?? randomUUID().slice(0, 8),
    seats: Array.from({ length: MAX_SEATS }, () => null),
    dealer: { hand: [], total: 0, name: DEALER_NAMES[0] },
    phase: 'waiting',
    deck: [],
    roundId: 0,
    insuranceOffered: false,
    createdAt: Date.now(),
    isMain: id === MAIN_ROOM_ID,
  };
  rooms.set(room.id, room);
  return room;
}

// Lazy init de la room main au premier accès — pas besoin d'un init() séparé.
function ensureMain() {
  if (!rooms.has(MAIN_ROOM_ID)) newRoom(MAIN_ROOM_ID);
  return rooms.get(MAIN_ROOM_ID);
}

function firstFreeSeat(room) {
  return room.seats.findIndex((s) => s === null);
}

/** Cherche une room non pleine. Priorité à la main, puis overflows existantes,
 *  sinon crée une overflow. */
export function findOrCreateRoomForJoin() {
  const main = ensureMain();
  if (firstFreeSeat(main) >= 0) return main;
  for (const room of rooms.values()) {
    if (room.id === MAIN_ROOM_ID) continue;
    if (firstFreeSeat(room) >= 0) return room;
  }
  return newRoom();
}

export function getRoom(id) { return rooms.get(id) || null; }
export function listRooms() {
  ensureMain();
  return [...rooms.values()].map((r) => ({
    id: r.id,
    players: r.seats.filter((s) => s).length,
    maxSeats: MAX_SEATS,
    phase: r.phase,
    isMain: r.isMain,
  }));
}

// ─ join / leave ────────────────────────────────────────────────────────
export function joinPlayer(user) {
  // Déjà assis ? on retourne sa place.
  for (const room of rooms.values()) {
    const idx = room.seats.findIndex((s) => s && s.userId === user.id);
    if (idx >= 0) return { room, seatIndex: idx };
  }
  const room = findOrCreateRoomForJoin();
  const idx = firstFreeSeat(room);
  if (idx < 0) throw new Error('room_full');
  room.seats[idx] = makeSeat(user);
  // Première arrivée dans la room ? on passe direct en betting pour
  // qu'il puisse miser tout de suite. Sinon (round en cours), il
  // attend la prochaine manche en spectateur.
  if (room.phase === 'waiting') openBetting(room);
  broadcastRoom(room);
  return { room, seatIndex: idx };
}

function makeSeat(user) {
  return {
    userId: user.id,
    pseudo: user.pseudo,
    avatarUrl: user.avatarUrl ?? null,
    bet: 0,
    insuranceBet: 0,
    insuranceDecided: false,
    hands: [],
    handBets: [],
    handStatus: [],
    activeHandIdx: 0,
    result: null,
    payout: 0,
    insurancePayout: 0,
    lastActivity: Date.now(),
  };
}

export function leaveByUserId(userId) {
  for (const room of rooms.values()) {
    const idx = room.seats.findIndex((s) => s && s.userId === userId);
    if (idx < 0) continue;
    room.seats[idx] = null;
    // Si overflow vide → supprime. La main reste toujours.
    if (!room.isMain && room.seats.every((s) => s === null)) {
      rooms.delete(room.id);
    } else {
      // S'il restait des actions à attendre de ce user (playing/insurance), ré-évalue.
      maybeAdvancePhase(room);
      broadcastRoom(room);
    }
    return true;
  }
  return false;
}

// ─ cycle de round ─────────────────────────────────────────────────────
function openBetting(room) {
  room.phase = 'betting';
  room.insuranceOffered = false;
  // Reset des hands précédentes mais on garde les seats.
  for (const seat of room.seats) {
    if (!seat) continue;
    seat.bet = 0;
    seat.insuranceBet = 0;
    seat.insuranceDecided = false; // CRITIQUE : sans ça, un user qui avait
    // déjà répondu à une assurance au round N gardait insuranceDecided=true
    // au round N+1. Résultat : maybeFinishInsurance le considérait
    // "décidé" et passait la phase 'insurance' direct vers 'playing'
    // sans lui laisser le temps de cliquer.
    seat.hands = [];
    seat.handBets = [];
    seat.handStatus = [];
    seat.activeHandIdx = 0;
    seat.result = null;
    seat.payout = 0;
    seat.insurancePayout = 0;
  }
  room.dealer = { hand: [], total: 0, name: room.dealer.name };
  room.roundId += 1;
  // Cycle dealer name à chaque round (Bebeto → Jumper → Dim → Bebeto …).
  const nextIdx = (DEALER_NAMES.indexOf(room.dealer.name) + 1) % DEALER_NAMES.length;
  room.dealer.name = DEALER_NAMES[nextIdx];
  broadcastRoom(room);
}

/** Démarre la manche. Action explicite (clic sur "Distribuer"). Exige au
 *  moins 1 joueur ayant misé. */
export function startRound(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room } = found;
  if (room.phase !== 'betting') throw new Error('not_betting_phase');
  const bettors = room.seats.filter((s) => s && s.bet > 0);
  if (bettors.length === 0) throw new Error('no_bets');

  room.deck = makeDeck();
  for (const seat of bettors) {
    const c1 = room.deck.pop();
    const c2 = room.deck.pop();
    seat.hands = [[c1, c2]];
    seat.handBets = [seat.bet];
    seat.handStatus = [isNaturalBlackjack(seat.hands[0]) ? 'blackjack' : 'playing'];
    seat.activeHandIdx = 0;
  }
  const d1 = room.deck.pop();
  const d2 = room.deck.pop();
  room.dealer.hand = [d1, { ...d2, hidden: true }];
  room.dealer.total = handValue([d1]);

  // Si l'up-card du dealer est un As → phase 'insurance' avant playing
  // (les bettors peuvent miser jusqu'à 0.5 × leur bet).
  if (d1.rank === 'A') {
    room.phase = 'insurance';
    room.insuranceOffered = true;
  } else {
    room.phase = 'playing';
  }
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

/** Termine la phase insurance soit en passant la mise (`insurance(0)`),
 *  soit en posant une mise (>0 jusqu'à floor(bet/2)). */
export function insurance(userId, amount, applyExtraBetCallback) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'insurance') throw new Error('not_insurance_phase');
  if (seat.insuranceBet > 0) throw new Error('already_insured');
  if (seat.bet === 0) throw new Error('no_active_bet');
  if (amount < 0) throw new Error('invalid_amount');
  const maxIns = Math.floor(seat.bet / 2);
  if (amount > maxIns) throw new Error('insurance_too_high');
  seat.insuranceBet = amount;
  seat.lastActivity = Date.now();
  return { room, seat, charge: amount, applyExtraBetCallback };
}

/** À appeler après que TOUS les bettors aient répondu à l'assurance (pose
 *  ou skip). On le détecte côté serveur en checkant que tous ont pris
 *  position : insuranceBet >= 0 + lastActivity récent. En pratique, on
 *  passe à playing dès qu'on est dans cette phase pour pas bloquer. */
function maybeFinishInsurance(room) {
  if (room.phase !== 'insurance') return;
  // Heuristique : on attend que TOUS les bettors aient posé une décision
  // explicite. On track via un flag `insuranceDecided` sur le seat.
  const bettors = room.seats.filter((s) => s && s.handBets.length > 0);
  if (bettors.length === 0) return;
  const allDone = bettors.every((s) => s.insuranceDecided);
  if (!allDone) return;

  // Vérifie le BJ dealer maintenant.
  const dealerBJ = isNaturalBlackjack([room.dealer.hand[0], { ...room.dealer.hand[1], hidden: false }]);
  if (dealerBJ) {
    // Révèle, résout les insurances + résout les mains direct.
    room.dealer.hand = room.dealer.hand.map((c) => ({ ...c, hidden: false }));
    room.dealer.total = handValue(room.dealer.hand);
    for (const seat of room.seats) {
      if (!seat || !seat.handBets.length) continue;
      // Insurance paie 2:1 si dealer BJ.
      if (seat.insuranceBet > 0) seat.insurancePayout = seat.insuranceBet * 3; // remise + 2× = 3×
      resolveSeatVsDealer(seat, room.dealer);
    }
    finalizePayouts(room);
    room.phase = 'result';
  } else {
    // Pas de BJ : les insurances sont perdues, on passe à playing.
    room.phase = 'playing';
  }
  broadcastRoom(room);
  maybeAdvancePhase(room);
}

/** Le joueur passe l'assurance (amount = 0) ou la confirme. À appeler
 *  après `insurance()` pour signaler la décision. */
export function decideInsurance(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'insurance') throw new Error('not_insurance_phase');
  if (seat.bet === 0) throw new Error('no_active_bet');
  seat.insuranceDecided = true;
  seat.lastActivity = Date.now();
  broadcastRoom(room);
  maybeFinishInsurance(room);
  return room;
}

function maybeAdvancePhase(room) {
  if (room.phase !== 'playing') return;
  const active = room.seats.filter((s) => s && s.handBets.length > 0);
  if (active.length === 0) {
    finishRound(room);
    return;
  }
  const allDone = active.every((s) =>
    s.handStatus.every((st) => st === 'standing' || st === 'busted' || st === 'blackjack')
  );
  if (allDone) startDealer(room);
}

function startDealer(room) {
  room.phase = 'dealer';
  room.dealer.hand = room.dealer.hand.map((c) => ({ ...c, hidden: false }));
  while (handValue(room.dealer.hand) < 17) {
    room.dealer.hand.push(room.deck.pop());
  }
  room.dealer.total = handValue(room.dealer.hand);
  for (const seat of room.seats) {
    if (!seat || !seat.handBets.length) continue;
    resolveSeatVsDealer(seat, room.dealer);
  }
  finalizePayouts(room);
  room.phase = 'result';
  broadcastRoom(room);
}

function finalizePayouts(room) {
  if (!applyCoins) return;
  for (const seat of room.seats) {
    if (!seat) continue;
    const total = (seat.payout ?? 0) + (seat.insurancePayout ?? 0);
    if (total > 0) applyCoins(seat.userId, total).catch(() => {});
  }
}

function resolveSeatVsDealer(seat, dealer) {
  const dv = dealer.total;
  let totalPayout = 0;
  seat.handStatus = seat.handStatus.map((st, i) => {
    const h = seat.hands[i];
    const b = seat.handBets[i];
    if (st === 'busted') return 'busted';
    if (st === 'blackjack') {
      if (isNaturalBlackjack(dealer.hand)) { totalPayout += b; return 'push'; }
      totalPayout += Math.floor(b * 2.5);
      return 'blackjack';
    }
    const pv = handValue(h);
    if (dv > 21 || pv > dv) { totalPayout += b * 2; return 'win'; }
    if (pv < dv) return 'lose';
    totalPayout += b; return 'push';
  });
  seat.payout = totalPayout;
  const priority = { blackjack: 5, win: 4, push: 3, lose: 2, busted: 1 };
  let best = null;
  for (const st of seat.handStatus) {
    if (!best || priority[st] > priority[best]) best = st;
  }
  seat.result = best;
}

function finishRound(room) {
  // Reste en result jusqu'à ce qu'un user appuie sur "Nouveau round" via next().
  room.phase = 'result';
  broadcastRoom(room);
}

/** Action explicite "Nouveau round". N'importe quel seat peut la déclencher.
 *  Réouvre une phase betting. */
export function next(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room } = found;
  if (room.phase !== 'result' && room.phase !== 'waiting') {
    throw new Error('not_result_phase');
  }
  openBetting(room);
  return room;
}

// ─ actions joueur ──────────────────────────────────────────────────────
export function placeBet(userId, amount) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'betting') throw new Error('not_betting_phase');
  if (amount < 1) throw new Error('bet_too_low');
  if (seat.bet > 0) throw new Error('already_bet');
  seat.bet = amount;
  seat.lastActivity = Date.now();
  broadcastRoom(room);
  return room;
}

export function hit(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  seat.hands[i].push(room.deck.pop());
  const v = handValue(seat.hands[i]);
  if (v > 21) seat.handStatus[i] = 'busted';
  else if (v === 21) seat.handStatus[i] = 'standing';
  seat.lastActivity = Date.now();
  if (seat.handStatus[i] !== 'playing' && i + 1 < seat.hands.length) {
    seat.activeHandIdx = i + 1;
  }
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export function stand(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  seat.handStatus[i] = 'standing';
  seat.lastActivity = Date.now();
  if (i + 1 < seat.hands.length) seat.activeHandIdx = i + 1;
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export async function doubleDown(userId, applyExtraBetCallback) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  if (seat.hands[i].length !== 2) throw new Error('double_after_hit');
  const extra = seat.handBets[i];
  if (applyExtraBetCallback) await applyExtraBetCallback(seat.userId, extra);
  seat.handBets[i] *= 2;
  seat.hands[i].push(room.deck.pop());
  const v = handValue(seat.hands[i]);
  seat.handStatus[i] = v > 21 ? 'busted' : 'standing';
  seat.lastActivity = Date.now();
  if (i + 1 < seat.hands.length) seat.activeHandIdx = i + 1;
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export async function split(userId, applyExtraBetCallback) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  if (seat.hands.length !== 1) throw new Error('already_split');
  const h = seat.hands[0];
  if (h.length !== 2) throw new Error('not_splittable');
  // Règle "same value" — 10/J/Q/K splittables entre eux car tous valent 10.
  // L'As reste un cas à part (As/As autorisé, mais pas mélange A+10/J/Q/K).
  const sameValue = cardValue(h[0]) === cardValue(h[1]);
  const isAcesPair = h[0].rank === 'A' && h[1].rank === 'A';
  // Pour éviter de splitter A+10 (BJ naturel) : on exige soit même rank,
  // soit deux cartes de valeur 10 strictes (10/J/Q/K).
  const bothTen = cardValue(h[0]) === 10 && cardValue(h[1]) === 10
    && h[0].rank !== 'A' && h[1].rank !== 'A';
  const sameRank = h[0].rank === h[1].rank;
  if (!sameRank && !bothTen && !isAcesPair) throw new Error('not_splittable');
  const extra = seat.handBets[0];
  if (applyExtraBetCallback) await applyExtraBetCallback(seat.userId, extra);
  const c1 = room.deck.pop();
  const c2 = room.deck.pop();
  seat.hands = [[h[0], c1], [h[1], c2]];
  seat.handBets = [extra, extra];
  seat.handStatus = isAcesPair ? ['standing', 'standing'] : ['playing', 'playing'];
  seat.activeHandIdx = 0;
  seat.lastActivity = Date.now();
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

// ─ helpers internes ────────────────────────────────────────────────────
function findSeat(userId) {
  for (const room of rooms.values()) {
    const seat = room.seats.find((s) => s && s.userId === userId);
    if (seat) return { room, seat };
  }
  return null;
}

export function snapshotRoom(room, viewerId) {
  const dealerHand = room.dealer.hand.map((c) =>
    c.hidden ? { hidden: true } : { rank: c.rank, suit: c.suit }
  );
  let dealerTotal = 0;
  if (room.dealer.hand.length > 0) {
    if (room.phase === 'playing' || room.phase === 'insurance') {
      dealerTotal = handValue([room.dealer.hand[0]]);
    } else if (room.phase === 'dealer' || room.phase === 'result') {
      dealerTotal = handValue(room.dealer.hand);
    }
  }
  return {
    id: room.id,
    isMain: room.isMain,
    phase: room.phase,
    roundId: room.roundId,
    insuranceOffered: room.insuranceOffered,
    maxSeats: MAX_SEATS,
    dealer: {
      name: room.dealer.name,
      hand: dealerHand,
      total: dealerTotal,
    },
    seats: room.seats.map((s, i) => {
      if (!s) return { index: i, empty: true };
      return {
        index: i,
        empty: false,
        userId: s.userId,
        pseudo: s.pseudo,
        avatarUrl: s.avatarUrl,
        bet: s.bet,
        insuranceBet: s.insuranceBet,
        insuranceDecided: !!s.insuranceDecided,
        hands: s.hands,
        handBets: s.handBets,
        handStatus: s.handStatus,
        activeHandIdx: s.activeHandIdx,
        result: s.result,
        payout: s.payout,
        insurancePayout: s.insurancePayout,
        isMe: s.userId === viewerId,
      };
    }),
  };
}

function broadcastRoom(room) {
  if (!broadcaster) return;
  for (const seat of room.seats) {
    if (!seat) continue;
    broadcaster(seat.userId, 'blackjack.room', snapshotRoom(room, seat.userId));
  }
}

export function tickCleanup() {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s) continue;
      if (now - s.lastActivity > SEAT_IDLE_TIMEOUT_MS) {
        room.seats[i] = null;
      }
    }
    if (!room.isMain && room.seats.every((s) => s === null)) {
      rooms.delete(room.id);
    }
  }
  ensureMain(); // re-create si jamais elle a été supprimée par erreur
}

export function heartbeat(userId) {
  const found = findSeat(userId);
  if (!found) return false;
  found.seat.lastActivity = Date.now();
  return true;
}
