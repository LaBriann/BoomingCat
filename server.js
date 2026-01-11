const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 游戏核心数据 ---
let players = {};
let playerIds = [];
let currentTurnIndex = 0;
let deck = [];
let topCardPublic = null;

// 弃牌堆
let discardPile = [];

// 游戏阶段
let phase = 'waiting';
let winnerId = null;

// 正在拆弹的玩家（必须先 insertBomb）
let defusingPlayerId = null;

const MIN_PLAYERS = 2;
const STARTING_HAND = ['拆除', '拆除', '普通牌'];

// 洗牌
function shuffleDeck() {
  const cards = [
    '炸弹', '炸弹', '炸弹', '炸弹',
    '拆除', '拆除',
    '跳过', '跳过',
    '克隆牌', '克隆牌',
    '普通牌', '普通牌', '普通牌', '普通牌', '普通牌'
  ];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function getAlivePlayers() {
  return playerIds.filter(pid => players[pid] && !players[pid].isDead);
}

function discard(card) {
  if (!card) return;
  discardPile.push(card);
}

function discardTop() {
  return discardPile.length ? discardPile[discardPile.length - 1] : null;
}

function buildState() {
  const currentTurn =
    (phase === 'playing' && playerIds[currentTurnIndex])
      ? playerIds[currentTurnIndex]
      : null;

  return {
    players,
    deckCount: deck.length,
    currentTurn,
    topCardPublic,

    // 弃牌堆（只下发数量 + 顶牌，避免过大）
    discardCount: discardPile.length,
    discardTopCard: discardTop(),

    phase,
    winnerId
  };
}

function broadcastState() {
  io.emit('gameState', buildState());
}

function ensureValidTurnIndex() {
  if (phase !== 'playing') {
    currentTurnIndex = 0;
    return;
  }

  const alive = getAlivePlayers();
  if (alive.length === 0) {
    currentTurnIndex = 0;
    return;
  }

  const curId = playerIds[currentTurnIndex];
  if (!players[curId] || players[curId].isDead) {
    const firstAliveId = alive[0];
    const idx = playerIds.indexOf(firstAliveId);
    currentTurnIndex = idx >= 0 ? idx : 0;
  }
}

function endRound(newWinnerId) {
  phase = 'ended';
  winnerId = newWinnerId;
  topCardPublic = null;
  currentTurnIndex = 0;
  defusingPlayerId = null;

  io.emit('gameOver', { winnerId });
  broadcastState();
}

function startNewRound() {
  deck = shuffleDeck();
  topCardPublic = null;
  winnerId = null;
  defusingPlayerId = null;

  // 新一局清空弃牌堆
  discardPile = [];

  for (const id of playerIds) {
    if (!players[id]) continue;
    players[id].isDead = false;
    players[id].hand = [...STARTING_HAND];
  }

  phase = 'playing';
  currentTurnIndex = 0;
  ensureValidTurnIndex();

  io.emit('gameRestarted');
  broadcastState();
}

function recomputePhaseAndMaybeEndOrStart() {
  playerIds = playerIds.filter(pid => players[pid]);

  const connectedCount = playerIds.length;

  if (connectedCount < MIN_PLAYERS) {
    phase = 'waiting';
    winnerId = null;
    topCardPublic = null;
    currentTurnIndex = 0;
    defusingPlayerId = null;
    broadcastState();
    return;
  }

  if (phase === 'waiting') {
    startNewRound();
    return;
  }

  if (phase === 'playing') {
    const alive = getAlivePlayers();
    if (alive.length <= 1) {
      endRound(alive.length === 1 ? alive[0] : null);
      return;
    }
    ensureValidTurnIndex();
    broadcastState();
    return;
  }

  broadcastState();
}

function nextTurn() {
  if (phase !== 'playing') return;

  // 拆弹中不推进回合
  if (defusingPlayerId) {
    broadcastState();
    return;
  }

  const alive = getAlivePlayers();
  if (alive.length <= 1) {
    endRound(alive.length === 1 ? alive[0] : null);
    return;
  }

  let attempts = 0;
  do {
    currentTurnIndex = (currentTurnIndex + 1) % playerIds.length;
    attempts++;
  } while (
    attempts <= playerIds.length &&
    (!players[playerIds[currentTurnIndex]] || players[playerIds[currentTurnIndex]].isDead)
  );

  ensureValidTurnIndex();
  broadcastState();
}

// 统一校验：是否允许该玩家在当前时刻主动出牌
function validateCanPlayActiveCard(socket) {
  if (phase !== 'playing') return { ok: false, msg: '当前不是游戏进行中，无法出牌' };
  if (defusingPlayerId) return { ok: false, msg: '正在拆弹中，必须先把炸弹塞回去' };
  if (!players[socket.id] || players[socket.id].isDead) return { ok: false, msg: '你已死亡，无法出牌' };
  if (socket.id !== playerIds[currentTurnIndex]) return { ok: false, msg: '还没轮到你，不能出牌' };
  return { ok: true };
}

io.on('connection', (socket) => {
  console.log('玩家加入: ' + socket.id);

  players[socket.id] = {
    id: socket.id,
    hand: [...STARTING_HAND],
    isDead: false
  };

  if (!playerIds.includes(socket.id)) {
    playerIds.push(socket.id);
  }

  recomputePhaseAndMaybeEndOrStart();

  // 单播给新玩家，避免首帧丢失
  socket.emit('gameState', buildState());

  socket.on('requestState', () => {
    socket.emit('gameState', buildState());
  });

  // 出牌：跳过 / 克隆牌
  socket.on('playCard', ({ card } = {}) => {
    const v = validateCanPlayActiveCard(socket);
    if (!v.ok) {
      socket.emit('errorMsg', { message: v.msg });
      return;
    }

    if (!card) {
      socket.emit('errorMsg', { message: '出牌参数错误：缺少 card' });
      return;
    }

    const hand = players[socket.id].hand;

    // --- 跳过 ---
    if (card === '跳过') {
      const idx = hand.indexOf('跳过');
      if (idx === -1) {
        socket.emit('errorMsg', { message: '你没有【跳过】牌' });
        return;
      }

      hand.splice(idx, 1);
      discard('跳过');

      io.emit('cardPlayed', { id: socket.id, card: '跳过' });

      nextTurn();
      return;
    }

    // --- 克隆牌 ---
    if (card === '克隆牌') {
      const idx = hand.indexOf('克隆牌');
      if (idx === -1) {
        socket.emit('errorMsg', { message: '你没有【克隆牌】' });
        return;
      }

      const top = discardTop();
      if (!top) {
        socket.emit('errorMsg', { message: '弃牌堆为空，无法克隆' });
        return;
      }

      // 本版本：只支持克隆“跳过”的效果（因为这是你目前唯一主动技能牌）
      if (top !== '跳过') {
        socket.emit('errorMsg', { message: `弃牌堆顶牌为【${top}】，当前不可克隆其效果` });
        return;
      }

      // 先消耗克隆牌，再把克隆牌放进弃牌堆
      // 注意：克隆目标已在上面读取，避免“克隆自己”
      hand.splice(idx, 1);
      discard('克隆牌');

      // 广播：克隆了谁（客户端可显示更丰富提示）
      io.emit('cardPlayed', { id: socket.id, card: '克隆牌', clonedCard: top });

      // 执行克隆效果：等同于打出“跳过”
      nextTurn();
      return;
    }

    socket.emit('errorMsg', { message: `暂不支持此卡牌：${card}` });
  });

  // 抽牌
  socket.on('drawCard', () => {
    if (phase !== 'playing') {
      socket.emit('errorMsg', { message: '需要至少 2 名玩家且游戏进行中才能抽牌' });
      return;
    }
    if (defusingPlayerId) return;
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    if (deck.length === 0) {
      socket.emit('errorMsg', { message: '牌库已空，无法抽牌' });
      return;
    }

    const card = deck.pop();
    topCardPublic = null;

    if (card === '炸弹') {
      const player = players[socket.id];
      const defuseIndex = player.hand.indexOf('拆除');

      if (defuseIndex !== -1) {
        // 消耗拆除 -> 进入弃牌堆
        player.hand.splice(defuseIndex, 1);
        discard('拆除');

        // 进入拆弹态
        defusingPlayerId = socket.id;

        broadcastState();
        socket.emit('askInsertBomb', { maxIndex: deck.length });
        return;
      }

      // 没拆除：死亡，炸弹进入弃牌堆（用于可视化爆炸）
      player.isDead = true;
      discard('炸弹');

      io.emit('playerDied', { id: socket.id });

      recomputePhaseAndMaybeEndOrStart();

      if (phase === 'playing') nextTurn();
      return;
    }

    // 非炸弹：入手
    players[socket.id].hand.push(card);
    nextTurn();
  });

  // 塞炸弹
  socket.on('insertBomb', ({ index, isPublic }) => {
    if (phase !== 'playing') return;
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (defusingPlayerId !== socket.id) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    let idx = Number(index);
    if (!Number.isFinite(idx)) return;
    if (idx < 0) idx = 0;
    if (idx > deck.length) idx = deck.length;

    deck.splice(idx, 0, '炸弹');

    const isAtTop = (idx === deck.length - 1);
    topCardPublic = (isAtTop && isPublic) ? '炸弹' : null;

    defusingPlayerId = null;

    io.emit('bombInserted');

    recomputePhaseAndMaybeEndOrStart();
    if (phase === 'playing') nextTurn();
  });

  // 再来一局
  socket.on('restartGame', () => {
    if (playerIds.length < MIN_PLAYERS) {
      phase = 'waiting';
      winnerId = null;
      topCardPublic = null;
      currentTurnIndex = 0;
      defusingPlayerId = null;

      io.emit('gameRestarted');
      broadcastState();
      return;
    }

    startNewRound();
  });

  socket.on('disconnect', () => {
    console.log('玩家离开: ' + socket.id);

    delete players[socket.id];
    playerIds = playerIds.filter(id => id !== socket.id);

    if (defusingPlayerId === socket.id) {
      defusingPlayerId = null;
      topCardPublic = null;
    }

    recomputePhaseAndMaybeEndOrStart();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
