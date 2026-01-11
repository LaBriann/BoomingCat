const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 游戏核心数据 ---
let players = {};          // { [id]: { id, hand, isDead } }
let playerIds = [];        // 回合顺序
let currentTurnIndex = 0;  // 当前回合索引
let deck = [];
let topCardPublic = null;

// 游戏阶段：waiting / playing / ended
let phase = 'waiting';
let winnerId = null;

// 正在拆弹的玩家（必须先 insertBomb 才能继续）
let defusingPlayerId = null;

// 配置：至少人数才能开局
const MIN_PLAYERS = 2;

// 配置：初始手牌内容
const STARTING_HAND = ['拆除', '拆除', '普通牌'];

// 洗牌算法
function shuffleDeck() {
  const cards = [
    '炸弹', '炸弹', '炸弹', '炸弹',
    '拆除', '拆除',
    '跳过', '跳过',
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

// 统一的阶段/结算判定：任何关键事件后都调用
function recomputePhaseAndMaybeEndOrStart() {
  // 清理无效 id
  playerIds = playerIds.filter(pid => players[pid]);

  const connectedCount = playerIds.length;

  // 人数不足：进入 waiting（防止单人一直抽牌直到炸弹才结束）
  if (connectedCount < MIN_PLAYERS) {
    phase = 'waiting';
    winnerId = null;
    topCardPublic = null;
    currentTurnIndex = 0;
    defusingPlayerId = null;
    broadcastState();
    return;
  }

  // waiting 且人数够：自动开局
  if (phase === 'waiting') {
    startNewRound();
    return;
  }

  // playing：检查活人
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

  // ended：只广播状态（等玩家点 restart）
  broadcastState();
}

function nextTurn() {
  if (phase !== 'playing') return;

  // 如果正在拆弹，回合不能推进
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

  // 连接变化统一重算（可能自动开局/结算）
  recomputePhaseAndMaybeEndOrStart();

  // 单播给新玩家（避免首帧丢失）
  socket.emit('gameState', buildState());

  socket.on('requestState', () => {
    socket.emit('gameState', buildState());
  });

  // --- 新增：打出卡牌（目前只实现“跳过”） ---
  socket.on('playCard', ({ card }) => {
    if (phase !== 'playing') return;
    if (defusingPlayerId) return; // 拆弹过程中禁止出牌
    if (socket.id !== playerIds[currentTurnIndex]) return;
    if (!players[socket.id] || players[socket.id].isDead) return;

    if (card !== '跳过') return;

    const hand = players[socket.id].hand;
    const idx = hand.indexOf('跳过');
    if (idx === -1) return;

    // 消耗一张跳过
    hand.splice(idx, 1);

    io.emit('cardPlayed', { id: socket.id, card: '跳过' });

    // 跳过：直接切回合，不抽牌
    nextTurn();
  });

  // 抽牌
  socket.on('drawCard', () => {
    if (phase !== 'playing') {
      socket.emit('errorMsg', { message: '需要至少 2 名玩家且游戏进行中才能抽牌' });
      return;
    }
    if (defusingPlayerId) return; // 拆弹过程中禁止抽牌
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
        // 有拆除：消耗拆除，进入“拆弹态”
        player.hand.splice(defuseIndex, 1);
        defusingPlayerId = socket.id;

        broadcastState();
        socket.emit('askInsertBomb', { maxIndex: deck.length });
        return;
      }

      // 没拆除：死亡
      player.isDead = true;
      io.emit('playerDied', { id: socket.id });

      // 死亡后立刻重新判定是否结束
      recomputePhaseAndMaybeEndOrStart();

      // 如果未结束且仍在 playing，切回合
      if (phase === 'playing') nextTurn();
      return;
    }

    // 普通牌
    players[socket.id].hand.push(card);
    nextTurn();
  });

  // 塞炸弹（仅允许“正在拆弹”的那个玩家执行）
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

    // 插完也重算一次（防极端状态）
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

    // 断线后如果正是拆弹玩家，清除拆弹态（否则会锁死）
    if (defusingPlayerId === socket.id) {
      defusingPlayerId = null;
      topCardPublic = null;
    }

    // 断线也立即判定阶段/结算
    recomputePhaseAndMaybeEndOrStart();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
