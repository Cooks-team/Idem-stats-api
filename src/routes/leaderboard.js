import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { computeElos, computeGlobalElos, rankFromElo, INITIAL_ELO, listTiers } from '../lib/elo.js';

const router = Router();

// GET /leaderboard?game=
// Renvoie [{ user, wins, losses, played, winrate, elo, rank, perGameElo }] trié
// par ELO desc. ELO calculé à la volée depuis l'historique en ordre chrono.
//
// - Sans filtre : ELO global (moyenne des jeux joués) + perGameElo en bonus
// - Avec ?game=X : ELO sur ce jeu uniquement
router.get('/', requireAuth, async (req, res) => {
  const game = typeof req.query.game === 'string' ? req.query.game : undefined;

  // On a besoin de TOUS les matchs finished, peu importe le filtre game, pour
  // calculer les ELO globaux. Le filtre s'applique au calcul des stats W/L et
  // au choix de l'ELO affiché.
  const all = await prisma.match.findMany({
    where: { status: 'finished' },
    select: {
      game: true,
      player1Id: true, player2Id: true, winnerId: true,
      finishedAt: true, status: true,
    },
    orderBy: { finishedAt: 'asc' },
  });

  const ratingsMap = computeElos(all);
  const globalElos = computeGlobalElos(ratingsMap);

  // Stats W/L/P sur les matchs filtrés (ou tous si pas de filtre)
  const filtered = game ? all.filter((m) => m.game === game) : all;
  const stats = new Map();
  const bump = (id, key) => {
    if (!id) return;
    const s = stats.get(id) || { wins: 0, losses: 0, played: 0 };
    s[key] += 1;
    stats.set(id, s);
  };
  for (const m of filtered) {
    bump(m.player1Id, 'played');
    bump(m.player2Id, 'played');
    if (m.winnerId) {
      bump(m.winnerId, 'wins');
      const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      bump(loserId, 'losses');
    }
  }

  // Liste des users : tous quand pas de filtre, ceux ayant joué le jeu quand filtré
  const includeIdle = !game;
  const users = await prisma.user.findMany({
    where: includeIdle ? undefined : { id: { in: [...stats.keys()] } },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });

  const entries = users.map((u) => {
    const s = stats.get(u.id) || { wins: 0, losses: 0, played: 0 };
    const winrate = s.played === 0 ? 0 : s.wins / s.played;
    const globalEntry = globalElos.get(u.id);
    // Si filtre par jeu → ELO du jeu uniquement (défaut INITIAL_ELO si jamais joué).
    // Sinon → ELO global (moyenne des jeux pratiqués).
    let elo = INITIAL_ELO;
    if (game) {
      elo = globalEntry?.perGame?.[game]?.rating ?? INITIAL_ELO;
    } else {
      elo = globalEntry?.global ?? INITIAL_ELO;
    }
    const rank = rankFromElo(elo);
    const perGameElo = {};
    if (globalEntry) {
      for (const [g, ent] of Object.entries(globalEntry.perGame)) {
        perGameElo[g] = { rating: ent.rating, games: ent.games, rank: rankFromElo(ent.rating) };
      }
    }
    return { user: u, wins: s.wins, losses: s.losses, played: s.played, winrate, elo, rank, perGameElo };
  });

  entries.sort((a, b) =>
    b.elo - a.elo
    || b.winrate - a.winrate
    || a.user.pseudo.localeCompare(b.user.pseudo),
  );
  res.json(entries);
});

// GET /leaderboard/tiers — barème public des ranks ELO. Sert à la page
// d'explication des ranks côté front. Pas d'auth requise (juste pour
// rester cohérent on garde requireAuth — c'est de l'app interne).
router.get('/tiers', requireAuth, (_req, res) => {
  res.json({ initialElo: INITIAL_ELO, tiers: listTiers() });
});

export default router;
